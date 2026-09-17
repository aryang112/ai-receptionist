# Visit tools (multi-service sittings)

**Purpose.** `book_visit`, `reschedule_visit`, `cancel_visit` handle a whole
sitting (2+ services kept back-to-back or moved/cancelled together) as one
caller-facing action, while writing through the same single-appointment
handlers and guards underneath.

**Key code** — `src/realtime/twilioStream.ts`:
- `book_visit` / `reschedule_visit` / `cancel_visit` — all THREE are
  two-phase: first call plans (no `startTime`/no `confirmed`), server
  returns a read-back, one caller "yes", then the call repeats with
  `confirmed:true` (cancel_visit: repeating the exact id set read back).
- `pendingCancelVisitIds` — the server-authored id set cancel_visit's
  confirmed call must match exactly (added 2026-09-16, closing the "consent
  theater" gap — `confirmed:true` used to be a free literal).
- `servedAppointmentIds` / `servedAppointmentServices` / `servedAppointmentDates`
  / `servedAppointmentTimes` — per-call maps populated at every server-side
  appointment resolution; the read-backs are built FROM these, never from
  model memory.
- `planConsecutive` (in `src/core/visits.ts`) — places services back-to-back
  where every start is a real Phorest-returned start.
- All three execute sequentially through the existing single-appointment
  handlers, so every write guard (fresh re-check, identity gates) applies
  unchanged; partial success is reported honestly (booked vs failed).
- `handleLogRunningLate` — optional `alsoAppointmentIds` to flag lateness
  across a whole sitting, not just one appointment.

**Guarded by:**
- `twilioStream.visit.test.ts` — the two-phase shape for all three tools.
- `visits.test.ts` — `planConsecutive`/`clusterSameVisit` unit coverage.
- `toolRegistration.test.ts` — every advertised tool has a REGISTERED
  handler on BOTH engines, dispatched through the real tool path (not just
  callable directly).

**Traps:**
- 2026-09-15/16: `reschedule_visit`/`cancel_visit`/`book_visit` were banned
  from the backend prompt in one place but a SECOND ban copy existed
  elsewhere — grep every occurrence before assuming a carve-out is complete.
- 2026-09-16: the same three tools were registered ONLY inside
  `if (voiceEngine === 'realtime')` — mis-indented so it read as top-level to
  three reviewers — while the Live backend prompt was told to call them
  directly. Erica told a real caller "I'm unable to check a combined
  opening." Fixed by moving registration out of the branch (`toolRegistration.test.ts`
  now guards this for both engines).
- A test that calls `handleRescheduleVisit(...)` etc. directly proves handler
  LOGIC works, not that the tool is REACHABLE — always also dispatch through
  the session's real tool path (`runTool`) in at least one test.
- Run the formatter before reviewing control flow in this file — indentation
  lies (the mis-indented block above passed three reads).

**Verify:**
```bash
npx vitest run src/tests/twilioStream.visit.test.ts src/tests/visits.test.ts src/tests/toolRegistration.test.ts
npx tsx scripts/sim-visit.ts <date> <time>
```

**Do not:**
- Add a new visit-tool call site without registering it OUTSIDE any
  `voiceEngine ===` branch (or explicitly inside both).
- Let `cancel_visit`'s confirmed call accept a different id set than the
  planning call returned — that is the whole point of `pendingCancelVisitIds`.
- Trust model-remembered service/date/time for a read-back — always resolve
  from the `servedAppointment*` maps.
