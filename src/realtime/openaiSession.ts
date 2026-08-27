import WebSocket from 'ws';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

type Logger = typeof logger;

// NOTE: Audio is now passed through end-to-end as G.711 mu-law (audio/pcmu),
// the exact format Twilio Media Streams use. No mu-law<->PCM transcoding or
// 8k<->24k resampling happens anymore — Twilio's base64 frames are forwarded
// verbatim to OpenAI and OpenAI's audio deltas are forwarded verbatim back.

/** M1: per-turn token usage, exactly what the existing 📊 turn tokens log carries. */
export type RealtimeUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  // ANALYTICS AUDIT FIX (2026-08-22, P1): the text/audio MODALITY split, read
  // defensively off response.usage.{input,output}_token_details — most
  // re-billed context is TEXT (priced far below audio), so an all-audio
  // cost estimate overstates spend. Undefined when the API response didn't
  // include the split (older responses, or a field OpenAI hasn't shipped
  // yet) — twilioStream.ts's estimateCostUsd falls back to the all-audio
  // formula in that case, never NaN.
  inputTextTokens?: number;
  inputAudioTokens?: number;
  outputTextTokens?: number;
  outputAudioTokens?: number;
  // Sub-split of the cached portion of inputTextTokens/inputAudioTokens
  // (input_token_details.cached_tokens_details.{text,audio}_tokens) — even
  // more defensive, this nested field may not exist even when the top-level
  // split does.
  cachedTextTokens?: number;
  cachedAudioTokens?: number;
};

export type RealtimeHandlers = {
  /** base64 G.711 mu-law audio from OpenAI, ready to send straight to Twilio. */
  onAudioChunk?: (base64MuLaw: string, itemId?: string) => void;
  onTextDelta?: (delta: string) => void;
  onResponseComplete?: () => void;
  /** Fired when OpenAI VAD detects the caller started talking (barge-in trigger). */
  onSpeechStarted?: () => void;
  /**
   * Fired when OpenAI VAD detects the caller's turn ENDED (they paused long
   * enough for server_vad to close the turn). Pairs with onSpeechStarted so a
   * listener can tell "caller is mid-sentence" from "caller has stopped" — the
   * silence watchdog needs that distinction (2026-08-24 Holly bug: a 21s
   * unbroken monologue never emits speech_stopped, and was being counted as
   * 21s of silence).
   */
  onSpeechStopped?: () => void;
  onError?: (error: Error) => void;
  /**
   * Fired when the OpenAI WebSocket closes for a reason OTHER than our own
   * close() — i.e. an unexpected drop. Lets the caller tear down the Twilio leg
   * instead of leaving a zombie call live in silence. Never fires on close().
   */
  onClose?: () => void;
  /**
   * M1: the caller's final transcribed turn (conversation.item.input_audio_
   * transcription.completed). Only ever fires when input transcription is
   * enabled (env.OPENAI_INPUT_TRANSCRIPTION !== 'off', default OFF) — with it
   * off this event never arrives, so this handler simply never fires.
   */
  onUserTranscript?: (text: string) => void;
  /** M1: Erica's final transcribed turn (response.(output_)audio_transcript.done). */
  onAssistantTranscript?: (text: string) => void;
  /** M1: per-turn token usage, fired alongside the existing 📊 turn tokens log. */
  onUsage?: (usage: RealtimeUsage) => void;
};

/** Constructor options: handlers plus an optional per-call log tag (RT-9). */
export type SessionOptions = RealtimeHandlers & {
  /**
   * Short identifier (e.g. last 8 of the streamSid) mixed into every log line so
   * concurrent calls are attributable. Undefined = current, untagged behavior.
   */
  callTag?: string;
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
  /** Per-session logger — a child logger when a callTag is supplied (RT-9). */
  private readonly log: Logger;
  private isConnected = false;
  private closing = false;
  /** Guards onClose so an unexpected drop fires the handler at most once (RT-1). */
  private closeNotified = false;
  // --- RT-2: response-collision guard ---------------------------------------
  /** True between response.created and response.done/error/cancelled. */
  private activeResponse = false;
  /** Set when a tool result arrived mid-response; drains on response.done. */
  private pendingResponseCreate = false;
  // --- RT-3: application-error circuit breaker ------------------------------
  /** True from configureSession() until session.created/updated (or a reject). */
  private awaitingSessionAck = false;
  /** Timestamps (ms) of recent benign "error" events for the 3-in-10s breaker. */
  private recentErrorTimes: number[] = [];
  private breakerTripped = false;
  // --- RT-5: failed-response retry ------------------------------------------
  /** Latest reset window (ms) from rate_limits.updated; used to space a retry. */
  private lastResetMs: number | undefined = undefined;
  private failedRetryTimer: NodeJS.Timeout | undefined = undefined;
  // --- B3: bound RT-5 retry churn under TPM starvation -----------------------
  /** Consecutive failed-response streak; retries stop once this exceeds 2. */
  private consecutiveResponseFailures = 0;
  // --- RT-7: stray-delta gating ---------------------------------------------
  /** id of the response currently being generated (from response.created). */
  private currentResponseId: string | null = null;
  /** response_id we truncated/cancelled; its later audio deltas are dropped. */
  private cancelledResponseId: string | null = null;
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

  constructor(options: SessionOptions = {}) {
    const { callTag, ...handlers } = options;
    this.handlers = handlers;
    this.log = callTag ? logger.child({ call: callTag }) : logger;
    this.model = env.OPENAI_REALTIME_MODEL;
    this.voice = env.OPENAI_REALTIME_VOICE;
    if (!env.OPENAI_REALTIME_API_KEY) {
      throw new Error('OPENAI_REALTIME_API_KEY not configured');
    }
  }

  async connect(): Promise<void> {
    if (this.ws && this.isConnected) {
      this.log.debug('Already connected to OpenAI, skipping reconnect');
      return;
    }

    if (this.ws) {
      this.log.warn(
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
        this.log.info(
          { model: this.model },
          'OpenAI WebSocket connection established'
        );
        resolve();
      });
      ws.once('error', (err: Error) => {
        this.log.error({ err }, 'OpenAI WebSocket connection failed');
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
      this.clearFailedRetry();
      this.isConnected = false;
      // Never let a stale pending response.create leak into a future socket.
      this.pendingResponseCreate = false;
      this.activeResponse = false;
      const reasonText = reason.toString();
      this.log.error(
        {
          code,
          reason: reasonText,
          codeDescription: this.getCloseCodeDescription(code),
        },
        `OpenAI WebSocket CLOSED - Code: ${code}, Reason: ${reasonText || 'none'}`
      );

      if (code === 1008 || (code >= 4000 && code < 5000)) {
        this.log.error(
          'This looks like an authentication error! Check your OPENAI_REALTIME_API_KEY'
        );
      }

      // RT-1: an unexpected close (NOT our own close()) leaves the Twilio leg
      // live in silence forever. Signal the caller to tear it down — exactly
      // once, and never for a deliberate shutdown.
      if (!this.closing && !this.closeNotified) {
        this.closeNotified = true;
        this.handlers.onClose?.();
      }
    });

    ws.on('error', (error: Error) => {
      this.log.error(
        { err: error, message: error.message },
        'OpenAI WebSocket error occurred'
      );
      if (this.handlers.onError) this.handlers.onError(error);
    });
  }

  close() {
    this.closing = true;
    this.stopKeepalive();
    this.clearFailedRetry();
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

    // M1: caller-side transcription, GA nested field `audio.input.transcription`.
    // ⚠️ ENV-GATED OFF BY DEFAULT (lessons.md: a bad/rejected session.update
    // field kills every call at pickup). When env.OPENAI_INPUT_TRANSCRIPTION
    // is 'off', inputTranscription is undefined and the spread below adds NO
    // key at all — the audio.input object, and therefore this whole payload,
    // stays byte-identical to before this field existed (proven by a snapshot
    // test in openaiSession.test.ts). Only flip the env var after a live call
    // confirms the session accepts the new field.
    const inputTranscription =
      env.OPENAI_INPUT_TRANSCRIPTION === 'off'
        ? undefined
        : { model: env.OPENAI_INPUT_TRANSCRIPTION };

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
            ...(inputTranscription
              ? { transcription: inputTranscription }
              : {}),
            turn_detection: {
              type: 'server_vad',
              threshold: env.OPENAI_VAD_THRESHOLD,
              prefix_padding_ms: env.OPENAI_VAD_PREFIX_MS,
              silence_duration_ms: env.OPENAI_VAD_SILENCE_MS,
              // Greeting protection (2026-08-26, both fields validated live):
              // while the greeting plays, a caller's "hello" must neither
              // CANCEL its generation (interrupt_response) nor SPAWN a
              // queued reply that re-opens after it ("Hi there, what do you
              // need?" right after the greeting already asked — observed).
              // Both start OFF; twilioStream re-enables them the moment the
              // greeting has played out (setAutoResponses) and manually
              // triggers ONE response if the caller said something
              // substantive during it. Every later turn depends on that
              // re-enable — it is load-bearing.
              interrupt_response: false,
              create_response: false,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: this.voice,
          },
        },
      },
    };

    this.log.info(
      {
        model: this.model,
        voice: this.voice,
        vadThreshold: env.OPENAI_VAD_THRESHOLD,
        noiseReduction: env.OPENAI_NOISE_REDUCTION,
      },
      'Sending GA session.update (g711_ulaw passthrough + server_vad + noise reduction)'
    );
    // RT-3: a rejected session.update is fatal (instant hangup). Arm the "still
    // awaiting ack" window so an error before session.created/updated escalates,
    // while application errors after the session is live are softened.
    this.awaitingSessionAck = true;
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
   * G2: create a response only when it's safe to — no response already in
   * flight. Unlike requestGreeting() (bare, unguarded, call-once-at-start),
   * this is meant for out-of-band triggers later in the call (e.g. the
   * silence watchdog's check-in) where a collision with an in-flight response
   * is the RT-2/RT-3 call-killer. Mirrors the guard already inside
   * scheduleFailedRetry.
   */
  requestResponse(): boolean {
    // AUDIT FIX (2026-08-22): report whether the response.create actually
    // fired, so callers (duration-cap goodbye) can retry instead of hanging
    // up after a goodbye that was silently dropped mid-conversation.
    if (!this.isOpen() || this.activeResponse) return false;
    this.sendRaw({ type: 'response.create' });
    return true;
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
    this.log.info(
      { phase, responseMs, modelCreateMs },
      `⏱  response latency ${responseMs}ms (${phase})`
    );
  }

  // F10k: sendUserText was removed — it had no call site in the live path
  // (audio is the only caller input) and was an extra response.create surface.

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
  /**
   * Toggle OpenAI's automatic response handling on caller speech: both the
   * auto-cancel of an in-progress response (interrupt_response) and the
   * auto-created reply to a committed caller turn (create_response). Off
   * during the greeting; on for the rest of the call. Sent as a partial
   * session.update carrying the FULL turn_detection object (nested objects
   * replace, not merge — validated live 2026-08-26, both directions echoed).
   * Fire-and-forget: an occasional drop just leaves the current state.
   */
  setAutoResponses(enabled: boolean) {
    this.sendRaw({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            turn_detection: {
              type: 'server_vad',
              threshold: env.OPENAI_VAD_THRESHOLD,
              prefix_padding_ms: env.OPENAI_VAD_PREFIX_MS,
              silence_duration_ms: env.OPENAI_VAD_SILENCE_MS,
              interrupt_response: enabled,
              create_response: enabled,
            },
          },
        },
      },
    });
  }

  truncateActiveResponse(audioEndMs: number) {
    if (!this.isOpen() || !this.activeItemId) return;
    this.sendRaw({
      type: 'conversation.item.truncate',
      item_id: this.activeItemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
    });
    this.activeItemId = null;
    // RT-7: the response we just truncated may still emit a few buffered audio
    // deltas. Remember its id so we drop them (no onAudioChunk, no re-arm) until
    // the next response.created clears the guard.
    if (this.currentResponseId) {
      this.cancelledResponseId = this.currentResponseId;
    }
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
      this.log.debug(
        { eventType: event.type, eventId: event.event_id },
        'OpenAI event received'
      );
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        // RT-3: the session is acknowledged — later application errors are now
        // safe to soften (only a rejected session.update before this is fatal).
        this.awaitingSessionAck = false;
        this.log.info(
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
        this.log.info(
          { eventType: event.type, itemId: event.item_id },
          'Speech started (VAD) — barge-in'
        );
        // B2: new caller speech makes any pending RT-5 failed-response retry
        // stale — without this, a bare `response.create` could fire up to 10s
        // later and resume an OLD task (with tool access) against whatever the
        // caller has said since. server_vad already creates a fresh response
        // for this new turn, so dropping the stale retry is safe.
        this.clearFailedRetry();
        // B3: a new caller turn is a fresh attempt, so it gets a fresh retry
        // budget. Required (not just "reset on success"): under sustained TPM
        // starvation responses may keep failing, so success alone might never
        // fire, permanently disarming retries for the rest of the call.
        this.consecutiveResponseFailures = 0;
        this.handlers.onSpeechStarted?.();
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        this.tSpeechStopped = Date.now();
        this.log.info({ eventType: event.type }, 'Speech stopped (VAD)');
        this.handlers.onSpeechStopped?.();
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.log.info(
          { transcript: event.transcript },
          'USER SAID: ' + event.transcript
        );
        // M1: only ever fires when input transcription is enabled — see
        // configureSession's env-gated `transcription` field, default OFF.
        if (typeof event.transcript === 'string') {
          this.handlers.onUserTranscript?.(event.transcript);
        }
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        // What Erica actually said — invaluable for spotting hallucinated/
        // misquoted details vs. what the tools returned.
        this.log.info(
          { transcript: event.transcript },
          '🗣️  ERICA SAID: ' + (event.transcript ?? '')
        );
        // M1: the final-per-turn transcript, for the both-side call log.
        this.handlers.onAssistantTranscript?.(
          (event.transcript ?? '') as string
        );
        break;
      }
      case 'response.created': {
        this.activeItemId = null;
        this.tResponseCreated = Date.now();
        this.firstAudioLogged = false;
        // RT-2: a response is now in flight — a tool result must defer its
        // response.create until this one finishes.
        this.activeResponse = true;
        // RT-7: a fresh response clears the post-barge-in stray-delta guard.
        this.currentResponseId = (event.response?.id as string) ?? null;
        this.cancelledResponseId = null;
        this.log.info(
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
        // RT-7: after a barge-in truncate/cancel, drop the trailing buffered
        // deltas of the cancelled response — don't play them or re-arm the item.
        if (
          this.cancelledResponseId &&
          event.response_id === this.cancelledResponseId
        ) {
          break;
        }
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
          this.log.error('No onAudioChunk handler registered!');
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
        // RT-2: this response is finished — the next response.create is now legal.
        this.activeResponse = false;
        // Surface token usage + cache hit rate so context/cost growth is visible.
        const usage = event.response?.usage;
        if (usage) {
          const cached = usage.input_token_details?.cached_tokens ?? 0;
          const input = usage.input_tokens ?? 0;
          this.log.info(
            {
              inputTokens: input,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
              cachedTokens: cached,
              cacheHitPct: input ? Math.round((cached / input) * 100) : 0,
            },
            '📊 turn tokens'
          );
          // ANALYTICS AUDIT FIX (2026-08-22, P1): read the text/audio
          // modality split defensively — these nested fields may be absent
          // (older/partial API responses), so every read is `?.` and every
          // pass-through is conditional (an absent field must stay absent
          // on RealtimeUsage, never coerced to 0 — twilioStream.ts's
          // estimateCostUsd uses presence, not value, to decide whether the
          // split is usable).
          const inputTextTokens = usage.input_token_details?.text_tokens as
            | number
            | undefined;
          const inputAudioTokens = usage.input_token_details?.audio_tokens as
            | number
            | undefined;
          const outputTextTokens = usage.output_token_details?.text_tokens as
            | number
            | undefined;
          const outputAudioTokens = usage.output_token_details?.audio_tokens as
            | number
            | undefined;
          const cachedTextTokens = usage.input_token_details
            ?.cached_tokens_details?.text_tokens as number | undefined;
          const cachedAudioTokens = usage.input_token_details
            ?.cached_tokens_details?.audio_tokens as number | undefined;

          // M1: same numbers as the log line above, for cost/dashboard persistence.
          this.handlers.onUsage?.({
            inputTokens: input,
            outputTokens: usage.output_tokens ?? 0,
            cachedTokens: cached,
            totalTokens: usage.total_tokens ?? 0,
            ...(inputTextTokens !== undefined ? { inputTextTokens } : {}),
            ...(inputAudioTokens !== undefined ? { inputAudioTokens } : {}),
            ...(outputTextTokens !== undefined ? { outputTextTokens } : {}),
            ...(outputAudioTokens !== undefined ? { outputAudioTokens } : {}),
            ...(cachedTextTokens !== undefined ? { cachedTextTokens } : {}),
            ...(cachedAudioTokens !== undefined ? { cachedAudioTokens } : {}),
          });
        } else {
          this.log.info({ eventType: event.type }, 'OpenAI response completed');
        }

        const status = event.response?.status as string | undefined;
        // RT-5: a failed response leaves the caller in dead air. Retry once
        // (spaced by the last known rate-limit reset window) instead of hanging.
        // 'cancelled' is a normal barge-in — ignore it.
        if (status === 'failed') {
          this.consecutiveResponseFailures++;
          // B3: under TPM starvation, failed→retry→failed can loop and burn
          // the very token budget the call is starved of. Cap consecutive
          // retries at 2 — beyond that, stop scheduling and let the next
          // caller-speech turn drive a fresh response instead.
          if (this.consecutiveResponseFailures > 2) {
            this.log.warn(
              { consecutiveFailures: this.consecutiveResponseFailures },
              '⚖️  retry budget exhausted — no more RT-5 retries this streak'
            );
          } else {
            this.log.warn(
              { status, response: event.response?.status_details },
              'OpenAI response FAILED — scheduling one retry'
            );
            this.scheduleFailedRetry();
          }
        } else {
          // B3: any non-failed completion (success, or a barge-in cancel)
          // clears the failure streak — a fresh attempt earns a fresh budget.
          this.consecutiveResponseFailures = 0;
        }

        // RT-2: if a tool result arrived while this response was active, its
        // response.create was deferred — send it now (exactly once).
        if (this.pendingResponseCreate) {
          this.pendingResponseCreate = false;
          if (this.isOpen() && !this.activeResponse) {
            this.tToolResultSent = Date.now();
            this.sendRaw({ type: 'response.create' });
          }
        }

        if (this.handlers.onResponseComplete)
          this.handlers.onResponseComplete();
        break;
      }
      case 'error': {
        this.handleErrorEvent(event);
        break;
      }
      case 'rate_limits.updated': {
        // Watch remaining tokens-per-minute — this is what hit 0 and froze a call.
        const tpm = event.rate_limits?.find((r: any) => r.name === 'tokens');
        if (tpm) {
          // RT-5: remember the reset window so a failed-response retry waits for
          // the tokens/min bucket to refill instead of failing again immediately.
          if (typeof tpm.reset_seconds === 'number') {
            this.lastResetMs = Math.round(tpm.reset_seconds * 1000);
          }
          const level = tpm.remaining < 5000 ? this.log.warn : this.log.info;
          level.call(
            this.log,
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
        this.log.debug({ eventType: event.type }, 'Unhandled OpenAI event');
        break;
    }
  }

  /**
   * RT-3: classify an application-level `error` event STRUCTURALLY (never by
   * matching provider error-code strings — we have been burned guessing them).
   *
   * Default = log and continue (do NOT tear the call down). Escalate to
   * `handlers.onError` only when the error is genuinely fatal or the connection
   * is clearly unhealthy:
   *   (a) it arrived before the session.update was acknowledged — a rejected
   *       session config is fatal (instant hangup), OR
   *   (b) a simple circuit breaker trips: >=3 error events within 10s.
   * Connection-level failures escalate separately via ws 'error'/'close'.
   */
  private handleErrorEvent(event: any): void {
    this.log.error({ error: event.error }, 'OpenAI error event received');

    // (a) A rejected session.update is fatal — preserve instant-hangup detection.
    if (this.awaitingSessionAck) {
      this.log.error('Error while awaiting session ack — treating as fatal');
      this.escalate(event);
      return;
    }

    // (b) Circuit breaker: 3+ errors in a 10s sliding window → escalate once.
    const now = Date.now();
    this.recentErrorTimes = this.recentErrorTimes.filter(
      (t) => now - t < 10_000
    );
    this.recentErrorTimes.push(now);
    if (this.recentErrorTimes.length >= 3 && !this.breakerTripped) {
      this.breakerTripped = true;
      this.log.error(
        { count: this.recentErrorTimes.length },
        'Error circuit breaker tripped (>=3 in 10s) — escalating'
      );
      this.escalate(event);
      return;
    }

    // Otherwise: recoverable glitch (e.g. active-response collision, truncate
    // range). Log and keep the call alive. An error terminates the in-flight
    // response, so clear activeResponse to honor the "true between
    // response.created and response.done/error/cancelled" invariant — otherwise
    // a standalone error (no following response.done) could leave a deferred
    // response.create undrained until the caller's next utterance.
    this.activeResponse = false;
    this.log.warn('OpenAI error softened (non-fatal) — call continues');
  }

  private escalate(event: any): void {
    if (this.handlers.onError) {
      this.handlers.onError(
        new Error(event.error?.message || 'OpenAI realtime error')
      );
    }
  }

  /**
   * RT-5: schedule exactly one retry response.create after a short delay (capped
   * ~10s). Uses the last observed rate-limit reset window when known, else ~2s.
   * Only fires if the session is still open and no response is active. Any
   * previously-scheduled retry is superseded (never stacks).
   */
  private scheduleFailedRetry(): void {
    this.clearFailedRetry();
    const delay = Math.min(this.lastResetMs ?? 2000, 10_000);
    this.failedRetryTimer = setTimeout(() => {
      this.failedRetryTimer = undefined;
      if (this.isOpen() && !this.activeResponse) {
        this.log.info({ delay }, 'RT-5: retrying failed response');
        this.sendRaw({ type: 'response.create' });
      }
    }, delay);
  }

  private clearFailedRetry(): void {
    if (this.failedRetryTimer) {
      clearTimeout(this.failedRetryTimer);
      this.failedRetryTimer = undefined;
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

    this.log.info({ tool: name, callId }, 'Tool call received');

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
      this.log.info(
        { tool: name, ms: Date.now() - startedAt },
        `⏱  tool ${name} ${Date.now() - startedAt}ms`
      );
      this.sendToolResult(callId, result ?? { ok: true });
    } catch (error) {
      this.log.warn(
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
      this.log.warn({ callId }, 'Tool result dropped — session already closed');
      return;
    }
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    // Always deliver the function output — the model needs it regardless.
    this.sendRaw({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    // Mark the start of the post-tool turn so first-audio latency is attributed
    // to "after-tool" rather than the (older) caller-turn timestamp.
    this.tToolResultSent = Date.now();
    // RT-2: if a response is still active (e.g. VAD auto-created one when the
    // caller interrupted during the tool), a second response.create collides and
    // drops the call. Defer it — response.done will drain exactly one instead.
    if (this.activeResponse) {
      this.pendingResponseCreate = true;
      this.log.debug(
        { callId },
        'Tool result delivered mid-response — deferring response.create (RT-2)'
      );
      return;
    }
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
