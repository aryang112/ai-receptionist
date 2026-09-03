# Functional Reliability Backlog — Live Forwarding

**Created:** 2026-09-02

**Production behavior commit:** `eca23f1`

**Railway deployment:** `de80d873-ce67-4f6d-a892-30e8ee53b663` (`SUCCESS`)

**Immediate rollback code baseline:** `e1e5268` (the superseded Railway
deployment is removed, so redeploy the commit)

**Operational state:** forwarding is ON

**Production rule:** do not deploy code, prompt, configuration, model, voice, or
Realtime session changes during live/business hours. The work below may be
implemented and tested locally, but a production release must wait for an
owner-confirmed after-hours quiet window.

This is the implementation backlog from the 2026-09-02 functional red-team
pass. It supplements—not replaces—the broader prompt audit in
[`PROMPT_AUDIT_2026-09-01.md`](PROMPT_AUDIT_2026-09-01.md).

## Executive decision

The current container passed synthetic/intercepted happy paths for the common
basic flow: one caller, one service, one booking/change at a time, ordinary API
responses, and a normal goodbye. Forwarding is operationally owner-enabled,
but these checks were not an end-to-end direct-phone booking certification
against every production dependency.

Most findings need a particular timing, failure, or unusual sequence. They are
real, but they are not all equally likely. The exceptions worth treating as
the first after-hours reliability release are the findings that can create or
change salon records incorrectly, mishandle an away-period message, or dial
Richa while she is away.

The owner authorized the first scoped after-hours release later that evening;
its exact status is recorded below. This document does not authorize any
additional production change.

**Configuration boundary:** `business.json.vacations` means the entire salon
is closed. It is correct for the current one-person salon. A future salon where
one stylist is away while others work needs provider-specific availability;
never represent that case with this salon-wide closure mechanism.

## After-hours release status — 2026-09-02

The deployed release intentionally fixes the vacation-period basics without
claiming the entire P0 architecture is complete.

| Item | Status after deployment | Evidence / remaining boundary |
| --- | --- | --- |
| FR-01 known closed dates | **Fixed for known closures** | Suggest, book, and reschedule reject the local closed date before any Phorest read/write. Open-date provider failures remain fail-closed. |
| FR-03 duplicate new client | **Fixed in-process** | One normalized phone + confirmed-name subject shares client resolution; optional email cannot split it. Exact contact matches are ranked and ties fail closed. |
| Client-create unknown outcome (part of FR-05) | **Fixed in-process** | A possibly committed create is latched and later attempts are bounded read-only reconciliation only. The latch is not restart-durable; appointment write timeouts remain open. |
| FR-08 caller message provenance | **Fixed** | Live transfer and message delivery are separate tools. Only exact caller transcripts inside an active collection state can be sent; offers, consent-only turns, stale pivots, and premature calls fail closed. |
| FR-09 SMS acceptance | **Fixed** | Five-second cap, SID requirement, explicit positive/terminal/unknown status mapping, and truthful result-specific speech. |
| FR-10 cancelled reschedule | **Fixed** | Cancelled appointment IDs are rejected by reschedule in the same call. |
| FR-19 unnecessary narration | **Fixed for reproduced flows** | Message-taking is silent before the tool, then one ordinary acknowledgement; direct hours/prices stay one-line. Broader conversation-quality work remains P2. |
| Subject-aware away/closure flow | **Fixed for the active closure** | One config-driven policy distinguishes Richa questions, salon/hours questions, affected bookings, and unrelated providers. Explicit and bare Richa requests state unavailability plus the full September 10 reopen date; unrelated-provider whereabouts are never invented. |
| New-client email | **Fixed for new writes** | A supplied email is trimmed and included; absent/blank email is omitted. No synthetic placeholder is generated. Existing placeholder records, including Tony Stark, are unchanged. |
| FR-02 / FR-04 / appointment portion of FR-05 / FR-06 / FR-07 / FR-11 | **Still open** | Per-call appointment mutation queue, semantic idempotency, appointment-write reconciliation, source-response settlement, fatal-Realtime away fallback, and appointment-subject binding were not mixed into this vacation release. |

Release evidence: 44 files / 512 tests passed locally and under `TZ=UTC`;
TypeScript build, formatting, diff, and prompt-budget checks passed. Live
`gpt-realtime-2.1` probes on the exact candidate covered today/tomorrow/reopen
hours, explicit and bare Richa requests, affected booking, and an unrelated
provider. Deployment health was HTTP 200, with 63 real services and 4,188
clients loaded completely. No direct phone ear call was made during this
automated pass, so continue to compare recordings with transcripts and use the
rollback code baseline above on any material regression.

## Is this a prompt fix?

Usually, no. A prompt tells the model what it should do; it cannot guarantee
what the program will do. OpenAI's Realtime API reference describes
`instructions` as guidance and explicitly notes that the model is not
guaranteed to follow it. The same API can allow multiple function calls in
parallel. Therefore any rule protecting bookings, client records, call
termination, or messages must be enforced by application code.

Use this fix ladder:

1. **Tool-result note** for advice that is only relevant after a particular
   result, such as “the booking outcome is uncertain; do not try again.”
2. **Tool definition/schema** for when a tool may be called and what each
   argument means.
3. **Application code/state** for invariants such as one mutation at a time,
   no duplicate write, no booking on a closed date, and no hangup while a
   write is unresolved.
4. **Conversation-flow state** when Erica must ask, wait, confirm, then act.
5. **Main prompt prose** for stable identity, tone, privacy, and broad behavior.

If the proposed fix is only “add another scenario paragraph to the prompt,” it
is a band-aid for every data-integrity finding below. A small prompt or tool
description change can still be useful as defense in depth after code owns the
guarantee.

### Multiple services for one client

Two appointment records may be legitimate when one person requests two
different services; the defect is not simply “more than one booking.” A live
Realtime probe with intercepted tools exposed two booking tool calls only 31
ms apart for a recognized client. In a separate local real-adapter simulation,
two concurrent bookings for one new caller created two client profiles and
booked against different client IDs. Parallel calls can also try to reserve
overlapping times or repeat the same service.

The correct layers are:

- **Root fix — code:** resolve the appointment subject to one canonical client
  ID, put all appointment-changing tools through one per-call mutation queue,
  and dedupe identical semantic operations. The identity key must be a known
  client ID or normalized phone plus confirmed full name—not phone alone,
  because family members can share a number.
- **Multi-service behavior — flow/code:** process confirmed services in order,
  re-check availability after each success, and clearly report partial success
  if service one books but service two does not.
- **Short-term guard — tool schema/config:** say “one appointment-changing call
  at a time” and consider `parallel_tool_calls: false` only after a staged live
  validation. This reduces exposure but is not the data-integrity guarantee.
- **Prompt:** one concise rule may support the above, but prompt-only prevention
  is a band-aid and should not be accepted as the final fix.

### Timeouts

A timeout is not merely an exception that should be caught politely. For a
read, a timeout normally means no state changed, so Erica can retry once or
apologize. For a booking, reschedule, cancellation, or client creation, the
request may have reached Phorest and succeeded even though the answer never
reached Erica. That is an **unknown outcome**, not a known failure.

The HTTP client already avoids automatically retrying non-idempotent writes.
The remaining risk is that the model hears “error” and calls the write tool
again, or that two equivalent calls were already in flight.

The proper write-timeout design is:

1. Record a semantic operation key before sending the write.
2. On timeout, latch that operation as `uncertain`; do not submit it again.
3. Reconcile with Phorest by reading the relevant client's appointments and
   matching service, date, time, and prior appointment state.
4. Return one of `confirmed_success`, `confirmed_failure`, or `uncertain`.
5. If still uncertain, tell the caller it must be checked and create an owner
   follow-up; never claim either success or failure.
6. Put the no-retry instruction in that tool result as immediate coaching, but
   keep the actual retry block in code.

Graceful wording is the last step. It improves the caller experience, but it
does not prevent duplicate salon records.

## Prioritized backlog

Layer key: **Code** = deterministic application behavior; **State/flow** =
conversation or operation state machine; **Tool** = tool contract/result;
**Config** = provider/session setting; **Prompt** = broad model instruction;
**Ops** = monitoring or release procedure.

### P0 — first after-hours reliability release

These items can corrupt appointment/client state or violate the active
away-period behavior. Resolve the owner-policy item, implement the agreed code
changes together locally, then release only through the after-hours gate below.

| ID | Failure | Correct fix layer | Root fix | Prompt's role |
| --- | --- | --- | --- | --- |
| FR-01 | A closed/vacation date can become bookable if the availability request errors. The current fresh check fails open. | Code | Check local business closure before any API call and fail closed for a known closed date. For an API error on an otherwise open date, make no write and offer to retry/check later. | None required; a result note can explain the safe recovery. |
| FR-02 | Two booking/reschedule/cancel calls can execute concurrently in one call, including duplicate FYI notifications. | Code + state | Add one per-call mutation queue/lock. Reads may remain parallel; writes and their notifications must be ordered and exactly once. After each mutation, refresh the state needed by the next one. | “One write at a time” is defense in depth, not enforcement. |
| FR-03 | Concurrent booking calls for a new caller can create duplicate Phorest client profiles. | Code | Make client resolution single-flight using a known client ID or normalized phone plus confirmed full name. Cache that appointment subject's canonical client ID; deliberately switching family member/subject must switch the binding. Add a second lookup before creation where safe. | No prompt fix. The model should not manage client identity concurrency. |
| FR-04 | Duplicate `call_id` events or semantically identical model calls can perform the same write and FYI twice. | Code | Coalesce/ignore an exact repeated OpenAI call ID without emitting a second output or `response.create`. For a different call ID with the same semantic key—call + subject + action + appointment/service + date/time—reuse the first operation outcome without another write/notification. | Tool-result note may say the request was already handled; prompt cannot guarantee idempotency. |
| FR-05 | A timed-out write may have committed; a model retry can duplicate it. | Code + state + tool result | Capture pre-write state, durably latch the operation before sending when restart protection is claimed, and reconcile with bounded repeated reads. Do not treat one absent read as proof of failure because visibility may lag. Block retries and remain `uncertain` unless success/failure is authoritative. Avoid attributing a pre-existing identical appointment to the new write. | Immediate result coaching only; no general scenario paragraph. |
| FR-06 | `end_call` can close while another tool from the same model response is queued or delayed, so a later write/result can be lost. | Code + response-batch state | Keep the existing in-flight guard, but add a per-source-response settlement barrier. `end_call` must be exclusive in its source tool batch; reject/defer it if any other tool is present, and never create the farewell continuation until every source tool settles. Wait for queued/in-flight writes; if an outcome becomes terminally `uncertain`, disclose it, record follow-up, then allow closure rather than waiting forever. | “Wait for the result” supports the code but cannot own the barrier. |
| FR-07 | The deliberate fatal OpenAI fallback currently can dial Richa during the away period. Whether this emergency exception remains is an owner policy decision, not a prompt bug. | Owner decision + deterministic telephony code | If “never dial while away” is absolute, replace the vacation-period fatal path with model-independent TwiML: a fixed apology/away message plus a chosen voicemail/message-capture path, or a fixed apology and hangup. Cover fatal error, unexpected close, session rejection, and breaker trip. If emergency dialing is desired, explicitly retain and document it. | No prompt can operate after the Realtime session has failed. |
| FR-08 | A generic transfer reason such as “wants Richa” can be sent as though it were the caller's actual message when transfer is suppressed. | Separate tool/schema + code + flow | Separate live transfer from message-taking. Require explicit caller consent and caller-authored message content grounded in captured transcript/state; if either is absent, send nothing and ask for the message. Never synthesize it from an internal transfer reason. | Prompt can govern tone, but provenance and the content gate are the root fix. |
| FR-09 | Twilio can return an SMS with terminal `failed` status, but the current path treats it as queued; the SDK call can also wait about 30 seconds. | Code + state | Require a SID; map Twilio create-response statuses into `accepted_for_delivery`, `terminal_failure`, or `uncertain`; reject `failed`, `undelivered`, and `canceled`; handle legitimate nonterminal/positive states such as `queued`, `sending`, `sent`, `scheduled`, and `delivered` without claiming delivery too early. Add a short bounded timeout, whose outcome is `uncertain`. | Tool-result coaching permits only truthful wording such as “I've passed that along for delivery,” not “it was delivered.” |
| FR-10 | A cancelled appointment can still be passed into reschedule. | Code | Maintain appointment lifecycle state and reject reschedule unless the selected appointment is currently active/booked. Refresh after cancellation. | None beyond explaining the result naturally. |
| FR-11 | Appointment ownership can drift if the call changes or confuses client identity, allowing a write against the wrong person's appointment. | Code + state | Bind appointment IDs to the confirmed appointment subject. Require deliberate re-identification before switching family member/client; switching must invalidate incompatible selections without forgetting the prior mapping. | Privacy principle stays in the prompt; the ownership check belongs in code. |

### P1 — next reliability release

These are important but need narrower timing, identity confusion, or telephony
ordering than the P0 items.

| ID | Failure | Correct fix layer | Root fix | Prompt's role |
| --- | --- | --- | --- | --- |
| FR-12 | The existing Realtime response guard has a small acknowledgement gap: a second `response.create` can be sent after the first request but before `response.created` arrives. | Code + state | Track `idle → requested → active → terminal`; sending moves to `requested`, matching `response.created` moves to `active`, and only a matching terminal event returns to `idle`. Correlate a rejected create by `event_id`, and account for a server-VAD response anticipated after speech stops. Use a per-source tool-settlement barrier so one continuation includes all results rather than merely suppressing the second request. | No prompt fix. |
| FR-13 | All outbound Twilio marks use `responsePart`; a late acknowledgement after `clear` can consume the wrong/newer audio mark. | Code | Give every mark a unique monotonic ID, track it by response/audio segment, and ignore stale/unknown acknowledgements after a clear epoch. | No prompt fix. |
| FR-14 | A brief empty mark-queue gap can clip goodbye audio or mark the greeting complete even though more audio from that response is still being produced. | Code + state | Consider playback complete only after generation is terminal and all uniquely identified marks are acknowledged. If the Realtime terminal event never arrives, end/cancel the stalled generation after a generation cap, then drain known audio. If generation ends but a mark never arrives, perform a separately capped degraded close and log it. Never wait forever; preserve the existing barge-in abort. | Natural greeting/farewell wording is separate from delivery correctness. |
| FR-15 | A generic recoverable OpenAI error can clear the local “response active” flag even though that response has not reached its terminal event, allowing a colliding request. | Code + state | Classify and correlate errors. Keep `requested`/`active` state until the matching terminal event unless `event_id` proves the create itself was rejected; then return safely to idle and retry at most once. Add a bounded recovery watchdog for a missing terminal event. | No prompt fix. |

### P2 — quality and lower-risk correctness

These should be fixed, but they are less likely to create material salon state
errors during the basic vacation-period flow.

| ID | Failure | Correct fix layer | Root fix | Prompt's role |
| --- | --- | --- | --- | --- |
| FR-16 | Exact closing time is treated as available because the hours boundary is inclusive. | Code | Treat closing time as exclusive and ensure service duration fits before close. Add boundary tests. | No prompt fix. |
| FR-17 | Cancellation and reschedule FYI texts can omit the original appointment time, making multiple appointments ambiguous. | Code/template | Include salon-local original date/time—and the new date/time for reschedule—from server-owned appointment state; never trust the model to compose operational facts. | None. |
| FR-18 | Transcription heard “Richa” as “Rich/Richard” in 3/3 baseline probes. | Config + deterministic matching | Stage the already live-accepted English language and salon-vocabulary transcription hint; retain normalization for known variants. Validate real phone audio before deployment. | Prompt pronunciation context may help output, but ASR configuration/matching fixes input recognition. |
| FR-19 | Some direct replies contain no-op preambles such as “let me check” when no tool is used, or mechanical future-call language such as “wrap up.” | Conversation flow + small prompt cleanup | Tighten the existing no-fake-wait/no-call-mechanics rules, remove conflicting wording if found, and ear-test exact prompts. There is no tool-result note in the reproduced direct-answer case. | This is one of the few genuinely prompt-level fixes; keep it small rather than adding scenario scripts. |
| FR-20 | With a caller-supplied broad preference such as “afternoon,” Erica can ask for an exact time instead of checking the requested window even though the current prompt already says to use the daypart. | Tool schema + code | Accept an explicit daypart/window value and map/filter it deterministically server-side; make the tool easy to call without inventing an exact time. | The existing prompt instruction did not hold, so another prompt line alone would be a band-aid. |

## Normal flow versus edge case

| Scenario | Current production assessment | Release urgency |
| --- | --- | --- |
| One known or new caller books one service, API responds normally | Passed in tests/synthetic probes; not fully production-certified | Monitor |
| Caller checks hours/prices/availability | Passed in tests/synthetic probes | Monitor |
| Caller books Sep 10 or later; Sep 1–9 ordinary closure lookup succeeds | Passed in tests/synthetic probes | Monitor |
| Caller asks for Richa during the closure | Explicit or bare requests state that she is unavailable through September 10 and offer a message; no clarification is needed because both meanings are unavailable | Monitor message delivery failure variants |
| Caller asks about another provider during a salon-wide closure | Policy does not invent that provider's absence; live model had one sample that still offered a Richa message unnecessarily | Future multi-provider hardening; current one-provider salon unaffected |
| One caller asks for two services | Normal customer request, not an exotic edge case; unsafe concurrency was reproduced | P0 |
| Phorest write times out after reaching the provider | Uncommon timing case, high impact because it can duplicate records | P0 |
| Availability fails on a known closed date | Failure-path edge case, but can violate the vacation promise | P0 |
| Caller says “done” while a write is still running | Plausible conversational timing case, potentially silent state change | P0 |
| Late Twilio marks/response acknowledgements | Narrow race condition | P1 |
| Exact closing-minute request | Boundary edge case | P2 |

## Recommended implementation shape

### One mutation coordinator per call

All appointment-changing actions should pass through a small server-owned
coordinator:

```text
model tool request
  -> validate caller/client/appointment ownership
  -> bind known client ID, or confirmed full name + normalized phone
  -> compute semantic operation key
  -> coalesce exact call-ID duplicate without a second protocol output
  -> reuse the operation outcome for a different call ID with the same key
  -> enqueue behind any current mutation
  -> re-check closure and current availability/state
  -> perform write once
  -> reconcile if the outcome is uncertain
  -> store final result
  -> let Erica speak the result
```

This single component addresses FR-01 through FR-06 more safely than several
independent prompt rules. Start in memory for per-call ordering, but use a
durable operation ledger if protection must survive a container restart or a
new WebSocket segment. A deliberate switch to another family member must also
switch the appointment-subject binding rather than reusing the first client ID.

Separately, track each Realtime source response as a complete tool batch.
Publish all of that batch's tool outputs before requesting one continuation.
Treat `end_call` as exclusive within its source batch and arm the goodbye only
after every source tool has settled.

### Read and write failures need different policies

- **Read tools:** short timeout, one bounded retry where appropriate, then a
  clear apology and a safe alternative.
- **Write tools:** no blind retry. Reconcile first; report uncertainty honestly.
- **Notification tools:** bounded timeout and exact provider-status mapping;
  never tell the caller a message was sent unless acceptance is confirmed.

The current broad “retry tool errors once” model instruction should be narrowed
at the tool-result layer: retry a classified transient read failure; do not
retry a write timeout or any write whose provider outcome is unknown.

### Parallelism policy

Parallelism is useful for independent reads, such as fetching two dates or
warming caller history. It should not be used for appointment/client writes
until mutation ordering and idempotency are implemented. A staged
`parallel_tool_calls: false` experiment is a useful temporary belt, but code
must remain correct if the model, transport, or retry path still supplies two
calls.

## Acceptance tests for the first release

The first after-hours release is not ready until all of these pass locally:

- Two `book_appointment` calls emitted in one Realtime response execute in
  order and reuse one client ID.
- Two identical tool calls with the same call ID execute once and emit only
  one function output/continuation request.
- Two semantically identical calls with different call IDs create one booking
  and return the same outcome without a second write or FYI.
- Two legitimate services for one client are handled sequentially, with fresh
  availability and explicit partial-success wording.
- Concurrent and sequential duplicate cancel/reschedule requests produce one
  write and one FYI.
- A client-create timeout followed by a second booking call creates at most one
  client.
- A shared phone number with two deliberately selected family members never
  reuses the wrong client's ID.
- Booking/reschedule/cancel timeout with a simulated provider commit is found
  by reconciliation and is not repeated.
- Reconciliation does not mistake a pre-existing identical appointment for
  the timed-out write and tolerates delayed provider visibility; an outcome
  stays `uncertain` unless success or failure becomes authoritative.
- Every Sep 1–9 suggest/book/reschedule is rejected locally and makes zero
  availability or write calls, even when the remote mock would throw.
- Book → cancel and book → reschedule still work; book → cancel → reschedule is
  rejected with zero update calls.
- Unknown appointment IDs and appointment-ID-as-client-ID inputs stay safely
  blocked with zero writes.
- Switching appointment subjects cannot cancel/reschedule the prior subject's
  appointment without deliberate re-identification.
- Parameterized `[write, end_call]` and `[end_call, write]` source batches do
  not close. With a delayed write and early source `response.done`, the output
  is still delivered before any continuation/close.
- `end_call` paired with a read or transfer is rejected/deferred, not armed.
- A terminally uncertain operation is disclosed and queued for follow-up, then
  permits graceful closure without deadlocking.
- The owner records the fatal-fallback policy. If away means zero dials, fatal
  error, unexpected close, session rejection, and breaker trip make zero owner
  dials and use the chosen deterministic fallback.
- A generic transfer reason is never copied into an owner SMS as caller speech.
- Message SMS requires explicit consent and transcript-grounded content.
- SMS terminal failure, timeout, nonterminal acceptance, and delivered states
  produce truthful wording without claiming delivery from queue acceptance.
- Full `npm test`, `TZ=UTC npm test`, TypeScript build, and `git diff --check`
  pass.

P1 transport regression tests must additionally prove:

- First greeting chunk/mark, a temporary empty queue, and a later
  same-response chunk before `response.done` do not set `greetingPlayedOut` or
  enable automatic VAD responses. Both require terminal generation and final
  matching-mark drain.
- First farewell chunk/mark, a temporary empty queue, a later same-response
  chunk, terminal `response.done`, and the final matching mark never close
  early.
- A missing Realtime terminal event triggers the capped stalled-generation
  path; a terminal response with a missing Twilio mark triggers the separate
  capped degraded-playback close. Neither hangs indefinitely or closes before
  its documented cap.
- After clearing an old mark generation, late, duplicate, or out-of-order old
  acknowledgements cannot drain new audio.
- Two tool outputs around the `response.create` acknowledgement gap produce
  one continuation containing both results.
- An active response plus an unrelated recoverable error remains active until
  its matching terminal event.
- A rejected `response.create` correlated by `event_id` safely returns to idle
  and retries at most once.

P2 correctness tests must cover the end-exclusive closing boundary, original
date/time in cancel and reschedule FYIs, the staged Richa transcription hints,
and deterministic handling of a caller-supplied daypart.

Then validate by direct/staging phone before production:

- One normal Sep 10 booking.
- One two-service request for a new caller.
- One explicit message for Richa and one “Can I speak to Richa?” request with
  no message content.
- One simulated/controlled slow failure without touching a real appointment.
- One “done” utterance while a safe intercepted write is delayed.
- Listen for the entire result and goodbye; interrupt the goodbye once.
- Supply “afternoon” without an exact time and verify Erica checks that window
  instead of asking an unnecessary extra question.

## After-hours production gate

1. Owner confirms the salon is outside business hours and authorizes the
   release window.
2. Confirm there is no active call. A deployment drops an in-flight call.
3. Confirm the candidate commit contains only the reviewed reliability bundle;
   do not mix in service history, voice/VAD, personalization, or spam features.
4. Run the full acceptance suite and direct-number ear test before deployment.
5. Record the exact production commit, deployment ID, image digest, and
   immediate rollback deployment.
6. Deploy once, verify Railway status and `/health`, then make controlled test
   calls.
7. Review logs for duplicate mutations, Phorest errors, message status, fatal
   failover, and clipped audio.
8. Keep the rollback ready. Any in-hours emergency action requires explicit
   owner approval; this document does not authorize one.

## Monitoring while the current build remains live

Until the P0 bundle is released, pay special attention to:

- callers asking for two or more services;
- repeated or near-simultaneous booking tool calls;
- duplicate new-client profiles;
- booking/client/reschedule/cancel timeouts;
- a call closing before a write result is spoken;
- owner SMS terminal status and duration;
- any attempted dial to Richa during the away period;
- closed-date requests accompanied by an availability error.

If any of these appears, do not ask the caller/model to repeat a write blindly.
Check Phorest first to establish what actually happened.

## Deferred enhancements—not part of the reliability release

- Past-service-history personalization and “your usual service?” behavior.
- Availability pre-warming and more aggressive read-only parallelism.
- Semantic VAD, response-speed, reasoning-effort, or voice experiments.
- Advanced spam scoring or Twilio Lookup/Voice Intelligence integration.
- Additional human-like phrasing and proactive familiarity.

These may improve the experience later, but they should not be mixed into the
first after-hours correctness release. Reliability gives Erica the most human
quality that matters now: she remembers what she just did, never makes the
caller wonder whether an appointment exists, and never confidently states an
action that the salon system cannot confirm.

## References

- [OpenAI Realtime call/session reference](https://developers.openai.com/api/reference/python/resources/realtime/subresources/calls/methods/accept)
- [OpenAI GPT-Realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [OpenAI Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Twilio Media Streams WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
