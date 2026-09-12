# Live adapter handoff — 2026-09-12

## Public surface

- `OpenAILiveSession` in `src/voice/liveSession.ts` preserves the meaningful
  `OpenAIRealtimeSession` methods: `connect`, `configureSession`, `registerTool`,
  `injectContext`, `requestGreeting`, `requestResponse`,
  `appendTwilioAudio`, and `close`.
- `injectBackendContext` is the backend-only path for caller/account context.
  It never emits a Live frontend instruction append, keeps notes whole, and
  serializes full backend `session.update` payloads.
- Live-specific callbacks: `onOutputSpeechStarted`, `onOutputSpeechStopped`,
  `onInputTranscriptFragment`, `onOutputTranscriptFragment`, and `onLiveUsage`.
  Transcript fragments carry `{delta,startMs?,endMs?}` and are never asserted
  to be final turns.
- Realtime-only `truncateActiveResponse` and `setAutoResponses` are explicit
  logged no-ops. `getCurrentResponseId` always returns `null` because continuous
  Live audio has no corresponding response identity.

## Protocol and audio decisions

- First command is `session.start`; configuration waits up to 5 seconds for
  `session.started`. The payload explicitly sends `store:false`,
  `audio/pcmu`/8 kHz, Marin, and Responses delegation. Backend effort is omitted
  unless supplied.
- Backend updates always include `delegation.type:'responses'` plus the full
  model, instructions, tool list, and optional effort, and wait for
  `session.updated` with a bounded timeout.
- Nested `response.event` envelopes are dispatched by their inner event type.
  Function calls are collected from `response.output_item.done`, keyed by the
  outer delegation and nested response ID. Every result in one completed batch
  is submitted before exactly one bare `response.create` continuation.
- Backend usage is deduplicated by response ID and emitted only through
  `onLiveUsage`; legacy `onUsage` is not called, avoiding Realtime pricing.
  Voice-duration updates are treated as cumulative snapshots. A confirmed
  final value is emitted only from `session.closed`; transport-only close is
  labelled `finalConfirmed:false`.
- Live output is split into 160-byte/20 ms frames and paced. The queue is capped
  at 400 ms. Low-energy frames may be collapsed to catch up. Speech is never
  dropped: an all-speech overrun emits `onError` and closes visibly.
- Input and output energy gates report activity only. Input stop hangover is
  200 ms; output stop hangover is 600 ms so ordinary phrase pauses do not split
  greetings/farewells. Neither transition means a final turn or completed
  playback; the controller owns Twilio marks and drain. Output-start fires
  before its first speech frame, while output-stop fires after its quiet
  boundary frame, so a controller mark covers the complete acoustic segment.
- Greeting uses the verified pattern B (instruction append plus commentary),
  retries commentary once after 2.5 seconds without speech, and fails/closes at
  5 seconds. `requestResponse` uses a frontend commentary nudge for application
  check-ins/goodbyes; tool continuation remains a separate internal
  `response.create`.
- A delegation with no output audio for 5 seconds produces an attributable
  warning. Startup, update, tool-drain-on-close, and graceful close waits are
  all bounded.
- Cleanup before `session.started` closes the WebSocket locally and rejects an
  in-flight configuration waiter. It never sends `session.close` as an invalid
  first protocol command.
- Close is single-flight. If its bounded wait expires while a tool is still
  running, a late result is discarded after `session.close` rather than being
  written into a closing session.

## Controller integration review limits

- Live barge-in now preserves the continuous stream and only advances the
  interruption epoch. Focused controller tests keep Realtime truncate/clear
  behavior unchanged.
- Greeting completion is still acoustic. A speech segment plus Twilio drain
  does not prove that the required recording disclosure was spoken; pilot
  evidence must check the output transcript or recording.
- A model-requested goodbye requires a new post-tool speech segment. This
  prevents continuous silence from authorizing a hangup, but it can leave the
  call open if the farewell continues inside an already-active segment.
- Live transcript callbacks are fragments with approximate backend offsets.
  Raw fragment events are the audit evidence; merged transcript text is a
  convenience view and is not exact turn ordering.

## Files

- `src/voice/liveSession.ts`
- `src/voice/liveProtocol.ts`
- `src/voice/mulawAudio.ts`
- `src/tests/liveSession.test.ts`
- `src/tests/twilioStream.liveIntegration.test.ts`

## Verification

- `npx vitest run src/tests/liveSession.test.ts src/tests/twilioStream.liveIntegration.test.ts`:
  23/23 passed (19 adapter and 4 focused controller tests).
- `npm run build`: passed with the integrated worktree.
- `npm test`: 61 files and 655 tests passed.
- Parent-run first full-controller Terra probe reported success at
  `/tmp/erica-live-terra-first`: 36-second final usage, greeting at about 1.8 s
  with recording disclosure, two backend responses with usage/cache data, and
  no speech-overrun failure. This worker did not run a billed probe.

## Limitations

- Energy boundaries are deliberately acoustic segments, not semantic turn or
  playback completion evidence.
- Exact caller-message capture from Live fragments remains deferred; legacy
  final-turn transcript callbacks are intentionally not invoked with fragments.
- The 400 ms queue bound is conservative. Parent comparison probes should keep
  the overrun metric visible; increase only with observed server burst evidence.
- The adapter closes on greeting failure rather than switching engines mid-call.
- No billed probe, call, deployment, message, Phorest write, or production
  configuration change was performed by this worker.
