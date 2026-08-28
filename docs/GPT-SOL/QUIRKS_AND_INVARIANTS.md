# Quirks and invariants

This is the high-signal checklist. [`../../tasks/lessons.md`](../../tasks/lessons.md)
contains the full history and must still be read before relevant changes.

## Contracts that should not drift

- Use `.js` extensions in local TypeScript imports; this project emits ESM.
- `PhorestPort` is the appointment-system contract. Change the interface, real
  adapter, mock, and tests together.
- `src/config/business.json` is the canonical hours, closures, vacation, and
  location source. Do not “fix” hours in prompt text or environment variables.
- Tool JSON schemas, `toolSchemas.ts`, handlers, and tests must describe the
  same arguments. A model-facing schema test alone does not test runtime
  rejection, and a Zod test alone does not protect the model contract.
- Voice turns should be one or two short sentences and one question at a time.
- Never log secrets or full phone numbers. Canonical phone matching uses ten US
  digits after stripping a leading country `1` and tolerated leading zeros.
- The production Phorest path is real (`USE_MOCK_PHOREST=false`). A seemingly
  harmless manual test can create or alter customer data.

## Phorest: the dangerous details

| Area                | Invariant                                                                                                                                   | Failure if ignored                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Timezones           | Appointment reads return salon-local times; availability returns UTC; writes expect local wall-clock. Normalize inside `phorest.client.ts`. | Double conversion, wrong-day results, or appointments booked at the wrong hour             |
| Query names         | Use snake_case such as `client_id` and `from_date`.                                                                                         | CamelCase is silently ignored; one historical failure returned other clients' appointments |
| Date range          | `/appointment` accepts at most 31 days; the implementation uses 30.                                                                         | Provider errors or incomplete scans                                                        |
| Client phone search | The provider's `?mobile=` is not a reliable filter; use the bounded client index.                                                           | False identity matches or missed callers                                                   |
| Appointment lookup  | Direct `GET /appointment/{id}` returns 404 on this tenant unless explicitly enabled for another tenant.                                     | Guaranteed latency/error before fallback                                                   |
| Cancellation        | Only BOOKED appointments can be cancelled; PAID cancellation returns 500.                                                                   | Misleading “system failed” behavior                                                        |
| Booking status      | Writes must use `bookingStatus: ACTIVE`.                                                                                                    | A RESERVED booking can expire                                                              |
| Availability grid   | Phorest re-anchors after appointment ends and returns odd minutes. Snap **up** to the clean grid and require service runway.                | Offering aesthetically wrong or not actually usable times                                  |
| Slot selection      | Center around the requested time or spread choices. Do not simply take the earliest array entries.                                          | “Anything around six?” gets morning slots                                                  |

## Realtime session invariants

- Use the GA schema: nested `session.audio.input/output`, typed PCMU formats,
  and no beta header.
- Validate every **new** `session.update` field against the live API before
  shipping. Realtime rejects the entire session for an invalid field, which
  presents to the caller as an immediate hangup.
- The historical `session.max_response_output_tokens` field name is invalid.
  Do not resurrect it. Confirm the current official field and placement before
  adding any output limit.
- Keep `truncation: { type: 'retention_ratio', retention_ratio: 0.8 }` unless a
  measured experiment justifies changing it. It reduces repeated prefix-cache
  invalidation on long calls.
- Keep the stable instruction/tool prefix stable. Add caller-specific context
  after it so prompt caching survives personalization.
- Tool preambles are selective: at most one brief action update for a whole
  noticeably slow lookup sequence. Routine price lookup, direct answers,
  confirmations, corrections, unclear/background audio, and `end_call` have no
  preamble. See [`PROMPT_ARCHITECTURE.md`](PROMPT_ARCHITECTURE.md).
- The current turn detector is `server_vad`. During the greeting,
  `interrupt_response` and `create_response` are deliberately disabled and then
  re-enabled with the **full** turn-detection object. Nested partial updates
  replace rather than safely merge in this path.
- A response already in flight and a new `response.create` can collide. Use the
  guarded response path and preserve the pending-tool-response logic.
- Input transcription is asynchronous guidance, not a guaranteed transcript of
  exactly what the speech model heard. Use the dual-channel recording and
  downstream transcription when name-level evidence matters.
- Marin and Cedar are the preferred voices for this project. Production is
  Marin; the code fallback is Cedar. Changing the environment requires a
  server restart, and a session's voice cannot change after audio begins.
- Reasoning effort is currently omitted. Adding `reasoning` is a new session
  shape and a behavior/cost/latency experiment, not a harmless tuning edit.

## Telephony and call-state invariants

- Audio is PCMU passthrough. Do not reintroduce transcoding without a measured
  reason and an end-to-end call test.
- Caller-ID warming races the OpenAI connection. A timeout is not a negative
  match; the late lookup may still adopt the recognized caller.
- Never cold-greet a recognized caller by name. Public information needs no
  identity check; immediately before the first account-specific read/write,
  make identity the only question in that turn and wait.
- `callerSpeaking` is true between VAD speech-started and speech-stopped. A long
  monologue is active speech, not mutual silence.
- Silence behavior is 20 seconds to one check-in, then 15 more seconds to a
  graceful hangup. It must pause around active responses, tools, transfer, and
  caller speech.
- Maximum call duration is ten minutes, with a wrap-up nudge one minute before
  the cap and bounded grace for in-flight tools.
- Barge-in must clear Twilio playback **and** truncate/cancel the matching
  assistant item. Stale audio deltas after cancellation are intentionally
  dropped.
- End-call and transfer paths drain queued audio. A caller barge-in during a
  goodbye cancels the pending hangup.
- Live transfer hours are Richa's independent calling window (default
  09:00–21:00 salon time), not salon operating hours. Active vacation still
  suppresses the live call and uses SMS message delivery.
- A failed transfer returns to a new Erica segment without duplicating the
  original call start or recording record and without dialing Richa twice.

## Write-path and privacy invariants

- Identification requires a confirmed warmed caller-ID account or a successful
  lookup for account actions; knowing a name alone is not identity. Never ask a
  recognized caller for their phone number.
- The recognized caller's `UNCONFIRMED`/`CONFIRMED`/`REJECTED` transition is
  currently model-tracked prompt state, not a deterministic server enum. Do not
  report it as server-enforced until tool authorization is implemented.
- Appointment details may be discussed only with the identified appointment
  owner. Never confirm another person's appointment, schedule, or whereabouts.
- Never speak or log a private phone number. A transfer connects the call
  without revealing Richa's number.
- Booking/rescheduling needs explicit caller confirmation of the final details.
- Booking validates against slots actually offered during the call, then
  rechecks fresh availability immediately before the write.
- Cancel/reschedule acts only on appointment IDs served into the current call.
- Server-resolved names should drive owner SMS, not untrusted model-supplied
  identity text.
- A Phorest client must never be automatically spam-blocklisted.
- Running-late messages should preserve how late the caller said they are and
  whether the existing schedule can squeeze them in.

## Person-versus-service invariant

“Is Richa available at six?” contains a person and time, not a service. The
correct behavior is to ask which service the caller wants before checking
calendar availability.

The current defense is intentionally redundant:

1. Prompt reference says Richa is the owner/staff member.
2. `suggest_availability.serviceName` explicitly forbids a person.
3. `matchStaffName()` recognizes exact, fuzzy, and token-wise staff-name use in
   phrases such as “Richa availability.”
4. The handler returns a coaching note rather than querying Phorest with the
   person's name.

Do not replace these layers with a longer prompt paragraph. The latest 2.1 call
passed this scenario, but keep it in regression tests and live-call scripts.

## Fix ladder

Use the lowest deterministic layer that can own a failure:

1. Tool-result note for state-specific conversational coaching.
2. Tool description/schema when an argument contract is wrong.
3. Server guard when the action can be detected deterministically.
4. Conversation flow/state change when the model lacks reliable state.
5. Prompt prose only for broad behavior that cannot be encoded below.

Every important fix should be exercised across the seam where the bug occurred.
For example, a person-as-service fix needs a real handler test, not only a
string assertion on the prompt.

## Operations and evidence

- `data/dev.log` is truncated when the dev server boots. `tsx watch` restarts
  also kill active calls, so do not edit during a live test.
- The append-only call store is the durable record; two transfer segments can
  contribute to one logical call and must be joined correctly.
- Dual-channel Twilio recording is the upstream ground truth for who said what.
- Production log retrieval should use the exact Railway deployment ID when a
  newer deployment has replaced the container.
- Never deploy merely to discover whether a change compiles or passes tests.
  Use local tests/build first, then the direct Twilio staging path while Vonage
  forwarding remains off.
- Prepend new dated status to `state.md`; do not erase history. The top of that
  file is authoritative when old summaries conflict.
