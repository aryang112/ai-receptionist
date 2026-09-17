import WebSocket from 'ws';
import { logger } from '../core/logger.js';
import type {
  RealtimeHandlers,
  ToolDefinition,
  ToolHandler,
} from '../realtime/openaiSession.js';
import { MuLawSpeechGate, muLawRms } from './mulawAudio.js';
import {
  parseBackendUsage,
  parseToolCall,
  parseTranscriptFragment,
  parseVoiceUsage,
  type LiveToolCall,
  type LiveTranscriptFragment,
  type LiveUsage,
} from './liveProtocol.js';

type Logger = typeof logger;
type LiveSocketFactory = (
  url: string,
  options: WebSocket.ClientOptions
) => WebSocket;

export type LiveSessionOptions = RealtimeHandlers & {
  callTag?: string;
  apiKey?: string;
  liveModel?: string;
  voice?: string;
  backendModel: string;
  backendEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  onOutputSpeechStarted?: () => void;
  onOutputSpeechStopped?: () => void;
  onInputTranscriptFragment?: (fragment: LiveTranscriptFragment) => void;
  onOutputTranscriptFragment?: (fragment: LiveTranscriptFragment) => void;
  onLiveUsage?: (usage: LiveUsage) => void;
  /** Test seam; production callers should leave this unset. */
  webSocketFactory?: LiveSocketFactory;
  startupTimeoutMs?: number;
  updateTimeoutMs?: number;
  closeTimeoutMs?: number;
  greetingRetryMs?: number;
  greetingTimeoutMs?: number;
};

export type LiveSessionConfig = {
  /** Compatibility fallback when the caller has not split the two prompts. */
  instructions?: string;
  tools?: ToolDefinition[];
  liveInstructions?: string;
  backendInstructions?: string;
  backendModel?: string;
  backendEffort?: LiveSessionOptions['backendEffort'];
};

type PendingAck = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ToolBatch = {
  delegationId?: string;
  responseId: string;
  calls: LiveToolCall[];
  callIds: Set<string>;
  dispatched: boolean;
};

const OUTPUT_FRAME_BYTES = 160; // 20 ms at 8 kHz G.711 mu-law.
const OUTPUT_FRAME_MS = 20;
const OUTPUT_SOFT_FRAMES = 20; // 400 ms target; ordinary jitter is not fatal.
const OUTPUT_HARD_FRAMES = 250; // 5 s pathological backlog, about 40 KB.
const OUTPUT_CATCHUP_FRAMES = 5; // At most 100 ms per event-loop wake.
const MAX_CONTEXT_APPEND_CHARS = 1_200; // Conservative guard below 500 tokens.
const MAX_BACKEND_CONTEXT_CHARS = 16_000;

/**
 * GPT-Live adapter for the existing Twilio controller. Live emits a continuous
 * audio stream and has no spoken-response completion event. Speech callbacks
 * therefore report activity only; Twilio marks remain the playback authority.
 */
export class OpenAILiveSession {
  private ws: WebSocket | undefined;
  private readonly handlers: RealtimeHandlers;
  private readonly onOutputSpeechStarted: (() => void) | undefined;
  private readonly onOutputSpeechStopped: (() => void) | undefined;
  private readonly onInputTranscriptFragment:
    | ((fragment: LiveTranscriptFragment) => void)
    | undefined;
  private readonly onOutputTranscriptFragment:
    | ((fragment: LiveTranscriptFragment) => void)
    | undefined;
  private readonly onLiveUsage: ((usage: LiveUsage) => void) | undefined;
  private readonly log: Logger;
  private readonly apiKey: string;
  private readonly liveModel: string;
  private readonly voice: string;
  private backendModel: string;
  private backendEffort: LiveSessionOptions['backendEffort'] | undefined;
  private readonly webSocketFactory: LiveSocketFactory;
  private readonly startupTimeoutMs: number;
  private readonly updateTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly greetingRetryMs: number;
  private readonly greetingTimeoutMs: number;

  private connected = false;
  private started = false;
  private closing = false;
  private sessionCloseSent = false;
  private closePromise: Promise<void> | undefined;
  private closeNotified = false;
  private sessionClosedReceived = false;
  private finalUsageEmitted = false;
  private startAck: PendingAck | undefined;
  private updateAck: PendingAck | undefined;
  private closeAck: PendingAck | undefined;

  private configuredTools: ToolDefinition[] = [];
  private liveInstructions = '';
  private backendInstructions = '';
  private readonly backendContextNotes: string[] = [];
  private backendUpdateChain: Promise<void> = Promise.resolve();
  private readonly toolHandlers = new Map<string, ToolHandler>();
  private readonly toolBatches = new Map<string, ToolBatch>();
  private readonly responseByDelegation = new Map<string, string>();
  private readonly pendingToolTasks = new Set<Promise<void>>();
  private readonly backendUsageResponseIds = new Set<string>();
  private readonly delegationStallTimers = new Map<string, NodeJS.Timeout>();

  private readonly inputSpeechGate = new MuLawSpeechGate({
    speechFramesToStart: 2,
    quietFramesToStop: 10,
  });
  private readonly outputSpeechGate = new MuLawSpeechGate({
    speechFramesToStart: 1,
    // Keep ordinary phrase pauses inside one acoustic segment. This is an
    // activity boundary only; Twilio marks decide when playback drains.
    quietFramesToStop: 30,
  });
  private inputSegmentSequence = 0;
  private activeInputSegmentId: string | undefined;
  private outputQueue: string[] = [];
  private outputTimer: NodeJS.Timeout | undefined;
  private outputRemainder = Buffer.alloc(0);
  private nextOutputAt: number | undefined;
  private outputDropLogged = false;
  private outputOverrun = false;
  private greetingRequested = false;
  private greetingSpoken = false;
  private greetingRetryTimer: NodeJS.Timeout | undefined;
  private greetingFailureTimer: NodeJS.Timeout | undefined;
  private lastVoiceSeconds: number | undefined;
  private lastContextWindowUsageRatio: number | undefined;
  private eventSequence = 0;

  constructor(options: LiveSessionOptions) {
    const {
      callTag,
      apiKey,
      liveModel,
      voice,
      backendModel,
      backendEffort,
      onOutputSpeechStarted,
      onOutputSpeechStopped,
      onInputTranscriptFragment,
      onOutputTranscriptFragment,
      onLiveUsage,
      webSocketFactory,
      startupTimeoutMs,
      updateTimeoutMs,
      closeTimeoutMs,
      greetingRetryMs,
      greetingTimeoutMs,
      ...handlers
    } = options;

    this.handlers = handlers;
    this.onOutputSpeechStarted = onOutputSpeechStarted;
    this.onOutputSpeechStopped = onOutputSpeechStopped;
    this.onInputTranscriptFragment = onInputTranscriptFragment;
    this.onOutputTranscriptFragment = onOutputTranscriptFragment;
    this.onLiveUsage = onLiveUsage;
    this.log = callTag ? logger.child({ call: callTag }) : logger;
    this.apiKey =
      apiKey ??
      process.env.OPENAI_REALTIME_API_KEY ??
      process.env.OPENAI_API_KEY ??
      '';
    this.liveModel = liveModel ?? 'gpt-live-1';
    this.voice = voice ?? 'marin';
    this.backendModel = backendModel;
    this.backendEffort = backendEffort;
    this.webSocketFactory =
      webSocketFactory ??
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.startupTimeoutMs = startupTimeoutMs ?? 5_000;
    this.updateTimeoutMs = updateTimeoutMs ?? 5_000;
    this.closeTimeoutMs = closeTimeoutMs ?? 3_000;
    this.greetingRetryMs = greetingRetryMs ?? 2_500;
    this.greetingTimeoutMs = greetingTimeoutMs ?? 5_000;

    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured for GPT-Live');
    }
    if (!this.backendModel) {
      throw new Error('GPT-Live backend model not configured');
    }
  }

  registerTool(name: string, handler: ToolHandler): void {
    this.toolHandlers.set(name, handler);
  }

  /**
   * Read-only: names of every tool with a registered handler on this session.
   * Exists so a contract test can assert every tool liveToolDefinitions()
   * advertises actually has a handler, without reaching into the private
   * toolHandlers map (2026-09-16 — see toolRegistration.test.ts).
   */
  registeredToolNames(): string[] {
    return Array.from(this.toolHandlers.keys());
  }

  async connect(): Promise<void> {
    if (this.isWritable()) return;
    if (this.ws) this.releaseSocket();
    this.closing = false;
    this.sessionCloseSent = false;
    this.closePromise = undefined;
    this.sessionClosedReceived = false;

    const ws = this.webSocketFactory('wss://api.openai.com/v1/live/sessions', {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'erica-live/1.0',
      },
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error('GPT-Live WebSocket connection timed out'));
        this.releaseSocket();
      }, this.startupTimeoutMs);
      timer.unref?.();

      ws.once('open', () => {
        this.connected = true;
        this.installSocketListeners(ws);
        this.log.info(
          { model: this.liveModel, backendModel: this.backendModel },
          'GPT-Live WebSocket connection established'
        );
        finish();
      });
      ws.once('error', (error: Error) => finish(error));
    });
  }

  async configureSession(config: LiveSessionConfig): Promise<void> {
    if (!this.isWritable()) {
      throw new Error('GPT-Live session is not connected');
    }
    if (config.tools) this.configuredTools = config.tools;
    this.liveInstructions =
      config.liveInstructions ?? config.instructions ?? this.liveInstructions;
    this.backendInstructions =
      config.backendInstructions ??
      config.instructions ??
      this.backendInstructions;
    this.backendModel = config.backendModel ?? this.backendModel;
    this.backendEffort = config.backendEffort ?? this.backendEffort;

    if (!this.started) {
      const ack = this.createAck(
        'GPT-Live session.start acknowledgment timed out',
        this.startupTimeoutMs
      );
      this.startAck = ack;
      this.sendRaw({
        type: 'session.start',
        event_id: this.nextEventId('session_start'),
        session: this.buildStartConfig(),
      });
      await this.waitForAck(ack);
      return;
    }

    await this.sendBackendUpdate();
  }

  /**
   * Adds a bounded note to the Live frontend immediately, then serializes a
   * full backend prompt update. Callers may ignore the returned promise for
   * compatibility; failures still reach onError.
   */
  injectContext(text: string): Promise<void> {
    if (!this.isReady() || !text.trim()) return Promise.resolve();
    const note = text.trim().slice(0, MAX_CONTEXT_APPEND_CHARS);
    if (note.length !== text.trim().length) {
      this.log.warn(
        { originalChars: text.trim().length, sentChars: note.length },
        'GPT-Live context append truncated to stay below protocol limit'
      );
    }
    this.addBackendContextNote(note);
    this.sendRaw({
      type: 'session.instructions.append',
      event_id: this.nextEventId('context'),
      delegation_id: null,
      content: note,
    });

    return this.queueBackendUpdate();
  }

  /**
   * Backend-only application context for private account and appointment data.
   * Notes stay whole; the bounded collection evicts older notes rather than
   * truncating a privacy or identity instruction.
   */
  injectBackendContext(text: string): Promise<void> {
    if (!this.isReady() || !text.trim()) return Promise.resolve();
    const note = text.trim();
    if (note.length > MAX_BACKEND_CONTEXT_CHARS) {
      this.notifyError(
        new Error(
          'GPT-Live backend context note exceeds the safe session bound'
        )
      );
      return Promise.resolve();
    }
    this.addBackendContextNote(note);
    return this.queueBackendUpdate();
  }

  /** Pattern B: an instruction append plus a direct commentary nudge. */
  requestGreeting(): boolean {
    if (!this.isReady() || this.greetingRequested) return false;
    this.greetingRequested = true;
    this.greetingSpoken = false;
    this.sendRaw({
      type: 'session.instructions.append',
      event_id: this.nextEventId('greeting_instruction'),
      delegation_id: null,
      content:
        'Greet the caller immediately using the required greeting and recording disclosure in your instructions. Then stop and listen.',
    });
    this.sendGreetingCommentary();

    this.greetingRetryTimer = setTimeout(() => {
      if (!this.greetingSpoken && this.isReady()) {
        this.log.warn(
          'GPT-Live greeting had no speech; retrying commentary once'
        );
        this.sendGreetingCommentary();
      }
    }, this.greetingRetryMs);
    this.greetingRetryTimer.unref?.();

    this.greetingFailureTimer = setTimeout(() => {
      if (this.greetingSpoken || !this.isReady()) return;
      const error = new Error(
        'GPT-Live greeting produced no speech before the deadline'
      );
      this.notifyError(error);
      void this.close();
    }, this.greetingTimeoutMs);
    this.greetingFailureTimer.unref?.();
    return true;
  }

  /**
   * A direct Live commentary nudge for server-owned check-ins and goodbyes.
   * Backend tool continuation uses response.create internally and separately.
   */
  requestResponse(): boolean {
    if (!this.isReady()) return false;
    this.sendRaw({
      type: 'session.commentary.append',
      event_id: this.nextEventId('application_nudge'),
      delegation_id: null,
      content:
        'Respond now using the latest application instruction and conversation context.',
    });
    return true;
  }

  appendTwilioAudio(base64MuLaw: string): void {
    if (!this.isReady() || this.closing) return;
    const transition = this.inputSpeechGate.process(base64MuLaw);
    if (transition === 'started') {
      this.activeInputSegmentId = `live_input_${++this.inputSegmentSequence}`;
      this.handlers.onSpeechStarted?.(this.activeInputSegmentId);
    } else if (transition === 'stopped') {
      this.handlers.onSpeechStopped?.(this.activeInputSegmentId);
      this.activeInputSegmentId = undefined;
    }
    this.sendRaw({ type: 'session.input_audio.append', audio: base64MuLaw });
  }

  /** Live owns interruption; this compatibility method intentionally does no I/O. */
  truncateActiveResponse(_audioEndMs: number): void {
    this.log.debug('GPT-Live ignores Realtime response truncation');
  }

  /** Live has no Realtime auto-response toggle; turn-taking remains model-owned. */
  setAutoResponses(_enabled: boolean): void {
    this.log.debug('GPT-Live ignores Realtime auto-response toggles');
  }

  /** Live audio has no response identity or response.done equivalent. */
  getCurrentResponseId(): null {
    return null;
  }

  close(): Promise<void> {
    if (!this.ws) return Promise.resolve();
    if (!this.closePromise) this.closePromise = this.closeSession();
    return this.closePromise;
  }

  private async closeSession(): Promise<void> {
    this.closing = true;
    this.clearGreetingTimers();
    this.stopOutputPacer();

    // session.close is valid only after session.started. During handshake
    // cleanup, release the transport locally and reject any configure waiter;
    // otherwise the invalid first command creates an API error loop followed
    // by the full close timeout.
    if (!this.started) {
      this.rejectAck(
        'startAck',
        new Error('GPT-Live session closed before session.started')
      );
      this.emitUnconfirmedFinalUsage();
      this.releaseSocket();
      return;
    }

    if (this.pendingToolTasks.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.pendingToolTasks]).then(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(1_000, this.closeTimeoutMs)
          );
          timer.unref?.();
        }),
      ]);
    }

    if (!this.isWritable()) {
      this.emitUnconfirmedFinalUsage();
      this.releaseSocket();
      return;
    }

    const ack = this.createAck(
      'GPT-Live session.close acknowledgment timed out',
      this.closeTimeoutMs
    );
    this.closeAck = ack;
    this.sessionCloseSent = true;
    this.sendRaw({
      type: 'session.close',
      event_id: this.nextEventId('session_close'),
    });
    await this.waitForAck(ack, false);
    if (!this.sessionClosedReceived) this.emitUnconfirmedFinalUsage();
    this.releaseSocket();
  }

  private buildResponsesConfig(): Record<string, unknown> {
    const instructions = [
      this.backendInstructions,
      ...this.backendContextNotes.map(
        (note) => `APPLICATION CONTEXT:\n${note}`
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      model: this.backendModel,
      instructions,
      tools: this.configuredTools,
      tool_choice: 'auto',
      ...(this.backendEffort
        ? { reasoning: { effort: this.backendEffort } }
        : {}),
    };
  }

  private buildStartConfig(): Record<string, unknown> {
    return {
      model: this.liveModel,
      store: false,
      instructions: this.liveInstructions,
      audio: {
        format: { type: 'audio/pcmu', rate: 8_000 },
        output: { voice: this.voice },
      },
      delegation: {
        type: 'responses',
        responses: this.buildResponsesConfig(),
      },
    };
  }

  private async sendBackendUpdate(): Promise<void> {
    if (!this.isReady()) return;
    const ack = this.createAck(
      'GPT-Live session.update acknowledgment timed out',
      this.updateTimeoutMs
    );
    this.updateAck = ack;
    this.sendRaw({
      type: 'session.update',
      event_id: this.nextEventId('session_update'),
      session: {
        delegation: {
          type: 'responses',
          responses: this.buildResponsesConfig(),
        },
      },
    });
    await this.waitForAck(ack);
  }

  private addBackendContextNote(note: string): void {
    this.backendContextNotes.push(note);
    let totalChars = this.backendContextNotes.reduce(
      (total, value) => total + value.length,
      0
    );
    let evicted = 0;
    while (
      totalChars > MAX_BACKEND_CONTEXT_CHARS &&
      this.backendContextNotes.length > 1
    ) {
      const removed = this.backendContextNotes.shift();
      if (!removed) break;
      totalChars -= removed.length;
      evicted += 1;
    }
    if (evicted > 0) {
      this.log.warn(
        { evicted, retainedChars: totalChars },
        'GPT-Live evicted old backend context notes at the session bound'
      );
    }
  }

  private queueBackendUpdate(): Promise<void> {
    const update = this.backendUpdateChain.then(() => this.sendBackendUpdate());
    this.backendUpdateChain = update.catch((error: unknown) => {
      this.notifyError(
        this.asError(error, 'GPT-Live backend context update failed')
      );
    });
    // Return the handled chain so fire-and-forget controller calls can never
    // create an unhandled rejection.
    return this.backendUpdateChain;
  }

  private installSocketListeners(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      let event: unknown;
      try {
        event = JSON.parse(data.toString());
      } catch (error) {
        this.notifyError(this.asError(error, 'Invalid GPT-Live event JSON'));
        return;
      }
      void this.handleEvent(event).catch((error: unknown) => {
        this.notifyError(this.asError(error, 'GPT-Live event handler failed'));
      });
    });
    ws.on('error', (error: Error) => this.notifyError(error));
    ws.on('close', () => {
      this.connected = false;
      this.started = false;
      this.stopOutputPacer();
      this.clearGreetingTimers();
      if (!this.sessionClosedReceived) this.emitUnconfirmedFinalUsage();
      if (!this.closing && !this.closeNotified) {
        this.closeNotified = true;
        this.handlers.onClose?.();
      }
    });
  }

  private async handleEvent(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, any>;
    switch (event.type) {
      case 'session.started':
        this.started = true;
        this.resolveAck('startAck');
        this.log.info(
          {
            model: event.session?.model,
            voice: event.session?.audio?.output?.voice,
            backendModel: event.session?.delegation?.responses?.model,
            store: event.session?.store,
          },
          'GPT-Live session started'
        );
        return;
      case 'session.updated':
        this.resolveAck('updateAck');
        return;
      case 'session.output_audio.delta':
        if (typeof event.delta === 'string') {
          this.clearDelegationStallTimers();
          this.enqueueOutputAudio(event.delta);
        }
        return;
      case 'session.input_transcript.delta': {
        const fragment = parseTranscriptFragment(event);
        if (fragment) this.onInputTranscriptFragment?.(fragment);
        return;
      }
      case 'session.output_transcript.delta': {
        const fragment = parseTranscriptFragment(event);
        if (fragment) {
          this.onOutputTranscriptFragment?.(fragment);
          this.handlers.onTextDelta?.(fragment.delta);
        }
        return;
      }
      case 'session.delegation.created': {
        const delegationId = event.delegation?.id;
        const responseId = event.response_id;
        if (
          typeof delegationId === 'string' &&
          typeof responseId === 'string'
        ) {
          this.responseByDelegation.set(delegationId, responseId);
          this.ensureToolBatch(responseId, delegationId);
          this.armDelegationStallLog(delegationId, responseId);
        }
        return;
      }
      case 'response.event':
        await this.handleResponseEvent(event);
        return;
      case 'session.usage.updated':
        this.emitVoiceUsage(event, false, false);
        return;
      case 'session.closed':
        this.sessionClosedReceived = true;
        this.emitVoiceUsage(event, true, true);
        this.resolveAck('closeAck');
        if (!this.closing && !this.closeNotified) {
          this.closeNotified = true;
          this.handlers.onClose?.();
        }
        return;
      case 'error': {
        const error = new Error(
          typeof event.error?.message === 'string'
            ? event.error.message
            : 'GPT-Live protocol error'
        );
        this.rejectAck('startAck', error);
        this.rejectAck('updateAck', error);
        this.notifyError(error);
        return;
      }
      default:
        return;
    }
  }

  private async handleResponseEvent(
    envelope: Record<string, any>
  ): Promise<void> {
    const inner = envelope.event;
    if (!inner || typeof inner !== 'object' || typeof inner.type !== 'string') {
      return;
    }
    const delegationId =
      typeof envelope.delegation_id === 'string'
        ? envelope.delegation_id
        : undefined;

    if (inner.type === 'response.created') {
      const responseId = inner.response?.id;
      if (typeof responseId === 'string') {
        if (delegationId) {
          this.responseByDelegation.set(delegationId, responseId);
        }
        this.ensureToolBatch(responseId, delegationId);
      }
      return;
    }

    if (inner.type === 'response.output_item.done') {
      const call = parseToolCall(inner);
      const responseId =
        (typeof inner.response_id === 'string'
          ? inner.response_id
          : undefined) ??
        (delegationId
          ? this.responseByDelegation.get(delegationId)
          : undefined);
      if (call && responseId) {
        const batch = this.ensureToolBatch(responseId, delegationId);
        if (!batch.callIds.has(call.callId)) {
          batch.callIds.add(call.callId);
          batch.calls.push(call);
        }
      }
      return;
    }

    if (inner.type !== 'response.completed') return;
    if (delegationId) this.clearDelegationStallTimer(delegationId);
    const responseId =
      typeof inner.response?.id === 'string'
        ? inner.response.id
        : delegationId
          ? this.responseByDelegation.get(delegationId)
          : undefined;
    if (!responseId) return;

    const usage = parseBackendUsage(inner.response?.usage);
    if (usage && !this.backendUsageResponseIds.has(responseId)) {
      this.backendUsageResponseIds.add(responseId);
      this.onLiveUsage?.({
        backendUsage: usage,
        responseId,
        final: false,
        finalConfirmed: false,
      });
    }

    const batch = this.ensureToolBatch(responseId, delegationId);
    if (batch.calls.length === 0 || batch.dispatched) return;
    batch.dispatched = true;
    const task = this.dispatchToolBatch(batch);
    this.pendingToolTasks.add(task);
    void task.finally(() => this.pendingToolTasks.delete(task));
  }

  private ensureToolBatch(
    responseId: string,
    delegationId?: string
  ): ToolBatch {
    const existing = this.toolBatches.get(responseId);
    if (existing) return existing;
    const batch: ToolBatch = {
      responseId,
      calls: [],
      callIds: new Set(),
      dispatched: false,
      ...(delegationId ? { delegationId } : {}),
    };
    this.toolBatches.set(responseId, batch);
    return batch;
  }

  private async dispatchToolBatch(batch: ToolBatch): Promise<void> {
    const results = await Promise.all(
      batch.calls.map(async (call) => ({
        callId: call.callId,
        output: await this.runTool(call),
      }))
    );
    if (
      !this.isWritable() ||
      this.sessionClosedReceived ||
      this.sessionCloseSent
    )
      return;

    for (const result of results) {
      this.sendRaw({
        type: 'response.item.create',
        event_id: this.nextEventId('tool_result'),
        item: {
          type: 'function_call_output',
          call_id: result.callId,
          output: result.output,
        },
      });
    }
    // One continuation only after every result in this backend response batch.
    this.sendRaw({
      type: 'response.create',
      event_id: this.nextEventId('tool_continue'),
    });
    this.toolBatches.delete(batch.responseId);
  }

  private async runTool(call: LiveToolCall): Promise<string> {
    const handler = this.toolHandlers.get(call.name);
    if (!handler) {
      return JSON.stringify({
        error: `No handler registered for tool ${call.name}`,
      });
    }
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      return JSON.stringify({ error: 'Tool arguments were not valid JSON' });
    }

    try {
      const result = await handler(args);
      return JSON.stringify(result ?? null);
    } catch (error) {
      this.log.error(
        { err: error, tool: call.name },
        'GPT-Live delegated tool failed'
      );
      return JSON.stringify({ error: 'Tool execution failed' });
    }
  }

  private enqueueOutputAudio(payload: string): void {
    if (this.closing) return;
    // A socket event can run before an overdue timer after an event-loop stall.
    // Drain that already-due work before judging the newly arrived backlog.
    if (
      this.outputTimer &&
      this.nextOutputAt !== undefined &&
      performance.now() >= this.nextOutputAt
    ) {
      clearTimeout(this.outputTimer);
      this.outputTimer = undefined;
      this.drainOneOutputFrame();
      if (this.closing) return;
    }
    // Live event boundaries are arbitrary. Carry partial samples into the next
    // event instead of charging a short chunk a full 20 ms of playback time.
    const bytes = Buffer.concat([
      this.outputRemainder,
      Buffer.from(payload, 'base64'),
    ]);
    const completeBytes = bytes.length - (bytes.length % OUTPUT_FRAME_BYTES);
    for (let offset = 0; offset < completeBytes; offset += OUTPUT_FRAME_BYTES) {
      this.outputQueue.push(
        bytes.subarray(offset, offset + OUTPUT_FRAME_BYTES).toString('base64')
      );
      // Bound retained frames even if an upstream event contains a huge burst.
      if (this.outputQueue.length > OUTPUT_HARD_FRAMES) {
        if (!this.outputTimer) this.drainOneOutputFrame();
        this.boundOutputQueue();
        if (this.closing) return;
      }
    }
    this.outputRemainder = Buffer.from(bytes.subarray(completeBytes));
    if (!this.outputTimer) this.drainOneOutputFrame();
    this.boundOutputQueue();
  }

  private boundOutputQueue(): void {
    while (this.outputQueue.length > OUTPUT_SOFT_FRAMES) {
      // Only collapse digital silence, never low-volume speech.
      const silenceIndex = this.outputQueue.findIndex(
        (frame) => muLawRms(frame) === 0
      );
      if (!this.outputDropLogged) {
        this.outputDropLogged = true;
        this.log.warn(
          {
            queuedMs: this.outputQueue.length * OUTPUT_FRAME_MS,
            targetMs: 400,
          },
          'GPT-Live output buffering transient audio jitter'
        );
      }
      if (silenceIndex < 0) break;
      this.outputQueue.splice(silenceIndex, 1);
    }
    if (this.outputQueue.length > OUTPUT_HARD_FRAMES && !this.outputOverrun) {
      this.outputOverrun = true;
      const error = new Error(
        'GPT-Live speech audio exceeded the 5s outbound queue bound'
      );
      this.log.error(
        { queuedFrames: this.outputQueue.length, maxQueuedMs: 5000 },
        error.message
      );
      this.handlers.onError?.(error);
      void this.close();
    }
  }

  private drainOneOutputFrame(): void {
    if (this.closing || !this.outputQueue.length) {
      this.outputTimer = undefined;
      this.nextOutputAt = undefined;
      return;
    }
    this.nextOutputAt ??= performance.now();
    let sent = 0;
    while (
      this.outputQueue.length &&
      sent < OUTPUT_CATCHUP_FRAMES &&
      performance.now() >= this.nextOutputAt &&
      !this.closing
    ) {
      const frame = this.outputQueue.shift();
      if (frame === undefined) break; // the while-condition length check guarantees this cannot happen
      const transition = this.outputSpeechGate.process(frame);
      if (transition === 'started') {
        this.greetingSpoken = this.greetingRequested || this.greetingSpoken;
        this.clearGreetingTimers();
        this.onOutputSpeechStarted?.();
      }
      this.handlers.onAudioChunk?.(frame);
      // Marks follow the quiet boundary frame, preserving playback ordering.
      if (transition === 'stopped') this.onOutputSpeechStopped?.();
      this.nextOutputAt += OUTPUT_FRAME_MS;
      sent++;
    }
    this.boundOutputQueue();
    if (this.closing) return;
    // Advance an absolute audio clock: callback overhead must not accumulate
    // into seconds of lag on a long call. Yield after each bounded catch-up.
    this.outputTimer = setTimeout(
      () => {
        this.outputTimer = undefined;
        this.drainOneOutputFrame();
      },
      Math.max(0, this.nextOutputAt - performance.now())
    );
    this.outputTimer.unref?.();
  }

  private stopOutputPacer(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = undefined;
    this.outputQueue = [];
    this.outputRemainder = Buffer.alloc(0);
    this.nextOutputAt = undefined;
    this.outputSpeechGate.reset();
  }

  private armDelegationStallLog(
    delegationId: string,
    responseId: string
  ): void {
    const existing = this.delegationStallTimers.get(delegationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.delegationStallTimers.delete(delegationId);
      this.log.warn(
        { delegationId, responseId, noOutputMs: 5_000 },
        'GPT-Live delegation pending with no output audio'
      );
    }, 5_000);
    timer.unref?.();
    this.delegationStallTimers.set(delegationId, timer);
  }

  private clearDelegationStallTimers(): void {
    for (const timer of this.delegationStallTimers.values()) {
      clearTimeout(timer);
    }
    this.delegationStallTimers.clear();
  }

  private clearDelegationStallTimer(delegationId: string): void {
    const timer = this.delegationStallTimers.get(delegationId);
    if (!timer) return;
    clearTimeout(timer);
    this.delegationStallTimers.delete(delegationId);
  }

  private sendGreetingCommentary(): void {
    this.sendRaw({
      type: 'session.commentary.append',
      event_id: this.nextEventId('greeting_commentary'),
      delegation_id: null,
      content: 'Begin the conversation now by speaking the required greeting.',
    });
  }

  private clearGreetingTimers(): void {
    if (this.greetingRetryTimer) clearTimeout(this.greetingRetryTimer);
    if (this.greetingFailureTimer) clearTimeout(this.greetingFailureTimer);
    this.greetingRetryTimer = undefined;
    this.greetingFailureTimer = undefined;
  }

  private emitVoiceUsage(
    event: Record<string, unknown>,
    final: boolean,
    finalConfirmed: boolean
  ): void {
    const parsed = parseVoiceUsage(event);
    if (parsed.voiceSeconds !== undefined) {
      this.lastVoiceSeconds = parsed.voiceSeconds;
    }
    if (parsed.contextWindowUsageRatio !== undefined) {
      this.lastContextWindowUsageRatio = parsed.contextWindowUsageRatio;
    }
    if (final && this.finalUsageEmitted) return;
    if (final) this.finalUsageEmitted = true;
    const reason = typeof event.reason === 'string' ? event.reason : undefined;
    this.onLiveUsage?.({
      ...(this.lastVoiceSeconds === undefined
        ? {}
        : { voiceSeconds: this.lastVoiceSeconds }),
      ...(this.lastContextWindowUsageRatio === undefined
        ? {}
        : { contextWindowUsageRatio: this.lastContextWindowUsageRatio }),
      ...(reason ? { closeReason: reason } : {}),
      final,
      finalConfirmed,
    });
  }

  private emitUnconfirmedFinalUsage(): void {
    if (this.finalUsageEmitted) return;
    this.finalUsageEmitted = true;
    this.onLiveUsage?.({
      ...(this.lastVoiceSeconds === undefined
        ? {}
        : { voiceSeconds: this.lastVoiceSeconds }),
      ...(this.lastContextWindowUsageRatio === undefined
        ? {}
        : { contextWindowUsageRatio: this.lastContextWindowUsageRatio }),
      final: true,
      finalConfirmed: false,
    });
  }

  private createAck(message: string, timeoutMs: number): PendingAck {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    return Object.assign(
      { resolve, reject, timer },
      { promise }
    ) as PendingAck & {
      promise: Promise<void>;
    };
  }

  private async waitForAck(
    ack: PendingAck,
    throwOnTimeout = true
  ): Promise<void> {
    try {
      await (ack as PendingAck & { promise: Promise<void> }).promise;
    } catch (error) {
      if (throwOnTimeout) throw error;
      this.log.warn(
        { err: error },
        'GPT-Live graceful close was not confirmed'
      );
    }
  }

  private resolveAck(field: 'startAck' | 'updateAck' | 'closeAck'): void {
    const ack = this[field];
    if (!ack) return;
    clearTimeout(ack.timer);
    this[field] = undefined;
    ack.resolve();
  }

  private rejectAck(field: 'startAck' | 'updateAck', error: Error): void {
    const ack = this[field];
    if (!ack) return;
    clearTimeout(ack.timer);
    this[field] = undefined;
    ack.reject(error);
  }

  private nextEventId(prefix: string): string {
    return `${prefix}_${++this.eventSequence}`;
  }

  private isWritable(): boolean {
    return !!this.ws && this.connected && this.ws.readyState === WebSocket.OPEN;
  }

  private isReady(): boolean {
    return (
      this.isWritable() &&
      this.started &&
      !this.closing &&
      !this.sessionClosedReceived
    );
  }

  private sendRaw(message: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || !this.isWritable()) return;
    ws.send(JSON.stringify(message));
  }

  private releaseSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.connected = false;
    this.started = false;
    this.clearDelegationStallTimers();
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      // Transport is already gone.
    }
  }

  private notifyError(error: Error): void {
    this.log.error({ err: error }, error.message);
    this.handlers.onError?.(error);
  }

  private asError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback);
  }
}

export type { LiveTranscriptFragment, LiveUsage } from './liveProtocol.js';
