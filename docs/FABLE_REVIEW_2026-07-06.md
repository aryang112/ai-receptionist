# Codebase Review & Productization Roadmap — 2026-07-06

> **Done by: Claude Fable 5** (full-codebase review session, 2026-07-06).
> Purpose: actionable findings for other agents to review and implement.
> Before implementing ANY item: read `state.md`, `tasks/lessons.md`, and
> `docs/CODEMAP.md` first. Run `npm test` after every change (32/32 green at
> time of review, `tsc` clean). Commit per item, not per batch.

---

## 1. SECURITY — verified corrections to state.md (do these first)

These were verified against actual git history during the review; they
**correct** what `state.md` currently says.

### 1.1 `.env.example` git history is CLEAN (state.md is wrong about this)
Every commit was scanned: no live OpenAI key was ever committed. The two live
`sk-proj-...` keys exist **only in the uncommitted working-tree copy** of
`.env.example` (`git status` shows it as `M`).
- [ ] Blank both keys in the working-tree `.env.example` (never commit them).
- [ ] Rotate both OpenAI keys anyway (they sat in a shareable file).
- [ ] No history purge needed for `.env.example`.

### 1.2 Phorest secret IS committed — in `PLAN.md` (state.md missed this)
`PLAN.md` is tracked and contains the Phorest Basic-auth credential at
lines 79 and 914 (`global/richa@richasthreading.com : D9x$...`). That
credential has full read/write access to the salon's client database.
- [ ] Rotate the Phorest API secret (owner action — Phorest dashboard/support).
- [ ] Redact the credential from `PLAN.md` and commit.
- [ ] Optionally purge from history (`git filter-repo`) — or accept rotation
      as sufficient while the repo stays private.
- [ ] `logs.md` (untracked) contains a full call transcript with customer PII —
      delete it or add to `.gitignore`. Never commit it.

---

## 2. P0 — endpoint security (required before any real deployment)

### 2.1 No Twilio request signature validation
`POST /twilio/voice` (`src/routes/twilio.ts`) accepts any request. Anyone who
discovers the public URL can trigger streams that burn the OpenAI account and
reach Phorest tools.
- [ ] Add `twilio.webhook()` middleware (validates `X-Twilio-Signature` using
      `TWILIO_AUTH_TOKEN`) to `/twilio/voice`. Note: needs the exact public
      URL — behind ngrok/proxy use `x-forwarded-*` (`trust proxy` is already set).

### 2.2 `/twilio/stream` WebSocket is unauthenticated
Anyone can open a WS to `/twilio/stream` and consume tokens.
- [ ] In `/voice`, generate a short-lived signed token (HMAC of callSid +
      expiry, keyed on `TWILIO_AUTH_TOKEN` or a dedicated secret) and pass it
      as a TwiML `<Parameter>`. In the `start` event handler
      (`src/realtime/twilioStream.ts` `handleMessage`), verify it **before**
      `session.connect()`; close the socket on failure.

### 2.3 Unauthenticated REST writes to real Phorest
`src/routes/appointment.ts` exposes `POST /api/suggest` and `POST /api/book`
with no auth — anyone can create REAL appointments with curl. These are
pre-voice legacy.
- [ ] Delete `src/routes/appointment.ts` routes (or put behind an API key if
      still wanted for testing). Also delete legacy dead code:
      `src/services/ai.ts`, `src/services/twilio.ts`, and the `/twilio/gather`
      route. Update tests accordingly.

### 2.4 No rate limiting
- [ ] Add rate limiting on `/twilio/*` and `/api/*` (e.g. `express-rate-limit`),
      plus a cap on concurrent WS connections.

---

## 3. P1 — correctness / safety holes in the tool layer

### 3.1 Cancel/reschedule don't verify appointment ownership (biggest hole)
`handleCancel` / `handleReschedule` (`src/realtime/twilioStream.ts`) act on
whatever `appointmentId` the model passes. A model slip could cancel a
**stranger's** appointment — same class of bug as the old `client_id` privacy
leak, but on the write path.
- [ ] Track per-call which appointment IDs were actually served to this caller
      (via `list_appointments` results and the caller-ID `prefetch`), e.g. a
      `servedAppointmentIds: Set<string>` field on `TwilioRealtimeCall`.
- [ ] In `handleCancel`/`handleReschedule`, refuse any ID not in that set and
      return a tool error telling the model to call `list_appointments` first.

### 3.2 `book_appointment` trusts the model's time
A hallucinated time can be force-booked (`force_selected_time=true` will
happily double-book).
- [ ] Cache the last `suggest_availability` result per call (per service+date)
      and validate the requested `time` against the offered slot `value`s
      before booking. On mismatch, return an error listing valid slots.

### 3.3 Tool args are unvalidated casts
Handlers do `args as {...}`. Malformed model args produce confusing downstream
errors instead of a clean, retryable message.
- [ ] Add a Zod schema per tool (mirror `TOOL_DEFINITIONS`) and `safeParse` at
      the top of each handler; return `{ error: <what's missing> }` on failure.

### 3.4 Fatal mid-call error = caller hears a click
`handleError → cleanup` just closes both sockets. The Twilio REST client
already exists in the file (`getTwilioClient`).
- [ ] On fatal error while a call is live, redirect the call via REST:
      `<Say>` "I'm having a little trouble — let me transfer you" +
      `<Dial>${env.OWNER_PHONE}</Dial>`, then cleanup. Turns the worst failure
      mode into a graceful handoff. (Full OpenAI WS reconnect-and-resume is a
      later, optional upgrade — see OPTIMIZATION_NOTES.md.)

### 3.5 Client phone index never refreshes
`clientPhoneIndex` (`src/services/phorest.client.ts`) loads once per process.
Clients added directly in Phorest are invisible to caller-ID lookup until a
restart.
- [ ] Add TTL-based background refresh like the service cache (e.g.
      `CLIENT_INDEX_TTL_HOURS`, default 1h; refresh in background, keep serving
      the stale index while reloading — never block a live call on it).

---

## 4. P2 — polish / hygiene

- [ ] `warmCallerContext` (up to 700ms) runs **serially** before the greeting
      (`handleMessage` 'start' case). Start it concurrently with
      `session.connect()` — Phorest and OpenAI are independent — and await it
      just before `requestGreeting()`. Cuts worst-case pickup silence.
- [ ] `env.OPENAI_MAX_RESPONSE_TOKENS` (`src/config/env.ts`) is defined but
      wired to nothing (the invalid session-level field was removed). Either
      attach it to `response.create` payloads (⚠️ validate against the live GA
      API first — see lessons.md) or delete it.
- [ ] Replace `console.log` with pino in `src/index.ts` and
      `src/routes/twilio.ts`.
- [ ] Delete `FIXES_APPLIED.md` — it documents the OLD pcm16/whisper
      architecture and is now misleading.
- [ ] Move or delete root-level `test-integration-simple.ts`,
      `test-openai-realtime.ts`, `test-twilio-openai-integration.ts`
      (→ `scripts/` if still useful).
- [ ] Existing state.md pending items still stand: fix `TWILIO_NUMBER` in
      `.env` (real number is +1 410-304-6449), raise OpenAI tier (TPM),
      try `semantic_vad` (validate GA shape live first), trim the prompt.

---

## 5. NEW FEATURES (in order of product value)

1. **SMS confirmations** — after book/reschedule/cancel, text the caller a
   confirmation via the existing Twilio number. Biggest trust win per line of
   code; cuts no-shows. (New `sendSms` helper + calls from the three handlers.)
2. **Call outcome persistence + daily owner digest** — store per-call records
   (transcript, intent, outcome, booking made, latency, tokens) in SQLite;
   text/email Richa a daily summary ("7 calls, 4 bookings, 1 transfer").
   Doubles as ops/regression tooling AND the ROI proof for selling to salon #2.
3. **Voicemail fallback** — "leave a message" flow when transfer fails /
   edge cases; transcription texted to owner.
4. **Waitlist** — when a day is genuinely fully booked, offer to note the
   caller down; notify owner.
5. Later: group bookings (currently always transfers), Spanish support
   (Realtime handles it natively — currently forced English-only in prompt),
   Stripe deposit links for chronic no-shows.

---

## 6. PRODUCTIZATION STRATEGY

Current reality: a well-built **single-tenant** deployment, one Phorest
tenant's quirks deep.

**Phase 0 — Prove it on Richa (now → ~1 month).** Do sections 1–3, deploy
long-lived (Fly.io/Railway, US-East near Twilio's edge — NOT serverless; the
in-memory caches need one process), run real calls, collect the outcome data
from feature #2. Consider launching via **conditional call forwarding** (Erica
answers only when the salon doesn't) — zero-risk adoption story.

**Phase 1 — Extract the tenant (the big refactor).** Everything salon-specific
is baked in: the prompt (Erica/Richa/Parkville hardcoded in
`buildInstructions()`), `business.json` on disk, env creds, module-level
caches, `OWNER_PHONE`, service aliases. Turn it into a `TenantConfig` (DB
row), template the prompt, key every cache by tenant, resolve tenant from the
**called** Twilio number per call. `PhorestPort` is already the right seam —
this is tractable because of it.

**Phase 2 — Second booking platform = second market.** Phorest is a niche
wedge. Add adapters by API openness: **Square Appointments** (fully open, huge
SMB share) → Acuity (open) → Boulevard/Mindbody (partner APIs) → skip Fresha
(closed API).

**Economics.** COGS ≈ $0.10–0.20/min OpenAI audio (with the prompt-caching
discipline already in place) + ~$0.01/min Twilio. Salon at 300 calls/mo ×
~3 min ≈ $100–180/mo COGS → price $249–399/mo per location (the comparison is
a receptionist's wage, not software). Differentiation vs. Smith.ai / Slang.ai /
Goodcall: they take messages; **Erica writes into the salon's real calendar in
real time** — that's the moat, and it's already built.

**Compliance (before selling).** Maryland is a **two-party consent** state and
transcripts are already logged → the greeting needs a recording/AI-disclosure
line. Several states are adding AI-caller disclosure laws. One sentence in the
greeting covers both — bake it into the tenant prompt template now.

---

## 7. RECOMMENDED IMPLEMENTATION SEQUENCE

1. Section 1 (rotate creds, blank `.env.example`, redact PLAN.md) — owner+agent.
2. Section 2 (Twilio signature validation, WS auth, delete legacy REST writes,
   rate limiting).
3. Section 3.1 + 3.2 (ownership guard, slot validation) — the write-path safety.
4. Features 1–2 (SMS confirmations, call persistence + digest).
5. Deploy for Richa (Phase 0), watch `⏱/📊/⚖️` logs on real calls.
6. Remaining P1/P2 items, then the Phase 1 tenant-config refactor.

Per project rules: update `state.md` after each completed item, keep all tests
green, and validate any new OpenAI session field against the live API before
shipping (lessons.md).
