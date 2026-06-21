# STATE — AI Receptionist (Erica)

> Working memory / handoff. Read `tasks/lessons.md` and `docs/CODEMAP.md` next.
> Last major work: 2026-06 — GA Realtime migration + ~25 production-bug fixes.

## Current status
- **Branch:** `feat/erica-v2` (NOT merged to main). ~27 commits of fixes this session.
- **Build/tests:** `tsc` clean, **32/32 vitest** green. Run `npm test` after every change.
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
1. **SECURITY (do first):** two live OpenAI keys are in `.env.example` **git history**
   — rotate them in the OpenAI dashboard, replace with blanks, and purge history.
   Phorest creds are in `NextSteps.md` (untracked, never committed — rotate if desired).
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
