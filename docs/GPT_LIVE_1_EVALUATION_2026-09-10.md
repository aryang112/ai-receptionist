# GPT-Live-1 evaluation and integration proposal

September 12 follow-up: [system design and weekend plan](GPT_LIVE_SYSTEM_DESIGN_2026-09-12.md)
rechecks current docs and production source. In particular, storage currently
defaults to **false**; playback marks remain useful; energy/transcript intervals
are not authoritative completed turns; dynamic tool lists do not replace action
authorization. The historical measurements below were not repeated in that review.

Date: 2026-09-10 (GPT-Live-1 reached the API today). Author: Jarvis.
Status: **Proposed** — nothing in production changed. Every "Verified" row below
was reproduced against the live API with our own key using
`scripts/gpt-live/*.mjs` (each run is a few cents of billed session time).

## TL;DR

- GPT-Live-1 is **not a model swap for `gpt-realtime-2.1`**. It is a new
  endpoint (`wss://api.openai.com/v1/live/sessions`), a new event protocol,
  a new prompt architecture (short "live" prompt + separate backend model that
  owns rules and tools), and a per-minute price. Our `openaiSession.ts` and
  large parts of `twilioStream.ts` state handling do not carry over.
- Our key already has access. Erica's exact telephony shape (mu-law 8 kHz
  passthrough, voice Marin, our tool schema via Responses delegation) is
  accepted and works end to end: greeting, caller question, delegation, tool
  call, spoken answer.
- Expected wins for a phone receptionist: full-duplex turn taking (no VAD
  tuning, no greeting-race hacks, no `wait_for_user` tool), native caller
  transcripts with timing, ~50% lower voice cost, no per-turn context
  re-billing (the old TPM freeze class disappears).
- Expected costs: ~1 s slower tool-result answers than today, no
  noise-reduction/VAD knobs at all, launch-day docs with real inconsistencies,
  and a full rewrite of the prompt test suite.
- Recommendation: build it as a **parallel engine behind an env switch**
  (`VOICE_ENGINE=realtime|live`), keep Realtime 2.1 as the production path and
  rollback, and decide on cutover only after after-hours test calls on the
  real Twilio number. `gpt-realtime-2.1` has no deprecation date, so there is
  no clock forcing this; the clock that does exist is our input-transcription
  model (`gpt-4o-mini-transcribe` shuts down 2027-02-26), which Live makes moot.

## What shipped

| Fact | Detail | Source |
| --- | --- | --- |
| Model | `gpt-live-1`, full-duplex speech-to-speech; listens while speaking; delegates reasoning/tools to a backend | model page, announcement |
| Endpoint | Only `v1/live/sessions` (WebSocket, WebRTC, SIP). Not Realtime, Responses, or Chat | model page |
| Price | $0.05 per minute of session time, billed per second; backend model and tools billed separately. WebRTC session creation bills 15 s; WebSocket does not | pricing, latency/cost guide |
| Delegation modes | `responses` (OpenAI runs your configured Responses model + tools) or `client` (you run any backend; you get a delegation id and must answer from transcripts). Mode is fixed for the life of the session | delegation guide |
| Backend models | Docs default `gpt-5.6-terra` ($2 / $12 per 1M), cost option `gpt-5.6-luna` ($0.20 / $1.20). `gpt-6-astra` ($10 / $50) for hard reasoning | pricing, delegation guide |
| Voices | 12 new voices plus `marin` (still the documented default) and `cedar`; both accepted by the API today | conversations guide, Verified |
| Context | 128k-token window; at 90% the service swaps in a fresh engine with instructions + last 8,192 tokens; instructions ≤ 16,384 tokens; `input` history ≤ 128 messages / 8,192 tokens | conversations guide |
| Session cap | `expires_at` = 120 minutes after start | Verified |
| Benchmarks (OpenAI) | Full-Duplex Bench 80.1% vs 45.4% for gpt-realtime-2.1; turn-taking 0.80 s vs 1.41 s; tool-calling accuracy 87% vs 60%; Tau3 #1 with GPT-6 Astra | announcement coverage |
| Named users | Yelp Host (restaurant reservations by phone), Speak (≈80% fewer interruptions of learners), a healthcare customer that deleted ~23k lines of cascaded pipeline | Register, AlphaSignal |
| Realtime status | Not deprecated. `gpt-realtime`/`gpt-4o-realtime` retire 2027-01-20 with `gpt-realtime-2.1` as replacement; 2.1 has no sunset. OpenAI positions Realtime as "speech, reasoning and tools in one session" and Live as "full-duplex with a separate backend" | deprecations page, voice-agents guide |
| Transcription | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (our production input transcription) shut down 2027-02-26; replacements `gpt-live-transcribe` / `gpt-transcribe` | deprecations page |

## What we verified against the live API today

Shape = `{model:'gpt-live-1', instructions, audio:{format:{type:'audio/pcmu',rate:8000}, output:{voice:'marin'}}, delegation:{type:'responses', responses:{model, instructions, tools:[our function schema], tool_choice:'auto'}}}`.

| Probe | Result |
| --- | --- |
| Access with our key | Accepted; `session.started` returns `live_…` id, config echo, `expires_at` |
| `audio/pcmu` 8000 in and out | Accepted; Twilio frames can pass through unchanged, as today |
| Voice `marin`, `cedar`, `quartz` | All accepted. Marin continuity is preserved |
| Our function-tool schema under `delegation.responses.tools` | Accepted (same flat `{type:'function', name, description, parameters}` shape we use) |
| `delegation.type='client'` | Accepted |
| `store:false` | Accepted (we should send it; default is a stored 30-day recording) |
| `input` history with a `developer` message | Accepted and echoed |
| `delegation.responses.reasoning.effort` low / minimal, `service_tier:'priority'`, `parallel_tool_calls:false`, models terra / luna / gpt-5.4-mini | All accepted at `session.start` |
| **`reasoning.effort:'minimal'` on Luna** | Accepted at start, then **fails at the first delegation** with an `error` event: the caller hears "Sure, checking that now" and then nothing. Session validation is not enough; validate with a real delegation |
| `audio.input.noise_reduction`, `audio.input.turn_detection`, top-level `turn_detection`, `audio.input.keywords`, top-level `keywords`, `audio.input.transcription` | **All rejected** (`unknown_parameter`). There are no input-audio controls on Live over WebSocket. Marketed "keyword biasing" and "explicit turn detection" have no accepted session field today |
| Mid-call `session.update` of backend `instructions`, `tools`, `model`, `reasoning` | Accepted, but the payload **must include `delegation.type`** (the docs' example omits it and is rejected with `missing_required_parameter`) |
| Mid-call `session.update` of live `instructions` or `audio.output.voice` | Rejected. Both are immutable after start |
| `session.instructions.append` / `session.thinking.append` / `session.commentary.append` with `delegation_id:null` | Accepted with `…appended` acks; hard cap **500 tokens per append** |
| Native transcripts | `session.input_transcript.delta` and `session.output_transcript.delta` arrive with `start_ms`/`end_ms`, no transcription config needed |
| Output audio stream | **Continuous** at ~0.96× realtime, silence included. There is no `response.done`; "Erica is speaking" must be derived from audio energy (or transcript timing), not from delta presence |
| Tool continuation | After `response.item.create{function_call_output}` you **must** send `response.create`. Without it the model said "let me check Saturday for you" and never answered (jambonz's note that no `response.create` is needed is wrong for the raw API) |
| Usage accounting | `session.usage.updated{usage.seconds, context_window.usage_ratio}` during the call, `session.closed{usage.seconds}` at the end; backend tokens arrive inside `response.event{event:{type:'response.completed', response.usage}}` |

### Greeting-first reliability (4 sessions per pattern, silence on the line)

| Pattern | Greeted within 5 s | Time to first speech |
| --- | --- | --- |
| A. `session.instructions.append` only (docs' basic pattern) | 3 / 4 | 3.0–4.5 s |
| **B. instructions.append + `session.commentary.append` "Begin the conversation now"** | **4 / 4** | **0.75–0.98 s** |
| C. Greeting inside `instructions` only | 0 / 4 | never speaks first |
| D. `input` history developer message "speak first now" | 4 / 4 | 1.2–1.5 s |

Pattern B is the one to build on. LiveKit's plugin does the same (their `generate_reply` is a commentary append) and treats no speech within 10 s as a refusal.

### Latency (clean runs, synthesized caller asking Saturday hours, tool answered locally)

| Stage | Luna ×2 | Luna effort=low | Terra ×2 |
| --- | --- | --- | --- |
| Greeting append → first speech | 844 / 855 ms | 970 ms | 946 ms |
| Caller stops → first speech (native preamble) | 1149 / 1165 ms | 1060 ms | 1264 ms |
| Caller stops → `session.delegation.created` | 813 / 1152 ms | 810 ms | 774 ms |
| Delegation → backend function call received | 774 / 769 ms | 710 ms | 625 / 725 ms |
| Function result sent → first spoken answer | 1662 / 2144 ms | 1610 ms | 2206 / 1901 ms |

Reading: turn-taking and preambles land where Agora measured the consumer
product (≈1.1 s median). The weak stage is **tool result → spoken answer
(1.6–2.2 s)**, because the backend writes a text answer (~0.8 s) and the live
model then re-speaks it. Today's Realtime path logs 448–1,347 ms (median 715 ms)
for the same phase, so expect roughly one extra second after every lookup. The
native preambles ("Mm, let me check Saturday hours for you", "Mhm. Sure, let me
take a look") cover part of that gap and need a prompt policy, not code. One of
seven runs also showed a ~10 s server-side stall where events arrived bunched;
the app must tolerate that (bounded outbound buffer, watchdog on output energy).

Backend usage per delegation on Terra: ~865–930 input tokens, 20–35 output,
no cache hits on a tiny prompt (caching starts at 1,024 tokens, so our real
backend prompt will cache).

## Cost

| | Today (Realtime 2.1, 31 production calls Sept 9) | GPT-Live-1 |
| --- | --- | --- |
| Voice layer | $3.07 for 28.9 min → **$0.106/min** with heavy cache hits | **$0.050/min** flat |
| Backend | none | Terra ≈ $0.02–0.03 per call (6 delegations × ~1k tokens); Luna ≈ $0.003 |
| 56-second average call | ≈ $0.10 | ≈ $0.05 + $0.02 |
| Long-call risk | full context re-billed every turn → TPM freeze class (lessons.md) | voice is per-second; only backend tokens count against TPM |

Net: roughly half the voice cost, and cost no longer grows with prompt size or
call length per turn.

## Nuances that change how Erica must be built

1. **Two prompts, not one.** Live prompt (≤ ~1k tokens: personality, greeting
   policy, backchannel/interruption policy, concrete "delegate when / do not
   delegate when" triggers, unclear-audio rule, privacy basics, closing).
   Backend prompt (everything else we have today: business rules, identity
   gating, read-back before booking, closure policy, message mode, spam,
   tool coaching). OpenAI: "Delegate before giving an answer that depends on
   backend work. Do not guess the result while waiting." Immutable live
   instructions mean per-call dynamic context (CURRENT STATUS, hours, closure)
   goes in at `session.start`; late context uses appends.
2. **The model decides turns.** No `server_vad`, no thresholds, no
   `interrupt_response`/`create_response` greeting protection, no
   `wait_for_user` tool, no barge-in truncation bookkeeping. LiveKit still
   cuts *playback* with its own VAD and warns: "the model doesn't know what the
   user heard"; Twilio's own samples do nothing on interruption. Our plan:
   never `clear` on caller speech (full duplex treats "mhm" as a backchannel),
   only bound the Twilio buffer (pace sends to ≤ ~400 ms ahead of realtime,
   which is a no-op while OpenAI streams at 1×).
3. **Speaking state comes from audio energy.** Silence watchdog, greeting
   played-out, end-call drain and the duration-cap goodbye all key on
   `markQueue`/`activeResponse` today. Replace with an output-energy gate on
   the frames we forward (validated: speech segments separate cleanly at RMS
   >200 with 3 quiet deltas of hysteresis) and an input-energy gate for
   `callerSpeaking` (native input transcripts lag speech by ~1 s).
4. **Tool flow is a Responses loop we drive.** `session.delegation.created` →
   `response.event{response.output_item.done, item.type='function_call'}` →
   run our handler → `response.item.create{function_call_output}` →
   `response.create`. Every pending call must be answered before continuing;
   stale calls get an explicit "superseded" output. Function results with
   coaching notes (our lowest fix-ladder layer) keep working because the
   backend is a text model that reads them.
5. **Authoritative state stays in our app.** OpenAI's migration guide is
   explicit: keep selected/confirmed slot, permissions, active operation and
   outcome in the application; carry a revision number so "Thursday, not
   Friday" invalidates a pending Thursday confirmation; enforce permissions by
   blocking tools in code, not in prompts. Mid-call `session.update` of the
   backend tool list (validated) gives a server-enforced write gate, e.g.
   `book_appointment` only exposed after a slot was offered and identity is
   confirmed. This directly targets the Sept 9 finding that a booking skipped
   the read-back.
6. **Greeting is requested, not guaranteed.** Use pattern B and add a fallback:
   no output speech within 2.5 s → re-send the commentary; within 5 s → fall
   back to the Realtime engine for that call. The recording disclosure must be
   verified from the output transcript, not assumed (the docs use exactly this
   example).
7. **Transcripts are time-ranged, not item-ranged.** Exact caller-message
   capture for `leave_message_for_owner` re-keys on `start_ms`/`end_ms`
   windows around the message turn instead of OpenAI item ids. Transcripts
   arrive after the audio and can overlap the assistant's.
8. **Background voices.** Agora measured the consumer product rejecting 30/30
   false interruptions (coughs, TV) but answering background voices in 4/30
   noisy windows. Speakerphone and side conversations still need the prompt
   line "Do not treat a cough, music, or nearby conversation as a new request"
   and a live test.
9. **Costs of being early.** Docs and partner write-ups disagree with the API
   in at least two places we hit (see the verified table). The Node SDK we pin
   (`openai@6.0.0`) predates `openai/resources/live`; 7.15.0 has typed
   `LiveWS`. Raw `ws` works fine and is what we validated.
10. **What we lose.** Noise-reduction and VAD knobs (`OPENAI_VAD_*`,
    `OPENAI_NOISE_REDUCTION`, `OPENAI_INPUT_TRANSCRIPTION` become dead in live
    mode), `response.cancel`/`output_audio_buffer.clear`, single-model tool
    speed, and the prompt-audit tests that lock section order and the 4.2k
    budget.

## How others have integrated it

- **Twilio** — Agent Connect ships a `GPTLiveProvider` (Responses delegation,
  `welcome_instruction`, "no barge-in or audio-truncate bookkeeping to write");
  the Node Media Streams tutorial uses the same shape we validated, forwards
  mu-law both ways unchanged, greets with `instructions.append` + commentary,
  and handles no mark/clear at all. Twilio SIP trunking into OpenAI's SIP
  connector (`sip.api.openai.com`, REFER for transfer, `/hangup`) is the other
  path; it would replace our Media Streams bridge and `<Dial>` failback and is
  out of scope for a first cut.
- **LiveKit** — `GPTLiveModel` plugin: Responses delegation default with Luna,
  greeting via commentary with a 10 s refusal timeout, VAD-driven playback cut,
  adaptive noise gate to segment the continuous output audio, transcripts
  arrive after audio. Caveats they publish: voice/instructions immutable, no
  text-only modality, cannot speak a script verbatim.
- **jambonz** — treats `session_update` as mandatory before audio is accepted,
  requires the greeting as a context append ("putting the greeting in
  instructions does not work", which our A/B reproduced), abstracts the
  response.create step inside their wrapper.
- **OpenAI's own guidance** — measure stages separately (delegation receipt,
  backend start, first useful result, tool start/end, result submission, audio
  arrival, playback); keep answers to facts; close voice sessions during long
  backend tasks; route audio-evidence detection (voicemail beeps) to a separate
  detector because the backend never sees the waveform.
- **Evalgent / Full-Duplex-Bench v3** — instrument overlap and timing, not
  transcripts; strong models self-correct in <59% of scenarios and show silent
  gaps in ~25% of delegated cases. Our 1.6–2.2 s post-tool gap is that class.

## Proposed integration

### Architecture

```
Twilio Media Streams ──► twilioStream.ts (unchanged Twilio side, call store, tools, Phorest)
                             │
                 VOICE_ENGINE=realtime ──► openaiSession.ts   (today, rollback)
                 VOICE_ENGINE=live     ──► liveSession.ts     (new adapter, same handler surface)
                                              │ wss /v1/live/sessions, pcmu 8k, marin
                                              │ delegation: responses → gpt-5.6-terra (Luna as cost fallback)
                                              └ tools = today's TOOL_DEFINITIONS minus wait_for_user
```

- `liveSession.ts` implements the existing handlers (`onAudioChunk`,
  `onSpeechStarted/Stopped`, `onUserTranscript`, `onAssistantTranscript`,
  `onUsage`, tool handler registry) so tool handlers and the call store stay
  shared. New responsibilities: speech-energy gates, greeting pattern B with
  fallback, Responses tool loop, backend `session.update` for caller context
  and tool gating, usage from `usage.seconds` + backend `response.usage`.
- Responses delegation, not client delegation: client mode hands us only a
  delegation id and makes us infer intent from transcripts; Responses mode
  keeps our function-call contract and result coaching intact.
- Backend `gpt-5.6-terra` at default effort (625–725 ms to a tool call, ~$0.03
  per call). Luna is the A/B for cost; `minimal` effort is invalid on Luna.
- Twilio marks stay for observability only; hangup/transfer still go through
  Twilio REST as today; `session.close` then wait for `session.closed`.

### Realtime → Live mapping for our code

| Today | Live |
| --- | --- |
| `session.update` (GA nested schema) | `session.start` as first message; wait for `session.started` before audio |
| `input_audio_buffer.append` | `session.input_audio.append` (same base64 mu-law) |
| `response.output_audio.delta` | `session.output_audio.delta` (continuous; forward with bounded pacing) |
| `response.created/done`, `activeResponse`, RT-2 deferral | none; speaking = output energy; no response collisions |
| `input_audio_buffer.speech_started/stopped` | local input-energy gate (+ `session.input_transcript.delta` for text) |
| `conversation.item.truncate`, Twilio `clear` on barge-in | removed; model owns interruption |
| `requestGreeting()` + interrupt/create_response toggles | `instructions.append` + `commentary.append` at start; fallback timers |
| `injectContext()` system item | `session.thinking.append` (live) + `session.update` backend instructions |
| `response.function_call_arguments.done` → handler → `function_call_output` + `response.create` | `session.delegation.created` → `response.event` envelope → handler → `response.item.create` + `response.create` |
| `wait_for_user` silent tool | removed |
| `truncation.retention_ratio`, prompt caching of the audio prefix | automatic compaction; backend prompt caching via Responses |
| `rate_limits.updated`, TPM guard | backend-only; `session.usage.updated` for seconds |
| `audio.input.transcription` (gpt-4o-mini-transcribe) | native transcripts; the deprecated model is no longer needed |

### Phases and acceptance

0. **Done today** — access, shape, field acceptance, greeting A/B, tool loop,
   latency and usage probes (`scripts/gpt-live/`).
1. **Adapter (1–2 days)** — `liveSession.ts` + `VOICE_ENGINE` switch; speech
   gates; greeting B + fallback; tool loop; usage/cost; unit tests (session
   shape snapshot, event mapping, energy gate, greeting timers, continuation).
   Accept: mock-Phorest local call completes a booking end to end.
2. **Prompt split + flows (2–3 days)** — live prompt and backend prompt derived
   from `buildInstructions()`; caller-context injection; tool gating by call
   state; end_call/transfer/duration-cap/silence watchdog on the new signals;
   owner-message capture on time windows; render/probe scripts for both
   prompts. Accept: existing scenario suite passes in both engines.
3. **After-hours test calls on the real number** — greeting latency, post-tool
   gap, speakerphone echo, background voices, read-back compliance, cost per
   minute, a forced mid-call stall. Accept: no regression on the Sept 9 QA
   dispositions, greeting ≤ 1.5 s in 10/10 calls.
4. **Canary** — `VOICE_ENGINE=live` after hours for a night, review with the
   existing call-review routine, then daytime; Realtime stays deployable as
   rollback until Live has a month of clean reviews.

### Open questions for Aryan

- Terra vs Luna as the production backend (quality vs $0.03 per call).
- Whether a ~1 s slower post-lookup answer is acceptable in exchange for the
  turn-taking and cost gains, or whether we should wait for a mini/faster
  Live tier before cutting over.
- Whether to keep Twilio Media Streams (proposed) or move to OpenAI SIP later.

## Sources

- OpenAI: [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live), [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation), [Prompting](https://developers.openai.com/api/docs/guides/live-prompting), [Conversations](https://developers.openai.com/api/docs/guides/live-conversations), [Migration](https://developers.openai.com/api/docs/guides/live-migration), [WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [SIP](https://developers.openai.com/api/docs/guides/voice-sip?api=live), [Server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live), [Latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live), [Voice agents comparison](https://developers.openai.com/api/docs/guides/voice-agents), [gpt-live-1 model](https://developers.openai.com/api/docs/models/gpt-live-1), [Pricing](https://developers.openai.com/api/docs/pricing), [Changelog](https://developers.openai.com/api/docs/changelog), [Deprecations](https://developers.openai.com/api/docs/deprecations), [Announcement](https://openai.com/index/introducing-gpt-live-1-in-the-api/), [Engineering post](https://openai.com/index/continuous-voice-interaction-with-gpt-live/), [Community thread](https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471)
- Twilio: [GPT-Live-1 resources](https://www.twilio.com/en-us/blog/developers/twilio-openai-gpt-live-1-api-resources), [Node Media Streams tutorial](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/voice-ai-assistant-openai-gpt-live-1-node), [Outbound Node](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/outbound-calls-openai-gpt-live-1-node), [Agent Connect Python](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/tac-gpt-live-voice-ai-agent-python)
- Others: [LiveKit GPT-Live plugin](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/), [jambonz](https://docs.jambonz.org/tutorials/voice-ai-examples/open-ai-gpt-live), [Agora latency measurements](https://www.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it/), [Evalgent](https://www.evalgent.com/blog/build-voice-agents-gpt-live), [The Register](https://www.theregister.com/ai-and-ml/2026/09/10/openai-arms-devs-with-ai-conversation-tool-that-can-talk-and-listen_at_the_same_time/5295708), [AlphaSignal](https://alphasignal.ai/news/openai-s-gpt-live-1-cuts-voice-agent-code-by-80-at-0-05-a-minute), [Unite.ai](https://www.unite.ai/openais-gpt-live-1-arrives-in-the-api-at-0-05-per-minute/), [testingcatalog](https://www.testingcatalog.com/openai-launches-gpt-live-1-for-full-duplex-voice-agents/)
