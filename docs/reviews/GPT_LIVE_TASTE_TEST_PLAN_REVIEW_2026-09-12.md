# Review: GPT-Live taste-test implementation plan

Date: September 12, 2026. Reviewer: Jarvis (Fable). Subject:
[`GPT_LIVE_TASTE_TEST_IMPLEMENTATION_PLAN_2026-09-12.md`](../GPT_LIVE_TASTE_TEST_IMPLEMENTATION_PLAN_2026-09-12.md).

**Verdict: approve with specific changes.** The architecture, baseline, engine
pinning, real-reads/simulated-writes boundary and the Terra → Luna → Realtime
comparison are right. The plan over-builds P2–P4 for a listening test, puts the
test boundary at a layer the production code does not have, leaves the prompt
split without its own milestone, and misses four side-effect paths. With the
changes below the first audible call is a 1-day job and the comparison is a
2–3 day job.

Everything below was checked against production source `8533e61`
(`twilioStream.ts` 5,584 lines), `booking.ts`, `env.ts`, `routes/twilio.ts`,
`scripts/test-call-local.sh`, the September 10 Live probes, and a green
`npm test` on main (554 tests / 46 files). No code, config, call or deployment
was changed by this review.

## 1. Blocking correctness issues

### 1a. P0 — the boundary must be selected at module level, not "wired around" the controller

The plan proposes `src/voice/testEffects.ts` "plus minimal dependency wiring
around existing `PhorestPort`, owner SMS/recaps and transfer clients". There is
no dependency seam to wire. The controller imports `phorest`, `sendOwnerSms`,
`maybeSendPostCallSummary` and `recordSpamOutcome` as module singletons and
calls `getTwilioClient()` directly for transfer, hangup, recording and
failover. Injecting these into a 5.5k-line class is a refactor with Realtime
regression risk, exactly what the plan says to avoid.

**Smallest correction.** Select simulated implementations where the singletons
are already selected, driven by one explicit env value that is a third state,
never a reuse of `USE_MOCK_PHOREST`:

- `src/services/phorest.ts`: when `PHOREST_WRITE_MODE=simulate`, export
  `simulatedWrites(realPhorest)`: a `PhorestPort` wrapper that delegates every
  read to the real client and intercepts `createAppointment`,
  `updateAppointment`, `cancelAppointment` and `addAppointmentNote` into an
  in-memory overlay. `listAppointments` and `getTodayAppointments` merge the
  overlay so a simulated booking can be listed, moved and cancelled. Return the
  same shapes the real client returns (a simulated appointment ID with a fixed
  `sim_` prefix) so both engines speak identical results. Refuse to boot in
  production unless the value is exactly `real` or `simulate`, mirroring the
  existing `USE_MOCK_PHOREST` fail-fast.
- `src/services/ownerSms.ts`: `OWNER_SMS_MODE=simulate` returns
  `{ queued: true, simulated: true, sid: 'SIM…' }` before touching Twilio. This
  covers caller messages, schedule-change FYIs, transfer FYIs and the post-call
  recap in one place because they all route through `sendOwnerSms`.
- Transfer: gate `handleTransferToOwner`'s `calls.update({twiml:<Dial>})` and
  `failoverToOwner`'s `<Dial>` on the same mode and return a labelled
  `simulated: 'no-answer'` outcome. Hangup (`status:'completed'`) and
  `recordings.create` stay real.

Because the flag is process-wide it covers both engines automatically, which is
what P0's "apply the boundary to either engine" needs. Realtime outside test
mode is unchanged because the default is `real`. Keep the existing prompt
snapshot test as proof.

### 1b. P0 — four side-effect paths the plan does not list

1. **Owner failover dial.** `onClose` and fatal errors run `failoverToOwner`,
   which dials `OWNER_PHONE` with a Polly apology. A Live session that drops
   during a test (the 1-in-7 stall class, or any adapter bug) rings Richa's
   personal phone. Must be inside the boundary.
2. **Blocklist writes.** `cleanup()` calls `recordSpamOutcomeIfNotClient` for
   spam-tagged calls. A test call that ends via `end_call{reason:'spam'}` puts
   the tester's number on the blocklist. Add the test phones to
   `SPAM_NEVER_BLOCK` in the test env or suppress blocklist writes in test mode.
3. **Daily digest.** `DIGEST_ENABLED` defaults to `true`. A hosted test day
   texts Richa a digest of test calls the next morning. Set it `false` on the
   test deployment and tag simulated calls in CallStore so the digest, the
   admin dashboard and the `call-review` routine can exclude them.
4. **CallStore rows.** Simulated bookings and messages must be written as a
   distinct event kind (the plan says this) and the call row must carry
   `engine`, `backendModel` and `simulated: true`, or the September QA
   routines will count taste-test calls as production.

### 1c. P1 — build Live as an adapter into the existing controller, not a second controller

§7 proposes `src/voice/engine.ts` + `src/voice/liveCall.ts` alongside
`liveSession.ts`. If `liveCall.ts` is a new call controller, every tool
handler, ownership guard, nearby-date path, staff guard, duration cap,
recording start and CallStore write gets duplicated or dropped for the test.
That is the hardest-won logic in the repo and it is where the taste-test
scenarios live.

**Smallest correction.** `liveSession.ts` implements the existing
`RealtimeHandlers` + `registerTool` / `appendTwilioAudio` / `injectContext` /
`requestGreeting` / `close` surface, and `TwilioRealtimeCall` constructs one or
the other in `createSession` based on the pinned engine. Realtime-only calls
(`truncateActiveResponse`, `setAutoResponses`, `getCurrentResponseId`) become
no-ops on Live and the four places that depend on Realtime semantics get an
engine branch:

- `onSpeechStarted/Stopped` come from an input-energy gate; `handleBargeIn`
  (Twilio `clear` + truncate) is skipped for Live.
- Marks: forward every output frame, but send a mark only at the end of each
  energy-detected speech segment. `markQueue` then means "speech not yet
  played" on both engines, so `greetingPlayedOut`, `waitForPlaybackToDrain`,
  the silence watchdog and the end-call/duration-cap goodbye drain keep
  working without rewrites. Continuous silence must never count as speech.
- `injectContext` routes by engine: live-side notes via
  `session.instructions.append` (`delegation_id:null`, ≤500 tokens); backend
  notes by resending the full backend instructions in a `session.update` that
  includes `delegation.type:'responses'`, awaiting `session.updated`.
- `onResponseComplete` never fires on Live; the one consumer that matters for
  the test (end-call goodbye settlement) already has a time cap.

A separate Live controller is the right long-term shape and belongs in P6.

### 1d. The prompt split is missing as a milestone

The plan mentions `livePrompts.ts` in §7 and "context split" in P2, but the
first checkpoint call in P1 cannot happen without a Live prompt and a backend
prompt, and lessons.md records that most production failures were prompt
salience failures. This is the highest-leverage work for what Aryan will hear.

**Correction.** Add a checkbox between P1's adapter and its checkpoint call:
`buildLivePrompt()` (≤900 tokens: identity, recorded-line greeting wording,
backchannel / interruption / delegation policy, today's hours and status from
the existing status builder) and `buildBackendPrompt()` (the current
`buildInstructions` sections minus Realtime protocol lines, plus the compact
catalog with IDs). Ship both with a render script, run the "no quotable
example line" grep from lessons.md before the first call, and snapshot-test
that the Realtime prompt bytes are unchanged.

### 1e. Effort setting conflicts between the three documents

The plan says start both backends at `low`; the design doc says default first,
`low` as a separate change; the evaluation measured Terra at default and Luna
at both. Use **default** for the first comparison on both, `low` as a labelled
variant only if delegated-answer latency misses the target. Never `minimal`.

## 2. Work to remove or defer without weakening the owner test

| Milestone | Cut for the taste test | Why | Lands in |
| --- | --- | --- | --- |
| P2 | Revision-ordered context update queue; "different person on a known number" as a done criterion; prepared backend snapshot with task revision | Production already has the shortcut: `lookup_customer` with no args returns the warmed record, and late recognition already upgrades the call. Put the existing recognized/unrecognized note into the backend instructions at start (or one `session.update` if late). Nothing else. | P6 |
| P3 | Feasible-sequence visit planner for threading + tint | The comparison question is whether Terra/Luna plan the visit better than Realtime *given the same tools*. Give the backend `list_appointments` + `reschedule_appointment` (simulated) and let each backend plan. A planner tool pre-empts the very thing being compared. Keep the canonical-ID seam (§5 below). | P6, only if the evidence says models cannot plan it |
| P3 | Task revisions and "late availability must not become a current offer" | Real race, but a P6 write-integrity guarantee. For the test, log offered slots per date as production already does. | P6 |
| P4 | Transcript-evidence validation of approval; proposal expiry | Keep the *shape* the owner will hear: a `prepare_appointment_action` tool that returns the exact facts to read back, and a `confirm_appointment_action` tool that requires the proposal ID and is the only path to the simulated write. Do not build evidence validation yet. This is the smallest form of the September 9 readback fix and it changes the conversational feel, so it belongs in the test. | Evidence gate in P6 |
| P4 | Exact caller-message capture on Live fragments | SMS is suppressed anyway. For the test, `leave_message_for_owner` takes the backend's relayed text and the store labels it `modelRelayed: true, notExactCapture: true`. The 400 lines of Realtime item-keyed capture stay untouched. | P6 |
| P5 | Authenticated, server-owned identity scenario selection | Replace with §6 item 1 (map outbound test calls to the tester's number). Real Phorest records then drive recognized / unknown / with-appointment cases, and the per-process overlay provides "recognized with a simulated appointment" after the first booking call. | Not needed |
| P1 | Cross-engine greeting fallback to Realtime | Retry the commentary once; if no speech within 5 s, log and end the call. Mid-call engine switching is P6+. | P6 |

Make the overlay **per process**, not per call. A booking simulated in call 1
should be visible in call 2; that is both more realistic and how the
"recognized caller with an appointment" case gets set up without fixtures. It
clears on restart, which is the intended reset.

## 3. Does the boundary cover every write, notification and transfer path in both engines?

With §1a and §1b applied, yes. The full list from the production source:

| Path | Site | Covered by |
| --- | --- | --- |
| Client create + booking | `bookAppointment` → `phorest.createAppointment` | `PHOREST_WRITE_MODE` wrapper |
| Reschedule | `phorest.updateAppointment` | wrapper |
| Cancel | `phorest.cancelAppointment` | wrapper |
| Running-late note | `phorest.addAppointmentNote` | wrapper |
| Caller message SMS, schedule FYI SMS, transfer FYI SMS, post-call recap | all via `sendOwnerSms` | `OWNER_SMS_MODE` |
| Live transfer `<Dial>` | `handleTransferToOwner` | mode gate |
| Failover `<Dial>` | `failoverToOwner` | mode gate (missed by the plan) |
| Blocklist | `recordSpamOutcomeIfNotClient` | `SPAM_NEVER_BLOCK` or mode gate (missed) |
| Daily digest | `services/digest.ts` scheduler | `DIGEST_ENABLED=false` on test deploys (missed) |
| Hangup, recording | `calls.update`, `recordings.create` | intentionally real |

Not a side effect but worth stating: real Phorest **reads** in test mode still
return real client names and appointments to whoever is on the test line. That
is acceptable because the tester is the owner or Aryan; it is another reason
never to enable the test mode with customer intake on.

## 4. Can managed Responses plus prepared context avoid redundant lookup turns without losing identity control?

Yes, and mostly with code that exists. Sequence for a Live call:

1. `start` event → `prepareCallerContext` runs as today, racing the Live
   handshake. If the match lands inside the greeting cap, the recognized or
   unrecognized note is part of the backend instructions in `session.start`.
2. If it lands late, one backend `session.update` carries the note. Production
   already handles late recognition (`adoptRecognizedCaller` with `late:true`).
3. `lookup_customer` with no args serves the warmed record; the backend never
   needs a Phorest round trip for a recognized caller, and if it calls the tool
   anyway it is a cache hit.
4. Identity control is unchanged: the note says a candidate match exists and
   the prompt's existing one-question confirmation rule still gates disclosure.
   No name in the cold open, per lessons.md.

Nothing in this needs a revision counter for the test. Where the plan is right
is that a candidate match must not be treated as identified; the existing note
wording already draws that line and should be carried over verbatim in
meaning, not in quotable form.

## 5. Does canonical-ID selection and minimal planning reuse enough calendar logic?

The seam is smaller than the plan describes and should be done exactly this
way:

- Add `suggestSlotsById(serviceId, date)` next to `suggestSlots` that skips
  `resolveService` and calls `phorest.getAvailability(svc.id, date)` after
  validating the ID against the current catalog. Everything downstream in
  `handleSuggestAvailability` (grid snap, hours filter, spread selection,
  nearby-date fallback, offered-slot tracking) is reused unchanged.
- The tool contracts gain an optional `serviceId`; when present, the handler
  bypasses the `matchCallerNamedStaff` guard. That guard runs on the raw
  `serviceName` before any catalog match, which is exactly why "eyebrow
  threading and upper lip" became "Manu" on September 10. Keep the guard for
  name-only calls.
- The backend prompt carries the compact catalog (ID, name, price, duration,
  approved aliases). The TPM lesson that kept the 63-item menu out of the
  Realtime prompt does not apply here: the backend is a Responses model, its
  prompt caches above 1,024 tokens, and it is not re-billed per audio turn.
- `get_prices` and `suggest_availability` must resolve through the same ID so
  the caller never hears one price and then a different match.

For multi-service visits, use the existing catalog bundles and let the backend
plan with `list_appointments` + `reschedule_appointment` (§2). Do not add
calendar math outside `booking.ts` / `slots.ts`.

## 6. Missing audio, delegation and recognition checks

1. **Outbound test calls carry the salon number as `From`.** The plan notes
   this and proposes scenario fixtures. The 5-line fix: in `/voice`, when
   Twilio's `Direction` is `outbound-api` **and** test mode is on, use `To` as
   the caller identity for prefetch and CallStore. Real caller-ID recognition
   is still proven only by the hosted inbound call, as the plan says.
2. **Send `store:false` in `session.start`** and assert it in the config
   echo. The two design documents disagree on the default; sending it
   explicitly makes the disagreement irrelevant. Caller audio must not be
   retained by OpenAI for 30 days.
3. **Measure the recording disclosure, not just the greeting.** Live cannot
   speak a script verbatim (LiveKit's documented caveat). Maryland two-party
   consent needs the disclosure in every greeting. Log, per call, whether the
   output transcript contains it, across the ten P1 greetings. This is not a
   taste-test gate (the caller is the owner) but it is a P7 gate and P1 is
   where it is cheap to measure.
4. **Latency numbers must be re-taken with the real backend prompt.** The
   September 10 figures used a tiny prompt with no cache hits. The first
   delegation with the full catalog prompt is a different number; record cold
   and warm separately as the plan says.
5. **Server-side stall.** One of seven probe runs bunched events for ~10 s.
   Add a bounded outbound buffer and a "no output audio for N s while a
   delegation is pending" log line so a stall in a test call is attributable.
6. **Speakerphone and handset.** Live's turn-taking is the headline claim.
   Run at least one call per variant on speakerphone; telephony has no echo
   cancellation (lessons.md) and the comparison is only fair if Realtime and
   Live face the same echo.
7. **Catalog snapshot.** Pin the catalog cache for the test day so a mid-test
   Phorest edit cannot change what one variant sees.
8. **Realtime baseline must run the simulated overlay too.** If the overlay
   returns a different shape than the real client, the Realtime variant's
   spoken result changes and the comparison is contaminated. Same-shape
   returns (§1a) are the fix; add a contract test that the wrapper's return
   types equal the real client's.

## 7. Revised effort

| Milestone | Plan | Revised | Basis |
| --- | --- | --- | --- |
| P0 boundary | 0.5–1 h | 2–3 h | Four extra paths, wrapper with overlay merge, CallStore tagging, contract test |
| P1 adapter + prompts + checkpoint call | 3–5 h | 5–7 h | Prompt split added; adapter into existing controller with four engine branches; `store:false`; disclosure log |
| P2 caller context | 2–4 h | 1 h | Reuse existing prefetch and notes; one `session.update` |
| P3 canonical IDs | 3–5 h | 2–3 h | Planner cut; `suggestSlotsById` + `serviceId` on tools + catalog in backend prompt |
| P4 simulated actions + evidence | 2–4 h | 3–4 h | Prepare/confirm tools kept; evidence validation and exact capture deferred |
| P5 comparison | 1–2 h | 2–3 h | Six calls plus replays plus the hosted inbound call |
| **Total** | **12–21 h** | **15–21 h** | First audible call after P0 + P1: about one focused day |

The range is unchanged at the top and honest at the bottom. The plan's 4–6 h
to first audio is optimistic only because it does not count the prompt split.

## Revised checklist for Codex (replaces §4 of the plan)

- [ ] **P0** Branch `codex/gpt-live-taste-test` from `8533e61`; tests + build
      green. Add `VOICE_ENGINE` selection pinned per call and carried through
      `/dial-status`. Add `PHOREST_WRITE_MODE`, `OWNER_SMS_MODE`, transfer /
      failover gate, `SPAM_NEVER_BLOCK` for test phones, `DIGEST_ENABLED=false`
      in the test env, CallStore `engine` / `simulated` fields. Contract test:
      wrapper return shapes equal the real client's. Prompt snapshot test:
      Realtime prompt bytes unchanged.
- [ ] **P1a** `liveSession.ts` implementing the existing session surface:
      `session.start` with `store:false`, pcmu 8 k, Marin, Responses delegation;
      input/output energy gates; speech-segment marks; greeting pattern B with
      one retry; delegation loop (all outputs → one `response.create`);
      `session.update` with `delegation.type` for backend context; close with
      final usage. Unit tests on event mapping, energy gate, continuation.
- [ ] **P1b** `buildLivePrompt()` and `buildBackendPrompt()` with a render
      script; quotable-line grep; catalog with IDs in the backend prompt.
- [ ] **P1c** First checkpoint call (local harness with the `Direction`
      mapping): greeting, hours question with zero delegation, one price
      question with delegation, interrupt, goodbye, clean teardown. Log
      disclosure presence and stage latencies. **Invite Aryan.**
- [ ] **P2** Recognized / unrecognized note into backend instructions at
      start or via one late `session.update`. Verify known-with-appointment,
      known-without, unknown, slow lookup.
- [ ] **P3** `suggestSlotsById`; optional `serviceId` on `suggest_availability`,
      `get_prices`, `book_appointment`; staff guard bypassed when an ID is
      given. Verify "eyebrow threading and upper lip", tattoo vs touch-up,
      henna brows, full day → nearby dates.
- [ ] **P4** `prepare_appointment_action` / `confirm_appointment_action`
      (proposal ID required; the only path to a simulated write); simulated
      book → change → cancel visible across calls; relayed-message tool
      labelled as not exact capture; engine-aware cost accounting.
- [ ] **P5** Six owner calls (two per variant, handset and speaker), matched
      replays, hosted inbound call with intake verified disabled, result sheet
      with recordings, stage latencies, cost, action trace and a preferred
      candidate or blocker.

Deferred to P6, unchanged from the plan: approval evidence validation, exact
message capture on fragments, ordered/deduplicated real writes, real transfer
and failback, cross-engine fallback, visit planner if needed.
