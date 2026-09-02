# PLAN — Prompt audit follow-ups (2026-09-01) — from docs/PROMPT_AUDIT_2026-09-01.md

Audit of the live prompt (ade8b16) + 34 test calls + OpenAI/ElevenLabs/Vapi
guides. Full findings, evidence and rationale in the audit doc; this is the
checklist. Fix ladder applies (note → schema → code → flow → prose).

## ✅ Done in the audit pass (commit "say Richa is away from the salon")
- [x] RICHA'S LINE folds an active closure in (was POSSIBLE beside "cannot connect")
- [x] nextOpen names the date when 7+ days out ("Thursday, September 10")
- [x] Owner wording everywhere: "away from the salon", never "vacation"
      (header, get_business_hours `awayClosures`, MESSAGE MODE, closed-date note)
- [x] Message-vs-FYI disambiguation in the three text-instead-of-transfer notes
- [x] scripts: render-prompt / validate-session-fields / validate-transcription-fields / probe-client-history

## P0 — before the next deploy
- [ ] Deploy after the 4 direct-dial checks in audit §0 (Aryan's call; rollback 51d62be6…)
- [ ] Transcription `language:'en'` + salon-vocabulary `prompt` behind env
      (both accepted live 2026-09-01; `keywords` rejected) — snapshot test for
      byte-identical payload when unset; one live call before flipping

## P1 — this week, one commit + ear test each
- [x] C4 finish: FYI SMS from handleCancel/handleReschedule (today or next open
      day while closed) in CODE; delete the MESSAGE MODE sentence; update prompt test
- [ ] C5: unrecognized context says the calling number was already checked →
      existing-appointment path asks for the booking number or name (4 wasted turns seen)
- [x] C7: end_call goodbye contract ("never announce the call is ending")
- [x] B5 un-park: appointmentId-in-clientId guard (note + param desc + short-circuit)
- [ ] `reasoning.effort` env knob (default unset) + staged A/B on latency/ear
- [ ] Log `phase` (commentary | final_answer) per output item
- [ ] TOOLS: "no day → both suggest_availability calls in ONE turn"

## P2 — next prompt release
- [ ] Flow states (Goal / How to respond / Exit when) for BOOK, RESCHEDULE, CANCEL, LATE
- [ ] C6 one failure rule · C8 staff-note "don't apologize for the preamble" ·
      C9 "never invent a reason" · C10 identity wording · C12 variety line ·
      C13 no repeated clarification · C11 constraint-word trim
- [ ] Verbosity table + digit-by-digit phone read-back
- [ ] Pronunciation HEARING hints for Richa (Richard, Rich, Raja, Recharge, "the judge")
- [ ] Service history / "your usual" (audit §5) — prefetch-side, identity-gated, offer-not-assume; second turn, never the greeting
- [ ] Pre-warm next-open-day availability for the usual service (measure Phorest latency on Railway first)
- [ ] Semantic VAD listening test (eagerness: low), staging only
- NOT recommended: parallel_tool_calls, audio.output.speed, injected disfluencies, catalog back behind a tool

---

# TODO — Non-client calls + privacy hardening (2026-08-25) — ✅ DONE (58dabd1)

Approved by Aryan (call-review follow-up): general handling for non-client
calls + a blanket never-disclose rule.

- [x] 1. Prompt: `NON-CLIENT CALLS` section (after SPAM) — triage principle
      (brief, warm, one pointer, no transfer, wrap up) + job seekers →
      website, vendors/press → message path, charity → decline, wrong
      number → identify + end, premises emergency → escalate (exception).
- [x] 2. Prompt: `PRIVACY` section — never give out any phone number,
      schedule, or whereabouts; never confirm who's at the salon;
      appointment details only with the identified appointment owner.
- [x] 3. Tests (N1/P1) in twilioStream.prompt.test.ts — 5 new.
- [x] 4. npm test 338/338 green + tsc clean.
- [x] 5. Committed 58dabd1; state.md updated.
- NOT in scope: Wix careers blurb (separate repo, publish needs approval),
  multilingual policy (flagged, no decision).
- [ ] Deploy: needs `railway up` — Aryan's call.

---

# PLAN — Audit → Fix Roadmap (2026-07-18)

> Produced by a full repo audit on 2026-07-18 (code + all md files + memory +
> git history verification). PLAN ONLY — nothing here is implemented yet.
> Source of detail for most items: `docs/FABLE_REVIEW_2026-07-06.md` (section
> refs below). Rules: read `tasks/lessons.md` before touching Phorest time
> handling or OpenAI session config; `npm test` after every item; commit per
> item; update `state.md` as items complete.

## Audit verdict (verified today, not assumed)

**WORKING**
- `tsc` clean, **32/32 vitest green** (8 files — includes 2 untracked test files).
- Core call loop works end-to-end on real calls (greet, book, reschedule,
  cancel, prices, hours, running-late, transfer, barge-in, caller-ID prefetch).
- `.env` `TWILIO_NUMBER` is **already fixed** (`+14103046449`) — state.md
  pending item 2 is STALE, treat as done.
- GA Realtime session config valid (server_vad + noise_reduction +
  retention_ratio truncation), g711 passthrough, TPM/token/latency logging.

**BROKEN / UNFIXED** (no code commits since the 2026-07-06 review — every
review finding still holds; each re-verified by grep today)
- Secrets: live OpenAI keys still in working-tree `.env.example`; Phorest
  secret still committed in `PLAN.md` (lines 79/914); **NEW FINDING:** the same
  Phorest secret is also in untracked `NextSteps.md` (~line 26); `logs.md`
  (403 lines of call transcripts w/ customer PII) is untracked and NOT in
  `.gitignore`.
- Endpoint security: zero — no Twilio signature validation, unauthenticated
  `/twilio/stream` WS, unauthenticated REST writes (`POST /api/suggest`,
  `POST /api/book` hit REAL Phorest), no rate limiting.
- Tool layer: no appointment-ownership guard on cancel/reschedule, no slot
  validation on booking, no Zod validation of tool args (0 `safeParse`), fatal
  mid-call error = dead click, client phone index never refreshes.
- Hygiene: `warmCallerContext` runs serially before greeting;
  `OPENAI_MAX_RESPONSE_TOKENS` defined but wired to nothing; `console.log` in
  `index.ts` + `routes/twilio.ts`; legacy dead code (`services/ai.ts`,
  `services/twilio.ts`, `/twilio/gather`); stray root `test-*.ts` ×3;
  `FIXES_APPLIED.md` documents the deleted pcm16 architecture (misleading);
  no AI/recording disclosure in the greeting (MD is two-party consent).
- Ops: OpenAI tier still low (40k TPM freeze risk on long calls); prompt still
  untrimmed; still `server_vad` (semantic_vad untested); branch unmerged.

## Functional audit (full walkthrough of `twilioStream.ts` + prompt, 2026-07-18)

**Feature surface today** — 10 tools, and the flows are genuinely good:
book (multi-service, same-day, preferredTime-centered slots), reschedule,
cancel (explicit-confirm, retry-once), prices (targeted or full menu), hours
(closed vs fully-booked distinction), running-late (with back-to-back squeeze
check), transfer, caller-ID/VIP recognition with greet-by-name + warmed
appointments. Note: VIP caller recognition is a $599/mo *premium* feature at
Slang.ai — we have it; market it.

**Functional gaps found in the walkthrough** (beyond the security review):
- **Calls leave no trace.** `handleAssistantText` is an empty stub; transcripts
  exist only in dev logs; nothing is persisted per call (no outcome, no
  duration, no booking value). This blocks the #1 retention feature the market
  research found (ROI dashboard) AND makes production debugging blind.
- **No SMS of any kind** (no confirmation text, no missed-call text-back).
- **Single-staff model**: availability/booking is pinned to
  `PHOREST_PRIMARY_STAFF_ID`. "Can I book with [stylist]?" isn't handleable;
  group bookings always transfer. Fine for Richa's solo shop — a blocker for
  salon #2.
- **Voice mismatch on transfer**: `transfer_to_owner` plays a Polly.Joanna
  `<Say>` before dialing — a different voice than Cedar mid-call (we deleted
  the Polly greeting for exactly this reason; Erica already says the handoff
  line herself, so the `<Say>` is redundant — just `<Dial>`).
- **No spam/robocall gate** — every junk call opens a full OpenAI Realtime
  session and burns tokens.
- **English-only is forced in the prompt** while gpt-realtime is natively
  multilingual — Spanish is a config-level unlock competitors charge $99/mo for.
- **No after-call/voicemail path**: if transfer fails or Erica can't help,
  the call just ends; nothing is captured for the owner.
- **New-client flow doesn't capture email** (Phorest profile created with
  name+phone only) — fine for calls, limits salon marketing later.
- Minor: `phorest.preloadClients()` re-fired on every call 'start' (already
  warmed at boot — harmless but redundant); unrecognized callers are asked
  "what's your phone number?" instead of being offered the number they're
  calling from.

## Architecture assessment

**As-is:** single-process, single-tenant monolith. Per-call `TwilioRealtimeCall`
class (clean event-driven design), module-level in-memory caches (client phone
index, service catalog), `business.json` + env as all config, salon identity
(Erica/Richa/Parkville) hardcoded in the prompt, pino logs as the only record,
zero persistence. `PhorestPort` interface is the one real abstraction seam —
and it's the right one.

**Verdict: the architecture is CORRECT for the current stage.** Speech-to-speech
passthrough with in-process tools is the lowest-latency shape available; the
per-call class is clean; the adapter seam is where multi-platform support will
plug in. Do NOT microservice/queue/K8s this. The real deltas, in order:
1. **Add a persistence layer (SQLite, e.g. better-sqlite3) for call records** —
   transcript turns, tool calls + outcomes, booking value, duration, tokens,
   caller. Cheap now; foundation for dashboard/digest/analytics/regression.
   The `handleAssistantText` stub + tool handlers are the natural write points.
2. **Add an SMS action layer** (Twilio Messaging on the existing number).
3. **Tenant extraction LATER, at salon #2** (review §6 Phase 1 maps it:
   TenantConfig row, templated prompt, per-tenant caches keyed by called
   number). Don't build it speculatively — but stop ADDING hardcoded salon
   facts to the prompt.
4. Deployment stays a long-lived single process (caches + WS need it).

## Market-informed product gaps (see `docs/MARKET_RESEARCH_2026-07-18.md`)

Researched Slang.ai, Rosie, Goodcall, Smith.ai, Yelp, Podium, Zenoti,
GlossGenius, Fresha, Phorest's own AI, AgentZap, BookingBee, MySalonDesk, Numa,
Avoca, Sameday, PolyAI. Bottom line: **live in-call booking into the real
calendar is the moat and we already have it** (competitors gate it behind 3×
pricing or use humans to do it). What every successful product has that we
lack, in order of universality: **SMS layer → owner dashboard w/ transcripts +
recordings → revenue-attribution analytics → spam blocking → Spanish →
outbound (confirmations/waitlist/win-back) → voicemail fallback →
multi-location.** $249–399/mo is validated market range. Platform risk:
GlossGenius "Reception" coming soon, Fresha announced 2026, Zenoti already
shipped, Phorest is SMS-only today (voice likely next) — window is open but
not forever; Boulevard + Mangomint have no first-party AI → best expansion
targets.

---

## Phase 0 — Secrets & repo hygiene (DO FIRST — one session)

- [ ] 0.1 **OWNER ACTION (Aryan):** rotate the Phorest API secret (Phorest
      dashboard/support) and both OpenAI keys. Everything else in this phase
      can proceed in parallel, but the leak isn't closed until rotation.
- [ ] 0.2 Blank both live keys in working-tree `.env.example` (keep placeholders
      like `sk-...`; the tracked HEAD copy is already clean — never stage keys).
- [ ] 0.3 Redact the Phorest credential from `PLAN.md` lines 79 + 914, commit.
      (History purge via `git filter-repo` optional while repo stays private —
      rotation is the real fix. `docs/FABLE_REVIEW_2026-07-06.md` §1.2.)
- [ ] 0.4 Redact or delete untracked `NextSteps.md` (contains the same Phorest
      secret; content is otherwise an obsolete pre-voice roadmap → recommend
      DELETE ⚠️ needs Aryan's ok per permission model).
- [ ] 0.5 Add `logs.md` to `.gitignore` (PII transcripts; never commit).
- [ ] 0.6 Delete `FIXES_APPLIED.md` (describes the old pcm16/manual-VAD
      architecture — actively misleading). ⚠️ delete = needs Aryan's ok.
- [ ] 0.7 Move root `test-integration-simple.ts`, `test-openai-realtime.ts`,
      `test-twilio-openai-integration.ts` → `scripts/` (or delete if dead).
- [ ] 0.8 Commit the two untracked-but-passing test files
      (`src/tests/appointment.validation.test.ts`, `src/tests/twilio.route.test.ts`).
- [ ] 0.9 Update `state.md`: mark TWILIO_NUMBER item done; point item list here.

## Phase 1 — Endpoint security (P0 — required before any real deployment)
(Review §2 — full implementation notes there.)

- [ ] 1.1 Twilio signature validation (`twilio.webhook()` middleware,
      `X-Twilio-Signature`) on `POST /twilio/voice`. `trust proxy` is already
      set; mind `x-forwarded-*` behind ngrok.
- [ ] 1.2 Auth the `/twilio/stream` WS: short-lived HMAC token (callSid +
      expiry) issued in `/voice` TwiML `<Parameter>`, verified in the `start`
      handler BEFORE `session.connect()`; close socket on failure.
- [ ] 1.3 Delete unauthenticated REST writes `POST /api/suggest` + `/api/book`
      (`src/routes/appointment.ts`) AND legacy dead code: `src/services/ai.ts`,
      `src/services/twilio.ts`, `/twilio/gather` route. Update/remove their
      tests (`appointment.test.ts`, `appointment.validation.test.ts` cover the
      deleted routes — rewrite against `booking.ts` directly or drop).
      ⚠️ deletes = needs Aryan's ok.
- [ ] 1.4 Rate limiting on `/twilio/*` + `/api/*` (`express-rate-limit`) + cap
      concurrent WS connections.

## Phase 2 — Tool-layer write-path safety (P1 — protects real customer data)
(Review §3. Same bug class as the old `client_id` privacy leak, write side.)

- [ ] 2.1 Ownership guard: `servedAppointmentIds: Set<string>` per call
      (populated from `list_appointments` + prefetch); `handleCancel` /
      `handleReschedule` refuse IDs not in the set → tool error telling the
      model to call `list_appointments` first.
- [ ] 2.2 Slot validation: cache last `suggest_availability` result per call
      (service+date); `book_appointment` validates requested time against
      offered slots; on mismatch return error listing valid slots.
- [ ] 2.3 Zod schema per tool mirroring `TOOL_DEFINITIONS`; `safeParse` at the
      top of every handler; clean `{ error }` return on bad args.
- [ ] 2.4 Graceful fatal-error path: on mid-call fatal error, Twilio REST
      redirect → `<Say>` apology + `<Dial>OWNER_PHONE</Dial>` instead of a
      dead click (Twilio client already exists in `twilioStream.ts`).
- [ ] 2.5 Client phone index TTL background refresh (`CLIENT_INDEX_TTL_HOURS`,
      default 1h; serve stale while reloading — never block a live call).

## Phase 3 — Perf/polish (P2)
(Review §4 + state.md pendings 3–5.)

- [ ] 3.1 Start `warmCallerContext` concurrently with `session.connect()`;
      await just before `requestGreeting()` (cuts up to ~700ms pickup silence).
- [ ] 3.2 `OPENAI_MAX_RESPONSE_TOKENS`: wire to `response.create` (⚠️ validate
      against live GA API first — lessons.md) or delete it.
- [ ] 3.3 Replace `console.log` with pino in `src/index.ts` + `src/routes/twilio.ts`.
- [ ] 3.4 Prompt trim: collapse verbose flow scripts, drop prompt alias list
      (code handles aliases), dedupe rules. KEEP all bug-fix behavior rules.
      Measure via `📊` token logs before/after.
- [ ] 3.5 Add one-line recording/AI disclosure to the greeting (Maryland
      two-party consent + emerging AI-disclosure laws; review §6 Compliance).
- [ ] 3.6 IF cut-offs still occur on test calls: try `semantic_vad`
      (⚠️ validate GA field shape against live API first — burned twice).
- [ ] 3.7 **OWNER ACTION:** raise OpenAI tier / TPM limit (Platform → Limits);
      watch `⚖️ TPM` logs on long calls.
- [ ] 3.8 Drop the Polly `<Say>` from `handleTransferToOwner` (voice mismatch
      with Cedar; Erica already speaks the handoff line) — keep just `<Dial>`.
- [ ] 3.9 Remove the redundant per-call `phorest.preloadClients()` in the
      'start' handler (already warmed at boot).
- [ ] 3.10 Unrecognized-caller UX: offer the caller-ID number instead of asking
      cold ("Is the number you're calling from the best one for your file?").

## Phase 4 — Features (re-ordered by market evidence; review §5 +
`docs/MARKET_RESEARCH_2026-07-18.md`)

- [ ] 4.1 **Call persistence** (SQLite): per-call record — transcript turns
      (wire the `handleAssistantText` stub + user transcripts), tool calls +
      outcomes, booking made + service + price, duration, latency, tokens,
      caller number (masked in logs, full in DB), after-hours flag. Foundation
      for 4.3/4.4 and for regression debugging. Do this FIRST of the features.
- [ ] 4.2 **SMS layer** on the existing Twilio number:
      a) instant booking-confirmation text after book/reschedule/cancel;
      b) missed-call / no-outcome text-back with booking info (the single
         highest-converting feature across the whole market — Numa's core loop);
      c) reminders 24–48h out — ⚠️ VERIFY Phorest's built-in SMS reminders
         first; if the salon already pays for those, skip (don't double-text).
- [ ] 4.3 **Owner daily digest** (text/email): "X calls (Y after-hours), Z
      bookings worth $N, W transfers" + link/attachment of transcripts.
      The "revenue booked while you were closed" line IS the retention product.
- [ ] 4.4 **Owner dashboard** (simple web view over the SQLite DB): call list,
      transcripts, outcomes, revenue-booked counters. (Can start as digest-only
      and add the web view when selling to salon #2.)
- [ ] 4.5 **Spam/robocall gate** before opening the OpenAI session (cheap
      screening: known-spam caller lists / silence-probe / Twilio Lookup line
      type) — saves real tokens and is a standard checklist feature.
- [ ] 4.6 **Spanish**: drop the English-only prompt rule, let gpt-realtime
      mirror the caller's language (validate quality on a test call). Rosie
      includes this free; Slang charges $99/mo for it.
- [ ] 4.7 **In-call upsell (soft)**: when booking, offer the natural add-on
      once ("want to add a brow tint with that?") — Zenoti reports 25% of
      recovered bookings take an upsell. Keep it to ONE offer, never pushy.
- [ ] 4.8 **Voicemail fallback**: when transfer fails or Erica can't help,
      capture a message + text transcript/summary to Richa.
- [ ] 4.9 **Waitlist**: when a day is genuinely full, note the caller; text
      them if a matching slot frees up (pairs with a cancellation hook later).
- [ ] Later (premium tier / salon #2+): outbound confirmation calls to
      unconfirmed clients, lapsed-client win-back (Phorest Client Reconnect
      identifies them — Erica actions them), staff-selection + multi-staff
      availability, group bookings, deposit links for chronic no-shows,
      multi-location.

## Phase 5 — Merge & deploy (Phase 0 of productization; review §6)

- [ ] 5.1 Clean test pass → merge `feat/erica-v2` → `main`.
- [ ] 5.2 Deploy long-lived process (Fly.io/Railway, US-East near Twilio edge —
      NOT serverless; in-memory caches need one process). Point the Twilio
      number's webhook at it (`scripts/set-twilio-webhook.sh`).
- [ ] 5.3 Real-call soak: watch `⏱ / 📊 / ⚖️` logs; consider conditional
      call-forwarding launch (Erica answers only when the salon doesn't).
- [ ] Tenant extraction (multi-salon) is Phase 1 of review §6 — out of scope
      until the above is proven on Richa.

## Competitive strategy — how Erica wins (esp. with Phorest customers)

**Positioning: "The AI receptionist that actually runs your Phorest front desk"**
— not an answering service. Every generic bot (Rosie, Goodcall, My AI Front
Desk) takes messages or texts booking links; the one direct Phorest rival
(BookingBee, $99/mo ≈ 100 calls, human-in-the-loop) claims live booking but
leans on humans and caps calls. Erica completes book/reschedule/cancel
IN-CALL, recognizes the salon's own clients by caller ID, and does it at
speech-to-speech latency with Cedar. Three pillars, in build order:

1. **Own the Phorest depth (moat #1 — already 80% built).** We are one tenant
   deep in quirks no competitor will debug (per-endpoint timezones, snake_case
   params, expiring RESERVED holds). Extend that depth into features only deep
   integration allows: caller-ID VIP greet (have), true reschedule/cancel
   (have), running-late notes on the real appointment (have), then — unique on
   the platform — **actioning Phorest's own data**: Client Reconnect lapsed
   clients get win-back calls/texts from Erica; upsell offers informed by the
   client's service history. Phorest builds the insights; Erica is the only
   one who picks up the phone and acts on them.
2. **Prove revenue, not answered calls (moat #2 — the retention lever).**
   Plan items 4.1–4.4: every call persisted, SMS confirmations, and a digest
   that reads "this month Erica booked $1,840, $610 of it after hours." The
   invoice defends itself. This is what separates $249–349/mo from the $99
   commodity tier and is the #1 pattern across every durable competitor
   (Zenoti, Slang, Podium, Numa).
3. **Win the demo (moat #3 — voice quality).** gpt-realtime speech-to-speech +
   barge-in + Cedar beats the STT→LLM→TTS pipelines most rivals run. Sales
   motion = "call this number yourself": keep a public demo line running the
   full experience. Sub-second, interruptible, warm — the difference is
   audible in 10 seconds.

**Go-to-market for Phorest salons:**
- **Zero-risk adoption:** conditional call forwarding — Erica answers only
  calls the desk misses (busy/after-hours). No workflow change, pure upside;
  the digest then proves what she captured. Upgrade path to full answering.
- **5-minute onboarding as a feature:** tenant config auto-pulled from the
  salon's Phorest creds (services, prices, staff, hours) — nothing to type.
  Goodcall/Slang tout fast setup; deep-integration rivals can't match this.
- **Pricing:** $249–349/mo flat, fair-use (undercuts BookingBee per-call at
  any volume; 3–5× cheaper than a part-time receptionist). Premium tier
  (+$100–150) later: outbound win-back, waitlist-fill, multi-location.
  Optional wedge experiment: pay-per-booked-appointment (Numa model).
- **Beachhead:** threading/brow salons like Richa's (referenceable niche,
  identical service structure), then Phorest's broader base; a Phorest
  marketplace/partner listing once one paying reference exists.

**Platform-risk hedge:** Phorest voice AI is likely eventually (their Front
Desk AI is SMS-only today). Two answers: (a) speed — be the incumbent on N
salons with ROI data before they ship (also makes us a partner/acquisition
candidate rather than roadkill); (b) the `PhorestPort` seam — Boulevard and
Mangomint have NO first-party AI and are the friendliest APIs; a second
adapter turns platform risk into a expansion story. Build nothing
Phorest-only outside the adapter.

**What we deliberately DON'T do:** race Rosie/Goodcall to $49–99 (they can't
write to Phorest — different product); build multi-location/enterprise before
salon #2; build outbound before inbound ROI is proven on Richa.

## Phase D — Defect fixes from the 2026-07-19 code audit (BEFORE live testing)

A three-lens defect hunt (`docs/DEFECTS_2026-07-19.md` — file:line, scenarios,
fix shapes, confidence, scenario→defect test map) found **5 call-breaking (P0),
13 wrong-behavior (P1), ~17 minor (P2)** defects, top findings verified in code
(TZ-1 reproduced under TZ=UTC; PH-5 verified against live Phorest). Highlights:
- [ ] D-TZ1 UTC-server timezone shift (1 line) — mandatory before deploy
- [ ] D-RT2+RT3 tool-result response collision + error fatalization (the
      "interrupt during lookup" call-killer)
- [ ] D-RT4 barge-in dead after response.done (wipes markQueue too early)
- [ ] D-RT1 OpenAI WS close never propagated (zombie silent calls)
- [ ] D-CT1 recognized-caller booking contract break (no clientId/phone →
      duplicate clients / wrong-record bookings)
- [ ] Then PH-1..6, CT-2..5, PH-5 per the fix order in the defects doc
- [ ] D-CF1 **OWNER INPUT:** 2026 closedDates for business.json
Full list + recommended fix order live in the defects doc — work top-down.
**➡️ SWARM EXECUTION PLAN: `tasks/fix_plan_2026-07-19.md`** — lane assignments
(A: Phorest/data ∥ B: OpenAI session → C: orchestration → D: integration gate),
exclusive file ownership, exact fix specs, cross-lane contracts, live
error-capture protocol, and the verification gate. Workers execute that plan,
not this summary.

## Suggested execution order
Phase D P0s (pre-test) → 0.1–0.9 (one sitting) → 1.1–1.4 → 2.1–2.3 → 2.4–2.5 → live test call →
3.x quick wins (3.1, 3.3, 3.8, 3.9 are minutes each) → 4.1 (persistence) →
4.2 (SMS) → 4.3 (digest) → deploy 5.1–5.3 → 4.4+ on real-call data.
Phases 1+2 are the gate for ANY public deploy. The strategic clock: platform
first-party AI receptionists are coming (GlossGenius/Fresha announced; Zenoti
shipped) — the moat window favors shipping 4.1–4.3 and proving ROI on Richa
this quarter over polishing.

## Nice-to-have backlog (deferred, no date)
- [ ] Greeting: signal callers they can just talk normally ("thrown-off by
      AI" feedback, Aryan 2026-08-26) — callers freeze up on an AI
      receptionist. Constraint: greeting is already long (compliance
      recording notice is mandatory) so this must NOT lengthen it — explore
      re-wording within the same breath, or a natural nudge on the first
      unclear/silent turn instead of the cold open. Do AFTER the prompt
      rework has soaked in production.
- [ ] Spam/telemarketer lookup on unrecognized inbound numbers — Twilio
      Lookup + Nomorobo Spam Score add-on ($0.003/lookup, ~$0.20/mo at our
      volume). Aryan installs the add-on in Twilio Console (Marketplace →
      Nomorobo Spam Score); code: lookup non-client numbers in parallel with
      greeting, cache per-number in data/, score=1 → soft guard line in
      Erica's context (polite-brief-no-transfer). Soft signal ONLY — never
      auto-block (false positives). Deferred by Aryan 2026-08-26.
