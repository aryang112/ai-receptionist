# CODEMAP — AI Receptionist (Erica)

Orientation map so agents don't have to scan every file. See `state.md` for status
and `tasks/lessons.md` for the gotchas.

For a current architecture, Realtime 2.1, quirks, and operations handoff, start
with [`GPT-SOL/README.md`](GPT-SOL/README.md).

Forwarding is live as of 2026-09-02. The categorized reliability backlog,
prompt-versus-code decisions, acceptance tests, and after-hours-only release
gate are in
[`FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md`](FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md).

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
  → OpenAI Realtime (gpt-realtime-2.1, speech-to-speech)  (realtime/openaiSession.ts)
      emits audio deltas → forwarded verbatim back to Twilio
      emits function calls → tool handlers in twilioStream.ts → Phorest
  → Phorest API  (services/phorest.client.ts)  — booking/availability/clients
```

## src/realtime/
- **twilioStream.ts** — the brain. Holds Erica's system prompt (`buildInstructions()` —
  **2026-08-28 Realtime 2.1 prompt release**: explicit Priority → Personality →
  Language → short-turn/turn-taking → Context → Reasoning/unclear audio →
  selective Preambles → Tools → Operating/Privacy → Conversation Flow →
  Safety → dynamic CURRENT STATUS last. `buildRecognizedCallerContext()` and
  `buildUnrecognizedCallerContext()` own compact late caller state;
  `REALTIME_CONTEXT_NOTES` owns unscripted silence/duration/goodbye coaching.
  Section order, one-question identity, write boundaries, a <4.2k fallback
  budget, and a <5k stressed 63-service path are locked by
  twilioStream.prompt.test.ts. 2026-09-02: one global TEMPORARY CLOSURE POLICY
  folds in the salon-configured public reason, dates, and current status; it
  adapts named-person, salon-hours, affected-booking, and unrelated-provider
  wording without duplicating scenario scripts. RICHA'S LINE carries the
  precomputed public reason + full reopen date when transfer is unavailable,
  and the word "vacation" is test-locked out of the rendered prompt except the
  explicit ban clause. See docs/PROMPT_AUDIT_2026-09-01.md. See
  [`GPT-SOL/PROMPT_ARCHITECTURE.md`](GPT-SOL/PROMPT_ARCHITECTURE.md) and the fix
  ladder in tasks/lessons.md. State-specific coaching still lives in tool-result
  `note` fields. `matchStaffName()` +
  `matchCallerNamedStaff` catch a staff name passed as serviceName (the
  Glenda flub) and coach via the tool result; suggest_availability /
  list_appointments results carry state-specific notes; wire formats live in
  TOOL_DEFINITIONS descriptions),
  `TOOL_DEFINITIONS`, all tool handlers (`handleSuggestAvailability`,
  `handleBookAppointment`, `handleReschedule`, `handleCancel`, `handleGetBusinessHours`,
  `handleGetPrices`, `handleLookupCustomer`, `handleListAppointments`,
  `handleLogRunningLate`, `handleTransferToOwner` — 2026-08-24 its `<Dial>` is
  TIMED (`TRANSFER_DIAL_TIMEOUT_S`) with an `action` back to
  `/twilio/dial-status`, built from the `host` stream parameter; no host ⇒ the
  original bare `<Dial>`. A `transferFailed=1` segment sets `transferFailback`,
  which swaps ONLY the GREETING paragraph, skips the duplicate
  `CallStore.startCall` + `startCallRecording` (segment 1 already wrote both),
  and makes transfer_to_owner return message-taking coaching — never a second dial),
  barge-in (mark/clear/truncate),
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
  consent gate (B2b). Also (2026-08-21 late): **`notifyOwnerSms`** (bounded
  result-bearing delegation to ownerSms), `clientNames`
  map (clientId→name at every server-side resolution point — feeds the SMS,
  never trusts model-supplied identity); log_running_late takes optional
  `detail` (caller's words → dynamic note + SMS), transfer drain cap 12s.
  Also (2026-08-22, Round 3): **`fetchOpenSlots(service, date)`** — the
  extracted fetch→snap→hours-filter "which times are genuinely open" truth;
  used by suggest_availability AND re-run fresh immediately before every
  booking/reschedule WRITE (A1 — rejects a stale time with the current list,
  fail-open on Phorest errors). **Temporary-closure gate** in
  `handleTransferToOwner` (active salon closure → no dial and no synthesized
  message; returns `{transferred:false,messageRequired:true}`); the global
  closure policy is auto-injected when a business.json range is active/≤14
  days out. **Spam**: SPAM &
  TELEMARKETING prompt section; `end_call` takes optional `reason`
  ('done'|'spam') → outcome 'spam' → `recordSpamOutcomeIfNotClient` on
  cleanup (NEVER for numbers in the Phorest client index). LOCATION prompt
  line + `address` in get_business_hours (from business.json). Greeting
  order (A2): `flushPendingMedia()` runs AFTER `requestGreeting()` so
  buffered early speech barges-in the greeting instead of suppressing it.
  2026-09-02 after-hours reliability: live transfer and caller messages are
  separate. **`handleLeaveMessageForOwner`** takes no model-authored content
  and delivers only exact final caller transcripts correlated by OpenAI item
  ID. A per-call `inactive → offered → collecting` state separates an offer
  from actual content, preserves a fixed multi-turn capture boundary, advances
  readiness after follow-up solicitations, rejects stale/premature attempts,
  clears abandonment pivots, and deduplicates same-item and normalized-content
  retries. Message bodies never enter tool telemetry. Explicit
  speak/talk/connect/transfer prompt rules outrank availability-only ambiguity
  and require the September 10 return date while Richa is away.
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
  2026-09-02: new-client resolution is single-flight by normalized phone plus
  confirmed full name (email+name fallback when phone is absent); exact-name
  candidates are ranked by matching supplied contacts and tied best matches
  fail closed. A possibly committed create is latched in-process and can only
  run bounded read-only reconciliation—never another create POST. The latch is
  not restart-durable. New-client POSTs omit email when none was genuinely
  supplied; blank email is never replaced with a synthetic placeholder.
- **blocklist.ts** — repeat-spam blocklist (S2). `recordSpamOutcome(phone)` /
  `isBlocked(phone)` (count ≥ `SPAM_BLOCK_THRESHOLD`, default 2). In-memory
  cache + write-through `data/blocklist.json` (human-editable = the unblock
  path); never throws. The client guard lives in twilioStream (a Phorest
  client can never be blocklisted).
- **callStore.ts** — append-only JSONL per-call persistence (`data/calls.jsonl`).
  Record types: start (from, recognizedClientId, stirVerstat) · tool · booking ·
  end (outcome, endReason, usage, estCostUsd, assistantTranscript) · transcript
  (interleaved both-side entries, M1) · recording (recordingSid, M2) · blocked
  (S2). `readCalls()` is the one sanctioned reader (dashboard + digest).
- **ownerSms.ts** — `sendOwnerSms(body, to?)` — the extracted owner-SMS core,
  used by running-late FYI, exact caller message-taking, and the digest. It
  never throws; the SDK and outer promise are capped at five seconds, a SID
  plus an accepted status is required for `queued:true`, terminal failures are
  rejected, and missing/unknown/timed-out outcomes are explicitly uncertain.
- **digest.ts** — `buildDailyDigest`/`buildWeeklyDigest` (calls, bookings +
  $revenue, spam, after-hours captured, est cost — salon-TZ day buckets; null
  on quiet days) + `maybeSendDigest(now?)` (once-daily send at `DIGEST_TIME`,
  stamped in `data/digest-state.json`; Sundays append the weekly).
- **phorest.mock.ts** — mock adapter (tests + USE_MOCK_PHOREST=true).
- **phorest.ts** — selector (mock vs real by env / NODE_ENV).
- **phorest.types.ts** — `PhorestPort` interface (CONTRACT — mock & real must match),
  `Service`, `CustomerResult`, `AppointmentSummary`.
- **booking.ts** — `suggestSlots`, `bookAppointment`, `findServiceByName` (fuzzy match
  + `SERVICE_ALIASES`, e.g. "lash lamination"→"Lash Lift"), Zod schemas.
## src/core/
- **hours.ts** — `getHoursStatus(date)` (open/closed/closedRightNow/nextOpen),
  `getOpenClose(date)`. Reads `config/business.json` (the hours source of truth).
  V1: `vacations` ranges close those dates like closedDates;
  `getActiveOrUpcomingVacation(now?)` →
  `{from,to,reopenISO,publicExplanation?}|null` (active or starting ≤14 days)
  drives the prompt block + transfer gate. `getVacationForDate(iso)` returns
  the same public closure context for ANY affected date (feeds the
  suggest_availability note). `nextOpen` names the date when the next opening
  is 7+ days out (2026-09-01: bare "Thursday" pointed at a closed day).
  `isWithinTransferWindow(now?)` — the HUMAN transfer window (2026-08-24, the
  Holly fix): live-transfer gate follows Richa's waking hours
  (`TRANSFER_WINDOW_START/END`, default 09:00–21:00 salon TZ, end-exclusive),
  ignoring the salon calendar entirely — her cell rings, not the front desk.
- **slots.ts** — `snapSlotsToGrid(slots, gridMin)` / `ceilToGrid`. Snaps Phorest's
  re-anchored odd-minute availability starts UP to a clean clock grid before Erica
  offers them (see lessons.md). Called in `handleSuggestAvailability`.
- **logger.ts** — pino logger. In dev it tees stdout → `data/dev.log`
  (truncated on every boot, gitignored) so any call can be inspected after the
  fact. `LOG_FILE=off` disables; skipped in production/test. `npm run logs`
  pretty-prints/follows it (`scripts/tail-log.mjs`).

## src/routes/
- **twilio.ts** — `/voice` (returns the Stream TwiML + caller-# param + `stir`
  STIR/SHAKEN param, log-only + `host` public-host param). S2: a blocklisted
  number gets `<Reject>` here — before any OpenAI session opens (repeat
  robocalls cost ~$0). `/gather` (legacy). **`/dial-status`** (2026-08-24, the
  live-transfer no-answer fallback): the action callback for
  handleTransferToOwner's `<Dial>`. `DialCallStatus === 'completed'` →
  `<Hangup/>`; anything else (no-answer / busy / failed / canceled) →
  reconnect the caller to a fresh Erica session with `transferFailed=1`
  instead of dropping them in Richa's personal voicemail (no-answer) or
  hanging up on them (busy/failed). `deriveStreamUrl` + `derivePublicHost` +
  the shared `buildStreamTwiml` mean /voice and /dial-status can't drift.
- **admin.ts** — the OWNER DASHBOARD (M3). Token-auth (`ADMIN_TOKEN`,
  fail-closed in prod, timing-safe compare), read-only GETs: `/admin` (serves
  `src/public/dashboard.html` — self-contained mobile-first page),
  `/admin/api/calls` (joined per-call view: last-4 only, outcome, tools,
  booking, usage/cost, flags), `/admin/api/stats` (daily buckets: revenue
  booked, est cost, after-hours capture, spam), `/admin/api/transcript/:sid`,
  `/admin/api/recording/:sid` (auth-proxied Twilio audio — creds never reach
  the browser).
- **metadata.ts**, **health.ts** — REST/health endpoints.

## src/config/
- **env.ts** — all env (model, voice, VAD knobs `OPENAI_VAD_*`, `OPENAI_NOISE_REDUCTION`,
  `SERVICE_CACHE_TTL_HOURS`, Phorest creds, `OWNER_PHONE`, `SILENCE_CHECKIN_MS`/
  `SILENCE_HANGUP_MS` (20s/15s watchdog), `MAX_CALL_MINUTES` (10),
  `BLOCKLIST_PATH`, `SPAM_BLOCK_THRESHOLD` (2), `OPENAI_INPUT_TRANSCRIPTION`
  (⚠️ default 'off' — session-shape change, flip only after a live call
  validates it), `RECORD_CALLS` ('true'), `ADMIN_TOKEN` (set in prod!),
  `DIGEST_ENABLED`/`DIGEST_TIME` ('08:30')/`DIGEST_TO`,
  `TRANSFER_WINDOW_START`/`TRANSFER_WINDOW_END` ('09:00'/'21:00' — Richa's
  live-transfer calling hours, decoupled from salon hours),
  `TRANSFER_DIAL_TIMEOUT_S` (15 — how long her phone rings before the dial
  hands back to /twilio/dial-status; deliberately under the ~20–25s carrier
  voicemail pickup)). Defaults are sensible.
- **business.json** — salon hours per weekday + closedDates + `vacations`
  (`[{from,to,note}]` — ONE entry creates a SALON-WIDE closure, closes booking
  on those dates, reroutes transfer to message-taking, and supplies the public
  reason to the global closure policy) + `location` (address for the
  prompt/hours tool). One provider's absence in a multi-stylist salon is not a
  salon closure. **Do not change casually.**

## src/tests/  (vitest, 44 files / 512 tests as of 2026-09-02)
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
2026-08-24 (transfer failback): twilioStream.transferFailback.test.ts (timed
dial + action URL, bare-dial fallback, no second dial, no duplicate
start/recording rows), plus new cases in twilio.route (`/dial-status`, the
`host` param), twilioStream.prompt (greeting swap is the ONLY diff) and
admin.route/digest (two end rows + two transcript rows → last outcome wins,
usage/duration/cost summed, transcript concatenated by ts).
2026-09-02 reliability release: `twilioStream.ownerMessage.test.ts` covers
exact multi-turn Bank messages, offer-versus-content consent, item/content
dedupe, premature/stale calls, abandonment, and correction races;
`ownerSms.test.ts` covers accepted/terminal/unknown statuses and timeouts;
`phorest.client.test.ts` covers mixed-payload client single-flight, ranked/tied
contact matches, committed-timeout reconciliation, delayed visibility, and
reconcile-only retries; prompt/vacation suites lock explicit versus ambiguous
Richa requests and the September 10 return date.

## scripts/  (read-only diagnostics + ops)
inspect-appointment.ts, list-services.ts, check-availability.ts, test-appt-filter.ts,
test-call-local.sh (direct-call staging harness), Realtime/integration diagnostics,
set-twilio-webhook.sh, tail-log.mjs (pretty live view of data/dev.log — `npm run logs`).
2026-09-01 (prompt audit, all read-only, run with `node --env-file=.env --import tsx`):
**render-prompt.ts** (today's CURRENT STATUS tail + constraint-word counts +
quoted candidate-reply lines), **validate-session-fields.ts** /
**validate-transcription-fields.ts** (live-validate a candidate session field
against gpt-realtime-2.1 before shipping — the lessons.md rule as one command),
**probe-client-history.ts** (raw client fields + 120 days of past appointments
for the service-history feature).

## Tools the model can call
`suggest_availability(serviceName, date, preferredTime?)`, `book_appointment`,
`reschedule_appointment`, `cancel_appointment`, `get_business_hours`, `get_prices(serviceName?)`,
`lookup_customer(phone?/name?)`, `list_appointments(clientId)`, `log_running_late`,
`transfer_to_owner()` (live transfer only; during the active away closure: no
dial, returns coaching to collect a message), `leave_message_for_owner()`
(argument-free exact caller-transcript delivery),
`end_call(reason?: 'done'|'spam')` (graceful hangup after
caller confirms done, or right after the one-line spam decline — 'spam' tags
the outcome for the blocklist; drains goodbye audio, aborts if the caller
barges in mid-goodbye).

## Log markers to grep
`⏱` per-turn latency + tool durations · `📊` token usage + cache-hit% · `⚖️` TPM remaining
/ retry budget exhausted · `🗣️ ERICA SAID` / caller transcript completion metadata · `🗓️ Booking state
after create` · `📞`/`☎️` call start/end · `🤫` silence check-in/hangup · `⏳` duration
warning/cap hangup · `📨` owner SMS accepted (warn lines: skipped/failed/uncertain) ·
`🚫` blocked spam caller (webhook reject) · "Transfer suppressed — temporary
salon closure is active" · "rejected — time no longer available on fresh
re-check" (A1).
