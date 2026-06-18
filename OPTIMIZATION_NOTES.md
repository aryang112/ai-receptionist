# Latency / Reliability Optimization — 2026-06-18

Diagnosis from the real call logs + a verified research pass, then implemented.
**The slowness was never the AI model or "the cloud being far away"** — a plain
conversational turn was ~200–375ms to first audio. On-prem / NVIDIA hosting would
NOT help a single Twilio phone line (the dominant latency is the PSTN/telephony
floor, which is independent of where compute runs) and costs ~10–40× more. Fixes
were all architectural.

## What changed (committed on `feat/erica-v2`)

**Realtime pipeline (`openaiSession.ts`, `twilioStream.ts`, `routes/twilio.ts`, `env.ts`, `index.ts`)**
- **GA Realtime migration (was required, not optional):** the old
  `gpt-4o-realtime-preview` model and the realtime **beta endpoint** were shut
  off by OpenAI in May 2026. Now on GA: no `OpenAI-Beta` header, model
  `gpt-realtime`, GA nested `session` schema.
- **G.711 µ-law passthrough:** `audio/pcmu` in/out — Twilio frames and OpenAI
  deltas are forwarded verbatim. Deleted all per-frame µ-law↔PCM + 8k↔24k
  resampling (CPU + the aliasing that caused ASR mishears / "say that again").
  → `src/realtime/audio.ts` is now **unused / dead code** (safe to delete).
- **Barge-in:** on caller speech, truncate the active item + send Twilio `clear`
  to flush buffered audio (tracks media timestamps + mark queue).
- **Crash-safety:** event dispatch can't become an unhandled rejection;
  tool-result/append are no-ops on a closed socket (fixes the
  `transfer_to_owner` mid-call process crash); process-level guards in `index.ts`.
- **One-voice greeting:** Erica greets via `response.create`; dropped the
  mismatched Polly `<Say>`.
- **VAD** silence 500ms → 400ms. **Filler-before-tools** added to instructions.

**Phorest hot path (`phorest.client.ts`)**
- 4s timeout + 1 retry on every request (a hung call no longer = dead air).
- Client phone index: parallel pagination + warmed at server boot + new clients
  appended in-memory.
- Booking resolves client + staff concurrently.
- Reschedule: direct `GET /appointment/{id}` fast path (was up to 10 serial pages).

**Tests:** `src/tests/phorest.client.test.ts` — to_date regression, retry, no-retry-on-4xx, abort signal. (20/20 green, `tsc` clean.)

## ⚠️ YOU MUST DO before the next live call
1. **Create a new OpenAI API key** (the old ones were committed in `.env.example`
   and are burned) and put it in `.env` as `OPENAI_REALTIME_API_KEY`.
2. **Check `.env`** — make sure it does NOT pin the dead model. Set (or remove to
   use defaults): `OPENAI_REALTIME_MODEL=gpt-realtime`, `OPENAI_REALTIME_VOICE=shimmer`.
3. **Rotate the Phorest credentials** (committed in `NextSteps.md`).
4. Purge all of the above secrets from git history.

## First live-call test checklist (needs the new key)
- Erica greets first, one voice, no dead air at pickup.
- Interrupt her mid-sentence → she stops immediately (barge-in).
- Ask to cancel/reschedule → hears a "let me check…" filler, no long silence.
- Trigger a transfer ("let me talk to Richa") → call transfers, **server stays up**.

## Remaining production checklist (infra — needs your hosting choices)
- Deploy long-lived (NOT serverless — caches depend on one process) in a US
  region near Twilio's media edge.
- Rate-limit `/twilio/*` + `/api/*`; validate Twilio request signatures.
- Optional: mid-call OpenAI WS reconnect-and-resume (today a hard drop ends the call gracefully).
- Optional architectural upgrade for the slow Phorest backend: capture booking
  intent live, commit to Phorest async after the call + SMS confirm.
