# Availability

**Purpose.** Fetch what Phorest ACTUALLY has open, never invent or round a
time, and choose a small, well-spread set of times to read aloud — including
nearby-date search when the requested day has nothing.

**Key code** — `src/realtime/twilioStream.ts`:
- `handleSuggestAvailability` — the `suggest_availability` tool handler;
  owns the staff-vs-service gate (see `service-matching.md`) and the
  nearby-date search.
- `fetchOpenSlots(service, date)` — the extracted fetch→snap→hours-filter
  "which times are genuinely open" truth; used by `suggest_availability` AND
  re-run fresh immediately before every booking/reschedule WRITE (see
  `appointments-and-writes.md`, A1).
- `selectOfferedSlots` — CHOOSES which real starts to read out (quarter-hours
  lead, odd minutes stay in reserve); never moves a time.
- `spreadAcross` — spreads picks across a list without clustering; had a
  divide-by-zero bug found 2026-09-15 by writing a capability test.
- `canonicalNames` (map, local to `handleSuggestAvailability`'s nearby-date
  loop) — gates which resolved service name backs an offered-slot key for
  each candidate date.
- `offeredSlots` — per-call cache keyed by service+date, the set of times
  actually offered; consulted by every later write's fresh re-check.
- `src/core/slots.ts` — `isOnGrid`/`isOnGridValue`/`partitionByGrid`:
  PRESENTATION ONLY, nothing here may move a start time.

**Guarded by:**
- `slots.test.ts` — clean-grid presentation logic.
- `availability.timezone.test.ts` — Phorest per-endpoint timezone handling.
- `twilioStream.nearby.test.ts` — nearby-date search.
- `twilioStream.slotIntegrity.test.ts` — no invented/rounded times reach the
  caller or a write.
- `twilioStream.vacation.test.ts`, `twilioStream.reopening.test.ts` —
  business.json closures fail closed; reopening dates render correctly.

**Traps:**
- 2026-09-14/15 (the "Loretta call"): code used to round Phorest's real free
  starts UP to a clean grid, then SPOKE AND BOOKED the rounded value —
  double-booked a real client, because Phorest anchors its grid to
  appointment ENDS, so gaps between free starts are other people's
  appointments. `snapSlotsToGrid` was deleted; do not reintroduce rounding.
- The real fix was a Phorest SETTING (Booking slots interval, was 0 minutes,
  now 5), not code — check the source system before writing code to
  compensate for awkward upstream data.
- business.json closures must fail CLOSED (no availability offered), never
  fail open, on a Phorest error during a closure check.
- Phorest timezone is per-ENDPOINT inconsistent (see project CLAUDE.md) —
  `/appointment` returns salon-local, `/appointments/availability` returns
  UTC, writes send local wall-clock; normalize in `phorest.client.ts`, not here.
- A missing `canonicalNames` entry used to silently write an offered-slot key
  from `undefined`, weakening the fresh-slot gate for that date (2026-09-16
  non-null-assertion sweep) — now logs and skips the write instead.

**Verify:**
```bash
npx vitest run src/tests/slots.test.ts src/tests/availability.timezone.test.ts src/tests/twilioStream.nearby.test.ts src/tests/twilioStream.slotIntegrity.test.ts
npx tsx scripts/sim-availability.ts <date>   # proves no invented times
```

**Do not:**
- Round, snap, or shift any Phorest-returned start time before speaking or
  booking it — `selectOfferedSlots` only choose from real starts.
- Fail open on a closure-check error — closures must fail closed.
- Re-derive "today's status" separately from the CURRENT STATUS computed
  fact used elsewhere — one source of truth (see `prompts.md`).
