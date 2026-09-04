# OpenAI Realtime 2.1 analysis

Last evidence refresh: 2026-09-03

## Model and current controls

Official references:

- [GPT Realtime 2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Realtime prompting guide](https://developers.openai.com/api/docs/guides/realtime-models-prompting)
- [Voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad)
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs)

`gpt-realtime-2.1` is a reasoning speech-to-speech model. The existing direct
speech architecture is a good fit for the receptionist because it preserves
prosody and avoids a separate STT → text model → TTS latency chain.

| Control                      | Current project state                                                             | Consequence                                                         |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Model                        | `gpt-realtime-2.1`                                                                | Active production model                                             |
| Voice                        | Marin in production; Cedar code fallback                                          | Natural female production voice; restart required for env change    |
| Output modality              | Audio                                                                             | Audio transcript events are also captured for observability         |
| Audio format                 | PCMU input/output                                                                 | Twilio frames pass through verbatim                                 |
| Turn detection               | Server VAD                                                                        | Predictable tunable phone-call behavior                             |
| VAD threshold/silence/prefix | Env-tunable; current defaults 0.6 / 700 ms / 300 ms                               | Noise/interruption tradeoff can be tuned without changing code      |
| Noise reduction              | Near-field default                                                                | Appropriate starting point for phone audio                          |
| Truncation                   | Retention ratio 0.8                                                               | Preserves prompt caching better during long calls                   |
| Input transcription          | `gpt-4o-mini-transcribe` in production after live schema validation               | Transcript is asynchronous and advisory                             |
| Reasoning effort             | Omitted                                                                           | Provider/default behavior; no reasoning change was made             |
| Parallel tool calls          | Not explicitly configured                                                         | Do not assume parallel execution semantics                          |
| Silence / non-addressed audio | `wait_for_user` no-op tool (2026-09-03, local); result delivered with no `response.create` | The model can decline to speak instead of reciting a menu       |
| Response phase handling      | All emitted audio/text is streamed; phase is not persisted                        | Native preambles can become audible duplicates                      |

Official documentation exposes `reasoning.effort` values from `minimal` through
`xhigh` and recommends starting low for most production voice agents. Higher
effort can increase latency and output tokens. For this receptionist, effort
should be treated as an A/B-tested operating point—not assumed to be “better”
because it is higher. No such experiment is authorized or implemented now.

## 2026-09-03 field probe

`scripts/validate-session-fields.ts` against `gpt-realtime-2.1` today: the
production shape plus each of `reasoning.effort` (`low`, `minimal`),
`audio.output.speed`, `semantic_vad` (+ `eagerness`), server-VAD
`idle_timeout_ms`, `parallel_tool_calls`, `tool_choice`, and
`max_output_tokens` were all ACCEPTED and echoed back. The echoed baseline
shows `reasoning: undefined`, so the effective default is the provider's, not
an explicit `low`. Nothing here is enabled yet; each is a staged experiment
in `tasks/todo.md`.

## Model-specific operating lessons

### Prompt literalness

Realtime 2 follows explicit instructions closely. That improves structured
flows, but conflicting rules become more visible. The prompt used for the first
2.1 call simultaneously said “one question at a time,” “check identity in the
same breath,” and “before every tool call say filler.” Those conflicts were
removed in the deployed prompt release.

Prefer:

- one named rule for each situation;
- clear precedence when rules can conflict;
- short examples at the exact ambiguity;
- server/tool state for deterministic facts;
- removal of obsolete rules rather than adding exceptions around them.

### Preambles and response phases

Realtime 2 can speak brief preambles before tool use and can produce multiple
response phases. The prompt used for the audited call also required spoken
filler before every tool call. Both mechanisms fired, so the caller heard
duplicate commentary. The deployed prompt now permits at most one action update
for a whole noticeably slow lookup sequence and explicitly skips routine price
lookups and several other fast paths. The application still forwards all audio
and does not record a phase label, so prompt success must be verified by a
staged call and phase instrumentation remains useful.

### Transcription is not hearing

Input audio transcription runs asynchronously and can disagree with the model's
understanding. A mini transcriber writing “Raja” does not prove the speech model
thought the caller said Raja. Diagnose name/entity problems from:

1. the action the model took;
2. tool arguments and tool results;
3. dual-channel recording;
4. a higher-quality offline transcription;
5. the low-latency transcript only as supporting evidence.

### Voice and turn behavior

Voice locks after the model emits audio. Greeting protection currently disables
automatic response creation and interruption during the greeting, then restores
both for normal conversation. Preserve that handshake. Server VAD remains the
right default until a staged, measured semantic-VAD experiment demonstrates a
better interruption/latency balance.

### Context and cost

Realtime rebills retained context on each response. The project benefits from a
stable cached prefix and retention-ratio truncation; the latest call achieved a
96–98% cache hit rate after the first turn. Prompt growth is therefore both a
behavior problem and an operating-cost problem.

## 2026-09-02 release evidence

The current production prompt is commit `eca23f1`. Live Realtime
text-to-audio-transcript probes used the exact local prompt and exercised:

- hours today, tomorrow, and the September 10 reopening day across one
  conversation;
- explicit and bare requests for Richa;
- a booking request during the closure;
- a question about an unrelated provider.

The final three-turn hours probe explained the temporary closure and reason
once, gave the September 10 reopen date, avoided repeating the full recital on
the next turn, and returned the configured September 10 hours when asked. The
Richa probes said she was unavailable through the closure and offered a
message. The unrelated-provider probe did not claim that provider was away.

These were live-model probes, not direct-phone calls: business tools were
intercepted and speech quality was assessed from output transcripts rather
than a phone recording. The model occasionally offered a Richa message in an
unrelated-provider sample despite the contrary policy. That is not material to
the current one-provider salon, but it is evidence that future multi-provider
routing must be deterministic rather than prompt-only.

## Historical 2026-08-28 audited call

**Observed:** a direct Twilio test call after the 2.1 deployment lasted about
98 seconds. It used Marin/PCMU, completed one successful
`suggest_availability` call, created no booking, ended when the caller hung up,
and recorded no provider errors, warnings, or Twilio 31924 event.

Approximate model usage was 43.4k input tokens, 2.2k output tokens, and 35.6k
cached input tokens across six turns, with an estimated cost of about $0.16.
First-audio latency was approximately 0.78 seconds for the greeting, then
0.52–1.67 seconds across caller/tool turns. These are one-call observations,
not production percentiles.

### What worked

- Caller: “Is Richa available tomorrow at twelve?”
- Erica treated Richa as a staff person, did not send `serviceName=Richa`, and
  asked which service the caller wanted.
- After the caller named eyebrow threading, availability ran successfully.
- Erica did not book anything without explicit confirmation.
- Tool history, transcript, recording reference, usage, cost, and latency were
  available for review.

This is positive evidence for the prompt + tool-schema + deterministic
`matchStaffName()` defense. It does not justify removing any layer.

### What failed: duplicate preambles

The caller heard multiple check/filler utterances around one availability
lookup: an initial acknowledgment, a clarification because service was absent,
then two similar “let me check” preambles once the service was known.

**Analysis:** Realtime 2's default preamble behavior and the project's absolute
“before EVERY tool call” filler instruction overlap. The code then streams all
spoken phases. This is a policy collision, not a Phorest or latency failure.

**Resolved in the deployed prompt:**

1. The universal filler mandate was removed.
2. The prompt allows at most one brief action update for a whole lookup
   sequence and treats two date checks as one sequence.
3. Direct answers, corrections, confirmations, unclear/background audio,
   routine fast lookups, and `end_call` explicitly receive no preamble.
4. Tests lock the policy and both fallback/full-catalog prompt budgets.

**Still required:** monitor real forwarded price, availability, booking, and
slow/error calls. Capture response-phase metadata so a recurrence can be
attributed. Suppress a provider commentary phase in code only if the prompt
cannot make output consistent and the phase contract proves stable.

Avoid a brittle list of forbidden phrases; the duplication is structural.

### What failed: identity was re-asked

The first assistant response combined “Are you Aryan?” with “Which service?”
The caller answered the service question only. The identity state therefore
remained unresolved. After the tool result Erica bundled identity and booking
again; an ambiguous reply led to another name request, which frustrated the
caller.

**Analysis:** the prompt used for that call contained a direct contradiction.
Its global rule said one question at a time, while recognized-caller context
told Erica to acknowledge the request and check the name “in the same breath.”
The first turn created two answerable questions, and the model had no
deterministic identity state transition because the reply did not answer both.

**Resolved in the deployed prompt:** recognized-caller context starts at
`UNCONFIRMED`, makes identity the only question in the turn, requires a stop and
wait, preserves the original request, and defines clear yes/no/unrelated-answer
handling. Public hours, services, prices, and availability do not require
identity. The old “same breath” direction and candidate reply scripts are gone,
and the caller-context builders now have focused tests.

**Remaining limitation:** those identity labels are a model-facing
conversation contract, not a server-owned enum that authorizes every account
tool. A future hardening pass should track `unconfirmed`, `confirmed`, and
`rejected` in call state and reject account reads/writes while unresolved. The
future controlled test must still cover partial answers, corrections, “no,”
and a conversational detour.

## Person versus service: current conclusion

The target bug is mitigated correctly at several layers, and the first 2.1 call
passed. The robust rule is entity-first:

- Staff/owner names answer **who**.
- Catalog entries answer **what service**.
- Date/time answer **when**.
- Availability requires a service and date; a staff name cannot fill the
  service slot.

The next improvement, if failures recur, should be structured entity state or a
deterministic pre-tool classifier—not more repeated prompt warnings.

## Early-arrival policy: Realtime implication

The requested multitasking exception is not something the speech model should
reason from prose on every call. Realtime should collect the caller's intent and
speak the result. A server policy should decide whether an overlapping current
appointment permits a squeeze-in, with facials, haircuts, and Brazilian waxing
as explicit non-multitaskable categories. This prevents model-version changes
from silently changing calendar policy.

## Recommended evaluation set before any next model/prompt release

- “Is Richa available at six?” followed by a service.
- The same request with ASR variants: Risha, Reesha, Richard, and a phrase such
  as “Richa availability.”
- Recognized caller answers only the service question, only the identity
  question, says no, corrects the name, or changes topic.
- Availability, price, booking, and error flows produce at most one preamble.
- Caller interrupts the greeting and a tool-result response.
- Early arrival when Richa is free, busy on a multitaskable service, and busy on
  each of the three prohibited service categories—after that policy exists.
- Long/noisy turns validate VAD, silence watchdog, cache hit, latency, and cost.

Record model, voice, reasoning setting, prompt commit, call ID suffix, tool
history, latency, usage, and outcome for each staged call. Without that matrix,
a model comparison is anecdotal.
