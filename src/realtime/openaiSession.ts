import WebSocket from 'ws';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

// NOTE: Audio is now passed through end-to-end as G.711 mu-law (audio/pcmu),
// the exact format Twilio Media Streams use. No mu-law<->PCM transcoding or
// 8k<->24k resampling happens anymore — Twilio's base64 frames are forwarded
// verbatim to OpenAI and OpenAI's audio deltas are forwarded verbatim back.

export type RealtimeHandlers = {
  /** base64 G.711 mu-law audio from OpenAI, ready to send straight to Twilio. */
  onAudioChunk?: (base64MuLaw: string, itemId?: string) => void;
  onTextDelta?: (delta: string) => void;
  onResponseComplete?: () => void;
  /** Fired when OpenAI VAD detects the caller started talking (barge-in trigger). */
  onSpeechStarted?: () => void;
  onError?: (error: Error) => void;
};

export type ToolHandler = (args: unknown) => Promise<unknown> | unknown;
export type ToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export class OpenAIRealtimeSession {
  private ws?: WebSocket;
  private readonly handlers: RealtimeHandlers;
  private isConnected = false;
  private closing = false;
  private readonly messagesQueue: Array<Record<string, unknown>> = [];
  private readonly model: string;
  private readonly voice: string;
  private readonly toolHandlers = new Map<string, ToolHandler>();
  private readonly toolBuffers = new Map<
    string,
    { name: string; args: string }
  >();
  private configuredTools: ToolDefinition[] = [];
  private keepaliveInterval: NodeJS.Timeout | undefined = undefined;
  /** item_id of the assistant message currently being spoken — used for barge-in truncation. */
  private activeItemId: string | null = null;
  // Per-turn latency instrumentation. Timestamps (ms) of the events that start
  // a "turn"; first audio out is measured against the most recent one.
  private tSpeechStopped = 0;
  private tResponseCreated = 0;
  private tToolResultSent = 0;
  private tGreetingRequested = 0;
  private firstAudioLogged = false;

  constructor(handlers: RealtimeHandlers = {}) {
    this.handlers = handlers;
    this.model = env.OPENAI_REALTIME_MODEL;
    this.voice = env.OPENAI_REALTIME_VOICE;
    if (!env.OPENAI_REALTIME_API_KEY) {
      throw new Error('OPENAI_REALTIME_API_KEY not configured');
    }
  }

  async connect(): Promise<void> {
    if (this.ws && this.isConnected) {
      logger.debug('Already connected to OpenAI, skipping reconnect');
      return;
    }

    if (this.ws) {
      logger.warn(
        'WebSocket exists but not connected - cleaning up before reconnect'
      );
      this.ws.removeAllListeners();
      this.ws.close();
    }

    // GA Realtime endpoint. The legacy `OpenAI-Beta: realtime=v1` header and the
    // beta wire schema were shut off in May 2026 — GA needs only the bearer token.
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${env.OPENAI_REALTIME_API_KEY}`,
      },
    });

    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        this.isConnected = true;
        this.flushQueue();
        this.startKeepalive();
        logger.info(
          { model: this.model },
          'OpenAI WebSocket connection established'
        );
        resolve();
      });
      ws.once('error', (err: Error) => {
        logger.error({ err }, 'OpenAI WebSocket connection failed');
        reject(err);
      });
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        if (this.handlers.onError && error instanceof Error)
          this.handlers.onError(error);
        return;
      }
      // Never let a thrown handler become an unhandled rejection — that would
      // crash the whole process (and every concurrent call) the way a transfer
      // mid-call used to. Swallow into onError instead.
      void this.handleEvent(message).catch((error: unknown) => {
        if (this.handlers.onError) {
          this.handlers.onError(
            error instanceof Error
              ? error
              : new Error('OpenAI event handler failed')
          );
        }
      });
    });

    ws.on('close', (code, reason) => {
      this.stopKeepalive();
      this.isConnected = false;
      const reasonText = reason.toString();
      logger.error(
        {
          code,
          reason: reasonText,
          codeDescription: this.getCloseCodeDescription(code),
        },
        `OpenAI WebSocket CLOSED - Code: ${code}, Reason: ${reasonText || 'none'}`
      );

      if (code === 1008 || (code >= 4000 && code < 5000)) {
        logger.error(
          'This looks like an authentication error! Check your OPENAI_REALTIME_API_KEY'
        );
      }
    });

    ws.on('error', (error: Error) => {
      logger.error(
        { err: error, message: error.message },
        'OpenAI WebSocket error occurred'
      );
      if (this.handlers.onError) this.handlers.onError(error);
    });
  }

  close() {
    this.closing = true;
    this.stopKeepalive();
    this.ws?.close();
    this.isConnected = false;
  }

  /** True only when the socket is genuinely open and writable. */
  private isOpen(): boolean {
    return (
      !this.closing &&
      !!this.ws &&
      this.isConnected &&
      this.ws.readyState === WebSocket.OPEN
    );
  }

  private getCloseCodeDescription(code: number): string {
    const descriptions: Record<number, string> = {
      1000: 'Normal closure',
      1001: 'Going away',
      1005: 'No status received',
      1006: 'Abnormal closure (connection lost)',
      1008: 'Policy violation (likely auth failure)',
      1011: 'Internal server error',
      1015: 'TLS handshake failure',
    };
    return descriptions[code] || `Unknown code ${code}`;
  }

  registerTool(name: string, handler: ToolHandler) {
    this.toolHandlers.set(name, handler);
  }

  async configureSession({
    instructions,
    tools,
  }: {
    instructions?: string;
    tools?: ToolDefinition[];
  }) {
    if (tools) {
      this.configuredTools = tools;
    }

    // GA session schema: audio config is nested under session.audio.input/output,
    // formats are typed objects ({type:'audio/pcmu'}), and output modality lives
    // in output_modalities. server_vad turn_detection sits under audio.input.
    //
    // Background-noise robustness (so Erica doesn't cut herself off on a noise):
    //  - noise_reduction filters input audio BEFORE the VAD sees it.
    //  - a higher threshold makes the VAD require clearer speech to trigger.
    // Both are env-tunable so they can be dialed in on a real noisy line.
    const noiseReduction =
      env.OPENAI_NOISE_REDUCTION === 'off'
        ? undefined
        : { type: env.OPENAI_NOISE_REDUCTION }; // 'near_field' (phone) | 'far_field'

    const sessionConfig = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        output_modalities: ['audio'],
        instructions,
        tools: this.configuredTools,
        // (max output is bounded via the 1-2 sentence prompt rule; the GA session
        // schema rejects a session-level max_response_output_tokens field.)
        // When context exceeds the input limit, drop down to 80% at once instead
        // of trimming a sliver every turn — fewer truncations AND it preserves the
        // cached prompt prefix (cached audio input is ~$0.40/1M vs $32/1M). This is
        // the key lever against the mid-call tokens/min "freeze".
        truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            ...(noiseReduction ? { noise_reduction: noiseReduction } : {}),
            turn_detection: {
              type: 'server_vad',
              threshold: env.OPENAI_VAD_THRESHOLD,
              prefix_padding_ms: env.OPENAI_VAD_PREFIX_MS,
              silence_duration_ms: env.OPENAI_VAD_SILENCE_MS,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: this.voice,
          },
        },
      },
    };

    logger.info(
      {
        model: this.model,
        voice: this.voice,
        vadThreshold: env.OPENAI_VAD_THRESHOLD,
        noiseReduction: env.OPENAI_NOISE_REDUCTION,
      },
      'Sending GA session.update (g711_ulaw passthrough + server_vad + noise reduction)'
    );
    this.queueMessage(sessionConfig);
    this.flushQueue();
  }

  /**
   * Add an out-of-band context note to the conversation (e.g. "the caller is a
   * recognized client named Aryan"). Added AFTER the cached instruction prefix,
   * so it personalizes without busting prompt caching.
   */
  injectContext(text: string) {
    if (!this.isOpen()) return;
    this.sendRaw({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  /** Ask Erica to greet the caller first (one consistent voice, no Polly handoff). */
  requestGreeting() {
    if (!this.isOpen()) return;
    this.tGreetingRequested = Date.now();
    this.sendRaw({ type: 'response.create' });
  }

  /**
   * Log how long it took Erica to start speaking after the last turn trigger
   * (caller stopped talking, greeting requested, or a tool result returned).
   * This is the headline "does it feel human" number — target sub-1s.
   */
  private logFirstAudioLatency() {
    if (this.firstAudioLogged) return;
    this.firstAudioLogged = true;
    let ref = this.tSpeechStopped;
    let phase = 'caller-turn';
    if (this.tToolResultSent > ref) {
      ref = this.tToolResultSent;
      phase = 'after-tool';
    }
    if (this.tGreetingRequested > ref) {
      ref = this.tGreetingRequested;
      phase = 'greeting';
    }
    if (!ref) return;
    const responseMs = Date.now() - ref;
    const modelCreateMs =
      this.tResponseCreated > ref ? this.tResponseCreated - ref : undefined;
    logger.info(
      { phase, responseMs, modelCreateMs },
      `⏱  response latency ${responseMs}ms (${phase})`
    );
  }

  async sendUserText(text: string) {
    if (!this.isOpen()) {
      logger.warn('sendUserText skipped — session not open');
      return;
    }
    this.sendRaw({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.sendRaw({ type: 'response.create' });
  }

  /** Forward a Twilio mu-law frame straight to OpenAI — no transcoding. */
  appendTwilioAudio(base64Mulaw: string) {
    if (!this.isOpen()) return;
    this.sendRaw({ type: 'input_audio_buffer.append', audio: base64Mulaw });
  }

  /**
   * Barge-in: tell OpenAI the caller interrupted, truncating the in-flight
   * assistant message to only the audio that was actually heard. Pair this with
   * a Twilio `clear` (sent by the caller of this method) to flush buffered audio.
   */
  truncateActiveResponse(audioEndMs: number) {
    if (!this.isOpen() || !this.activeItemId) return;
    this.sendRaw({
      type: 'conversation.item.truncate',
      item_id: this.activeItemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
    });
    this.activeItemId = null;
  }

  private flushQueue() {
    if (!this.isOpen()) return;
    while (this.messagesQueue.length) {
      const message = this.messagesQueue.shift();
      if (!message) continue;
      this.ws!.send(JSON.stringify(message));
    }
  }

  private queueMessage(message: Record<string, unknown>) {
    if (this.isOpen()) {
      this.ws!.send(JSON.stringify(message));
    } else {
      this.messagesQueue.push(message);
    }
  }

  /** Send immediately, or silently drop if the socket is closed (never throws). */
  private sendRaw(message: Record<string, unknown>) {
    if (!this.isOpen()) return;
    this.ws!.send(JSON.stringify(message));
  }

  private async handleEvent(event: any): Promise<void> {
    const routineEvents = [
      'response.output_audio.delta',
      'response.audio.delta',
      'response.output_text.delta',
    ];
    if (!routineEvents.includes(event.type)) {
      logger.debug(
        { eventType: event.type, eventId: event.event_id },
        'OpenAI event received'
      );
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        logger.info(
          {
            eventType: event.type,
            voice: event.session?.audio?.output?.voice ?? event.session?.voice,
            outputModalities: event.session?.output_modalities,
            inputFormat: event.session?.audio?.input?.format,
            outputFormat: event.session?.audio?.output?.format,
          },
          'OpenAI session configured'
        );
        break;
      }
      case 'input_audio_buffer.speech_started': {
        logger.info(
          { eventType: event.type, itemId: event.item_id },
          'Speech started (VAD) — barge-in'
        );
        this.handlers.onSpeechStarted?.();
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        this.tSpeechStopped = Date.now();
        logger.info({ eventType: event.type }, 'Speech stopped (VAD)');
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        logger.info(
          { transcript: event.transcript },
          'USER SAID: ' + event.transcript
        );
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        // What Erica actually said — invaluable for spotting hallucinated/
        // misquoted details vs. what the tools returned.
        logger.info(
          { transcript: event.transcript },
          '🗣️  ERICA SAID: ' + (event.transcript ?? '')
        );
        break;
      }
      case 'response.created': {
        this.activeItemId = null;
        this.tResponseCreated = Date.now();
        this.firstAudioLogged = false;
        logger.info(
          { responseId: event.response?.id },
          'OpenAI response created'
        );
        break;
      }
      case 'response.output_text.delta': {
        if (this.handlers.onTextDelta)
          this.handlers.onTextDelta(event.delta as string);
        break;
      }
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        const delta = event.delta || event.audio;
        if (!delta) break;
        // First audio of this response = the moment Erica starts speaking.
        this.logFirstAudioLatency();
        // Track which assistant item is speaking so barge-in can truncate it.
        if (event.item_id) this.activeItemId = event.item_id as string;
        if (this.handlers.onAudioChunk) {
          this.handlers.onAudioChunk(
            delta as string,
            this.activeItemId ?? undefined
          );
        } else {
          logger.error('No onAudioChunk handler registered!');
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        this.handleToolDelta(event);
        break;
      }
      case 'response.function_call_arguments.done': {
        await this.handleToolCompleted(event);
        break;
      }
      case 'response.done':
      case 'response.completed': {
        this.activeItemId = null;
        // Surface token usage + cache hit rate so context/cost growth is visible.
        const usage = event.response?.usage;
        if (usage) {
          const cached = usage.input_token_details?.cached_tokens ?? 0;
          const input = usage.input_tokens ?? 0;
          logger.info(
            {
              inputTokens: input,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
              cachedTokens: cached,
              cacheHitPct: input ? Math.round((cached / input) * 100) : 0,
            },
            '📊 turn tokens'
          );
        } else {
          logger.info({ eventType: event.type }, 'OpenAI response completed');
        }
        if (this.handlers.onResponseComplete)
          this.handlers.onResponseComplete();
        break;
      }
      case 'error': {
        logger.error({ error: event.error }, 'OpenAI error event received');
        if (this.handlers.onError)
          this.handlers.onError(
            new Error(event.error?.message || 'OpenAI realtime error')
          );
        break;
      }
      case 'rate_limits.updated': {
        // Watch remaining tokens-per-minute — this is what hit 0 and froze a call.
        const tpm = event.rate_limits?.find((r: any) => r.name === 'tokens');
        if (tpm) {
          const level = tpm.remaining < 5000 ? logger.warn : logger.info;
          level.call(
            logger,
            {
              remaining: tpm.remaining,
              limit: tpm.limit,
              resetSeconds: tpm.reset_seconds,
            },
            `⚖️  TPM remaining ${tpm.remaining}/${tpm.limit}`
          );
        }
        break;
      }
      default:
        logger.debug({ eventType: event.type }, 'Unhandled OpenAI event');
        break;
    }
  }

  private handleToolDelta(event: any) {
    const callId = event.call_id as string;
    if (!callId) return;
    const record = this.toolBuffers.get(callId) ?? { name: '', args: '' };
    if (typeof event.name === 'string' && event.name.length)
      record.name = event.name;
    if (typeof event.delta === 'string') record.args += event.delta;
    this.toolBuffers.set(callId, record);
  }

  private async handleToolCompleted(event: any) {
    const callId = event.call_id as string;
    if (!callId) return;

    const name = event.name || this.toolBuffers.get(callId)?.name || '';
    const argsString =
      event.arguments || this.toolBuffers.get(callId)?.args || '';
    this.toolBuffers.delete(callId);

    logger.info({ tool: name, callId }, 'Tool call received');

    const handler = this.toolHandlers.get(name);
    if (!handler) {
      if (this.handlers.onError)
        this.handlers.onError(new Error(`Unhandled tool call: ${name}`));
      this.sendToolResult(callId, { error: `No handler for tool ${name}` });
      return;
    }

    let args: unknown = {};
    if (argsString) {
      try {
        args = JSON.parse(argsString);
      } catch (error) {
        if (this.handlers.onError && error instanceof Error)
          this.handlers.onError(error);
        this.sendToolResult(callId, {
          error: 'Failed to parse tool arguments',
        });
        return;
      }
    }

    const startedAt = Date.now();
    try {
      const result = await handler(args);
      logger.info(
        { tool: name, ms: Date.now() - startedAt },
        `⏱  tool ${name} ${Date.now() - startedAt}ms`
      );
      this.sendToolResult(callId, result ?? { ok: true });
    } catch (error) {
      logger.warn(
        { tool: name, ms: Date.now() - startedAt },
        `⏱  tool ${name} FAILED after ${Date.now() - startedAt}ms`
      );
      if (this.handlers.onError && error instanceof Error)
        this.handlers.onError(error);
      this.sendToolResult(callId, {
        error: error instanceof Error ? error.message : 'Tool execution failed',
      });
    }
  }

  private sendToolResult(callId: string, result: unknown) {
    // The session may have been closed by the tool itself (e.g. transfer_to_owner
    // redirecting the call). Dropping the result is correct here — never throw.
    if (!this.isOpen()) {
      logger.warn({ callId }, 'Tool result dropped — session already closed');
      return;
    }
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    this.sendRaw({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    // Mark the start of the post-tool turn so first-audio latency is attributed
    // to "after-tool" rather than the (older) caller-turn timestamp.
    this.tToolResultSent = Date.now();
    this.sendRaw({ type: 'response.create' });
  }

  private startKeepalive() {
    this.keepaliveInterval = setInterval(() => {
      if (this.isOpen()) this.ws!.ping();
    }, 30000);
  }

  private stopKeepalive() {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = undefined;
    }
  }
}
