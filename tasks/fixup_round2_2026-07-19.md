# FIXUP ROUND 2 — Architect review of the two swarms (2026-07-19)

> Independent architect review of ALL swarm fixes (hardening swarm d7957ea..1b12b29,
> defects swarm 0d9c683..e11e353). Verdict: **work is largely real and well built**
> — 78/78 tests, tsc, TZ=UTC all re-verified by the architect, git hygiene clean
> (committed `.env.example` blob has placeholders only; PLAN.md redacted;
> NextSteps/FIXES_APPLIED deleted; PII gitignored). Lane B (openaiSession) passes
> spec review outright; its deviation (structural error classification instead of
> the B0 error-code capture) is APPROVED — better design than the spec, correctly
> documented. **But the swarm broke CT-1 at an integration seam its lanes didn't
> share, shipped WS auth in an inert config, and made one false claim.** The items
> below gate the live smoke test.
>
> Boot ritual per agent: state.md → docs/CODEMAP.md → tasks/lessons.md →
> this file → your items. Guardrails from `tasks/fix_plan_2026-07-19.md` §GLOBAL
> apply verbatim (esp. NEVER `git add -A`). Commit per item: `fix(F<N>): …`.

## P1 — BLOCKERS (gate the live smoke test)

### F1. Zod schema re-breaks the CT-1 booking fix at the validation layer
`src/realtime/toolSchemas.ts:15-24` vs `src/realtime/twilioStream.ts:195-224`.
TOOL_DEFINITIONS added optional `clientId` + made `customer.phone` optional
("book with just their name"), but TOOL_SCHEMAS.book_appointment has NO
`clientId` (zod strip mode silently DELETES it from the parsed payload —
empirically confirmed on zod 4.1.11) and `customer.phone` REQUIRED.
Consequences: (a) name-identified caller's clientId is stripped → falls into
getOrCreateClient → the duplicate-client path CT-1 was built to kill;
(b) recognized-caller name-only booking FAILS validation → Erica errors or asks
for the number the injection forbids her to ask for.
**Fix:** mirror TOOL_DEFINITIONS exactly (`clientId: z.string().optional()`,
`phone: z.string().optional()`). **Test at the HANDLER layer** (above zod —
that's exactly where the existing contracts test sits below and why this
slipped): recognized caller books name-only → success; explicit clientId
survives parse and reaches booking.

### F2. Prefetch clientId injection bypasses the shared-phone name guard
`src/realtime/twilioStream.ts:1070` — `payload.clientId ?? this.prefetch?.clientId`
injects unconditionally. Daughter calls from mom's caller-ID-recognized phone,
gives her own name → books under MOM deterministically; the A5 guard in
`getOrCreateClient` never runs. (The scenario-map row "shared family phone" is
currently only fixed for UNKNOWN caller IDs.)
**Fix (small):** inject `prefetch.clientId` only when the first token of
`payload.customer.name` case-insensitively matches `prefetch.firstName`;
otherwise omit clientId entirely so the A5 fall-through guard runs. Test both
branches.

### F3. WS auth shipped INERT — fail-open with no secret configured
`src/security/wsAuth.ts:33-41` + gate `twilioStream.ts:592` are fail-open when
`WS_AUTH_SECRET` is empty; `env.ts:48` defaults it to ''; it is NOT set in
`.env` and is commented out in `.env.example`. As deployed, `/twilio/stream`
is still unauthenticated — the flagship Phase-1 fix does nothing.
**Fix:** (a) generate + set a strong `WS_AUTH_SECRET` in `.env` (32+ random
bytes; do NOT print it in logs/commits); (b) uncomment with placeholder in
`.env.example`; (c) **fail CLOSED when `NODE_ENV==='production'` and the secret
is empty** (refuse the stream or refuse boot — pick refuse-boot, matches CF-4
pattern); (d) test the reject path.

## P2 — fix in the same round (cheap, real)

### F4. Matcher: "micro blading" dead-ends with ZERO alternatives + spec-mandated tests missing
`src/services/booking.ts:96-129`. Split compound words share no whole token
with any catalog name → `{ notOffered, closest: [] }` ("we don't offer
microblading" while Microblading Consult exists — probe-verified live). Also:
`ambiguous` candidates unbounded (4 for "threading") violating the ≤3 contract
(consumers slice, but fix at source).
**Fix:** before returning notOffered with empty closest, retry the match with
adjacent tokens collapsed ("micro blading"→"microblading"); add aliases for
known splits; `slice(0,3)` inside `resolveService`. **Add the two spec-mandated
tests the swarm skipped: "micro blading" and "massage".** Bonus: boot-time
warn for any SERVICE_ALIASES target that doesn't resolve against the live
catalog (alias rot detector).

### F5. New regression: createClient overwrites the phone index entry
`src/services/phorest.client.ts:615-626`. After the A5 shared-phone
fall-through creates the daughter, `clientPhoneIndex[phone] = daughter`
overwrites mom — mom's NEXT call prefetches the daughter (wrong greeting,
wrong clientId). Newly reachable; pre-A5 this couldn't collide.
**Fix:** `if (!index.has(normalized)) set(...)` — never overwrite an existing
entry from createClient. Test.

### F6. Reschedule bypasses slot validation and force-books
`twilioStream.ts` handleReschedule (~:1156-1170) + `phorest.client.ts:952`
(`force_selected_time: true`) — a hallucinated reschedule time books
unvalidated (the exact hole 2.2 closed for book_appointment).
**Fix:** apply the same `offeredSlots` guard (service+date key) to reschedule;
same fallback-open behavior as booking for uncached entries, but log it.

### F7. WS endpoint: no connection cap, no pre-auth timeout
`twilioStream.ts:1940-1948`. WS upgrades bypass Express middleware entirely —
unbounded sockets, and a socket that never sends `start` is never auth-checked
nor closed (FD exhaustion).
**Fix:** live-connection counter with hard cap (e.g. 20; reject 1013), plus a
~10s timer closing sockets that haven't passed the start-event auth gate.

### F8. Phase 3.1 "concurrent prefetch" was claimed but NOT implemented
`twilioStream.ts:639-642` — `const warm = this.warmCallerContext(...); await warm;`
runs strictly AFTER connect+configureSession; functionally identical to the old
serial code, while comments + state.md claim concurrency. **Fix:** start
`warmCallerContext` BEFORE `await session.connect()`, await it just before
`requestGreeting()`. Correct the comment. **Also append a lesson to
`tasks/lessons.md`: never claim an optimization the code doesn't perform —
this was caught in review and burns trust in every other claim.**

### F9. Stale-serve without backoff = up to ~8s dead air per tool call during a Phorest outage
`phorest.client.ts:447-486` — failed catalog refresh leaves `serviceCacheAt`
stale, so EVERY get_prices/availability call re-attempts a full 2×4s refresh.
**Fix:** on failed refresh, bump `serviceCacheAt` by ~60s (retry at most once
a minute while serving stale).

## P3 — batch (one agent, one commit ok)

- F10a `phorest.client.ts:1080`: endTime fallback should be start + service
  duration (spec), not `?? startTime` (drops still-running >2h appointments).
- F10b `phorest.ts:24-25`: CF-4 throw only fires when var UNSET —
  `USE_MOCK_PHOREST=flase` typo silently mocks prod. Require ∈ {'true','false'}.
- F10c `twilioStream.ts:1735/1763`: reset `transferring=false` when the
  deliberate transfer's REST update fails (else later fatal = dead click).
- F10d `twilioStream.ts:1653`: log_running_late — apply the ownership guard to
  its appointmentId (only tool left unguarded).
- F10e `twilioStream.ts:811-818`: `assistantTranscript` is a dead buffer —
  persist Erica's transcript turns into CallStore (preferred; 4.1 spec wanted
  transcripts) or delete the buffer.
- F10f Greeting: add the recording/consent clause to the disclosure line
  (transcripts are now PERSISTED; MD is two-party consent). One sentence.
- F10g `phorest.mock.ts:109-140`: fixture rot — startTimeRaw '19:00:00'
  labelled '2:00 PM' contradicts the salon-LOCAL contract CT-9 just fixed.
- F10h `docs/FABLE_REVIEW_2026-07-06.md:26`: scrub the 4-char secret fragment
  (`D9x…`) — moot after rotation but no reason to keep it.
- F10i Missing tests: /twilio/voice signature-reject (403) path; wsAuth
  verify/expiry/reject; rate-limit window. (The route test currently passes
  only via the NODE_ENV==='test' bypass.)
- F10j `findClientIdByName` 2-match: log a warn (spec was silent; visibility).
- F10k `sendUserText` (`openaiSession.ts:373-387`): unguarded `response.create`
  — grep call sites; if unused in the live path, guard it like sendToolResult
  anyway (one line) or delete the method.
- F10l Rate-limiter key is spoofable under `trust proxy: true` + unbounded
  bucket map — key on leftmost UNTRUSTED-stripped IP or cap map size. Low risk
  behind signature validation; note in code.

## Explicitly APPROVED deviations (do not "fix")
- Lane B structural error classification replacing B0 error-code capture.
- JSONL CallStore instead of SQLite (revisit at dashboard time, todo 4.4).
- In-house rate limiter instead of express-rate-limit (zero new deps).
- Matcher's coverage==1 decisive rule replacing the 0.15 band (more conservative).
- PH-9 fuzzy-name deferral (but run the 15-min live probe during Lane D).

## Still open after this round (unchanged)
Owner: rotate Phorest secret + OpenAI keys BEFORE any push (secret is in git
HISTORY, not just tree); raise TPM tier; 2026 closedDates. Then: live smoke per
the scenario map in `docs/DEFECTS_2026-07-19.md` (now also exercising F1/F2
fixes), PH-6/PH-11 live probes, semantic_vad decision, then todo Phases 4.2+.

## Round-2 exit criteria
tsc clean · full suite green incl. new tests (target ≥85) · `TZ=UTC` green ·
F1-F3 have handler-level regression tests · state.md updated per item ·
lessons.md gets the F8 honesty lesson + the F1 "test above the validation
layer" lesson · NO new deps · NO `git add -A`.
