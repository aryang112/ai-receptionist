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
  private readonly toolBuffers = new Map<string, { name: string; args: string }>();
  private configuredTools: ToolDefinition[] = [];
  private keepaliveInterval: NodeJS.Timeout | undefined = undefined;
  /** item_id of the assistant message currently being spoken — used for barge-in truncation. */
  private activeItemId: string | null = null;

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
      logger.warn('WebSocket exists but not connected - cleaning up before reconnect');
      this.ws.removeAllListeners();
      this.ws.close();
    }

    // GA Realtime endpoint. The legacy `OpenAI-Beta: realtime=v1` header and the
    // beta wire schema were shut off in May 2026 — GA needs only the bearer token.
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${env.OPENAI_REALTIME_API_KEY}`
      }
    });

    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        this.isConnected = true;
        this.flushQueue();
        this.startKeepalive();
        logger.info({ model: this.model }, 'OpenAI WebSocket connection established');
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
        if (this.handlers.onError && error instanceof Error) this.handlers.onError(error);
        return;
      }
      // Never let a thrown handler become an unhandled rejection — that would
      // crash the whole process (and every concurrent call) the way a transfer
      // mid-call used to. Swallow into onError instead.
      void this.handleEvent(message).catch((error: unknown) => {
        if (this.handlers.onError) {
          this.handlers.onError(error instanceof Error ? error : new Error('OpenAI event handler failed'));
        }
      });
    });

    ws.on('close', (code, reason) => {
      this.stopKeepalive();
      this.isConnected = false;
      const reasonText = reason.toString();
      logger.error({
        code,
        reason: reasonText,
        codeDescription: this.getCloseCodeDescription(code)
      }, `OpenAI WebSocket CLOSED - Code: ${code}, Reason: ${reasonText || 'none'}`);

      if (code === 1008 || (code >= 4000 && code < 5000)) {
        logger.error('This looks like an authentication error! Check your OPENAI_REALTIME_API_KEY');
      }
    });

    ws.on('error', (error: Error) => {
      logger.error({ err: error, message: error.message }, 'OpenAI WebSocket error occurred');
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
    return !this.closing && !!this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN;
  }

  private getCloseCodeDescription(code: number): string {
    const descriptions: Record<number, string> = {
      1000: 'Normal closure',
      1001: 'Going away',
      1005: 'No status received',
      1006: 'Abnormal closure (connection lost)',
      1008: 'Policy violation (likely auth failure)',
      1011: 'Internal server error',
      1015: 'TLS handshake failure'
    };
    return descriptions[code] || `Unknown code ${code}`;
  }

  registerTool(name: string, handler: ToolHandler) {
    this.toolHandlers.set(name, handler);
  }

  async configureSession({ instructions, tools }: { instructions?: string; tools?: ToolDefinition[] }) {
    if (tools) {
      this.configuredTools = tools;
    }

    // GA session schema: audio config is nested under session.audio.input/output,
    // formats are typed objects ({type:'audio/pcmu'}), and output modality lives
    // in output_modalities. server_vad turn_detection sits under audio.input.
    const sessionConfig = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this.model,
        output_modalities: ['audio'],
        instructions,
        tools: this.configuredTools,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 400
            }
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: this.voice
          }
        }
      }
    };

    logger.info({ model: this.model, voice: this.voice }, 'Sending GA session.update (g711_ulaw passthrough + server_vad)');
    this.queueMessage(sessionConfig);
    this.flushQueue();
  }

  /** Ask Erica to greet the caller first (one consistent voice, no Polly handoff). */
  requestGreeting() {
    if (!this.isOpen()) return;
    this.sendRaw({ type: 'response.create' });
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
        content: [{ type: 'input_text', text }]
      }
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
      audio_end_ms: Math.max(0, Math.floor(audioEndMs))
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
    const routineEvents = ['response.output_audio.delta', 'response.audio.delta', 'response.output_text.delta'];
    if (!routineEvents.includes(event.type)) {
      logger.debug({ eventType: event.type, eventId: event.event_id }, 'OpenAI event received');
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        logger.info({
          eventType: event.type,
          voice: event.session?.audio?.output?.voice ?? event.session?.voice,
          outputModalities: event.session?.output_modalities,
          inputFormat: event.session?.audio?.input?.format,
          outputFormat: event.session?.audio?.output?.format
        }, 'OpenAI session configured');
        break;
      }
      case 'input_audio_buffer.speech_started': {
        logger.info({ eventType: event.type, itemId: event.item_id }, 'Speech started (VAD) — barge-in');
        this.handlers.onSpeechStarted?.();
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        logger.info({ eventType: event.type }, 'Speech stopped (VAD)');
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        logger.info({ transcript: event.transcript }, 'USER SAID: ' + event.transcript);
        break;
      }
      case 'response.created': {
        this.activeItemId = null;
        logger.info({ responseId: event.response?.id }, 'OpenAI response created');
        break;
      }
      case 'response.output_text.delta': {
        if (this.handlers.onTextDelta) this.handlers.onTextDelta(event.delta as string);
        break;
      }
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        const delta = event.delta || event.audio;
        if (!delta) break;
        // Track which assistant item is speaking so barge-in can truncate it.
        if (event.item_id) this.activeItemId = event.item_id as string;
        if (this.handlers.onAudioChunk) {
          this.handlers.onAudioChunk(delta as string, this.activeItemId ?? undefined);
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
        logger.info({ eventType: event.type }, 'OpenAI response completed');
        if (this.handlers.onResponseComplete) this.handlers.onResponseComplete();
        break;
      }
      case 'error': {
        logger.error({ error: event.error }, 'OpenAI error event received');
        if (this.handlers.onError) this.handlers.onError(new Error(event.error?.message || 'OpenAI realtime error'));
        break;
      }
      case 'rate_limits.updated': {
        logger.debug({ rateLimits: event.rate_limits }, 'Rate limits updated');
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
    if (typeof event.name === 'string' && event.name.length) record.name = event.name;
    if (typeof event.delta === 'string') record.args += event.delta;
    this.toolBuffers.set(callId, record);
  }

  private async handleToolCompleted(event: any) {
    const callId = event.call_id as string;
    if (!callId) return;

    const name = event.name || this.toolBuffers.get(callId)?.name || '';
    const argsString = event.arguments || this.toolBuffers.get(callId)?.args || '';
    this.toolBuffers.delete(callId);

    logger.info({ tool: name, callId }, 'Tool call received');

    const handler = this.toolHandlers.get(name);
    if (!handler) {
      if (this.handlers.onError) this.handlers.onError(new Error(`Unhandled tool call: ${name}`));
      this.sendToolResult(callId, { error: `No handler for tool ${name}` });
      return;
    }

    let args: unknown = {};
    if (argsString) {
      try {
        args = JSON.parse(argsString);
      } catch (error) {
        if (this.handlers.onError && error instanceof Error) this.handlers.onError(error);
        this.sendToolResult(callId, { error: 'Failed to parse tool arguments' });
        return;
      }
    }

    try {
      const result = await handler(args);
      this.sendToolResult(callId, result ?? { ok: true });
    } catch (error) {
      if (this.handlers.onError && error instanceof Error) this.handlers.onError(error);
      this.sendToolResult(callId, {
        error: error instanceof Error ? error.message : 'Tool execution failed'
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
      item: { type: 'function_call_output', call_id: callId, output }
    });
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
