# STATE — AI Receptionist (Erica)

> Working memory / handoff. Read `tasks/lessons.md` and `docs/CODEMAP.md` next.
> Last major work: 2026-06 — GA Realtime migration + ~25 production-bug fixes.

## 2026-08-21 — B3 IMPLEMENTED (worker agent): bound RT-5 retry churn under TPM starvation
Implemented `tasks/agent_queue.md` B3 code mitigation exactly (P0). Built on top
of B2 (commit 4795acc) without undoing its `clearFailedRetry()` call in
`input_audio_buffer.speech_started`. OWNER action (raise the OpenAI TPM tier)
is the real structural fix and is NOT something this worker can do — left open.
- **CODE** — `src/realtime/openaiSession.ts`:
  - New field: `private consecutiveResponseFailures = 0;` (declared next to
    the existing RT-5 fields, under a new `--- B3 ---` comment block).
  - `response.done`/`response.completed` handler: on `status === 'failed'`,
    increment the counter BEFORE deciding whether to retry. If it exceeds 2,
    log `⚖️  retry budget exhausted — no more RT-5 retries this streak` and do
    NOT call `scheduleFailedRetry()`. Otherwise (counter ≤ 2) behave exactly as
    before — log the existing warn and call `scheduleFailedRetry()`. On any
    non-`'failed'` completion (success, or a barge-in `'cancelled'`), reset
    `consecutiveResponseFailures = 0` (new `else` branch).
  - `input_audio_buffer.speech_started` handler (same case B2 touches): added
    `this.consecutiveResponseFailures = 0;` right after the existing
    `this.clearFailedRetry();` call — a new caller turn gets a fresh retry
    budget. Required per spec (not just "reset on success"): under sustained
    TPM starvation, responses may keep failing, so success alone might never
    fire and would permanently disarm retries for the rest of the call.
  - No `session.update` shape changes — this is all plain app-code state on
    the class, same pattern as B2's `clearFailedRetry()` call.
- **NEW tests** — `src/tests/openaiSession.test.ts`, describe block "B3 TPM
  retry-budget cap" (3 tests, using the existing `RT-5 failed-response retry`
  and `B2 stale RT-5 retry` fake-timer harness):
  1. "caps consecutive retries at 2 — a third consecutive failure schedules no
     retry" — 3 consecutive failed responses (each retry allowed to actually
     fire via `vi.advanceTimersByTime` before the next failure, since
     `scheduleFailedRetry` supersedes rather than stacks pending timers);
     asserts exactly 2 `response.create`s total, none for the 3rd failure.
  2. "a successful response resets the cap" — 2 failures (both retry, at the
     cap boundary), then a `status: 'completed'` response, then 2 more
     failures — asserts both post-success failures retry again (would fail if
     the streak carried over, since the 2nd would be the 4th consecutive).
  3. "speech_started also resets the cap" — same shape, but the reset trigger
     is `input_audio_buffer.speech_started` instead of a success.
  Existing `RT-5 failed-response retry` (single failure → one retry) and `B2
  stale RT-5 retry` tests are untouched and still pass unmodified — the cap
  permits the single-failure case they exercise (1 ≤ 2).
- **Verified:** `npx tsc --noEmit` clean. `npm test` → **107/107** (was 104,
  +3 new). `TZ=UTC npm test` → **107/107**. Barge-in tests
  (`twilioStream.bargein.test.ts`) untouched and green;
  `handleBargeIn`/`markQueue`/`bargeInEpoch` not touched. `twilioStream.ts`,
  `.env`, `business.json`, and Phorest write paths not touched (B3 is
  `openaiSession.ts` + its tests only, per the task's hard rules).
- Marked `[x]` in `tasks/agent_queue.md` with "(code mitigation implemented,
  awaiting Fable review/commit; OWNER action — raise OpenAI TPM tier — still
  open)" — this worker did not commit or push per instructions.

## 2026-08-21 — B2 FIXED (worker agent): stale RT-5 retry executes writes against switched intent
Implemented `tasks/agent_queue.md` B2 exactly (P0, code + prompt). Root cause:
`clearFailedRetry()` was only called on close/cleanup, so a scheduled RT-5 retry
(`response.create`, up to 10s later) could fire AFTER the caller switched intent
mid-call (e.g. "reschedule" → "actually cancel it") and resume the OLD task with
tool access — this is exactly what moved Aryan's real appt to Aug 20 4:00 PM
without consent in live call #3.
- **(a) CODE** — `src/realtime/openaiSession.ts`, `input_audio_buffer.speech_started`
  case: added `this.clearFailedRetry();` (with a comment) right after the log
  line, before `this.handlers.onSpeechStarted?.()`. New caller speech now
  invalidates any pending stale retry; server_vad's default `create_response:true`
  still creates a fresh response for the new turn, so nothing is lost. No
  `session.update` shape change — this is a plain method call in app code.
- **(b) PROMPT** — `src/realtime/twilioStream.ts` `buildInstructions()`,
  RESCHEDULING section: inserted an explicit-consent gate before the tool call
  (mirrors the CANCELLATION flow's existing "get an explicit yes" step) and an
  abandon-on-mind-change rule. Renumbered steps 6→8. New/changed lines:
  - step 6 (new): `Get an explicit yes — "So moving it to [day] at [time],
    correct?" — BEFORE calling reschedule_appointment. Never reschedule to a
    time the caller hasn't clearly chosen.`
  - step 7 (was 6, reworded): `Call reschedule_appointment once they confirm —
    pass the chosen slot's value (24-hour) as the time.`
  - new trailing line: `If the caller changes their mind mid-flow (e.g. asks to
    cancel instead) → ABANDON the reschedule immediately and follow the new
    request.`
- **NEW test** — `src/tests/openaiSession.test.ts`, describe block "B2 stale
  RT-5 retry cleared on new caller speech": schedules a failed-response retry,
  fires `input_audio_buffer.speech_started`, advances fake timers 11s (past the
  10s retry cap), asserts zero messages were sent (no stale `response.create`).
- **Verified:** `npx tsc --noEmit` clean. `npm test` → **104/104** (was 103,
  +1 new). `TZ=UTC npm test` → **104/104**. Barge-in tests (`twilioStream.bargein.test.ts`)
  untouched and green; `handleBargeIn`/`markQueue`/`bargeInEpoch` not touched.
- Marked `[x]` in `tasks/agent_queue.md` (awaiting Fable review/commit — this
  worker did not commit or push per instructions).

## 2026-08-19 — 📞 Live test round 2: barge-in ✅ + two UX changes shipped
Live call (ngrok, real Phorest): barge-in/interrupt confirmed smooth by Aryan.
Two behavior changes implemented same session (tsc clean, 103/103 vitest):
- **Recognized-caller confirmation**: injected caller-ID background note rewritten
  (`twilioStream.ts` prepareCallerContext) — Erica now, on the caller's FIRST
  request, acknowledges it and asks "just to confirm — is this [First]?" once.
  YES → continue their stated request by name, no phone asked. NO (shared
  phone) → ask THEIR name, never book under the recognized account (CT-1 guard
  still enforces name-match server-side). Prompt IDENTIFICATION step 0 added.
- **`end_call` tool (NEW)**: Erica can now hang up. Prompt "ENDING THE CALL"
  section: after each task ask "Anything else?"; on "no, I'm good" → one goodbye
  line then end_call same turn. Handler mirrors transfer_to_owner: sets
  `transferring` (blocks failover), `waitForPlaybackToDrain(6000)` so the goodbye
  isn't cut off, then Twilio REST `status: 'completed'`; outcome 'completed' only
  if none set. **Barge-in abort guard**: new `bargeInEpoch` counter — if the
  caller interrupts mid-goodbye ("oh wait—"), the hangup aborts and the tool
  returns a note telling the model to keep helping. Zod schema `end_call: {}`.
- Prior call's log showed silent recognition worked (lookup 4ms prefetch,
  booked under Aryan) but never confirmed identity, and Erica couldn't hang up
  ("Hi again! Just let me know…" after goodbye) — both now addressed.
- NOT yet live-verified: end_call + confirm flow need a live call. Session
  config risk is minimal (end_call shape identical to get_business_hours) but
  per lessons.md, first call should verify session.update was accepted (greeting
  plays = accepted).
- **PH-11 FIXED: running-late note never reached Phorest.** Aryan's live call
  logged running-late → Erica said "logged!" but the POST 400'd
  ("serviceNote must not be empty") and addAppointmentNote swallowed it.
  Fix: body field `text` → `serviceNote` (phorest.client.ts). Verified live:
  200 + noteId, note visible on the appointment (`notes` field). Lesson added.
- Guardrails discussion opened (caller said "don't interrupt me" → Erica went
  mute until told otherwise; prompt-injection hardening requested). Assessment
  delivered; implementation pending Aryan's pick.
- **Live call #3 (9a7b0447) diagnosed — 3 bugs → queue B1–B3.** (1) B1: Erica
  parroted the literal example line from the recognized-caller note ("Hi Aryan!
  What service were you thinking?") after the caller had already named the
  service. (2) B3: the "freezes" were TPM starvation — remaining hit 935/40000,
  6 response failures in ~45s, each RT-5 retry = up to 10s dead air; OWNER
  action (raise OpenAI tier) is the structural fix + retry-churn cap as
  mitigation. (3) B2 (P0): a stale RT-5 retry fired AFTER the caller switched
  intent to "cancel" and executed reschedule_appointment → appt moved to Aug 20
  **4:00 PM** without consent (guards passed: 4:00 was in offeredSlots).
  clearFailedRetry() is never called on speech_started — that's the hole.
  ⚠️ Aryan's real appt now sits at Aug 20 4:00 PM (not 5:30). No failover
  misfire at hangup (clean CALL ENDED). Also noticed: NO "USER SAID" input
  transcripts in this call's log — diagnosis relied on Erica's lines only;
  worth a look when convenient.
- **NEW: `tasks/agent_queue.md`** — executable queue for Opus worker agents
  (Fable = advisor/leader, workers implement). Seeded with G1 conversation-
  policy prompt block, G2 silence watchdog, G3 max-call-duration cap — full
  specs + acceptance criteria + orchestration notes (all three touch
  twilioStream.ts → run ONE worker sequentially, not parallel). New requests
  get spec'd there before any worker codes.

## 2026-08-07 — 🔍 Pre-production functional edge-case audit (analysis only, no code changes)
Full read of twilioStream / openaiSession / phorest.client / booking / hours /
slots / toolSchemas / env / routes / callStore, deduped against DEFECTS doc +
todo.md + fixup_round2. 103/103 tests green. NEW findings (reported to Aryan):
1. **Greeting race** — likely root cause of the OPEN call-2 anomaly: RT-8
   `flushPendingMedia()` runs BEFORE `requestGreeting()`; server_vad has
   `create_response:true` (GA default), so buffered pre-greeting caller speech
   auto-creates a response that collides with (or is interrupted by) the
   greeting `response.create` → greeting skipped, Erica answers the utterance.
   `requestGreeting()` also never checks `activeResponse`.
2. **No booking-time availability re-check** — `/booking?force_selected_time=true`
   means Phorest force-books; concurrent callers offered the same slot, stale
   offeredSlots (caller dawdles / walk-in takes it), and the warn-allow
   no-prior-suggest paths can all silently double-book. No past-date/time guard
   either. Fix: re-validate availability server-side right before createAppointment.
3. **lookupCustomerByName has NO client-side re-filter** — trusts Phorest
   `?firstName=&lastName=` filtering (the same API whose `?mobile=` and
   `?clientId=` are silently ignored). If ignored/fuzzy → strangers offered as
   candidates or "Priya"→"Priyanka" wrong single match. Needs 5-min live probe.
4. **PH-10 still live** — updateAppointment recomputes endTime from CATALOG
   duration; front-desk-extended appts shrink on reschedule (never fixed in any
   lane, despite being easy to believe done).
5. Duplicate-profile accumulation (exact-first-name F2 guard + `sanitisePhone`
   accepts any digit count + placeholder emails); booked slot stays in
   offeredSlots (self-overlap possible); `nextOpen` is now-relative not
   request-relative; getTodayAppointments end fallback `?? startTime` + squeeze
   checks ALL staff; split-hours ranges not honored by availability filter
   (latent); 0-duration services bookable; ws keepalive has no pong deadline;
   RT-5 retries loop (not once) under sustained TPM freeze; bare `<Dial>` on
   transfer → rings out to Richa's personal voicemail.
Deploy gotchas: Twilio signature + stream URL depend on x-forwarded-* matching
the exact public webhook URL; first call after deploy races the client-index
warm (lookup awaits full build). Owner gates unchanged (keys, TPM, 2026
closedDates). NOT fixed yet — awaiting Aryan's go-ahead on priority order.

## 2026-07-21 — 🎧 FIRST LIVE TEST CALL + 3 fixes (committed, NOT pushed)
Aryan ran the first live smoke call (ngrok → real number). Core loop worked;
3 issues found and fixed the same session. `tsc` clean, **103/103 vitest** (was
98), green under `TZ=UTC`.
- **Voice → female:** `OPENAI_REALTIME_VOICE=marin` in `.env` (was cedar). Marin
  is OpenAI's natural female Realtime voice — right fit for a women's salon.
  ⚠️ `.env` change needs a **dev-server restart** (dotenv loads at boot; tsx
  watch won't pick it up).
- **Greeting no longer says the caller's name in the cold open** (felt creepy).
  Recognition stays in the BACKGROUND — standard greeting, no name; Erica may use
  the first name naturally later. Still no re-lookup (`warmCallerContext`
  injection rewritten, `twilioStream.ts` ~605).
- **Odd availability times fixed** (the "2:43 / 5:28 pm" bug). ROOT CAUSE: Phorest
  availability re-anchors its grid to each appointment's END, so free starts come
  back at odd minutes — NOT a hallucination (verified live vs raw Phorest). New
  `src/core/slots.ts` `snapSlotsToGrid` snaps starts UP to a clean grid
  (`SLOT_GRID_MIN`=15), proven-safe (successor-runway rule; drops lone tail
  slots). Wired into `handleSuggestAvailability`. Unit test uses the exact live
  dataset from the call. Lessons + CODEMAP updated.
- **Observability (NEW):** `logger.ts` now tees stdout → `data/dev.log`
  (truncated each boot, gitignored, dev-only) so calls can be inspected after the
  fact — the pane-only stdout was un-diagnosable. `npm run logs` pretty-follows
  it. Structured audit trail is still `data/calls.jsonl` (append-only, CallStore).
- **⚠️ OPEN — call-2 greeting anomaly (needs the log):** on a 2nd back-to-back
  call Erica skipped the greeting and jumped to "what would you like to book" —
  felt like it resumed the prior call. Verified NOT possible via shared state
  (fresh instance + fresh OpenAI session + fresh requestGreeting per call; no
  conversation_id reuse). Leading hypothesis: spurious VAD/echo truncating the
  greeting (see lessons telephony-echo). Diagnose from `data/dev.log` next call.
- **Follow-up (not done, minor):** "what's available AFTER 2pm" still centers
  results on 2pm (offers some earlier times too) — `preferredTime` has no
  "at-or-after" qualifier. Low priority; the model can filter.

## 2026-07-19 — ✅ ARCHITECT SIGN-OFF on round-2 fixups
Independent re-review of all 3 fix commits (8145f00, 17ddfd5, 0468060): every
F1–F10 item verified implemented as specified — diffs read line-by-line, gates
re-run by the architect (98/98, tsc, TZ=UTC, no new deps, tree clean,
WS_AUTH_SECRET confirmed set, secret-fragment scrubbed). Handler-level tests
sit ABOVE the zod seam as required; F8 is now genuinely concurrent
(stash-and-apply pattern); no approved deviation was touched; both mandated
lessons landed. **APPROVED — live smoke test is GO.** Residual watch items for
the smoke test (non-blocking): reschedule slot guard is date-wide across
services (documented tradeoff); collapsed-compound matcher retry uses substring
inclusion (watch for over-match on new catalog entries); only Erica's side of
the transcript persists so far. Owner gates before push/deploy unchanged:
rotate Phorest secret + OpenAI keys (still in git history), TPM tier, 2026
closedDates.

## 2026-07-19 — ROUND-2 FIXUPS (`tasks/fixup_round2_2026-07-19.md`) — DONE, committed, NOT pushed
All architect-review findings F1–F10 fixed directly (not swarmed). `tsc` clean,
**98/98 vitest** (was 78), green under `TZ=UTC`. 3 commits (P1 / phorest+booking
/ orchestration+P3). Exit criteria met: F1–F3 have handler-level regression
tests; ≥85 tests; lessons.md got the F8 honesty + F1 test-above-validation-layer
lessons.
- **P1 (unblocked the smoke test):** F1 book_appointment zod schema mirrors
  TOOL_DEFINITIONS again (clientId kept, phone optional — was silently stripped);
  F2 prefetch clientId/phone injected only when the given name matches the
  recognized account (daughter on mom's phone no longer books under mom); F3 WS
  auth fails CLOSED in prod (verify + `assertWsAuthConfigured` refuse-boot),
  `WS_AUTH_SECRET` now set in `.env` (gitignored), placeholder in `.env.example`.
- **P2/P3:** F4 matcher ("micro blading" resolves, ambiguous≤3, alias-rot warn),
  F5 no phone-index overwrite, F6 reschedule slot guard, F7 WS conn cap +
  pre-auth timeout, F8 REAL concurrent prefetch (was falsely claimed), F9
  stale-cache backoff, F10a-l (endTime-from-duration, USE_MOCK strict, transfer
  flag reset, running-late ownership guard, transcript persisted, consent line,
  fixture rot, secret-fragment scrub, sendUserText removed, rate-limit map cap).
- **✅ Live smoke test is now UNBLOCKED.** Still owner-gated before push/deploy:
  rotate Phorest secret + OpenAI keys (in git history), raise TPM tier, provide
  2026 closedDates (CF-1). Approved deviations (do NOT "fix"): Lane B structural
  error classification, JSONL CallStore, in-house rate limiter, matcher
  coverage==1 rule, PH-9 deferral.

## 2026-07-19 — Defects swarm (DONE, committed, NOT pushed) — ⚠️ NEEDS LIVE SMOKE TEST
13-agent A∥B→C swarm (`tasks/swarm-defects.mjs`) fixed the `docs/DEFECTS_2026-07-19.md`
functional/correctness audit. `tsc` clean, **78/78 vitest** (was 39), green under
`TZ=UTC`. Adversarial review across 4 dimensions → **0 must-fix** (it CONFIRMED the
barge-in invariant, bounded/once-flushed media buffer, capped transfer timing, no
dropped safety rules). 3 lane commits + 1 low-sev follow-up (activeResponse reset).
- **Lane A (Phorest/booking):** PH-4 idempotent retries (no double-book), PH-1 index
  promise reset, PH-2/3 appt window (finds late + 5-week-out appts), PH-5 matcher
  rewrite (ambiguous/notOffered; "wax" no longer silent-picks), PH-6/7/8, CF-4
  fail-fast, CT-9 doc-rot, CT-1 clientId booking + shared-phone/name guard.
- **Lane B (openaiSession):** RT-1 onClose teardown (no zombie calls), RT-2 defer
  response.create (no interrupt-during-tool drop), RT-3 stop fatalizing recoverable
  errors, RT-5 failed-response retry, RT-7 stray-delta gating, RT-9 call-tagged logs.
  Structural only — session.update untouched, no guessed error strings.
- **Lane C (twilioStream):** consume matcher union (notOffered/ambiguous, no full-menu
  dump), CT-1/CT-2 identity threading + name disambiguation, RT-1 onClose→failover,
  RT-4 barge-in tail, RT-8 pre-ready media buffer, RT-6 transfer timing, CT-3/6/7/10.
- **⚠️ THE BEHAVIORAL FIXES (RT-2/RT-4/RT-5) NEED A LIVE SMOKE TEST** — compile/tests/
  logic verified, but real audio timing can't be proven offline. Run the scenario→
  defect map at the bottom of `docs/DEFECTS_2026-07-19.md` (interrupt-during-tool,
  interrupt-near-end-of-list, running-late-after-start, "book a wax", etc.).
- **Still deferred:** PH-9 name-fuzzy + PH-6/PH-11 full verify (need live probe), B0
  live error-code capture (nice-to-have precise fast-path), CF-1 2026 closedDates
  (OWNER data), semantic_vad / Spanish / SMS features.

## 2026-07-19 — Security-hardening swarm (DONE, committed, NOT pushed)
20-agent file-partitioned swarm (`tasks/swarm-hardening.mjs`) completed Phases
0–3 + call persistence (4.1) from `tasks/todo.md`. `tsc` clean, **39/39 vitest**
(was 32), green under `TZ=UTC` too. Adversarial review ran; 3 must-fix defects
found + fixed (WS token was issued-but-never-verified; PII phone in book log;
PLAN.md secret). 3 local commits on `feat/erica-v2`.
- **DONE:** Phase 0 hygiene (gitignore PII, redact PLAN.md secret, delete
  NextSteps/FIXES_APPLIED, move stray tests); Phase 1 (Twilio signature
  validation, WS HMAC token verified before session.connect, rate limiting,
  delete unauth REST writes + dead code, pino); Phase 2 (zod tool validation,
  ownership guard, slot validation, graceful fatal→owner transfer, client-index
  TTL); Phase 3 polish (concurrent prefetch, drop Polly transfer Say, AI
  disclosure, conservative prompt trim); Phase 4.1 JSONL call persistence.
  Bonus: **TZ-1** fixed (availability parsed in salon zone — was +4/5h wrong on
  UTC hosts; a hard deploy-blocker) with a `TZ=UTC` regression test.
- **⛔ OWNER (do before push/deploy):** ROTATE the Phorest secret + both OpenAI
  keys — redaction only cleans the working tree; the secret is still in git
  HEAD/history. Do NOT `git push feat/erica-v2` until rotated (optionally
  `git filter-repo` to scrub history). Also raise the OpenAI TPM tier.
- **NEXT (separate scope):** the swarm also produced `docs/DEFECTS_2026-07-19.md`
  — a deeper FUNCTIONAL/correctness audit (30+ bugs: RT-2/RT-3 call-drop on
  interrupt-during-tool, PH-5 wrong service matching, CT-1 recognized-caller
  booking contract break, etc.) with a ready `tasks/fix_plan_2026-07-19.md`
  (3-lane A/B/C/D). NOT fixed yet — recommended next swarm before any live-call
  soak. semantic_vad / Spanish / SMS still need live validation.

## Current status
- **Branch:** `feat/erica-v2` (NOT merged to main). ~38 commits of fixes.
- **Build/tests:** `tsc` clean, **98/98 vitest** green (also under `TZ=UTC`). Run `npm test` after every change.
- **Runtime:** `npm run dev` (tsx watch, auto-reloads on save) → server on :5050.
  `USE_MOCK_PHOREST=false` (real Phorest in `.env`). Voice = **cedar**, model = **gpt-realtime**.
- The core loop WORKS end-to-end on real calls: greet, book, reschedule, cancel,
  prices, hours, running-late, transfer, barge-in, caller-ID prefetch.

## Architecture (1 line)
Twilio Media Streams (g711 µ-law) ⇄ WebSocket `/twilio/stream` ⇄ OpenAI Realtime
(`gpt-realtime`, speech-to-speech, g711 passthrough) with in-process tools that
call the Phorest salon API. No STT/TTS vendors — it's a single speech-to-speech model.

## What's DONE (highlights)
- GA Realtime migration (no beta header, nested schema, g711 passthrough, barge-in,
  crash-safety, per-turn latency + token logging).
- Phorest hot-path hardened (timeouts+retry, bounded-parallel client index warmed
  at boot, TTL-cached service catalog, parallel booking calls).
- Correctness fixes: appointment timezone (local not UTC), `client_id` filter
  (privacy), 31-day range, `bookingStatus: ACTIVE`, cancel only BOOKED, availability
  UTC→local + business-hours filter + nearest-to-`preferredTime` selection.
- UX: prices via on-demand `get_prices` tool (not in prompt — fixes token freeze),
  hours-aware "closed vs fully booked", service synonym aliases, exact-time readout,
  caller-ID prefetch (greet by name, instant tools), Cedar voice + delivery coaching,
  "don't assume intent / let the caller lead".

## ⚠️ PENDING — action items
> **2026-07-18 audit:** full repo audit done; findings + prioritized roadmap now
> live in **`tasks/todo.md`** (supersedes the numbering below as the working
> plan). Verified: item 2 (TWILIO_NUMBER) is ALREADY FIXED in `.env`; items 1,
> 3–6 still open; NEW: untracked `NextSteps.md` also contains the Phorest
> secret, and `logs.md` (PII) is still not gitignored. No code commits since
> the 2026-07-06 review — all its findings re-verified still open.
> **2026-07-19 (2):** SWARM FIX PLAN authored → **`tasks/fix_plan_2026-07-19.md`**
> — 4 lanes (A Phorest/data ∥ B session → C orchestration → D gate), exclusive
> file ownership, per-defect specs + contracts, B0 live error-capture protocol,
> TZ=UTC test gate, scenario smoke checklist. Swarm boot ritual: state.md →
> CODEMAP → lessons.md → DEFECTS doc → own lane. Guardrail: NEVER `git add -A`
> (live secrets + PII in working tree). Awaiting swarm execution.
> **2026-07-19:** pre-live-test defect hunt (3 parallel review lenses) →
> **`docs/DEFECTS_2026-07-19.md`**: 5 P0 call-breaking (UTC timezone shift on
> deploy — reproduced; tool-result response collision; error fatalization;
> WS-close zombie calls; recognized-caller booking contract break), 13 P1,
> ~17 P2, plus a scenario→defect map for testing. Plan updated (Phase D).
> **Same day (2026-07-18), part 2:** functional + architecture + competitive audit added to
> `tasks/todo.md` (feature gaps: no call persistence/SMS/dashboard/spam gate;
> architecture verdict: correct for stage, add SQLite call records + SMS layer,
> defer tenant extraction to salon #2). Market research (17 competitors, pricing,
> platform risk: GlossGenius/Fresha first-party AI announced, Zenoti shipped,
> Phorest SMS-only today) → **`docs/MARKET_RESEARCH_2026-07-18.md`**.
0. **📋 2026-07-06 — full review by Claude Fable 5: see `docs/FABLE_REVIEW_2026-07-06.md`.**
   Prioritized, checkbox-level findings for agents to implement (security P0s,
   tool-layer safety holes, features, productization phases). It also CORRECTS
   item 1 below — read it before acting on these items.
1. **SECURITY (do first — corrected 2026-07-06, verified against git history):**
   `.env.example` history is CLEAN; the two live OpenAI keys are only in the
   *uncommitted working-tree* copy — blank them there and rotate anyway.
   The REAL leak is the **Phorest secret committed in `PLAN.md`** (lines 79/914)
   — rotate it and redact PLAN.md. Details in `docs/FABLE_REVIEW_2026-07-06.md` §1.
2. **`.env` has the WRONG Twilio number** (`TWILIO_NUMBER=+18778058794`). The real,
   working number on the account is **+1 (410) 304-6449**. Fix the env value.
3. **Raise the OpenAI tier** — 40k tokens/min freezes long calls; structural fix is
   a higher rate limit (Platform → Limits). Watch `⚖️ TPM` / `📊 token` logs.
4. **Turn-taking:** if Erica still cuts callers off, switch `turn_detection` to
   `semantic_vad` (VAD silence is env-tunable at `OPENAI_VAD_SILENCE_MS`, now 700ms).
   Verify the semantic_vad GA field shape against the live API first.
5. **Prompt trim** (token efficiency): collapse verbose flow scripts, drop the
   prompt service-alias list (code handles it), dedupe rules. Keep all bug-fix rules.
6. Merge `feat/erica-v2` → main once a clean test pass is confirmed; then deploy
   (long-lived process in a US region near Twilio's edge, NOT serverless — caches
   depend on one process).

## How to run a live test
1. `npm run dev` (already auto-reloads).
2. `ngrok http 5050` (account has a static domain).
3. `bash scripts/set-twilio-webhook.sh https://<ngrok-host>` (points the number).
4. Call **+1 (410) 304-6449**.
5. Watch logs: `npm run dev | grep -E "⏱|📊|⚖️|🗣️|USER SAID"`.

## Diagnostics (read-only, hit real Phorest)
- `scripts/inspect-appointment.ts [apptId] [first] [last]` — appt state + time.
- `scripts/list-services.ts` — full live catalog.
- `scripts/check-availability.ts` — raw availability slots for a service.
- `scripts/test-appt-filter.ts` — proves `client_id` vs `clientId` filtering.

## Key files
`src/realtime/twilioStream.ts` (call orchestration, prompt, tool handlers),
`src/realtime/openaiSession.ts` (GA session + events + barge-in),
`src/services/phorest.client.ts` (the real Phorest adapter — tz + API quirks live here),
`src/services/booking.ts` (service matching + aliases), `src/core/hours.ts` (business hours),
`src/config/business.json` (hours source of truth), `.env` (real creds, gitignored).
