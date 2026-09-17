# Identity and lookup

**Purpose.** Resolve who's calling (caller-ID prefetch, phone match, or
name-only) without ever letting a caller's own stated name or affiliation
substitute for a verified Phorest client record — especially on the
real-write Live path where identity gates a write.

**Key code** — `src/realtime/twilioStream.ts`:
- `handleLookupCustomer` — the `lookup_customer` tool handler. Covers: the
  caller-ID prefetch result, an explicit phone match, and name-only
  candidates — the last of these is explicitly REFUSED as a basis for a
  real-write Live client ID (name-only lookups do not serve appointment ids;
  verified in `docs/AUDIT_REVIEW_2026-09-15.md` §4).
- `handleListAppointments` — the `list_appointments` tool handler; on the
  real-write Live path, refuses any client not matched by phone.
- Privacy rule (authored in `backendRules.ts` `PRIVACY`, see `prompts.md`):
  never give out a phone number — Richa's, staff, or another client's — to
  identify or satisfy a caller.

**Guarded by:**
- `twilioStream.callerIdPhone.test.ts` — caller-ID prefetch → phone-match
  binding.
- `twilioStream.toolNotes.test.ts` — `describe('list_appointments — note
  coaching')`: empty-list offer-to-book coaching, non-empty soonest-first +
  quote-fields-exactly coaching, error retry-once coaching; also covers
  `matchStaffName` staff-name detection used by `handleSuggestAvailability`
  (see `service-matching.md`).
- `liveRealWrites.test.ts` — identity gates on the real-write path
  (`hasPhoneMatchedClient`, see `appointments-and-writes.md`).

**Traps:**
- 2026-09-03 lesson: "a caller's name does not make them a salon client" —
  a self-stated name or company affiliation is never sufficient identity;
  only a Phorest-matched phone (or an explicit prior server-side resolution)
  is.
- 2026-09-12 lesson: "a caller-ID miss is not missing caller ID" — a prefetch
  timeout is not a no-match; the in-flight lookup keeps running and can
  upgrade the call late via `adoptRecognizedCaller`/`applyCallerContext`
  (see the CODEMAP's `prepareCallerContext` entry) — don't treat a timeout
  as a confirmed "unrecognized caller."
- Missing optional customer data (e.g. no email) should stay missing, never
  be replaced with a synthetic placeholder (2026-09-02 lesson) — applies to
  both lookup and client-create paths.
- `list_appointments` on the real-write Live path never serves an
  appointment id for a name-only match — verify this before trusting any
  identity-adjacent change.

**Verify:**
```bash
npx vitest run src/tests/twilioStream.callerIdPhone.test.ts src/tests/twilioStream.toolNotes.test.ts src/tests/liveRealWrites.test.ts
npx tsx scripts/probe-client-history.ts   # read-only raw client fields probe
```

**Do not:**
- Let a model-supplied name or clientId stand in for a phone-matched
  identity on the real-write Live path.
- Log or persist a full phone number (project CLAUDE.md: last-4 only in the
  admin dashboard, never log secrets or full numbers).
- Treat a caller-ID prefetch timeout as a definitive "unrecognized" result.
