# CODEMAP — AI Receptionist (Erica)

**Current production: `994ce3d`, branch `codex/gpt-live-taste-test`, Railway
deployment `fad266a2-09a3-4bda-90d2-743956dd518f`, 2026-09-17 8:51 PM ET.**
Engine `live`, backend `gpt-5.6-terra`, writes `real`. Deploys come from the
`ai-receptionist-live-2026-09-12` worktree only — main is unlinked from Railway.
**Every "current production" line further down this file is historical and stale;
`state.md`'s CURRENT section is the authority.**

Orientation map so agents don't have to scan every file. See `state.md` for status
and `tasks/lessons.md` for the gotchas.

Orientation map so agents don't have to scan every file. See `state.md` for status
and `tasks/lessons.md` for the gotchas.

`docs/SYMBOLS.md` — generated symbol -> file:line index (`npm run symbols`);
grep it before grepping the source.

For a current architecture, Realtime 2.1, quirks, and operations handoff, start
with [`GPT-SOL/README.md`](GPT-SOL/README.md).

Production is `fcee0d8` on `codex/focused-service-synonyms-2026-09-08`, deployed
September 8 at approximately 6:21 PM ET. Focused brow/lash matching and the
client-create hotfix are live; the existing sequential contact flow is preserved.
See [`reviews/SYNONYMS_RELEASE_2026-09-08.md`](reviews/SYNONYMS_RELEASE_2026-09-08.md).
Forwarding is live. The categorized reliability backlog,
prompt-versus-code decisions, acceptance tests, and after-hours-only release
gate are in
[`FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md`](FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md).

## 2026-09-17 — call-QA fix run (`525233d` … `994ce3d`)

**`src/realtime/twilioStream.ts`**
- `isFarewellText(text)` — **exported**, module-level. The farewell-wording predicate behind
  `liveHasCurrentFarewell`. Precision over recall by design: `take care` counts, `take care of
  <anything>` does not (except `of yourself`). A miss costs one extra farewell request; a false
  positive ships a silent hangup. Unit-tested in `twilioStream.farewellText.test.ts`.
- `isOpenQuestionText(text)` — **exported**, module-level. Did this fresh post-tool text hand the
  turn BACK to the caller? True on an `isMoreHelpOfferText` match anywhere, or a question mark at
  the very END (trailing-only, so "Sound good? See you Saturday!" still closes).
- `liveClosingTextSince(since)` — private. Erica's own output text recorded STRICTLY after `since`;
  the post-tool window the close content gate reads. Never the whole-call buffer — that holds the
  "anything else?" which produced the close in the first place.
- `driveLiveFailbackOpening(session)` — private. On a transfer-failback segment, replaces
  `requestGreeting()`, which appends a "greet + disclose the recording" instruction that OUTRANKS
  the prompt. Sends only the apologetic opening; re-arms the retry nudge but deliberately NOT the
  fatal no-speech deadline, whose failover dials the owner's just-unanswered phone.
- `endCallNow` opts gained `farewellAudioConfirmed`, `farewellTextSince`, `abortIfStillPlaying`.
- `FAILBACK_OPENING_RETRY_MS`, `failbackOpeningRetryTimer` (cleared in `cleanup()`).

**`src/voice/livePrompts.ts`**
- `buildLivePrompt` now USES its `services` argument (it previously discarded it with
  `void services`): renders `SERVICE PRICES` (name + price only — never IDs or durations), a price
  policy authorising an instant quote for one clearly-matched listed service while delegating
  everything else, and `AMBIGUOUS PRICE TERMS`.
- `ambiguousPriceKeys(services)` — **exported**, pure. Derives from the live catalog every bare
  word/word-pair naming two or more listed services at DIFFERENT prices. Ignores text inside
  parentheses; keeps a pair's concatenated form only when the catalog really spells that joined
  word; exempts equal-price collisions per key across all sharers; excludes combo names (`+`, `&`,
  `and`). Nothing hardcoded — edit the Phorest menu and it recomputes.
- Helpers: `stripParentheticals`, `stripServiceCode`, `fmtLivePrice`, `livePriceLines`,
  `bareServiceKeys`, `catalogVocabulary`, `isComboServiceName`, `singularize`.
- The `Reaching Richa` line was REMOVED — the talking model cannot know if she is reachable.

**`src/voice/backendRules.ts`** — `CONNECTING TO RICHA` rewritten as one arc: the handoff covers
connecting plus the short wait in which they may hear ringing; that wait is the single call mechanic
that may ever be named, and only while `RICHA'S LINE` says AVAILABLE; then the deny-list; then the
not-AVAILABLE branch inline.

**`src/services/callStore.ts`** — `recordDialStatus(callSid, dialCallStatus)` appends a
`dial_status` amendment row for any non-`completed` `DialCallStatus` (same pattern and reason as
`recordRecognized`: a fact that resolves after its natural row is already persisted).

**`src/routes/admin.ts`** — `DialStatusRow`; `CallSummary.transferDialStatus`; `computeFlags` raises
`transfer-failed` on EITHER a failed `transfer_to_owner` tool OR a recorded dial status.

**`src/routes/twilio.ts`** — `/dial-status` records the dial outcome. TwiML unchanged.

**New tests:** `adminFlags.transferDial.test.ts`, `twilioStream.farewellText.test.ts`,
`twilioStream.closeContentGate.test.ts`. Suite 839 → 892.

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
  Glenda flub) and coach via the tool result — edit bound scales with name
  length (`maxEditsFor`: 2 edits for 5+ letters so Richard/Rishka→Richa, 1 for
  4 letters so "and"↛Manu), only consulted when the resolver returned NO
  service candidates; `STAFF_MATCH_STOPWORDS` is a small function-word safety
  net. `moreHelpOffered` (set from Erica's own output text via
  `isMoreHelpOfferText`) makes every later tool result carry
  `moreHelpAlreadyOffered` + a note, so "ask once" is server state, not prose;
  suggest_availability /
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
  (S2) · owner_notification (delivery metadata only; never the SMS body).
  `readCalls()` is the one sanctioned reader (dashboard + digest). The
  owner-notification ledger prevents duplicate post-call recaps when the same
  call already delivered a caller message, transfer FYI, running-late notice,
  or schedule-change notice.
- **ownerSms.ts** — `sendOwnerSms(body, to?)` — the extracted owner-SMS core,
  used by running-late FYI, exact caller message-taking, and the digest. It
  never throws; the SDK and outer promise are capped at five seconds, a SID
  plus an accepted status is required for `queued:true`, terminal failures are
  rejected, and missing/unknown/timed-out outcomes are explicitly uncertain.
- **smsStore.ts** — append-only JSONL SMS thread store (`SMS_STORE_PATH`),
  short human refs ("A7") for owner replies, durable opt-out ledger replayed
  on boot. See `docs/areas/sms-concierge.md`.
- **smsCompliance.ts** — STOP/START/HELP keyword detection, exact
  whole-message match only.
- **smsRouter.ts** — `routeInbound`, the four SMS lanes (owner/compliance/
  review_reply/booking) and the fail-closed `isAllowedForAgent` gate.
- **smsSender.ts** — `sendClientSms`, the single exit point to a client,
  opt-out-gated.
- **smsOwner.ts** — `handleOwnerMessage`/`parseOwnerCommand`, Richa/Aryan's
  `"A7 <instruction>"` control channel.
- **smsAgent.ts** (the separate SMS-concierge text agent, not the voice
  owner-SMS above) — as of 2026-09-16 (`12c26d5`) calls
  `openai.responses.create` on `OPENAI_SMS_MODEL` (default `gpt-5.6-terra`)
  with `reasoning: { effort: OPENAI_SMS_EFFORT }`: gpt-5.6 rejects function
  tools together with reasoning on chat completions, so the Responses API is
  required. `gpt-4.1` remains selectable via `OPENAI_SMS_MODEL` and gets no
  `reasoning` field. Locked by `src/tests/smsAgent.test.ts` (5 tests).
- **postCallSummary.ts** — opt-in, asynchronous owner recap after call teardown.
  It gives `gpt-4.1-mini` the immutable final transcript and outcome under a
  strict JSON schema, prefers a Phorest-confirmed client name, rejects invented
  self-stated names/affiliations, distinguishes stated company representatives
  from salon clients, adds `No action needed` to resolved or routine non-client
  calls, and sends one concise `Hi Richa — …` SMS. Generation
  failure falls back to bounded transcript excerpts; delivery never delays or
  changes the live call. Explicit caller messages remain exact text rather than
  generated summaries.
- **digest.ts** — `buildDailyDigest`/`buildWeeklyDigest` (calls, bookings +
  $revenue, spam, after-hours captured, est cost — salon-TZ day buckets; null
  on quiet days) + `maybeSendDigest(now?)` (once-daily send at `DIGEST_TIME`,
  stamped in `data/digest-state.json`; Sundays append the weekly).
- **phorest.mock.ts** — mock adapter (tests + USE_MOCK_PHOREST=true).
- **phorest.ts** — selector (mock vs real by env / NODE_ENV).
- **phorest.types.ts** — `PhorestPort` interface (CONTRACT — mock & real must match),
  `Service`, `CustomerResult`, `AppointmentSummary`.
- **booking.ts** — `resolveService` is THE one service matcher (get_prices and
  suggest_availability both use it; there are not "two selectors"). `normalize()`
  drops joiner words (and/plus/with…) and the modifiers upper/lower from BOTH
  catalog names and caller phrases, maps synonyms (thread→threading,
  waxing→wax…), and token scoring compares token SETS so a repeated word in a
  bundle name ("Brow Thread + Lip Thread") does not undercount. 2026-09-16:
  "brow and lip" used to MATCH "Brow Wax and Lip Wax" because the wax name's own
  "and" won; now ambiguous (threading vs wax), never a silent wax pick. Locked by
  booking.serviceJoiner.test.ts. `suggestSlots`, `bookAppointment`,
  `findServiceByName` (thin wrapper), `SERVICE_ALIASES`, Zod schemas.
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
  `isWithinTransferWindow(now?)` — owner calling window, default 09:00–20:00
  salon TZ, end-exclusive, on working days only. Reuses business.json weekday
  hours, closedDates and vacations for the single-provider working-day calendar.
  The window can extend before opening/after closing on those days. Shared by
  prompt status, normal transfer and technical-error failover.
- **slots.ts** — `isOnGrid` / `isOnGridValue` / `partitionByGrid`.
  **PRESENTATION ONLY — nothing here may MOVE a start time.** Replaced
  `snapSlotsToGrid` on 2026-09-14: that version rounded Phorest's real free
  starts UP to a clean grid and the rounded value was then spoken AND booked,
  which double-booked live clients (the "Loretta call" — Phorest anchors its
  grid to appointment ENDS, so the gaps between free starts are other people's
  appointments). Source tidiness now belongs to the salon's Phorest *Booking
  slots* interval (set to 5 min). `selectOfferedSlots` only CHOOSES which real
  starts to read out: quarter-hours lead, odd minutes stay in reserve.
- **visits.ts** — `clusterSameVisit(entries, maxGapMin)` groups a day into
  sittings (`SAME_VISIT_GAP_MIN` = 30); `planConsecutive(available, durations,
  preferred, max)` places services back-to-back where EVERY placed start is a
  start Phorest actually returned. Options never overlap each other, so the
  caller hears real alternatives rather than three versions of one.
  **Togetherness belongs to the appointments, not the day** — a noon and a 5 PM
  on one date are two visits and must never move as a pair.
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
- **sms.ts** — `POST /sms`, the inbound Twilio SMS webhook (`twilioSignature()`
  -gated), persists before routing, one in-flight turn per phone. See
  `docs/areas/sms-concierge.md`.
- **metadata.ts**, **health.ts** — REST/health endpoints.

## src/config/
- **env.ts** — all env (model, voice, VAD knobs `OPENAI_VAD_*`, `OPENAI_NOISE_REDUCTION`,
  `SERVICE_CACHE_TTL_HOURS`, Phorest creds, `OWNER_PHONE`, `SILENCE_CHECKIN_MS`/
  `SILENCE_HANGUP_MS` (20s/15s watchdog), `MAX_CALL_MINUTES` (10),
  `BLOCKLIST_PATH`, `SPAM_BLOCK_THRESHOLD` (2), `OPENAI_INPUT_TRANSCRIPTION`
  (⚠️ default 'off' — session-shape change, flip only after a live call
  validates it), `RECORD_CALLS` ('true'), `ADMIN_TOKEN` (set in prod!),
  `DIGEST_ENABLED`/`DIGEST_TIME` ('08:30')/`DIGEST_TO`,
  `OWNER_CALL_SUMMARY_ENABLED` ('false' — opt-in release gate),
  `OWNER_CALL_SUMMARY_EXCLUDE_PHONES` (comma-separated normalized caller
  numbers, used to suppress test/internal calls), `OPENAI_CALL_SUMMARY_MODEL`
  (`gpt-4.1-mini`),
  `TRANSFER_WINDOW_START`/`TRANSFER_WINDOW_END` ('09:00'/'20:00' — Richa's
  calling window on working days, distinct from public opening times),
  `TRANSFER_DIAL_TIMEOUT_S` (15 — how long her phone rings before the dial
  hands back to /twilio/dial-status; deliberately under the ~20–25s carrier
  voicemail pickup), `OPENAI_SMS_MODEL` (SMS-concierge text model, default
  `gpt-4.1` → `gpt-5.6-terra` as of 2026-09-16), `OPENAI_SMS_EFFORT`
  (low|medium|high, default low; not sent for gpt-4.x models)). Defaults are
  sensible.
- **business.json** — salon hours per weekday + closedDates + `vacations`
  (`[{from,to,note}]` — ONE entry creates a SALON-WIDE closure, closes booking
  on those dates, reroutes transfer to message-taking, and supplies the public
  reason to the global closure policy) + `location` (address for the
  prompt/hours tool). One provider's absence in a multi-stylist salon is not a
  salon closure. **Do not change casually.**

## src/tests/  (vitest, 71 files / 832 tests as of 2026-09-16)
2026-09-16 additions: booking.serviceJoiner.test.ts (joiner words / set coverage),
toolRegistration.test.ts (every advertised tool has a handler, both engines),
__golden__/ (rendered prompt snapshots; see Prompt layers), staffMatch.test.ts
(length-scaled bound), twilioStream.liveIntegration.test.ts (more-help offer
note), twilioStream.visit.test.ts (two-phase cancel_visit),
smsRouter.test.ts/smsOwner.test.ts/smsAgent.test.ts (SMS lane selection,
owner ref parsing, gpt-5.6 Responses-API tool round-trip — see
`docs/areas/sms-concierge.md`).
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
2026-09-03 owner recaps: `postCallSummary.test.ts` covers format, trusted and
self-stated names, invented-name rejection, opt-in/exclusion/deduplication,
fallback, delivery failure, and empty calls;
`twilioStream.postCallSummary.test.ts` locks the one-shot immutable teardown
snapshot. Owner-message tests also reject short consent noise such as “Ja.”

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

## GPT-Live owner taste-test path (September 12, 2026)

- `src/voice/liveSession.ts`, `liveProtocol.ts`, `mulawAudio.ts`: continuous Live transport, delegated tools, usage snapshots, approximate fragments and bounded pacing/close.
- `src/voice/livePrompts.ts`: public speech prompt and policy/catalog backend prompt.
  `backendSections()` SKIPS whole sections of the production prompt (`TOOLS`,
  `PREAMBLES`, `SERVICES & PRICES`) — any behavioral rule in them must be
  re-stated in the replacement section or it silently disappears from the Live
  stack. That is how the `No day → today AND tomorrow` rule was lost; carry-over
  and the no-day fallback now live in the Live prompt, SERVE and BACKEND TOOL USE,
  locked by `src/tests/livePrompts.test.ts`. See
  [`reviews/GPT_LIVE_DAY_CARRYOVER_FIX_2026-09-13.md`](reviews/GPT_LIVE_DAY_CARRYOVER_FIX_2026-09-13.md).
- `src/voice/appointmentProposals.ts`: simulated prepare/confirm and per-call retry deduplication.
- `src/voice/testAccess.ts`, `testControl.ts`, `src/routes/voiceTest.ts`: allowed callers and authenticated idle variant switches/reset.
- `src/services/phorest.simulated.ts`: real-read/simulated-write overlay including client/read continuity.
- `src/services/liveTestTelemetry.ts`: voice seconds plus deduplicated backend costs; test-only admin view via `?testView=true`.
- `scripts/gpt-live/controller-probe.mjs`: actual-model synthetic audio through local controller or authenticated hosted WebSocket. Not a carrier/handset test.
- `scripts/gpt-live/select-variant.mjs`, `owner-call.mjs`: operator comparison controls and explicitly invoked owner call.


## Live real direct-number pilot (September 12, evening)

- `appointmentProposals.ts`: both real/simulated single-appointment modes, immutable proposal, approval, pending-confirm barrier and unknown-outcome latch.
- `phorest.client.ts`: Live real writes verify persisted state via bounded reads; create uses client/date filtering, cancellation includes canceled records, fractional local times normalize before comparison.
- `twilioStream.ts`: real Live fresh checks fail closed; caller-ID/phone-match binding gates explicit client IDs; uncertain writes invalidate warm appointment lists. Live tool notes retain prepare/confirm for subsequent changes.
- `env.ts`: PHOREST_WRITE_MODE=real allows direct callers; independent OWNER_TRANSFER_MODE and OWNER_SMS_MODE keep communications simulated during this pilot. Digest/summary are disabled in runtime.
- `controller-probe.mjs`: hosted real mode requires explicit PROBE_ALLOW_REAL_BACKEND=true; default remote refusal protects against mistaken reliance on local simulate settings.
- Grouped visits are RUNTIME functionality (2026-09-15/16), superseding
  `docs/GPT_LIVE_GROUPED_VISIT_PLAN_2026-09-12.md`: `book_visit`,
  `reschedule_visit` and `cancel_visit` are ALL two-phase — a plan call returns a
  server-authored read-back (options, or for cancel_visit the exact
  service/day/time list from the served-appointment maps), then one yes, then
  the call again with `confirmed:true`; cancel_visit's confirmed call must repeat
  the exact id set it read back (`pendingCancelVisitIds`). All execute
  sequentially through the existing single-appointment handlers, so every write
  guard applies unchanged, and partial success is reported honestly.
  `log_running_late` takes optional `alsoAppointmentIds`.
  ⚠️ Two ways a tool can be dead: (1) the backend rules ban it — needs a
  carve-out in `backendRules.ts` BACKEND TOOL USE; (2) it is advertised but has
  no handler registered on that engine — the visit tools were Realtime-only until
  2026-09-16. `src/tests/toolRegistration.test.ts` now asserts every advertised
  tool has a handler on both engines and dispatches the visit tools through the
  session's real tool path.

## Prompt layers (GPT-Live) — read before editing any prompt
**Realtime is retired (Aryan, 2026-09-16).** `VOICE_ENGINE=live` is the only
production path; see `docs/REALTIME_RETIREMENT_PLAN_2026-09-16.md` for the
staged removal. Until Stage 1 lands, `buildInstructions()` in `twilioStream.ts`
still exists because the COMPUTED facts (CONTEXT, CURRENT STATUS, closure) are
parsed out of it.
- `livePrompts.ts` `buildLivePrompt()` — the VOICE model's prompt. Budget 900
  est. tokens. Conversation only; it delegates everything factual.
- `src/voice/backendRules.ts` — the THINKING model's RULES, authored as plain
  string constants (PRIORITY … BACKEND TOOL USE). **Edit Live behaviour here**,
  or (preferred) in a tool-result note, which rides with the data.
- `livePrompts.ts` `buildBackendPrompt()` assembles backendRules + computed
  facts + catalog + caller context. No regex rewriting of rule text remains.
- `src/tests/__golden__/*.txt` pin the rendered Live and backend prompts
  byte-for-byte at fixed clocks/closure states. A wording change is deliberate:
  regenerate with `UPDATE_GOLDEN=1 npx vitest run src/tests/livePrompts.test.ts`,
  then review `git diff src/tests/__golden__` — only the intended sentences may
  differ.
- ⚠️ The `═══ CONVERSATION FLOW ═══` (IDENTIFY/SERVE/CLOSE) block in
  `buildInstructions()` is REALTIME-ONLY and inert in production (banner comment
  in the template). `livePrompts.test.ts` pins a SHA of that production prompt;
  its failure message now says so.
- Render what the model actually receives:
  `node --env-file=.env --import tsx scripts/render-live-prompts.ts`

## Read-only diagnostics added 2026-09-14/15
- `scripts/sim-scenarios.ts` — production scenarios (register item numbers)
  through the REAL handlers against REAL Phorest reads. Re-run after ANY service
  matcher or prompt change.
- `scripts/sim-visit.ts` — visit planning against the live calendar.
- `scripts/sim-availability.ts` — slot integrity; proves no invented times.

## Deploying
`railway up --service erica --detach` from
`~/Documents/Dev/ai-receptionist-live-2026-09-12` **only**. 2026-09-16: the main
checkout was `railway unlink`ed so it can no longer ship old `main` by accident.
Verify with `railway deployment list` (new SUCCESS row) and
`GET /admin/voice-test` → `engine: "live"`; a booted container proves nothing.
Backlog: expose a build identity (commit sha) on that route.
