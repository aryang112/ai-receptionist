# CODEMAP — AI Receptionist (Erica)

Orientation map so agents don't have to scan every file. See `state.md` for status
and `tasks/lessons.md` for the gotchas.

## Data flow (a call)
```
Caller dials Twilio number
  → Twilio POSTs /twilio/voice  (routes/twilio.ts)
      returns TwiML <Connect><Stream url=wss://…/twilio/stream>
        + <Parameter name="from" value="<caller#>">   ← caller ID for prefetch
  → Twilio opens WS to /twilio/stream  (realtime/twilioStream.ts)
      'start' event → connect to OpenAI Realtime, configureSession(instructions+tools),
                      warmCallerContext(caller#)  [prefetch], requestGreeting()
      'media' events → forward g711 µ-law frames verbatim to OpenAI (no transcoding)
  → OpenAI Realtime (gpt-realtime, speech-to-speech)  (realtime/openaiSession.ts)
      emits audio deltas → forwarded verbatim back to Twilio
      emits function calls → tool handlers in twilioStream.ts → Phorest
  → Phorest API  (services/phorest.client.ts)  — booking/availability/clients
```

## src/realtime/
- **twilioStream.ts** — the brain. Holds Erica's system prompt (`buildInstructions()`),
  `TOOL_DEFINITIONS`, all tool handlers (`handleSuggestAvailability`,
  `handleBookAppointment`, `handleReschedule`, `handleCancel`, `handleGetBusinessHours`,
  `handleGetPrices`, `handleLookupCustomer`, `handleListAppointments`,
  `handleLogRunningLate`, `handleTransferToOwner`), barge-in (mark/clear/truncate),
  outbound audio to Twilio, and the caller-ID prefetch: **`prepareCallerContext`**
  (700ms-capped lookup racing the greeting; a TIMEOUT is not a no-match — the
  in-flight lookup keeps running and upgrades the call late via
  **`adoptRecognizedCaller`** + `applyCallerContext`, see c4b9c7d). The per-call
  `prefetch` field caches the recognized caller.
  Also (2026-08-21): **silence watchdog** (`startSilenceWatchdog`/`tickSilenceWatchdog`
  — 20s mutual silence → one check-in, +15s → goodbye + hangup; guards:
  sessionReady/toolCallsInFlight/transferring/markQueue), **duration cap**
  (`startDurationCap` — warn at cap−60s, goodbye+hangup at cap, ≤15s in-flight-tool
  grace), shared **`endCallNow(reason)`** hangup core (drain + REST + bargeInEpoch
  abort; `handleEndCall` is a thin wrapper), `registerTrackedTool` (counts
  `toolCallsInFlight`), prompt sections CONVERSATION POLICY (G1) + reschedule
  consent gate (B2b). Also (2026-08-21 late): **`notifyOwnerSms`** (best-effort
  FYI text from TWILIO_NUMBER → OWNER_PHONE; fire-and-forget), `clientNames`
  map (clientId→name at every server-side resolution point — feeds the SMS,
  never trusts model-supplied identity); log_running_late takes optional
  `detail` (caller's words → dynamic note + SMS), transfer drain cap 12s.
  Also (2026-08-22, Round 3): **`fetchOpenSlots(service, date)`** — the
  extracted fetch→snap→hours-filter "which times are genuinely open" truth;
  used by suggest_availability AND re-run fresh immediately before every
  booking/reschedule WRITE (A1 — rejects a stale time with the current list,
  fail-open on Phorest errors). **Vacation gate** in `handleTransferToOwner`
  (active vacation → no dial; SMS message to Richa via notifyOwnerSms,
  returns `{transferred:false}`); VACATION prompt block auto-injected when a
  business.json vacation is active/≤14 days out. **Spam**: SPAM &
  TELEMARKETING prompt section; `end_call` takes optional `reason`
  ('done'|'spam') → outcome 'spam' → `recordSpamOutcomeIfNotClient` on
  cleanup (NEVER for numbers in the Phorest client index). LOCATION prompt
  line + `address` in get_business_hours (from business.json). Greeting
  order (A2): `flushPendingMedia()` runs AFTER `requestGreeting()` so
  buffered early speech barges-in the greeting instead of suppressing it.
- **openaiSession.ts** — `OpenAIRealtimeSession`: WS connect (GA, no beta header),
  `configureSession` (GA nested schema: g711_ulaw, server_vad, noise_reduction,
  truncation.retention_ratio), event loop (`handleEvent`), tool-call buffering,
  `injectContext`, `requestGreeting`, **`requestResponse()`** (guarded response.create
  — the ONLY safe out-of-band speech trigger; use with `injectContext`),
  `truncateActiveResponse` (barge-in), RT-5 retry (cleared on speech_started — B2;
  capped at 2 consecutive, reset on success/speech — B3), latency +
  token + TPM logging, crash-safe sends. **Validate any new session field vs the live API.**
- **audio.ts** — DELETED (g711 passthrough replaced it).

## src/services/
- **phorest.client.ts** — the REAL Phorest adapter (`realPhorest: PhorestPort`).
  ⚠️ All the API quirks live here: timezone normalization, `client_id` snake_case,
  31-day cap, client phone index (bounded-parallel, TTL service cache), `bookingStatus:
  ACTIVE`, availability UTC→local. `phorestFetch` has timeout+retry. Big tz convention
  comment at `SALON_TIMEZONE`.
- **blocklist.ts** — repeat-spam blocklist (S2). `recordSpamOutcome(phone)` /
  `isBlocked(phone)` (count ≥ `SPAM_BLOCK_THRESHOLD`, default 2). In-memory
  cache + write-through `data/blocklist.json` (human-editable = the unblock
  path); never throws. The client guard lives in twilioStream (a Phorest
  client can never be blocklisted).
- **phorest.mock.ts** — mock adapter (tests + USE_MOCK_PHOREST=true).
- **phorest.ts** — selector (mock vs real by env / NODE_ENV).
- **phorest.types.ts** — `PhorestPort` interface (CONTRACT — mock & real must match),
  `Service`, `CustomerResult`, `AppointmentSummary`.
- **booking.ts** — `suggestSlots`, `bookAppointment`, `findServiceByName` (fuzzy match
  + `SERVICE_ALIASES`, e.g. "lash lamination"→"Lash Lift"), Zod schemas.
- **ai.ts**, **twilio.ts** — legacy helpers.

## src/core/
- **hours.ts** — `getHoursStatus(date)` (open/closed/closedRightNow/nextOpen),
  `getOpenClose(date)`. Reads `config/business.json` (the hours source of truth).
  V1: `vacations` ranges close those dates like closedDates;
  `getActiveOrUpcomingVacation(now?)` → `{from,to,reopenISO}|null` (active or
  starting ≤14 days) drives the prompt block + transfer gate.
- **slots.ts** — `snapSlotsToGrid(slots, gridMin)` / `ceilToGrid`. Snaps Phorest's
  re-anchored odd-minute availability starts UP to a clean clock grid before Erica
  offers them (see lessons.md). Called in `handleSuggestAvailability`.
- **logger.ts** — pino logger. In dev it tees stdout → `data/dev.log`
  (truncated on every boot, gitignored) so any call can be inspected after the
  fact. `LOG_FILE=off` disables; skipped in production/test. `npm run logs`
  pretty-prints/follows it (`scripts/tail-log.mjs`).

## src/routes/
- **twilio.ts** — `/voice` (returns the Stream TwiML + caller-# param + `stir`
  STIR/SHAKEN param, log-only). S2: a blocklisted number gets `<Reject>` here —
  before any OpenAI session opens (repeat robocalls cost ~$0). `/gather` (legacy).
- **appointment.ts**, **metadata.ts**, **health.ts** — REST/health endpoints.

## src/config/
- **env.ts** — all env (model, voice, VAD knobs `OPENAI_VAD_*`, `OPENAI_NOISE_REDUCTION`,
  `SERVICE_CACHE_TTL_HOURS`, Phorest creds, `OWNER_PHONE`, `SILENCE_CHECKIN_MS`/
  `SILENCE_HANGUP_MS` (20s/15s watchdog), `MAX_CALL_MINUTES` (10),
  `BLOCKLIST_PATH`, `SPAM_BLOCK_THRESHOLD` (2)). Defaults are sensible.
- **business.json** — salon hours per weekday + closedDates + `vacations`
  (`[{from,to,note}]` — ONE entry closes booking those dates, reroutes transfer
  to SMS message-taking, injects the prompt block; edit this for future
  vacations) + `location` (address for the prompt/hours tool). **Do not change casually.**

## src/tests/  (vitest, 174 tests)
phorest.client.test.ts (URL/range/client_id/timezone/retry regressions),
hours.test.ts, booking.alias/match.test.ts, slots.test.ts (clean-grid snapping),
wsAuth, middleware, twilioStream.bargein/contracts, phorest.mock/selector,
appointment(.validation), twilio.route, openaiSession.test.ts (RT-5 retry, B2
stale-retry clear, B3 retry cap, requestResponse guard),
twilioStream.silenceWatchdog.test.ts (9, fake timers),
twilioStream.durationCap.test.ts (5, fake timers). Round 3 (2026-08-22):
twilioStream.prompt.test.ts (LOCATION/VACATION/SPAM sections),
twilioStream.vacation.test.ts (transfer gate), twilioStream.spam.test.ts
(end_call reason→outcome), blocklist.test.ts + twilioStream.blocklist.test.ts
(threshold/persistence/client guard), twilioStream.freshCheck.test.ts (A1
stale-slot rejection + fail-open), twilioStream.greetingRace.test.ts (A2 order).

## scripts/  (read-only diagnostics + ops)
inspect-appointment.ts, list-services.ts, check-availability.ts, test-appt-filter.ts,
set-twilio-webhook.sh, tail-log.mjs (pretty live view of data/dev.log — `npm run logs`).

## Tools the model can call
`suggest_availability(serviceName, date, preferredTime?)`, `book_appointment`,
`reschedule_appointment`, `cancel_appointment`, `get_business_hours`, `get_prices(serviceName?)`,
`lookup_customer(phone?/name?)`, `list_appointments(clientId)`, `log_running_late`,
`transfer_to_owner(reason)` (during an active vacation: no dial — SMS message
to Richa instead), `end_call(reason?: 'done'|'spam')` (graceful hangup after
caller confirms done, or right after the one-line spam decline — 'spam' tags
the outcome for the blocklist; drains goodbye audio, aborts if the caller
barges in mid-goodbye).

## Log markers to grep
`⏱` per-turn latency + tool durations · `📊` token usage + cache-hit% · `⚖️` TPM remaining
/ retry budget exhausted · `🗣️ ERICA SAID` / `USER SAID` transcripts · `🗓️ Booking state
after create` · `📞`/`☎️` call start/end · `🤫` silence check-in/hangup · `⏳` duration
warning/cap hangup · `📨` owner FYI SMS sent (warn lines: skipped/failed) ·
`🚫` blocked spam caller (webhook reject) · "Transfer suppressed — Richa is on
vacation" · "rejected — time no longer available on fresh re-check" (A1).
