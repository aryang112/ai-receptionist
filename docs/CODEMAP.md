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
  outbound audio to Twilio, and **`warmCallerContext`** (caller-ID prefetch +
  `injectContext`). The per-call `prefetch` field caches the recognized caller.
- **openaiSession.ts** — `OpenAIRealtimeSession`: WS connect (GA, no beta header),
  `configureSession` (GA nested schema: g711_ulaw, server_vad, noise_reduction,
  truncation.retention_ratio), event loop (`handleEvent`), tool-call buffering,
  `injectContext`, `requestGreeting`, `truncateActiveResponse` (barge-in), latency +
  token + TPM logging, crash-safe sends. **Validate any new session field vs the live API.**
- **audio.ts** — DELETED (g711 passthrough replaced it).

## src/services/
- **phorest.client.ts** — the REAL Phorest adapter (`realPhorest: PhorestPort`).
  ⚠️ All the API quirks live here: timezone normalization, `client_id` snake_case,
  31-day cap, client phone index (bounded-parallel, TTL service cache), `bookingStatus:
  ACTIVE`, availability UTC→local. `phorestFetch` has timeout+retry. Big tz convention
  comment at `SALON_TIMEZONE`.
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
- **slots.ts** — `snapSlotsToGrid(slots, gridMin)` / `ceilToGrid`. Snaps Phorest's
  re-anchored odd-minute availability starts UP to a clean clock grid before Erica
  offers them (see lessons.md). Called in `handleSuggestAvailability`.
- **logger.ts** — pino logger.

## src/routes/
- **twilio.ts** — `/voice` (returns the Stream TwiML + caller-# param), `/gather` (legacy).
- **appointment.ts**, **metadata.ts**, **health.ts** — REST/health endpoints.

## src/config/
- **env.ts** — all env (model, voice, VAD knobs `OPENAI_VAD_*`, `OPENAI_NOISE_REDUCTION`,
  `SERVICE_CACHE_TTL_HOURS`, Phorest creds, `OWNER_PHONE`). Defaults are sensible.
- **business.json** — salon hours per weekday + closedDates. **Do not change casually.**

## src/tests/  (vitest, 103 tests)
phorest.client.test.ts (URL/range/client_id/timezone/retry regressions),
hours.test.ts, booking.alias/match.test.ts, slots.test.ts (clean-grid snapping),
wsAuth, middleware, twilioStream.bargein/contracts, phorest.mock/selector,
appointment(.validation), twilio.route.

## scripts/  (read-only diagnostics + ops)
inspect-appointment.ts, list-services.ts, check-availability.ts, test-appt-filter.ts,
set-twilio-webhook.sh.

## Tools the model can call
`suggest_availability(serviceName, date, preferredTime?)`, `book_appointment`,
`reschedule_appointment`, `cancel_appointment`, `get_business_hours`, `get_prices(serviceName?)`,
`lookup_customer(phone?/name?)`, `list_appointments(clientId)`, `log_running_late`,
`transfer_to_owner(reason)`.

## Log markers to grep
`⏱` per-turn latency + tool durations · `📊` token usage + cache-hit% · `⚖️` TPM remaining
· `🗣️ ERICA SAID` / `USER SAID` transcripts · `🗓️ Booking state after create` · `📞`/`☎️` call start/end.
