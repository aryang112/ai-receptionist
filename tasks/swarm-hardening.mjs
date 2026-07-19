export const meta = {
  name: 'erica-hardening-swarm',
  description: 'Fix Phases 0-3 + call persistence (4.1) from tasks/todo.md via a file-partitioned agent swarm',
  phases: [
    { title: 'Foundation', detail: 'env vars + .env.example redaction (single owner of env.ts/package.json)' },
    { title: 'Modules', detail: 'parallel disjoint files: new middleware/security/zod, call-store, phorest TTL, hygiene, dead-code' },
    { title: 'Wiring', detail: 'index.ts + routes/twilio.ts in parallel; twilioStream.ts as a strict sequential 3-stage chain' },
    { title: 'Verify', detail: 'tsc + npm test gate with a fix loop' },
    { title: 'Review', detail: 'adversarial security review of customer-data-critical changes, then fix + re-gate' },
  ],
}

// ---- Shared constraints every editing agent must obey ----
const RULES = [
  'HARD CONSTRAINTS:',
  '- This is an ESM TypeScript project: ALL local imports MUST use the .js extension (e.g. import { env } from "../config/env.js").',
  '- Do NOT run any git command (no add/commit/rm/mv/checkout). The orchestrator commits later.',
  '- Do NOT run `npm test`, `npm run build`, or `tsc` — a later serialized gate handles verification. Running them now races other agents.',
  '- Touch ONLY the file(s) you are assigned to own. Do not edit any other source file. If you think another file needs changing, say so in your summary instead.',
  '- Never print, echo, or paste secret values (API keys, Phorest secret) anywhere, including your summary. Redact by replacing with a placeholder.',
  '- Keep changes minimal and senior-engineer clean. Match surrounding style. No over-engineering.',
  '- Phorest timezone is per-endpoint and normalized in phorest.client.ts — do NOT touch time handling unless assigned.',
  '- Do NOT add any field to the OpenAI session.update — a bad field hangs up the call. Not your job unless assigned.',
  'Return a concise bullet summary of exactly what you changed (files + one line each). No secrets.',
].join('\n')

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true only if BOTH tsc and tests pass' },
    tsc_ok: { type: 'boolean' },
    test_ok: { type: 'boolean' },
    test_summary: { type: 'string', description: 'e.g. "34 passed / 0 failed"' },
    errors: { type: 'array', items: { type: 'string' }, description: 'concise tsc/test error lines, most relevant first' },
  },
  required: ['ok', 'tsc_ok', 'test_ok', 'test_summary', 'errors'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          issue: { type: 'string' },
          mustFix: { type: 'boolean', description: 'true = a real defect that breaks the build, the tests, a live call, or leaves the security hole open' },
        },
        required: ['severity', 'file', 'issue', 'mustFix'],
      },
    },
  },
  required: ['findings'],
}

// ============================ FOUNDATION ============================
phase('Foundation')
const fnd = await agent(
  [
    'You own EXACTLY two files: src/config/env.ts and .env.example. (You may also read package.json but do not modify it — we are adding NO npm dependencies.)',
    '',
    'TASK A — src/config/env.ts: add these env vars with sensible defaults, following the existing style (Number()/string coercion, grouped with comments):',
    '  WS_AUTH_SECRET: string, default "" (empty = dev-permissive; consumers must treat empty as "skip verification but warn")',
    '  WS_TOKEN_TTL_SECONDS: number, default 300',
    '  RATE_LIMIT_WINDOW_MS: number, default 60000',
    '  RATE_LIMIT_MAX: number, default 120   (per-IP per window for /twilio/*)',
    '  API_RATE_LIMIT_MAX: number, default 30   (stricter, for /api/*)',
    '  CLIENT_INDEX_TTL_HOURS: number, default 1',
    '  CALL_STORE_PATH: string, default "./data/calls.jsonl"',
    'TASK B — OPENAI_MAX_RESPONSE_TOKENS (todo item 3.2): grep the whole src/ tree for OPENAI_MAX_RESPONSE_TOKENS. It is currently wired to NOTHING at runtime. Do NOT attempt to send it to the OpenAI session or response.create (that path needs live-API validation and risks an instant call hangup — see tasks/lessons.md). If it is referenced nowhere except env.ts, DELETE the env var (dead config). If it is referenced elsewhere, LEAVE it and add a one-line comment that it is intentionally not wired pending live GA validation.',
    'TASK C — .env.example: (1) find the two live OpenAI keys in the working-tree .env.example and replace their VALUES with placeholders like sk-REPLACE_ME (do NOT print the real values anywhere). (2) Add commented placeholder lines for every new env var from TASK A so operators know they exist. Do not touch any real Phorest values that may be placeholders already.',
    '',
    'At the end, list the EXACT new env var names + defaults you added (downstream agents will consume these names verbatim).',
    RULES,
  ].join('\n'),
  { label: 'foundation:env', phase: 'Foundation' }
)

// ============================ MODULES (parallel, disjoint files) ============================
phase('Modules')

const MW_PROMPT = [
  'You CREATE four brand-new files (no existing file is yours to edit). All must be ESM TypeScript with .js import extensions, importing env from "../config/env.js" and logger from "../core/logger.js" where useful.',
  '',
  '1) src/middleware/twilioSignature.ts — export a function twilioSignature() returning an Express middleware that validates the X-Twilio-Signature header using the `twilio` package (twilio.validateRequest(authToken, signature, fullUrl, req.body)). Build fullUrl from the forwarded proto/host headers (app has `trust proxy` set; use x-forwarded-proto and x-forwarded-host, falling back to req.protocol/req.headers.host) plus req.originalUrl. Behavior: if process.env.NODE_ENV === "test" OR env.TWILIO_AUTH_TOKEN is empty, call next() immediately (cannot validate without a token — log a one-time warn in the empty-token case). On a VALID signature call next(); on INVALID respond 403 and do not call next().',
  '2) src/middleware/rateLimit.ts — export a factory rateLimiter({ windowMs, max }) returning an Express middleware implementing a minimal in-memory fixed-window limiter keyed by req.ip. Zero external dependencies. When the cap is exceeded respond 429 with a short JSON body. Keep it ~30 lines, with a periodic cleanup of stale buckets so the map cannot grow unbounded.',
  '3) src/security/wsAuth.ts — export issueStreamToken(callSid: string): string and verifyStreamToken(token: string, expectedCallSid?: string): boolean. Token = `${callSid}.${expiryMs}.${hmac}` where hmac = HMAC-SHA256 over `${callSid}.${expiryMs}` using env.WS_AUTH_SECRET (node:crypto). Expiry = now + env.WS_TOKEN_TTL_SECONDS*1000 (compute now via Date.now()). verify: if env.WS_AUTH_SECRET is empty, return true (dev-permissive) and warn once; otherwise recompute the hmac with a timing-safe compare, reject if expired, and reject if expectedCallSid is provided and does not match the token callSid. issueStreamToken with empty secret returns "".',
  '4) src/realtime/toolSchemas.ts — using zod (already a dependency), define one schema per tool mirroring TOOL_DEFINITIONS in src/realtime/twilioStream.ts (READ that file to copy the exact param shapes for suggest_availability, book_appointment, reschedule_appointment, cancel_appointment, get_business_hours, get_prices, lookup_customer, list_appointments, log_running_late, transfer_to_owner). Export a record TOOL_SCHEMAS keyed by tool name, and a helper parseToolArgs(name: string, args: unknown) that returns { success: true, data } or { success: false, error: string } (join zod issues into a short message). Match required/optional fields exactly; be permissive where the tool is (e.g. get_prices/lookup_customer have no required fields).',
  '',
  'Do not wire these into anything — other agents import them. Just create correct, compiling files.',
  RULES,
].join('\n')

const PERSIST_PROMPT = [
  'You CREATE two brand-new files. Goal: todo item 4.1 — a per-call persistence layer (foundation for the owner ROI digest/dashboard). Use ONLY node builtins (fs, path) — append-only JSONL. No external deps.',
  '',
  '1) src/services/callStore.ts — an append-only JSONL call store at env.CALL_STORE_PATH (default ./data/calls.jsonl). Ensure the parent dir exists (fs.mkdirSync recursive) lazily on first write. Export a CallStore with:',
  '   - startCall(meta: { callSid: string; streamSid?: string; from?: string; recognizedClientId?: string; startedAt: number }): void',
  '   - recordToolCall(callSid: string, entry: { name: string; ok: boolean; error?: string; detail?: Record<string, unknown> }): void',
  '   - recordBooking(callSid: string, booking: { service: string; price?: number; date: string; time: string }): void',
  '   - endCall(callSid: string, end: { endedAt: number; durationMs: number; outcome: string }): void  // outcome e.g. "booked" | "rescheduled" | "cancelled" | "transferred" | "info" | "none"',
  '   Each method appends ONE JSON line: { type, callSid, ts, ...fields }. Store the FULL from-number in the file (this is the private data store), but you do NOT log it to pino here.',
  '   CRITICAL: every method must be wrapped so it can NEVER throw into the caller — a persistence failure must not break a live phone call. Catch and swallow (optionally logger.warn) all fs errors.',
  '   Also export readCalls(): any[] that reads+parses the JSONL (skipping malformed lines) for future digest use.',
  '2) src/tests/callStore.test.ts — a vitest test that points CALL_STORE_PATH at a temp file (os.tmpdir() + unique name), exercises startCall/recordToolCall/recordBooking/endCall, reads it back via readCalls(), asserts the shapes, and cleans up. Keep it self-contained and deterministic. This must pass under `vitest run`.',
  '',
  'Note the exact method names + signatures in your summary — the twilioStream persistence agent will call them verbatim.',
  RULES,
].join('\n')

const PH_PROMPT = [
  'You own EXACTLY one file: src/services/phorest.client.ts. Task: todo item 2.5 — give the in-memory client phone index a TTL-based background refresh so a long-running process does not serve a stale index forever, WITHOUT ever blocking a live call.',
  '',
  'First READ the file to find how the client phone index is built/cached and how preloadClients()/lookupCustomerByPhone work. Then:',
  '- Record the timestamp when the index finished loading.',
  '- Add env.CLIENT_INDEX_TTL_HOURS (already added to env.ts) as the freshness window.',
  '- When a lookup happens (or preloadClients is called) and the index is older than the TTL, trigger a background reload (fire-and-forget) but KEEP SERVING the current (stale) index for the in-flight lookup — never await the reload on the request path. Guard against concurrent reloads with an "isReloading" flag.',
  '- Do NOT change the PhorestPort interface or any method signature (phorest.mock.ts must still satisfy the same contract). This is purely internal caching behavior.',
  '- Do NOT break existing tests in src/tests/phorest.client.test.ts — keep the same observable behavior for a fresh index.',
  RULES,
].join('\n')

const HYG_PROMPT = [
  'You handle repo hygiene + secret redaction (todo Phase 0). You may edit/delete ONLY: .gitignore, PLAN.md, NextSteps.md, FIXES_APPLIED.md, and the three root test-*.ts files. Do NOT touch .env.example (another agent owns it). Do NOT run git.',
  '',
  '1) .gitignore — append entries so PII/data never gets committed: `logs.md`, `data/`, and `*.jsonl`. Keep existing lines.',
  '2) PLAN.md — it contains a committed Phorest API secret (around lines 79 and 914, and possibly elsewhere). READ those regions, find the secret token, and replace the secret VALUE with the placeholder <REDACTED-ROTATE-THIS> everywhere it appears in PLAN.md. Do NOT print the secret in your summary. Grep the file to be sure you caught every occurrence.',
  '3) NextSteps.md — DELETE this file (rm). It contains the same Phorest secret and is an obsolete pre-voice roadmap. (The user authorized this deletion.)',
  '4) FIXES_APPLIED.md — DELETE this file (rm). It documents the old pcm16/manual-VAD architecture that no longer exists and is actively misleading. (Authorized.)',
  '5) The three untracked root files test-integration-simple.ts, test-openai-realtime.ts, test-twilio-openai-integration.ts — MOVE them into scripts/ with plain `mv` (they are untracked, so no git needed). They are ad-hoc integration probes, not part of the vitest suite; scripts/ is where diagnostics live.',
  '',
  'Confirm in your summary that no secret value remains in any tracked file you touched (grep to verify) — WITHOUT printing the value.',
  RULES,
].join('\n')

const DEAD_PROMPT = [
  'You remove dead/unauthenticated code (todo item 1.3). You own: src/services/ai.ts, src/services/twilio.ts, src/routes/appointment.ts, and the two tests src/tests/appointment.test.ts + src/tests/appointment.validation.test.ts. You must NOT edit src/index.ts (the index-owner agent removes the appointment import+mount) — but DO note in your summary that index.ts imports `appointment` from ./routes/appointment.js and mounts it at /api, so that must be removed (it is being handled by another agent).',
  '',
  '1) FIRST grep the whole src/ tree for imports of services/ai.js, services/twilio.js, and routes/appointment.js. Report what you find.',
  '2) DELETE src/services/ai.ts and src/services/twilio.ts (legacy helpers, unused by the voice path). If your grep shows any live (non-test) import of them beyond index.ts, STOP and report instead of deleting.',
  '3) DELETE src/routes/appointment.ts — it exposes unauthenticated POST /api/suggest and POST /api/book that write to REAL Phorest. (Authorized.)',
  '4) Tests: src/tests/appointment.test.ts and src/tests/appointment.validation.test.ts currently exercise those deleted routes. REWRITE them to test the underlying logic directly against src/services/booking.ts (suggestSlots / bookAppointment / their zod validation) instead of the HTTP routes — preserve meaningful validation coverage (invalid input rejected, service-not-found handled) using the mock Phorest. If a test cannot be meaningfully rewritten, delete that individual case rather than leave it broken. The suite must stay green under the mock. Do NOT hit real Phorest.',
  RULES,
].join('\n')

const [mw, persist, ph, hyg, dead] = await parallel([
  () => agent(MW_PROMPT, { label: 'modules:new-files', phase: 'Modules' }),
  () => agent(PERSIST_PROMPT, { label: 'modules:call-store', phase: 'Modules' }),
  () => agent(PH_PROMPT, { label: 'modules:phorest-ttl', phase: 'Modules' }),
  () => agent(HYG_PROMPT, { label: 'hygiene:secrets-docs', phase: 'Modules' }),
  () => agent(DEAD_PROMPT, { label: 'modules:dead-code', phase: 'Modules' }),
])

// ============================ WIRING ============================
phase('Wiring')

const IDX_PROMPT = [
  'You own EXACTLY one file: src/index.ts. Three tasks:',
  '- todo 1.3: remove the now-deleted appointment router — delete the `import { appointment } from "./routes/appointment.js"` line and the `app.use("/api", appointment)` mount. KEEP the metadata router and its mount.',
  '- todo 1.4: add rate limiting. Import rateLimiter from "./middleware/rateLimit.js" (a new file created this run) and mount two limiters BEFORE the routers: one on "/twilio" using { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX } and one on "/api" using { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.API_RATE_LIMIT_MAX }. Import env from "./config/env.js".',
  '- todo 3.3: replace the console.log request-logger middleware (the `app.use((req,_res,next)=>{ console.log("REQ",...) })`) and the `console.log("Server up on", PORT)` with the pino logger already imported (logger.info). Keep it terse.',
  'Read the current src/index.ts first. Keep all the crash-safety handlers and warm-up calls intact.',
  RULES,
].join('\n')

const ROUTES_PROMPT = [
  'You own EXACTLY one file: src/routes/twilio.ts. Tasks:',
  '- todo 1.1: apply Twilio signature validation to POST /voice. Import twilioSignature from "../middleware/twilioSignature.js" (new file this run) and add it as route-level middleware on the /voice handler (it no-ops in test / when no auth token, so existing tests stay green).',
  '- todo 1.2: issue a short-lived WS auth token. Import issueStreamToken from "../security/wsAuth.js" (new file this run). In /voice, read the Twilio CallSid from req.body.CallSid, and if present add it as a Stream <Parameter name="token" value="<token>"> alongside the existing "from" parameter (use stream.parameter({name:"token", value: issueStreamToken(callSid)})). If issueStreamToken returns "" (empty secret in dev/test), skip adding the token parameter.',
  '- todo 1.3: DELETE the legacy POST /gather handler entirely.',
  '- todo 3.3: replace the console.log lines in /voice with the pino logger (import { logger } from "../core/logger.js"; logger.info(...)). Do not log full phone numbers.',
  'READ src/tests/twilio.route.test.ts and make sure it still passes (it asserts the /voice TwiML contains a streaming Connect). vitest sets NODE_ENV=test so the signature middleware will no-op; the token param will be skipped with an empty secret — so the TwiML shape the test checks is preserved. If the test needs a trivial update to stay meaningful and green, make it (this test file is fair game since it directly covers your route).',
  RULES,
].join('\n')

// twilioStream.ts is edited by a STRICT SEQUENTIAL 3-stage chain (never parallel on this file).
const TS_CONTEXT = [
  'FILE: src/realtime/twilioStream.ts — the per-call orchestrator (class TwilioRealtimeCall). READ it fully first.',
  'Key anchors: the "start" case in handleMessage (~line 507) connects the session, configureSession, warmCallerContext, requestGreeting, and a redundant phorest.preloadClients(); warmCallerContext(~460); handleAssistantText stub (~653); the tool handlers handleSuggestAvailability/handleBookAppointment/handleReschedule/handleCancel/handleListAppointments/etc.; handleTransferToOwner (~1077) which sends a Polly <Say> before <Dial>; handleError/cleanup (~1122).',
  'RELEVANT LESSONS: appointment times are salon-local (do not touch tz); tool args currently cast with `as` (no validation); the model must never be told an appointment/slot that a tool did not return.',
].join('\n')

const TS1_PROMPT = [
  'You are STAGE 1 of a sequential chain editing ONE file: src/realtime/twilioStream.ts. Only you are editing it right now. Focus: WRITE-PATH SECURITY (todo 1.2, 2.1, 2.2, 2.3, 2.4).',
  TS_CONTEXT,
  '',
  '2.3 Zod validation: import parseToolArgs from "./toolSchemas.js" (created this run). At the TOP of each tool handler, run parseToolArgs(<toolName>, args); on failure return { error: <message> } immediately and log it. On success, use the parsed data instead of the raw `as`-cast. Do this for every handler that takes args.',
  '2.1 Ownership guard: add a private `servedAppointmentIds = new Set<string>()`. Populate it: (a) in handleListAppointments, add every returned appointmentId; (b) when warmCallerContext warms prefetch.appointments, add those ids too (and in handleListAppointments when served from prefetch); (c) in handleBookAppointment on success, add the new appointmentId. In handleCancel and handleReschedule, BEFORE calling Phorest, if the requested appointmentId is not in servedAppointmentIds, return { error: "I need to pull up your appointments first — please call list_appointments." } (do NOT hit Phorest). This closes the write-side of the same class of bug as the old client_id privacy leak.',
  '2.2 Slot validation: add a private cache of the last offered slots, keyed by `${serviceName.toLowerCase().trim()}|${date}` -> Set<string> of the offered 24h "value" times. Populate it at the end of handleSuggestAvailability (the values you actually returned in slots). In handleBookAppointment, IF a cache entry exists for that service+date, require the requested time to be one of the offered values; on mismatch return { error: "That time is not available — the open times are: <list>" }. IF there is NO cache entry for that exact service+date, ALLOW the booking (do not block legitimate flows) but logger.warn it. Same optional check for reschedule if practical, but do not over-engineer.',
  '2.4 Graceful fatal-error path: in handleError (currently just logs + cleanup, which leaves the caller on a dead line), BEFORE cleanup, best-effort redirect the live call via the Twilio REST client (getTwilioClient() + this.callSid already exist) to TwiML: <Response><Say voice="Polly.Joanna-Neural">I\'m so sorry, I\'m having a technical problem — let me connect you with the salon.</Say><Dial>${env.OWNER_PHONE}</Dial></Response>. Guard: only attempt if client + callSid exist and we are not already closed/transferring; wrap in try/catch; ALWAYS still call cleanup after. Do not create an infinite loop (a failure here must not re-enter handleError).',
  '',
  'Do NOT do polish or persistence — later stages handle those. Keep the diff surgical and compiling.',
  RULES,
].join('\n')

const TS2_PROMPT = [
  'You are STAGE 2 of a sequential chain editing ONE file: src/realtime/twilioStream.ts. Stage 1 (security guards) is already applied — READ the current file before editing so you build on it. Focus: POLISH (todo 3.1, 3.5, 3.8, 3.9, 3.10, 3.4).',
  TS_CONTEXT,
  '',
  '3.8 Drop the voice-mismatch Polly <Say> in handleTransferToOwner: change the transfer TwiML from `<Say ...>One moment...</Say><Dial>OWNER</Dial>` to just `<Dial>${env.OWNER_PHONE}</Dial>` — Erica already speaks the handoff line herself in her own voice, so the Polly line is a jarring voice switch. (Do NOT touch the DIFFERENT Polly <Say> used in the fatal-error path from stage 1 — that one is an emergency fallback and stays.)',
  '3.9 Remove the redundant `phorest.preloadClients?.().catch(()=>{})` inside the "start" handler — the index is already warmed at boot in index.ts, so this per-call call is redundant.',
  '3.1 Concurrent prefetch: currently the "start" handler awaits session.connect(), then configureSession, then AWAITS warmCallerContext before requestGreeting — the caller-lookup adds pickup latency. Kick off warmCallerContext concurrently (store the promise) right after configureSession, and `await` that promise just before requestGreeting(). Preserve ordering guarantees (the injected context must still be applied before the greeting is requested). Do not change warmCallerContext\'s internal behavior beyond what 3.10 needs.',
  '3.10 Unrecognized-caller UX: warmCallerContext currently returns early (no injectContext) when the caller ID is not recognized. When we DO have the caller\'s number (the callerPhone arg) but no Phorest match, inject a short context note so Erica can offer that number instead of asking cold — e.g. "We could not match this caller ID. When you later need their number on file, offer the one they are calling from: \'Is the number you\'re calling from the best one for your file?\' — do not ask cold." Keep it one or two sentences; do not put the raw number into pino logs.',
  '3.5 AI disclosure: we do NOT record calls, so do NOT add a recording notice (that would be false). Instead add a light, natural AI/virtual-assistant disclosure to the greeting for emerging AI-disclosure norms — adjust the GREETING line in buildInstructions so Erica identifies as a virtual/AI receptionist warmly (e.g. "Hi, this is Erica, the virtual receptionist at Richa\'s Threading Salon — how can I help you today?"). Apply the SAME wording change to the VIP greeting string injected in warmCallerContext so recognized callers hear a consistent disclosure. Keep it warm and one sentence.',
  '3.4 Conservative prompt trim: reduce token footprint WITHOUT dropping any behavioral rule. Specifically: remove the hard-coded service-alias list in the SERVICES & PRICES section (the "lash lamination = Lash Lift" etc. bullets) because src/services/booking.ts findServiceByName already resolves aliases via SERVICE_ALIASES — keep the one-line instruction to "just try to book any service the caller names." Collapse obviously duplicated phrasing. DO NOT remove or weaken: the CURRENT DATE/TIME injection, the READING suggest_availability RESULTS rules, LET THE CALLER LEAD, the cancel explicit-confirm rule, "only state what a tool returned", or any tz/anti-hallucination rule. When unsure whether a line is a behavior rule, KEEP it. This is the risky item — err heavily toward preserving behavior.',
  '',
  'Do NOT add persistence — stage 3 handles it. Keep it compiling.',
  RULES,
].join('\n')

const TS3_PROMPT = [
  'You are STAGE 3 (final) of a sequential chain editing ONE file: src/realtime/twilioStream.ts. Stages 1-2 are applied — READ the current file first. Focus: CALL PERSISTENCE wiring (todo 4.1) using the callStore module created this run.',
  TS_CONTEXT,
  'The persistence module is src/services/callStore.ts. Its exact method signatures were: startCall({callSid, streamSid?, from?, recognizedClientId?, startedAt}), recordToolCall(callSid,{name, ok, error?, detail?}), recordBooking(callSid,{service, price?, date, time}), endCall(callSid,{endedAt, durationMs, outcome}). READ callStore.ts to confirm the real signatures before calling — match them exactly.',
  '',
  'Wire it defensively (callStore already swallows its own errors, but never let persistence logic throw into the call path):',
  '- In the "start" handler, after callSid/streamSid are set, call CallStore.startCall with the callSid, streamSid, the caller-ID from customParameters.from, the recognizedClientId if warmCallerContext matched one, and startedAt = Date.now(). Record a private startedAtMs on the instance.',
  '- In each tool handler, on the success path call CallStore.recordToolCall(this.callSid, { name, ok:true, detail: <small, e.g. date/time/service or clientId — NO raw phone> }); in the catch, recordToolCall with ok:false and the error message. Keep detail tiny.',
  '- In handleBookAppointment success, also call CallStore.recordBooking with service, price, date, time.',
  '- Track a per-call `outcome` string (default "none"; set to "booked"/"rescheduled"/"cancelled"/"transferred"/"info" as those handlers succeed). In cleanup(), before closing, call CallStore.endCall(this.callSid, { endedAt: Date.now(), durationMs: Date.now()-startedAtMs, outcome }). Guard cleanup so endCall is only recorded once and only if the call actually started.',
  '- Optionally accumulate assistant text: change the handleAssistantText stub to append deltas to a private buffer (bounded) so a future digest can store what Erica said — but do NOT add new external calls per delta. This is optional; skip if it complicates the diff.',
  'Everything must remain compiling and must never throw into audio handling.',
  RULES,
].join('\n')

const wiring = await parallel([
  () => agent(IDX_PROMPT, { label: 'wiring:index', phase: 'Wiring' }),
  () => agent(ROUTES_PROMPT, { label: 'wiring:routes', phase: 'Wiring' }),
  async () => {
    const s1 = await agent(TS1_PROMPT, { label: 'wiring:twiliostream-security', phase: 'Wiring' })
    const s2 = await agent(TS2_PROMPT, { label: 'wiring:twiliostream-polish', phase: 'Wiring' })
    const s3 = await agent(TS3_PROMPT, { label: 'wiring:twiliostream-persist', phase: 'Wiring' })
    return { s1, s2, s3 }
  },
])

// ============================ VERIFY (gate + fix loop) ============================
phase('Verify')
const GATE_PROMPT = [
  'You are the build+test GATE. Run exactly: `npx tsc --noEmit` then `npm test` (vitest). Report results.',
  'Set ok=true ONLY if tsc has zero errors AND every test passes. In errors[], put the most relevant tsc/test failure lines (file:line: message), most important first, max ~15 lines. test_summary like "34 passed / 0 failed". Do not fix anything — just report.',
].join('\n')

let gate = await agent(GATE_PROMPT, { label: 'verify:gate', phase: 'Verify', schema: GATE_SCHEMA })
let fixRounds = 0
while (!gate.ok && fixRounds < 3) {
  fixRounds++
  log(`Gate red (round ${fixRounds}): ${gate.errors.slice(0, 4).join(' | ')}`)
  await agent(
    [
      'The build/tests are RED after a multi-agent hardening pass. Fix them with MINIMAL, correct changes. You may edit any file needed to make `npx tsc --noEmit` and `npm test` both pass, but do NOT revert the intended features (Twilio signature middleware, WS auth token, rate limiting, zod tool validation, appointment-ownership guard, slot validation, graceful fatal-error path, call persistence, dead-code removal, prompt/polish changes). Prefer fixing types/imports/tests over deleting behavior. Keep the .js ESM import extension rule. Do NOT run git.',
      'Current failures:',
      ...gate.errors.map((e) => '  - ' + e),
      'test_summary: ' + gate.test_summary,
    ].join('\n'),
    { label: `verify:fix-${fixRounds}`, phase: 'Verify' }
  )
  gate = await agent(GATE_PROMPT, { label: `verify:gate-${fixRounds}`, phase: 'Verify', schema: GATE_SCHEMA })
}

// ============================ REVIEW (adversarial) ============================
phase('Review')
const REVIEW_DIMS = [
  {
    key: 'webhook-ws-auth',
    prompt:
      'Adversarially review the Twilio webhook signature validation (src/middleware/twilioSignature.ts + its use in src/routes/twilio.ts) and the WS auth token (src/security/wsAuth.ts, issued in routes/twilio.ts, verified in the "start" handler of src/realtime/twilioStream.ts). Look for: bypasses, wrong URL reconstruction behind the proxy (x-forwarded-*), test-mode no-op accidentally disabling prod security, HMAC compare not timing-safe, missing expiry/callSid check, token verified AFTER session.connect() instead of before, or the WS never actually verifying the token. Confirm the /twilio/stream start handler REJECTS/closes on an invalid token when WS_AUTH_SECRET is set.',
  },
  {
    key: 'tool-write-safety',
    prompt:
      'Adversarially review the tool-layer write-path guards in src/realtime/twilioStream.ts: the appointment-ownership guard (servedAppointmentIds) on cancel/reschedule, the slot-validation cache on book_appointment, and the zod parseToolArgs at each handler (against src/realtime/toolSchemas.ts). Look for: a cancel/reschedule path that still reaches Phorest without ownership, the guard blocking LEGITIMATE flows (VIP caller-ID prefetch, same-day booking, a time that was genuinely offered), slot cache key mismatches (case/whitespace/date), zod schemas that reject valid tool args the model actually sends, or required/optional mismatches vs TOOL_DEFINITIONS.',
  },
  {
    key: 'resilience-persistence',
    prompt:
      'Adversarially review the graceful fatal-error redirect (handleError) and call persistence (src/services/callStore.ts + its wiring in twilioStream.ts). Look for: persistence that can throw into the audio/call path, endCall double-firing or never firing, a fatal-error redirect that can loop or re-enter handleError, full phone numbers leaking into pino logs, or the data file path not being created. Confirm a persistence failure cannot drop a live call.',
  },
  {
    key: 'hygiene-deadcode',
    prompt:
      'Verify repo hygiene + dead-code removal actually landed. Check: the Phorest secret VALUE no longer appears in any tracked file (grep PLAN.md and the tree — do NOT print the value), logs.md + data/ + *.jsonl are in .gitignore, NextSteps.md and FIXES_APPLIED.md are gone, the three root test-*.ts moved to scripts/, src/services/ai.ts + src/services/twilio.ts + src/routes/appointment.ts are deleted, index.ts no longer imports the appointment router, and no remaining import references a deleted module. Report anything still dangling.',
  },
]

const reviews = (
  await parallel(
    REVIEW_DIMS.map((d) => () =>
      agent(d.prompt + '\n\nBe precise and skeptical. Only set mustFix=true for a REAL defect that breaks the build/tests/a live call or leaves the security hole open. Read the actual files.', {
        label: `review:${d.key}`,
        phase: 'Review',
        schema: REVIEW_SCHEMA,
      })
    )
  )
).filter(Boolean)

const mustFix = reviews.flatMap((r) => (r?.findings || []).filter((f) => f.mustFix))
if (mustFix.length) {
  log(`${mustFix.length} must-fix finding(s) from adversarial review — applying fixes`)
  await agent(
    [
      'Adversarial security review found real defects in the hardening pass. Fix each one with a minimal, correct change. Do NOT weaken the intended security controls. Keep .js ESM imports. Do NOT run git.',
      'Findings to fix:',
      ...mustFix.map((f) => `  - [${f.severity}] ${f.file}: ${f.issue}`),
    ].join('\n'),
    { label: 'review:fix', phase: 'Review' }
  )
  gate = await agent(GATE_PROMPT, { label: 'verify:gate-final', phase: 'Review', schema: GATE_SCHEMA })
}

return {
  foundation: fnd,
  modules: { mw, persist, ph, hyg, dead },
  wiring,
  finalGate: gate,
  reviewFindings: reviews.flatMap((r) => r?.findings || []),
  mustFixCount: mustFix.length,
}
