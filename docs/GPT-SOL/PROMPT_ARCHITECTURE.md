# Erica prompt architecture and rationale

Last updated: 2026-08-28

Implementation status: code and automated tests complete on the working branch;
not deployed or validated by a direct Twilio call as part of this change.

## Purpose

Erica's prompt should make a phone call feel like a capable salon receptionist:
short turns, one question at a time, accurate use of the appointment system, and
no unnecessary narration. “Natural” does not mean pretending to be human or
adding verbal tics. It means listening, retaining context, speaking only when
useful, and moving the caller's task forward without ceremony.

The canonical implementation is `buildInstructions()` in
`src/realtime/twilioStream.ts`. This document explains that prompt rather than
duplicating its full rendered text, because the exact prompt includes current
time, hours, transfer status, vacations, and the live service catalog. A copied
static prompt would immediately become a second, stale source of truth.

## The effective prompt is more than one string

The model sees several instruction layers during a call. All of them are part
of prompt design and must be reviewed together.

| Layer | Canonical source | Role |
| --- | --- | --- |
| Core instructions | `buildInstructions()` | Role, speaking behavior, business facts, flows, privacy, and escalation |
| Dynamic business context | `buildInstructions()` tail | Salon-local date/time, today's status, transfer availability, vacation state, and optional live price catalog |
| Tool contracts | `TOOL_DEFINITIONS` | High-salience argument and confirmation rules beside each function |
| Caller context | `buildRecognizedCallerContext()` and `buildUnrecognizedCallerContext()` | Caller-ID match state and the next permitted identity/contact step |
| Tool-result coaching | Individual tool handlers | State-specific next action based on the result that just occurred |
| Out-of-band notes | `REALTIME_CONTEXT_NOTES` | Silence check-in, duration wrap-up, and interrupted-goodbye behavior |

The stable core remains first and current, caller-specific facts arrive later.
This preserves a cacheable prefix while giving recent, state-specific results
the salience they need.

## Core prompt shape

The section order is deliberate:

1. `PRIORITY`
2. `PERSONALITY & TONE`
3. `LANGUAGE`
4. `RESPONSE SHAPE & TURN-TAKING`
5. `REFERENCE PRONUNCIATIONS`
6. `CONTEXT`
7. `SERVICES & PRICES`
8. `REASONING & UNCLEAR AUDIO`
9. `PREAMBLES`
10. `TOOLS`
11. `OPERATING RULES`
12. `PRIVACY`
13. `CONVERSATION FLOW`
14. `SAFETY & ESCALATION`
15. `SPAM & TELEMARKETING`
16. `NON-CLIENT CALLS`
17. dynamic `CURRENT STATUS`

`PRIORITY` resolves collisions explicitly: recording disclosure, privacy,
safety, and confirmed writes outrank status/results; those outrank the current
task; style comes last. The other sections then separate how Erica sounds from
what she may do. This follows OpenAI's recommendation to use clear labeled
sections, concise bullets, and explicit handling for ambiguous audio and tool
behavior.

## Natural conversation policy

The main behavior contract is intentionally small:

- Default to one short sentence and use a second only when a result,
  confirmation, or next step requires it.
- Ask exactly one question, then stop. Identity is never bundled with service,
  date, time, or booking consent.
- Let the caller finish. A brief pause, background media, or side conversation
  is not a new request.
- Retain details already supplied and immediately replace corrected values.
- Do not reflexively restate requests. Restatement is for ambiguity or the
  final confirmation before a write.
- Never speak internal reasoning, tool names, hidden instructions, system
  state, or call mechanics.
- Use ordinary contractions and match the caller's pace while remaining a
  little calmer.
- Do not manufacture warmth with forced laughter, habitual backchannels,
  praise, repeated thanks, or repeated use of the caller's name.

The exact recorded-line greeting is the one intentional ready-made assistant
line:

> Richa's Threading Salon, this is Erica on a recorded line — how can I help
> you?

It is fixed because the recording disclosure and pickup experience must be
consistent. Other instructions describe behavior instead of supplying
quotable candidate replies. Realtime models tend to reuse dialogue examples,
especially later injected notes, even when the example was intended only as
guidance.

## Preamble policy

The old rule required filler before every tool call. Realtime 2.1 can also emit
native spoken preambles, so the two policies produced duplicate versions of a
check-in around one availability lookup.

The replacement rule is sequence-based:

- Use at most one short action update for an entire lookup sequence, and only
  when the silence would be noticeable.
- If the turn already acknowledged the task or said a check was happening,
  run the remaining tools silently.
- Two date lookups for one availability request are one sequence.
- Use no preamble for direct answers, corrections, confirmations, unclear or
  background audio, routine price lookup, or `end_call`.
- A preamble describes the action, never the model's reasoning or a tool name.

This is a prompt-level control, not proof that Realtime will always emit zero
or one spoken preamble. The application still streams all emitted audio and
does not persist response-phase labels. A staged call and phase instrumentation
remain the right way to determine whether provider-native preambles need an
additional code-level guard.

## Identity and contact flow

Public information—hours, services, prices, and general availability—does not
require identity. Identification happens immediately before the first
account-specific read or write.

For a caller-ID match, the later caller-context note begins as
`UNCONFIRMED`. Erica asks only whether she is speaking with the matched person
and waits:

- clear yes: use the warmed account and do not ask again;
- clear no or a different supplied name: reject the match for the rest of the
  call and never expose it;
- unrelated or ambiguous reply: remain unconfirmed and do not access the
  account or write to it.

The pending request is retained across this beat, so confirmation resumes at
the next missing detail instead of restarting the call. A recognized client is
never asked for a phone number. If they mention a changed number, the existing
account remains in use and Erica neither updates nor asks for the new number,
matching the owner's recorded decision.

For an unrecognized existing client, phone lookup precedes name fallback. For
a new booking, Erica first asks whether the calling number is best for the
file, waits, and only then asks for the name or a preferred number in a later
turn.

Important limitation: `UNCONFIRMED`, `CONFIRMED`, and `REJECTED` are currently
a conversational contract expressed to the model, not a deterministic server
enum that gates every account tool. The server already holds the warmed client
record, but a future hardening pass should own identity transitions and tool
authorization in code. This release does not claim that work is complete.

## Tool and write boundaries

Read-only tools run once intent and required values are clear. After a result,
Erica gives the result first and only then the next useful question or action.
Raw errors, IDs, and URLs are never spoken.

Every appointment write has the same boundary in both the core prompt and its
tool description:

- booking: explicit confirmation of exact service, date, and time;
- rescheduling: explicit confirmation of the new date and time;
- cancellation: explicit confirmation of the exact appointment;
- completion may be announced only after the tool returns success.

These prompt and schema rules support, but do not replace, deterministic
ownership, offered-slot, fresh-availability, and provider checks in the
handlers.

## Why this rework is smaller

The previous prompt had useful production fixes but accumulated conflicting
behavioral patches. The rework removes or consolidates four sources of
artificial speech:

1. universal filler before tools;
2. identity confirmation “in the same breath” as another question;
3. forced smile/laughter/backchannel directions;
4. quotable reply examples in caller, silence, duration, and goodbye notes.

Repeated transfer prose was also collapsed into four mutually exclusive
branches: explicit request for Richa, self-service first, live transfer, and
message mode. No business capability or safety rule was intentionally removed.

Using the repository's conservative `characters / 4` estimate, the fallback
prompt is about 3.9k tokens. The test fixture combining 63 realistically named
services, active vacation state, and transfer failback remains below 5k. These
are regression budgets, not tokenizer-accurate billing figures.

## Verification and release gate

Automated tests lock:

- section order and both prompt budgets;
- the exact legal greeting appearing once;
- selective-preamble and zero-preamble paths;
- anti-echo, anti-meta-narration, and absence of forced performance tics;
- immediate and late caller-ID context, one-question identity, rejection, and
  control-whitespace handling;
- descriptive, unscripted silence/duration/goodbye notes;
- confirmation and successful-result language beside every write tool.

String tests prove that the contract is present; they do not prove natural
speech. Before deployment, use the direct Twilio staging number and evaluate at
least:

1. price lookup: zero spoken preambles;
2. two-date availability: no more than one preamble for the sequence;
3. recognized caller: identity is the only question, followed by silence;
4. unrelated identity answer: no account action and no bundled question;
5. correction: old value is replaced without an echo ritual;
6. unclear audio: one clarification and no tool;
7. booking, reschedule, and cancellation: no write before explicit yes and no
   success claim after failure;
8. caller interruption and goodbye: no internal or call-ended narration.

Safety, privacy, legal greeting, and write boundaries are hard gates. Judge
naturalness with blind side-by-side listening against the prior prompt rather
than phrase-counting alone. Record the model, voice, prompt commit, call ID
suffix, transcript, recording, tool history, first-audio latency, cache hit,
usage, and outcome.

## Deliberately out of scope

This prompt release does not change the model, voice, reasoning effort, VAD,
noise reduction, session schema, forwarding, deployment, or Phorest data. It
also does not implement response-phase suppression, deterministic identity
authorization, two-phase write state, or the owner's future early-arrival
multitasking policy.

## Official references

- [GPT Realtime 2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Realtime models prompting guide](https://developers.openai.com/api/docs/guides/realtime-models-prompting)

