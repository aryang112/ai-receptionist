export const meta = {
  name: 'erica-defects-swarm',
  description: 'Fix functional/correctness defects from docs/DEFECTS_2026-07-19.md per tasks/fix_plan (Lane A data + Lane B session ∥, then Lane C orchestration)',
  phases: [
    { title: 'DataAndSession', detail: 'Lane A (phorest/booking, sequential on shared files) ∥ Lane B (openaiSession, structural)' },
    { title: 'Verify-1', detail: 'tsc + tests + TZ=UTC gate with fix loop' },
    { title: 'Orchestration', detail: 'Lane C: twilioStream contracts + prompt/polish, sequential (consumes A+B)' },
    { title: 'Verify-2', detail: 'gate + fix loop' },
    { title: 'Review', detail: 'adversarial review of session-resilience, data-layer, matcher/CT-1, barge-in/prompt' },
  ],
}

const RULES = [
  'HARD CONSTRAINTS:',
  '- ESM TypeScript: ALL local imports use the .js extension.',
  '- Do NOT run git. The orchestrator commits later.',
  '- Do NOT run `npm test`/`tsc`/`npm run build` — a serialized gate handles verification (running them now races other agents).',
  '- Touch ONLY your assigned file(s). If another file needs changing, say so in your summary instead of editing it.',
  '- STALENESS: docs/DEFECTS_2026-07-19.md and tasks/fix_plan_2026-07-19.md were written BEFORE a security-hardening swarm already landed. RE-VERIFY each defect exists in the CURRENT file before fixing. These are ALREADY DONE — do NOT redo or duplicate them: TZ-1 (availability now parsed with {zone: env.TIMEZONE}), the graceful mid-call fatal->owner redirect in twilioStream.handleError, dropping the Polly <Say> from handleTransferToOwner, zod tool validation, ownership guard, slot validation. If an assigned item is already fixed, report "already fixed" and skip.',
  '- Never print secrets. Keep diffs minimal and senior-clean; match surrounding style. New behavior gets a test in the same file-set where practical.',
  'Return a concise bullet summary: per defect ID, what you changed (or "already fixed"/"deferred: reason"). No secrets.',
].join('\n')

const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true only if tsc AND tests AND the TZ=UTC run all pass' },
    tsc_ok: { type: 'boolean' }, test_ok: { type: 'boolean' }, tz_utc_ok: { type: 'boolean' },
    test_summary: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'tsc_ok', 'test_ok', 'tz_utc_ok', 'test_summary', 'errors'],
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        file: { type: 'string' }, issue: { type: 'string' },
        mustFix: { type: 'boolean', description: 'true = real defect: breaks build/tests, breaks a live call, regresses behavior, or leaves the target defect unfixed' },
      },
      required: ['severity', 'file', 'issue', 'mustFix'],
    } },
  },
  required: ['findings'],
}

// Cross-lane CONTRACTS (A/B produce, C consumes). C agents must READ the actual
// files to confirm the final shape, but these are the intended interfaces.
const CONTRACTS = [
  'CONTRACTS between lanes (Lane C: read booking.ts/openaiSession.ts to confirm the ACTUAL shape A/B produced, do not assume):',
  '1. Service matching (booking.ts): a resolver returns a discriminated union — { kind:"match", service } | { kind:"ambiguous", candidates: Service[] (<=3) } | { kind:"notOffered", closest: Service[] (<=3) }. findServiceByName stays as a thin wrapper returning the matched Service | undefined so existing simple callers keep working. suggestSlots NO LONGER throws "Service not found" — on no clean match it returns { notOffered:true, closest } or { ambiguous:candidates } (still throws for genuine infra errors).',
  '2. createAppointment (PhorestPort) gains an OPTIONAL trailing clientId?: string; when present, client resolution (getOrCreateClient) is skipped. BookSchema gains optional clientId. bookAppointment threads it through.',
  '3. RealtimeHandlers gains onClose?: () => void, fired ONCE only on an UNEXPECTED close (not on intentional close()). ',
  '4. OpenAIRealtimeSession accepts an optional callTag (constructor opt) used to make a pino child logger for all session logs.',
].join('\n')

// ============================ Lane A ∥ Lane B ============================
phase('DataAndSession')

const A1_PROMPT = [
  'LANE A / stage 1. You own ONLY: src/services/phorest.client.ts, src/services/phorest.ts, src/services/phorest.mock.ts, src/config/env.ts. Fix these Phorest data-layer defects (READ docs/DEFECTS_2026-07-19.md and tasks/fix_plan_2026-07-19.md §Lane A for full detail; RE-VERIFY each against current code):',
  '- PH-1: the client phone index caches a REJECTED load promise forever (a single failed load breaks every later lookup + booking for the process life). Reset the loading promise to null on failure so the next call retries. Add a test.',
  '- PH-4 (data-integrity): the phorestFetch retry-once loop is applied to NON-idempotent writes → timed-out POST /booking or /client can DOUBLE-BOOK / duplicate a client. Add a `retriable` option (default: method === "GET"); the read-only availability POST may pass retriable:true; booking POST, client POST, update, cancel must NEVER be retried. Test: a timeout-then-success on /booking fires exactly ONE request.',
  '- PH-2 + PH-3: listAppointments (a) filters start >= now so an ALREADY-STARTED appt (the "running 5 min late" call) and same-day post-start cancels return empty — keep appointments whose END >= now (use endTimeRaw; fallback start + duration; grace start >= now-120min). (b) uses a single 30-day window (API caps 31) so appts 5+ weeks out are invisible → duplicate-booking offers — cover ~60 days via two sequential <=30-day windows, concatenated. Tests for both.',
  '- PH-7: on a TTL-expired service-catalog refresh FAILURE, serve the stale cached copy (log warn) instead of throwing mid-call. PH-8: a client-index page that fails after retry should set an "index incomplete" warn-once flag, behavior otherwise unchanged.',
  '- PH-6 groundwork: fetchAppointment does a direct GET /appointment/{id} that ALWAYS 404s on this tenant (guaranteed mid-call latency). Gate it behind env PHOREST_DIRECT_GET_APPT (default false) so we skip straight to the scan; widen the updated-scan to two 30-day windows. (Full old-appointment reschedule verification is a live task — do the code groundwork only.)',
  '- CF-4: in src/services/phorest.ts (the mock/real selector), if NODE_ENV === "production" and USE_MOCK_PHOREST is unset/empty, THROW at boot (fail fast — never silently serve mock data in prod).',
  '- CONTRACT #2 (createAppointment clientId): add an OPTIONAL trailing clientId?: string param to createAppointment in the PhorestPort type is NOT here (types are Lane A stage 2) — but IMPLEMENT it in phorest.client.ts.createAppointment and phorest.mock.ts: when clientId is provided, skip getOrCreateClient/phone-resolution and book against that clientId. Also (CT-1 data half) in getOrCreateClient: if a firstName was provided that does NOT case-insensitively match the phone-matched record, do NOT silently reuse the phone match — fall through to name lookup then create. Keep the mock in sync so tests pass.',
  '- Enrich the mock service catalog (phorest.mock.ts) to be representative for the matcher tests Lane A stage 2 will write: include realistic entries such as "Brow Threading", "Eyebrow Tinting", "Lash Lift", "Brow Lamination", plus at least TWO wax services (e.g. "Full Leg Wax", "Bikini Wax") so "wax" is genuinely ambiguous, and a "Microblading Consult" ($0). Keep existing mock behavior/tests green.',
  'Add env vars you introduce to env.ts (e.g. PHOREST_DIRECT_GET_APPT). Do NOT change PhorestPort method SIGNATURES beyond the additive optional clientId (types file is stage 2 — note exactly what type change stage 2 must make).',
  RULES,
].join('\n')

const A2_PROMPT = [
  'LANE A / stage 2 — runs AFTER stage 1 (READ the current phorest.client.ts + phorest.mock.ts + phorest.types.ts first to see what stage 1 produced). You own ONLY: src/services/booking.ts, src/services/phorest.types.ts, src/tests/booking.alias.test.ts (and you may ADD src/tests/booking.match.test.ts).',
  '- PH-5 (service matcher rewrite): the current findServiceByName does naive substring matching — "wax" grabs the first service whose name contains "wax" (e.g. a bikini/leg wax), "eyebrows" can hit a permanent-makeup-removal, etc. Implement a resolver per CONTRACT #1: normalize both sides (strip leading "N)"/"3a)" numeric prefixes, lowercase, non-alnum->space, collapse); match priority (1) exact normalized name, (2) SERVICE_ALIASES, (3) all query tokens present as WHOLE words in the name, scored by matched-token ratio, tie-break shortest name; if the top two candidates are close and different -> ambiguous; if nothing scores -> notOffered with closest few. findServiceByName stays a thin wrapper (returns the matched Service | undefined). suggestSlots stops throwing "Service not found" and instead returns { notOffered:true, closest } or { ambiguous:candidates }.',
  '- CONTRACT #2 (schema half): add optional clientId to BookSchema; bookAppointment, when clientId is present, passes it to createAppointment (the param stage 1 added) and skips relying on phone. Keep customer.phone optional.',
  '- CT-9: fix the doc-rot in phorest.types.ts — the comment claiming start/endTimeRaw are UTC is WRONG (they are salon-LOCAL). Correct it. Also add the optional clientId to the createAppointment signature in the PhorestPort type EXACTLY as stage 1 implemented it (read stage 1 output).',
  'Update booking.alias.test.ts to the new resolver and ADD booking.match.test.ts covering the live-verified traps against the enriched mock catalog: "wax" -> ambiguous (not a single silent pick), "eyebrows"/"brows" -> Brow Threading, "lash lamination" -> Lash Lift (alias still works), a clearly-unknown service -> notOffered. All green under the mock.',
  RULES,
].join('\n')

const B_PROMPT = [
  'LANE B. You own ONLY src/realtime/openaiSession.ts (+ you MAY add src/tests/openaiSession.test.ts). Fix the realtime-plumbing defects that drop or freeze live calls. RE-VERIFY each against the current file.',
  'CRITICAL GUARDRAILS (this file has hung up calls before):',
  '  * Do NOT add, remove, or rename ANY field inside the session.update object (configureSession). Leave the session config byte-for-byte as is.',
  '  * Do NOT hardcode any OpenAI error-code/type STRING (we have been burned guessing them). Classify STRUCTURALLY only.',
  '- RT-1 (onClose): ws.on("close") currently only logs — an unexpected OpenAI close leaves the Twilio leg live forever (zombie call, silent). Add onClose?: () => void to RealtimeHandlers (CONTRACT #3) and invoke it from ws.on("close") ONLY when the close was NOT caused by our own close() (track via the existing this.closing flag). Fire it at most once.',
  '- RT-3 (stop fatalizing recoverable errors): today every "error" event calls handlers.onError -> the call is torn down (and now redirected to the owner). Change the "error" event handler to DEFAULT to log-and-continue. Escalate to handlers.onError ONLY when: (a) an error arrives while we are still awaiting the session.update acknowledgement (track awaitingSessionAck = true from configureSession until session.updated/created — a rejected session.update IS fatal and must still escalate, preserving instant-hangup detection), OR (b) a simple circuit breaker trips: >=3 error events within 10s -> escalate once. Connection-level failures already escalate via ws.on("error")/onClose, so the application-level "error" event is safe to soften. NO error-string matching.',
  '- RT-2 (response.create collision): sendToolResult unconditionally sends response.create; if a response is already active (e.g. VAD auto-created one when the caller interrupted during the tool), this collides and (via RT-3 today) drops the call. Track activeResponse via response.created (true) and response.done/completed + error/cancelled (false). In sendToolResult: ALWAYS send the function_call_output item; but if activeResponse is true, set pendingResponseCreate=true instead of sending response.create; when response.done fires and pendingResponseCreate is set, clear it and send exactly one response.create then (guard on still-open + not-active). This must never deadlock (always eventually fires or is cleared on close).',
  '- RT-5 (failed-response dead air): response.done never checks event.response.status. On status === "failed": log a warn; if the session is still open and no response is active, schedule ONE retry response.create after a short delay (cap ~10s; you already read reset_seconds in rate_limits.updated — store the latest and use it, else default ~2s). On status === "cancelled" (barge-in): treat as normal, ignore. Never double-fire onResponseComplete.',
  '- RT-7 (stray deltas after barge-in): on truncateActiveResponse (and on a cancelled response), record the cancelled response_id; drop subsequent response.audio.delta / response.output_audio.delta carrying that id (no onAudioChunk, no activeItemId re-arm). Clear the guard on the next response.created.',
  '- RT-9 (call-tagged logs): accept an optional callTag (constructor option, CONTRACT #4); if provided, use logger.child({ call: callTag }) for this session\'s log lines so concurrent calls are attributable. Default undefined = current behavior.',
  'If you can cleanly extract the error-classification and response-state transitions into small pure/testable helpers, add openaiSession.test.ts for them (fake minimal event objects). If a WS harness is too heavy, skip the test and rely on the review + a live smoke test — do not force a brittle test.',
  RULES,
].join('\n')

const laneA = (async () => {
  const s1 = await agent(A1_PROMPT, { label: 'laneA:phorest-client', phase: 'DataAndSession' })
  const s2 = await agent(A2_PROMPT, { label: 'laneA:booking-matcher', phase: 'DataAndSession' })
  return { s1, s2 }
})()
const laneB = agent(B_PROMPT, { label: 'laneB:openai-session', phase: 'DataAndSession' })
const [aRes, bRes] = await parallel([() => laneA, () => laneB])

// ============================ Verify-1 ============================
phase('Verify-1')
const GATE_PROMPT = [
  'You are the build+test GATE. Run, in order: `npx tsc --noEmit`, then `npm test`, then `TZ=UTC npx vitest run`.',
  'ok=true ONLY if tsc is clean AND both test runs fully pass. Put the most relevant failing lines (file:line: message) in errors[] (max ~15). test_summary like "NN passed / 0 failed". Fix nothing.',
].join('\n')
async function runGateWithFixes(tag, maxRounds) {
  let g = await agent(GATE_PROMPT, { label: `${tag}:gate`, phase: tag, schema: GATE_SCHEMA })
  let r = 0
  while (!g.ok && r < maxRounds) {
    r++
    log(`${tag} gate red (round ${r}): ${g.errors.slice(0, 4).join(' | ')}`)
    await agent(
      [
        'The build/tests are RED after a defect-fix pass. Fix with MINIMAL correct changes so `npx tsc --noEmit`, `npm test`, and `TZ=UTC npx vitest run` all pass. Do NOT revert the intended defect fixes (Phorest retry-idempotency, listAppointments window, service-matcher union, createAppointment clientId, onClose, response-state tracking, error de-fatalizing, delta gating, call-tag logging). Prefer fixing types/imports/tests/contracts over deleting behavior. Do NOT touch git or the session.update object.',
        'Failures:', ...g.errors.map((e) => '  - ' + e), 'summary: ' + g.test_summary,
      ].join('\n'),
      { label: `${tag}:fix-${r}`, phase: tag }
    )
    g = await agent(GATE_PROMPT, { label: `${tag}:gate-${r}`, phase: tag, schema: GATE_SCHEMA })
  }
  return g
}
let gate = await runGateWithFixes('Verify-1', 3)

// ============================ Lane C (orchestration) ============================
phase('Orchestration')
const C_CONTEXT = [
  'FILE: src/realtime/twilioStream.ts (the per-call orchestrator). READ it fully first — it was heavily edited by the last hardening swarm, so ignore the stale line numbers in the DEFECTS doc. Also READ the CURRENT src/services/booking.ts and src/realtime/openaiSession.ts to see the EXACT contracts Lane A/B just produced (service resolver union, createAppointment clientId, onClose, callTag) and consume them as-built.',
  CONTRACTS,
].join('\n')

const C1_PROMPT = [
  'LANE C / stage 1 — CONTRACTS & data-correctness wiring in src/realtime/twilioStream.ts ONLY (you may also add src/tests/*.ts). Consume Lane A/B as-built.',
  C_CONTEXT,
  '- Adapt to the service-resolver union (CONTRACT #1): every call site of findServiceByName / suggestSlots must handle the new shapes. handleGetPrices (CT-5): on no single match, return the top few closest matches (name/price/duration), NEVER the full 63-row catalog (full menu only when serviceName is absent). handleSuggestAvailability (CT-4): if suggestSlots returns notOffered -> return { notOffered:true, closest:[names] }; if ambiguous -> return the candidate names for Erica to disambiguate; never throw a bare "Service not found". The slot-guard code added last swarm that calls findServiceByName must still compile against the wrapper.',
  '- CT-1 (recognized-caller booking, orchestration half): thread the real identity so we never fabricate a phone or dup a client. In warmCallerContext store the normalized caller phone in this.prefetch; include phone in the lookup_customer prefetch response; add optional clientId to the book_appointment tool schema and make customer.phone optional there; in handleBookAppointment, if the model passed no clientId but this.prefetch exists, inject prefetch.clientId deterministically and pass it through to bookAppointment. Update the injected VIP context to say the system already knows their account (no need for their phone number).',
  '- CT-2 (name disambiguation): handleLookupCustomer multi-match branch currently returns only a count — return up to 3 candidates { clientId, firstName, lastName, nextAppointment:{date,time}|null } (fetch each candidate\'s next appt via listAppointments, bounded, tolerate per-candidate failure -> null). This lets Erica match on the appointment the caller describes.',
  '- RT-1 wiring: pass an onClose handler to the OpenAIRealtimeSession that runs the SAME graceful path as a fatal error — i.e. if the call is still live, best-effort redirect to the owner then cleanup (reuse the failover logic the last swarm added to handleError; extract a shared private method if cleaner). Do NOT duplicate the Polly/redirect code — factor it. Confirm handleError now only receives genuinely-fatal errors (Lane B de-fatalized the rest).',
  '- RT-9 wiring: pass callTag (e.g. streamSid.slice(-8)) into the session constructor.',
  'Add focused tests where practical (e.g. handleGetPrices no-full-menu on miss; prefetch clientId threaded into booking). Keep everything compiling and all existing tests green.',
  RULES,
].join('\n')

const C2_PROMPT = [
  'LANE C / stage 2 — barge-in + prompt/UX polish in src/realtime/twilioStream.ts ONLY. READ the current file first (stage 1 just edited it). Build on it.',
  C_CONTEXT,
  '- RT-4 (barge-in tail — behavioral, flag for live test): handleResponseComplete currently nulls responseStartTimestamp and clears markQueue at response.done, which fires SECONDS before Twilio finishes playing the buffered audio — so interrupting Erica during the tail no-ops (no clear/truncate). Fix per OpenAI\'s reference pattern: do NOT reset markQueue/responseStartTimestamp in handleResponseComplete; instead, on each Twilio "mark" ack, when markQueue becomes EMPTY reset responseStartTimestamp = null. This keeps barge-in armed through the whole playback without leaving a stale reference for the next response. Do not change the truncation math.',
  '- CT-3 (contradiction): the transfer_to_owner tool DESCRIPTION says transfer for "multiple services or group booking ... after one clarifying attempt" — which contradicts the prompt (multi-service is normal; transfer is last resort). Rewrite the description to match the prompt: transfer ONLY for an explicit request for a human, a group booking for several DIFFERENT people, repeated tool failure AFTER a retry, or a clearly upset caller. Remove "multiple services" and "one clarifying attempt".',
  '- CT-6: there are two competing verbatim first-line greeting scripts (the prompt GREETING line and the injected VIP greeting) which can blend/double. Keep ONE source of truth for the exact wording and have the VIP injection just say "use the standard greeting and include their first name after the salon name" rather than a second full script.',
  '- CT-10: the booking flow tells Erica to offer BOTH today and tomorrow — add a carve-out: "If the caller already named a day, check THAT day only" (avoid two off-target tool calls).',
  '- CT-7: recognized caller who volunteers a NEW number -> a real lookup misses and contradicts the "existing client on file" injection. Add prompt/handler guidance: if they say their number changed, take the new number and pass BOTH clientId and the new phone to book_appointment; and a firstName-only search should ask for the last name (return a needLastName signal) rather than a bare not-found.',
  '- RT-8 (clipped opening): media frames arriving before sessionReady are dropped, so an impatient "hello?" during the ~300-500ms OpenAI handshake is lost. Buffer incoming media frames while !sessionReady (cap ~250 frames ≈ 5s) and flush them once ready.',
  '- RT-6: in handleTransferToOwner, the REST redirect can fire while "let me get Richa for you" is still in Twilio\'s buffer (cuts the sentence). Delay the REST update until the markQueue drains (poll, cap ~3s) so the handoff line finishes. (The Polly <Say> was already removed last swarm — do not re-add it.)',
  'Preserve EVERY behavioral/anti-hallucination rule in the prompt (date-time injection, READING suggest_availability results, LET THE CALLER LEAD, cancel explicit-confirm, "only state what a tool returned", tz rules). When unsure whether a line is a safety rule, keep it. Keep tests green.',
  RULES,
].join('\n')

await agent(C1_PROMPT, { label: 'laneC:contracts', phase: 'Orchestration' })
await agent(C2_PROMPT, { label: 'laneC:prompt-polish', phase: 'Orchestration' })

// ============================ Verify-2 ============================
phase('Verify-2')
gate = await runGateWithFixes('Verify-2', 3)

// ============================ Review (adversarial) ============================
phase('Review')
const DIMS = [
  { key: 'session-resilience', prompt:
    'Adversarially review src/realtime/openaiSession.ts changes (RT-1/2/3/5/7). CONFIRM: (a) the session.update object is UNCHANGED (no added/renamed field — a regression here hangs up every call); (b) NO hardcoded OpenAI error-code/type strings were introduced; (c) a rejected session.update STILL escalates (awaitingSessionAck path) — softening errors must not hide the instant-hangup case; (d) the response-state machine cannot deadlock (pendingResponseCreate always fires on response.done or is cleared on close; activeResponse resets on error/cancelled/close); (e) onClose fires at most once and never on intentional close(); (f) the failed-response retry cannot loop infinitely. Flag any path that could drop, freeze, or double-respond on a live call.' },
  { key: 'data-layer', prompt:
    'Adversarially review src/services/phorest.client.ts + phorest.ts + phorest.mock.ts (PH-1/2/3/4/6/7/8, CF-4, createAppointment clientId). CONFIRM: (a) booking/client/update/cancel POSTs are NEVER retried (double-booking prevention) while GET/availability may be; (b) the client-index loading promise resets on failure (no permanent breakage); (c) listAppointments keeps END>=now and covers ~60 days without exceeding the 31-day API cap; (d) PhorestPort stays a valid contract — phorest.mock.ts matches phorest.client.ts signatures (the additive optional clientId included); (e) stale-cache serve never throws mid-call; (f) createAppointment with clientId skips client resolution and cannot create a duplicate. Flag contract mismatches or new mid-call throw paths.' },
  { key: 'matcher-ct1', prompt:
    'Adversarially review the service matcher (src/services/booking.ts resolver) + CT-1 wiring (booking.ts + src/realtime/twilioStream.ts). CONFIRM: (a) existing aliases still resolve (lash lamination->Lash Lift etc.) — no regression; (b) genuinely ambiguous queries ("wax") return ambiguous rather than silently picking one; (c) suggestSlots no longer throws bare "Service not found" and all its call sites in twilioStream handle notOffered/ambiguous; (d) every findServiceByName/resolver call site in twilioStream compiles against the new shape (including the slot-guard code from the prior swarm); (e) recognized-caller booking threads clientId so it cannot fabricate a phone or dup a client. Flag any unhandled union case or broken call site.' },
  { key: 'bargein-prompt', prompt:
    'Adversarially review the barge-in change (RT-4) and prompt/UX edits in src/realtime/twilioStream.ts (CT-3/6/7/10, RT-6/8). CONFIRM: (a) removing the response.done resets plus resetting responseStartTimestamp when markQueue drains does NOT leave a stale timestamp for the next response or break the truncation math; (b) the pre-ready media buffer is bounded and flushed exactly once; (c) the transfer-timing delay is capped and cannot hang the call; (d) NO safety/anti-hallucination prompt rule was dropped, and the two-greeting duplication is resolved without losing the AI disclosure; (e) none of the already-done fixes (TZ-1, failover redirect, Polly-Say removal) were duplicated or reverted. Flag regressions.' },
]
const reviews = (await parallel(DIMS.map((d) => () =>
  agent(d.prompt + '\n\nBe precise and skeptical; READ the actual files. Only mustFix=true for a REAL defect (breaks build/tests/a live call, regresses behavior, or leaves the target defect unfixed).',
    { label: `review:${d.key}`, phase: 'Review', schema: REVIEW_SCHEMA })
))).filter(Boolean)

const mustFix = reviews.flatMap((r) => (r?.findings || []).filter((f) => f.mustFix))
if (mustFix.length) {
  log(`${mustFix.length} must-fix finding(s) from adversarial review — applying fixes`)
  await agent(
    [
      'Adversarial review found real defects in the defect-fix pass. Fix each minimally and correctly. Do NOT change the session.update object, do NOT hardcode OpenAI error strings, do NOT revert intended fixes, keep .js ESM imports, do NOT run git.',
      'Findings:', ...mustFix.map((f) => `  - [${f.severity}] ${f.file}: ${f.issue}`),
    ].join('\n'),
    { label: 'review:fix', phase: 'Review' }
  )
  gate = await runGateWithFixes('Review', 2)
}

return {
  laneA: aRes, laneB: bRes,
  finalGate: gate,
  reviewFindings: reviews.flatMap((r) => r?.findings || []),
  mustFixCount: mustFix.length,
}
