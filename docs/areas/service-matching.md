# Service matching

**Purpose.** Turn a caller's spoken service phrase into a catalog service (or
an honest "notOffered"/"ambiguous"), and separately catch a staff NAME
mistakenly passed as a service phrase — without letting one matcher's fix
break the other.

**Key code** — `src/services/booking.ts`:
- `resolveService` — THE one service matcher; `get_prices` and
  `suggest_availability` both call it (there are not "two selectors").
- `normalize` — strips joiner words and modifiers, maps synonyms, from both
  catalog names and caller phrases.
- `TOKEN_SYNONYMS`, `JOINER_TOKENS` (and/plus/with/also/then/n), `SERVICE_ALIASES`.

`src/realtime/twilioStream.ts`:
- `matchStaffName` — fuzzy staff-name matcher (the "Glenda"/"Richa" flub).
- `maxEditsFor(name)` — length-scaled edit bound: 5+ letters → 2 edits,
  4 letters → 1, ≤3 → exact only.
- `STAFF_MATCH_STOPWORDS` — small function-word safety net (trimmed 2026-09-16
  to ~41 genuine closed-class words; booking vocabulary removed).
- the `result.closest.length === 0` gate inside `handleSuggestAvailability` —
  only consult the staff matcher when the resolver found NO service
  candidates; a phrase with candidates is a service phrase.

**Guarded by:**
- `booking.serviceJoiner.test.ts` — joiner words / token-set coverage (the
  "brow and lip" conjunction fix).
- `booking.match.test.ts`, `booking.alias.test.ts`, `booking.tattoo.test.ts`,
  `booking.focusedSynonyms.test.ts` — matcher/alias/tattoo/brow-lash cases.
- `staffMatch.test.ts` — the length-scaled bound (Richard/Rishka match Richa;
  "and"/"want"/"then"/"than" do not match Manu).
- `twilioStream.serviceMatch.test.ts` — end-to-end: a service phrase with
  candidates never returns a staff match; a bare name still does.

**Traps:**
- 2026-09-15: "eyebrow threading and upper lip" resolved to stylist **Manu**
  because "and" is 2 edits from "manu" and the old flat bound allowed 2 for
  any 4+ letter word. Fixed via length-scaled bound + stopwords, not by
  tightening the bound globally (Richa is heard as "Richard"/"Rishka", both
  distance 2 — a global tighter bound would break real matches).
- 2026-09-16: the SAME filler word ("and") also broke the **service**
  resolver — "brow and lip" matched "Brow Wax and Lip Wax" because the wax
  catalog name's own "and" won over the threading bundle's "+" (which
  normalizes to nothing). Fixed in `normalize()`: strip conjunctions from
  catalog names too, score on token SETS not counts. Rule: when a token
  causes a false match, check every other matcher for the same token.
- 2026-09-16: a repeated word in a bundle name ("Brow Thread + Lip Thread")
  used to undercount token coverage — fixed by set-based scoring.
- Before loosening any fuzzy threshold, check what ordinary English words
  fall inside the new bound (2026-09-15 lesson).

**Verify:**
```bash
npx vitest run src/tests/booking.serviceJoiner.test.ts src/tests/staffMatch.test.ts src/tests/twilioStream.serviceMatch.test.ts
npx tsx scripts/sim-scenarios.ts <today's-date>   # re-run after ANY matcher change
```

**Do not:**
- Add booking/scheduling vocabulary (book, time, date, upper, lower...) back
  to `STAFF_MATCH_STOPWORDS` — the bound alone now handles it; the list is a
  safety net, not the resolver's job.
- Assume `get_prices` and `suggest_availability` use different selectors —
  they share `resolveService`; fix the resolver once, not twice.
- Tighten `maxEditsFor` globally instead of per length class.
