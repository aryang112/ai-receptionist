# Lessons — AI Receptionist (Erica)

Hard-won gotchas. Read this BEFORE touching Phorest time handling, the OpenAI
session config, or the availability/booking flow. Most of these bit us in
production testing and cost real debugging.

---

## ⏰ Phorest timezone is INCONSISTENT per endpoint (bit us 3×)
The single biggest trap. The same tenant returns different timezones per endpoint:
- **GET `/appointment`** → returns **salon-LOCAL** time (`"12:45:00"` = 12:45 PM local).
- **POST `/appointments/availability`** → returns **UTC** (`"...T19:00:00Z"`).
- **Writes** (booking/reschedule) → send **local wall-clock**; Phorest stores it as-is.

**RULE:** normalize EVERYTHING to salon-local at the adapter boundary in
`src/services/phorest.client.ts` (there's a big comment at `SALON_TIMEZONE`).
Never hand a raw Phorest time string to the model/caller without converting first.
- Reads parse appointment times with `{ zone: SALON_TIMEZONE }`, NOT `'utc'`.
- `getAvailability` converts the UTC `Z` slots → local before returning.
- The system prompt is injected with the current salon date/time so the model
  computes "today"/"tomorrow" correctly (don't trust the model's own clock).

## 🔑 Phorest query params are snake_case, NOT camelCase (was a PRIVACY leak)
`?clientId=` is **silently ignored** — `/appointment?clientId=X` returned EVERY
client's appointments (one caller heard a stranger's appointment + could have
rescheduled it). The correct param is **`client_id`**. Same for `from_date`,
`to_date`, `appointment_id`. Defense-in-depth: also filter results by clientId
client-side (the appointment object carries a `clientId` field).

## Other Phorest API quirks
- **31-day cap:** `/appointment` rejects ranges > 31 days ("Max date range allowed
  is 31 days"). `listAppointments` uses 30.
- **`?mobile=` does not filter** clients → we build a full client phone index in
  memory (paginated, warmed at boot, parallel-but-bounded to 5 concurrent so we
  don't blow undici's 6-connection limit and time out).
- **Direct `GET /appointment/{id}` returns 404** on this tenant → use the query
  endpoint / fallback scan.
- **Cancelling a `PAID` (completed) appointment → HTTP 500.** Only cancel
  `BOOKED`. `listAppointments` only surfaces upcoming `BOOKED` ones.
- **Bookings need `bookingStatus: "ACTIVE"`** in the `/booking` body — otherwise
  they can land as RESERVED holds that **expire (~7 min) and vanish** from the
  calendar (looked like a hallucination; was an expiring hold).
- **Availability is per-staff** (`PHOREST_PRIMARY_STAFF_ID`). With/without the
  staff restriction returned identical slots in testing, so it wasn't the cause
  of "no evening slots" — that was our slice bug (below).
- Auth is HTTP Basic (`username:secret`), no token fetch. Phone normalize = 10
  digits, strip leading 1.

## 🤖 OpenAI Realtime GA gotchas
- **No `OpenAI-Beta` header.** The beta endpoint + `gpt-4o-realtime-preview` were
  shut off May 2026. Use `gpt-realtime` and the GA nested session schema
  (`session.audio.input/output.format = {type:'audio/pcmu'}`, `output_modalities`,
  `turn_detection` under `audio.input`).
- **`session.max_response_output_tokens` is INVALID at session level** — it belongs
  on `response.create`. Sending it makes OpenAI reject the WHOLE `session.update`
  → the call **hangs up instantly**. ⇒ **ALWAYS validate a new session field
  against the live API before shipping** (connect, send config, watch for an
  `error` event). We got burned twice trusting docs/research on field names.
- **`session.truncation = {type:'retention_ratio', retention_ratio:0.8}`** IS valid
  and is the key lever against the mid-call freeze.
- **Token rate limit (40k/min on a low tier) freezes long calls.** The Realtime API
  re-bills the FULL context every turn, so a big system prompt (e.g. a 63-item
  price menu) blows the per-minute cap mid-call → dead air. Keep the prompt small
  (data lives behind tools like `get_prices`, NOT in the prompt); keep the prefix
  stable for prompt caching (cached audio input ~$0.40/1M vs $32/1M).
- **Cedar / Marin** are the most natural voices but are **Realtime-exclusive** —
  NOT in the TTS API. So you can't pre-render a matching greeting clip via TTS
  (it'd be a different voice = the mismatch we deleted the Polly greeting to fix).

## 🪓 Self-inflicted bug we kept repeating: the `slice()` bug
`suggest_availability` sliced to the first N slots = the EARLIEST ones, repeatedly
hiding afternoon/evening availability (slice(0,6) → slice(0,12) → still wrong; a
full day is ~29 slots). Fixed properly: return slots **nearest to the caller's
`preferredTime`**, or an **even spread across the whole day** if no time given.
NEVER "first N" on a time-ordered slot list.

## 🗣️ Conversation behavior lessons
- **Don't assume intent.** Erica was greeting then immediately running tools and
  driving the flow ("let me pull up your appointments…") unprompted. Greet → STOP
  → WAIT. Only act on a clearly-stated request; ask if unclear.
- **Mask tool latency with a spoken filler** ("let me check that…") before every
  tool call so the line never goes dead.
- **Telephony has no echo cancellation** — the agent's own greeting can echo back
  (esp. speakerphone) and falsely trigger a turn. `semantic_vad` (waits for
  semantic end-of-turn) is the candidate fix; verify its GA shape first.

## Workflow lessons
- `tsx watch` auto-reloads on save — every commit is live immediately.
- Verify against REAL Phorest data with the `scripts/*.ts` diagnostics, not
  assumptions (the "hallucinated appointment" was real data from the camelCase bug).
- Never stage `.env` / `.env.example` (live keys are in them).

## 🪧 Never claim an optimization the code doesn't perform (F8)
Phase 3.1 "concurrent prefetch" was reported DONE in state.md + commit while the
code still ran `warmCallerContext` strictly AFTER `await connect()` — functionally
serial. An architect review caught it. A false "done" is worse than an open item:
it burns trust in every OTHER claim in the same handoff. Rule: before writing
"done/optimized/concurrent/parallel" for a behavior, trace the actual control
flow (what's awaited before what). If you can't point at the line that makes it
true, don't claim it. (The real fix: start the lookup BEFORE `await connect()`,
inject its result only after the session is open.)

## 🧪 Test ABOVE the validation seam, not just below it (F1)
The defects swarm added `clientId` to the OpenAI TOOL_DEFINITIONS but not to the
zod `TOOL_SCHEMAS` — zod strip-mode silently DELETED it, re-breaking CT-1. The
booking-layer contract tests passed because they call `bookAppointment()`
directly, BELOW `parseToolArgs`. The bug lived in the gap the tests skipped over.
Rule: when a value crosses a validation/parse boundary (zod, a schema, a
serializer), put at least one test on the FAR side of it — drive the actual
handler (`handleBookAppointment(rawArgs)`), not just the function it eventually
calls. Keep TOOL_DEFINITIONS and TOOL_SCHEMAS mirror-images.
