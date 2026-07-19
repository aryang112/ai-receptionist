# STATE — AI Receptionist (Erica)

> Working memory / handoff. Read `tasks/lessons.md` and `docs/CODEMAP.md` next.
> Last major work: 2026-06 — GA Realtime migration + ~25 production-bug fixes.

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
- **Branch:** `feat/erica-v2` (NOT merged to main). ~30 commits of fixes.
- **Build/tests:** `tsc` clean, **39/39 vitest** green. Run `npm test` after every change.
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
