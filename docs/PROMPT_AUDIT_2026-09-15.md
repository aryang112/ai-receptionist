# Prompt & functionality audit — 2026-09-15 (post-GPT-Live)

**Written for a reviewing agent (Fable).** Please challenge the reasoning, not
just the diffs. Where I am uncertain I say so explicitly — those are the places
I most want pushed on.

**Scope.** First audit since the GPT-Live split. The Sept 1 and Sept 3 prompt
audits both predate it, and the split introduced a **second prompt** that had
never been reviewed against the first.

**Method.** Rendered both prompt layers exactly as production builds them
(`scripts/render-live-prompts.ts`, real catalog, real clock), read them against
each other and against the tool surface, then ran a read-only scenario sweep
(`scripts/sim-scenarios.ts`) that drives the REAL handlers against REAL Phorest
reads. No writes, no calls, no customer data touched.

**Baseline.** Branch `codex/gpt-live-taste-test`, engine `live`, backend
`gpt-5.6-terra`. 797 tests green, tsc clean at the end of the audit.

---

## 0. The structural finding — everything else follows from it

`livePrompts.ts` builds its **own** `CONVERSATION FLOW` block for the backend
model rather than reusing the production prompt's `SERVE` section.

**Consequence: every edit to `SERVE` in `twilioStream.ts` is inert on the Live
path.** Including one made earlier the same day — the RESCHEDULE flow was
rewritten to be visit-aware, tests passed, and the model never saw it.

Two corroborating observations:

- The visit-aware `list_appointments` change DID reach production, because it
  rides with a **tool result**, not the prompt. Confirmed on a live call:
  *"I see Brow Threading at 4:00 PM and Chin Threading at 4:05 PM tomorrow."*
- `dae29c7` fixed a raw-write ban in `BACKEND TOOL USE` after a live failure,
  but an **identical ban** sat in the unreviewed flow section, earlier in the
  prompt. It would have re-broken all three visit tools on the next deploy.

**Question for review:** is the right long-term answer to delete the duplicated
flow section and have `livePrompts.ts` filter the production `SERVE` (one
source), or to accept two prompts and add a test that diffs their rule sets? I
lean toward one source, but did not attempt it here — it is a larger change than
an audit should make unsupervised, and the Realtime fallback path still reads
the production prompt.

---

## 1. Prompt conflicts found and fixed

All seven are real contradictions, not stylistic. Six were invisible from the
production prompt.

| # | Conflict | Why it mattered |
| --- | --- | --- |
| 1 | `"Do not build a separate visit plan; prepare at most one appointment action at a time"` | Second copy of the ban `dae29c7` fixed, sitting EARLIER in the prompt. Would have disabled `book_visit`, `reschedule_visit`, `cancel_visit`. |
| 2 | RESCHEDULE: *"identify the exact one they mean"* | Singular; fights naming or moving a whole sitting. |
| 3 | CANCEL: *"identify the exact appointment, prepare one cancellation proposal"* | No route to `cancel_visit`. |
| 4 | BOOK: *"preparing one exact proposal"* | Excluded `book_visit`. |
| 5 | RUNNING LATE: *"find today's appointment"* | Singular; no mention of `alsoAppointmentIds`, so only the first service of a visit gets flagged. |
| 6 | Live: *"suggest another task unless the caller asks"* vs backend: *"take the lead: ask once whether they need anything else"* | The voice model could suppress the delegated closing offer. Narrowed to *"propose a specific task"*, which is what the rule was guarding against. |
| 7 | *"ask once whether they need anything else"* vs register item 14 (*more-help question after an explicit goodbye*, VERIFIED on Sept vendor calls) | **Self-inflicted earlier the same day.** Precedence now explicit: *"A farewell outranks the offer."* |

**Uncertainty I want reviewed:** #6 and #7 are judgement calls about instruction
precedence, expressed in prose. Neither is mechanically enforced. If the model
mis-ranks them the failure is silent and only shows on a call. Is prose
precedence acceptable here, or should closing eligibility be computed
server-side and delivered as state (the way transfer eligibility already is)?

---

## 2. Defects found by the scenario sweep

### 2.1 Register item 05 — open since Sept 10 — REPRODUCED and fixed

> "eyebrow threading and upper lip" → resolved to the stylist **MANU**

**Cause: the word "and" is two edit-operations from "manu"**, and token matching
allowed a distance of two for any name ≥ 4 characters. Any sentence containing
"and" could produce a confident staff match.

The bound cannot simply be tightened: phone transcription renders Richa as
"Richard" and "Rishka", both also distance two, and the prompt documents this.
So the fix removes filler words from the matcher rather than narrowing the
distance. `STAFF_MATCH_STOPWORDS`, applied to tokens and to a bare single-word
query (which bypasses token matching).

After: that phrase returns `notOffered` with closest = **"Brow Thread + Lip
Thread"** first, so the conversation recovers in one short question.

**Uncertainty:** a stopword list is a blunt instrument and English-specific. I
considered requiring the staff matcher to run only when the caller phrase has no
service-like token, which is more principled but touches the matcher's contract.
Worth a second opinion.

### 2.2 Ten consecutive starts offered as alternatives

A requested time that is unavailable returned the ten NEAREST starts — which on
a busy day are consecutive: `12:55, 1:00, 1:05, 1:10` for a 6:45 PM request. The
model offers three and the caller hears one answer three times.

Now: nearest few kept, remainder spread across the day. **Scoped to the same-day
list only** — nearby-DATE summaries must stay close to the requested time, which
an existing test (`twilioStream.nearby.test.ts`) encodes deliberately.

### 2.3 Latent divide-by-zero in `spreadAcross`

Mine, introduced in `78ecd3a`. `max === 1` divides by `(max - 1)` → `list[NaN]`
→ `undefined` through a non-null assertion. Unreachable until 2.2 started asking
for a single spread pick. Caught by the existing nearby tests.

**Worth noting for review:** this is the second time in this session that a
non-null assertion (`!`) turned a logic error into a runtime crash rather than a
type error. There are many in this file.

---

## 3. Verified healthy

Same sweep, same run — these are the register items that are genuinely fixed:

| Scenario | Result |
| --- | --- |
| "eyebrow threading" | → Brow Threading (item 03) |
| "eyebrow tattoo" | → Micro Blading/Shading (item 06) |
| "microblading touch-up" | → Microblading Touch-Up (6 Months), NOT the full treatment (item 07) |
| "henna brows" | → no silent substitution; closest offered (item O06 regression held) |
| "Richa" as a service | → correctly identified as a person (item 01) |
| unknown service ("microneedling") | → coaching forbids "not in our system" |
| closed day (Sunday) | → closure wording, never "fully booked" |
| "wax" | → ambiguous, ask which |

---

## 4. Still open — NOT fixed in this audit

1. **Register item 15 — narration.** `5769300` (focused cleanup) confirmed NOT
   in the deployed line. Heard live this session: *"Okay, checking that"*,
   *"Okay, rescheduling for you now."* The prompt already forbids narration, so
   this is a **compliance** gap, not a conflict — a different class of fix, and
   arguably a model/eval problem rather than a prompt one.
2. **Item 05's deeper half.** The PRICE path resolves "brow threading and upper
   lip" to the bundle; the AVAILABILITY path does not. Two tools, two service
   selectors. The register's own recommendation is to unify them. Not attempted.
3. **Same-client double-booking has no explicit guard.** It is currently
   prevented only because availability became truthful — a data property, not a
   rule. `book_visit` covers the deliberate case; a caller booking two services
   in separate turns still relies on the calendar telling the truth.
4. **`log_running_late` note text is uniform across the sitting.** Every
   appointment gets the same sentence. Arguably each should say which service.

---

## 5. What I would ask a reviewer to check hardest

- **Section 0's question** — one prompt source or two, and what test enforces it.
- Whether the stopword approach (2.1) is the right shape, or a workaround.
- Whether prose precedence (conflicts 6 and 7) is sufficient for closing
  behaviour, or whether it should be server-computed state.
- Whether `cancel_visit` needs a planning phase after all. I argued no (nothing
  to compute), so it writes on the first call with `confirmed: true`. That makes
  it the only visit tool that can write without a prior read-back from the
  server — the read-back is the model's responsibility alone.
- Whether the visit tools should have been ONE tool with an `action` parameter
  rather than three. I chose three for clearer model-facing semantics, at the
  cost of three more entries in an already 14-tool surface.

---

## Reproducing this audit

```bash
cd ~/Documents/Dev/ai-receptionist-live-2026-09-12
node --env-file=.env --import tsx scripts/render-live-prompts.ts   # both prompt layers
npx tsx scripts/sim-scenarios.ts 2026-09-16                        # read-only scenario sweep
npx tsx scripts/sim-visit.ts 2026-09-16 17:30                      # visit planning, live data
npx tsx scripts/sim-availability.ts 2026-09-16                     # slot integrity, live data
npx vitest run                                                     # 797 tests
```

Evidence for the live-call claims: `state.md` entries for 2026-09-14/15, and
call `CA4fc18ea61a5343563e751ca5721edcbe` (visit naming worked, visit move
blocked) and `CA57b7d8e37eb91ed3ecea117a3cdd3f34` (silent close, one-at-a-time
reschedule).
