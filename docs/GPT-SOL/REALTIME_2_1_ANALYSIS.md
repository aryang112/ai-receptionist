# OpenAI Realtime 2.1 analysis

Last evidence refresh: 2026-08-28

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
| Model                        | `gpt-realtime-2.1`                                                                | Production upgrade completed without changing tools or salon policy |
| Voice                        | Marin in production; Cedar code fallback                                          | Natural female production voice; restart required for env change    |
| Output modality              | Audio                                                                             | Audio transcript events are also captured for observability         |
| Audio format                 | PCMU input/output                                                                 | Twilio frames pass through verbatim                                 |
| Turn detection               | Server VAD                                                                        | Predictable tunable phone-call behavior                             |
| VAD threshold/silence/prefix | Env-tunable; current defaults 0.6 / 700 ms / 300 ms                               | Noise/interruption tradeoff can be tuned without changing code      |
| Noise reduction              | Near-field default                                                                | Appropriate starting point for phone audio                          |
| Truncation                   | Retention ratio 0.8                                                               | Preserves prompt caching better during long calls                   |
| Input transcription          | Env-gated; historically off by default, enabled only after live schema validation | Transcript is asynchronous and advisory                             |
| Reasoning effort             | Omitted                                                                           | Provider/default behavior; no reasoning change was made             |
| Parallel tool calls          | Not explicitly configured                                                         | Do not assume parallel execution semantics                          |
| Response phase handling      | All emitted audio/text is streamed; phase is not persisted                        | Native preambles can become audible duplicates                      |

Official documentation exposes `reasoning.effort` values from `minimal` through
`xhigh` and recommends starting low for most production voice agents. Higher
effort can increase latency and output tokens. For this receptionist, effort
should be treated as an A/B-tested operating point—not assumed to be “better”
because it is higher. No such experiment is authorized or implemented now.

## Model-specific operating lessons

### Prompt literalness

Realtime 2 follows explicit instructions closely. That improves structured
flows, but conflicting rules become more visible. Instructions such as “one
question at a time,” “check identity in the same breath,” and “before every
tool call say filler” cannot all be left to soft interpretation.

Prefer:

- one named rule for each situation;
- clear precedence when rules can conflict;
- short examples at the exact ambiguity;
- server/tool state for deterministic facts;
- removal of obsolete rules rather than adding exceptions around them.

### Preambles and response phases

Realtime 2 can speak brief preambles before tool use and can produce multiple
response phases. Erica's prompt already requires spoken filler before every
tool call. If both mechanisms fire, the caller hears two versions of “let me
check that.” The application currently forwards all audio and does not record a
phase label, so it cannot distinguish or suppress duplicate commentary.

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

## Latest audited call

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

**Proposed experiment, not implemented:**

1. Capture/log response phase metadata first so the source is measurable.
2. Replace the universal filler mandate with one narrow latency rule: speak one
   brief acknowledgment only when a tool is actually about to run and no
   equivalent preamble has already been spoken in that turn.
3. Add transcript-level tests for exactly zero or one preamble per tool call.
4. Stage calls across price, availability, booking, and slow/error paths.
5. Consider suppressing a commentary phase in code only if the model/prompt
   change cannot make output consistent and the phase contract is stable.

Avoid a brittle list of forbidden phrases; the duplication is structural.

### What failed: identity was re-asked

The first assistant response combined “Are you Aryan?” with “Which service?”
The caller answered the service question only. The identity state therefore
remained unresolved. After the tool result Erica bundled identity and booking
again; an ambiguous reply led to another name request, which frustrated the
caller.

**Analysis:** the prompt contains a direct contradiction. Its global rule says
one question at a time, while recognized-caller context instructs Erica to
acknowledge the request and check the name “in the same breath.” The first turn
created two answerable questions, and the model had no deterministic identity
state transition because the reply did not answer both.

**Proposed experiment, not implemented:**

1. Make identity confirmation a discrete state with a single question.
2. Do not ask service/date/time in the identity-confirmation turn.
3. Track identity as `unknown`, `confirmed`, or `rejected` in server-side call
   state when possible; do not infer confirmation from an unrelated answer.
4. If a reply is ambiguous, acknowledge it once and ask one short identity
   question. Never bundle it with booking consent.
5. Add scripted tests for partial answers, corrections, nicknames, “no,” and
   conversational detours before another live call.

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
