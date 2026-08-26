# Prompt Rework Proposal — from accreted rules to a structured architecture
**Date:** 2026-08-26 · **Trigger:** Glenda call (CA7b608d06…) — Erica said
"we don't have a service named Richa in the system" while a rule forbidding
exactly that sat ~100 lines away in the prompt. **Status: PROPOSAL — nothing
applied.**

---

## 1. The problem, stated precisely

The prompt has a rule (SERVICES line): *"NEVER tell a caller 'we don't offer
that.'"* Erica violated its spirit anyway. This is not a wording bug — it is a
**salience failure**: the instruction existed but lost the competition for
attention at the decision moment. Adding another rule for this scenario would
make the next salience failure MORE likely, not less (every added line dilutes
every other line). That is the band-aid trap Aryan named.

## 2. Current state, measured

Built via `buildInstructions()` (2026-08-26, without live price list):

| Metric | Value |
|---|---|
| Characters / words / est. tokens | 22,220 / 3,833 / **~5,555** |
| Lines / sections | 165 / 15 |
| With live 63-service price list | ~6.5–7k tokens |

Per-section token weight (heaviest first): TRANSFER TO RICHA **996** ·
header/persona/greeting/hours **985** · BOOKING **643** · CUSTOMER ID **505** ·
RESCHEDULING **360** · NON-CLIENT **328** · CANCELLATION **301** · GENERAL
**273** · PRIVACY **223** · SERVICES **222** · ENDING **187** · RUNNING LATE
**156** · SPAM **152** · CONVERSATION POLICY **126** · VACATION **73**.

**How it got here:** the prompt is a sediment of dated incident patches (grep
the source: "LIVE FIX 2026-08-23", "AUDIT FIX 2026-08-22", "Transfer-window
fix 2026-08-24", "Holly call"…). Each patch was individually right; the
accumulation is the problem. Retell's own threshold for "your single prompt is
too complex, restructure" is **3–4 conditional branches or 5+ tools** — Erica
has 9 tools and dozens of branches.

## 3. What the professional sources prescribe

**OpenAI Realtime Prompting Guide** (cookbook; re-validated 2026-08-26 — same
findings as the 2026-08-25 3-agent sweep):
- Canonical skeleton: **Role & Objective → Personality & Tone → Context →
  Reference Pronunciations → Tools → Instructions/Rules → Conversation Flow →
  Safety & Escalation**. Remove unused sections; every section earns its place.
- **Bullets over paragraphs**; short lines; ambiguity/conflicts = degraded
  performance; run a rule-conflict audit.
- CAPS for critical rules — works only when RARE (our prompt caps ~40% of
  lines → nothing stands out).
- Explicit **unclear-audio block** (respond only to clear input; ask for
  repeats when unsure) — we have none; the "wirsaa/Resta" turns worked on luck.
- **Numeric escalation thresholds** ("more than 2 tool failures → escalate")
  instead of our vague "keeps failing even AFTER you retried".
- Conversation Flow as **states with goals + exit criteria**, not prose
  scripts.
- Sample phrases as *style examples* with a variety rule (never verbatim
  every time) — we learned this the hard way (parrot class, lessons.md).
- Static content first, **dynamic variables at the end** (cache-friendly;
  our CURRENT DATE & TIME is line 2).

**Retell AI prompt-engineering guide** (industry receptionist platform):
- Sectional prompting: Identity → Style → Response Guidelines → Task
  Instructions → Objection Handling.
- Tools get a **dedicated section**: trigger conditions, sequences, boundaries,
  exact names — not usage rules scattered through task prose.
- Past ~4 branches / 5 tools: move logic OUT of the monolithic prompt
  (their answer: flow nodes; our equivalent: tool-result coaching + code
  invariants + a compact state flow).

**The pattern behind both:** the prompt carries *identity, principles, and
flow shape*. **Situational coaching travels in tool results** (arrives at the
exact decision moment, only when relevant), **formats live in tool schemas**,
**invariants live in code**. Our proven wins already follow it: precomputed
TODAY'S STATUS (2026-08-23 fix), precomputed RICHA'S LINE, A1 pre-write
re-validation. The rework finishes what those started.

## 4. Diagnosis — seven structural defects

| # | Defect | Evidence |
|---|---|---|
| D1 | **Salience dilution** — 5.5k tokens of rules competing at once | Glenda flub with the rule present; job-seeker improvisation (8/25) with NON-CLIENT rules present |
| D2 | **Rules far from their trigger** — error handling in global prose | `notOffered` returns bare `{notOffered, closest:[]}`; model improvises system-speak |
| D3 | **Scenario proliferation** — enumerated cases instead of principles | NON-CLIENT lists 5 caller types; TRANSFER has 6 sub-rules + 2 exceptions; each incident adds prose |
| D4 | **Mixed altitude** — wire formats beside personality | "pass 24h HH:MM", "pass the slot's value", "YYYY-MM-DD" sit in conversation sections; belongs in tool schemas |
| D5 | **Duplication** — same rule stated 2–4× | never-guess-prices ×3; retry-once ×3 (resched/cancel/transfer); don't-transfer-for-X ×4; recognized-caller handling in 2 sections |
| D6 | **Flow scripts as near-duplicate paragraphs** | BOOKING/RESCHEDULING/CANCELLATION/LATE ≈ 1,460 tokens sharing one skeleton: identify → list/check → confirm → act → confirm result |
| D7 | **Missing guide-recommended blocks** | No unclear-audio handling; no pronunciations (Richa = "REE-cha"; caller said "Rishka"); no numeric thresholds; dynamic vars at top |

## 5. Target architecture

### 5a. New prompt skeleton (OpenAI order, ~3,000–3,500 tokens target)

```
1. ROLE & OBJECTIVE        (~60 tok)  who Erica is, what success is
2. PERSONALITY & TONE      (~180)     persona + pacing + 1–2 sentence cap + variety rule
3. REFERENCE PRONUNCIATIONS(~40)      Richa, service terms that get mangled
4. CONTEXT — STATIC        (~350)     address, weekly hours table, price list (or tool-first line)
5. TOOLS                   (~350)     per-tool: trigger, boundary, preamble rule (NEVER LEAVE
                                      SILENCE lives here, once). Formats → schemas, not here.
6. INSTRUCTIONS            (~450)     deduped globals: never-invent, confirm-before-write,
                                      privacy (kept ~verbatim — it's good), English-only,
                                      caller-leads, unclear-audio block (NEW), numeric
                                      escalation thresholds (NEW)
7. CONVERSATION FLOW       (~700)     states with goal + exit criteria:
                                      Greet → Discover intent → Identify → Serve → Confirm →
                                      Anything-else → Close. "Serve" variants (book/resched/
                                      cancel/late/info) share the confirm-before-write spine;
                                      only their deltas are stated. Replaces 4 numbered scripts.
8. SAFETY & ESCALATION     (~400)     transfer principle + spam + non-client TRIAGE PRINCIPLE
                                      (one rule + ≤3 exemplars, not 5 enumerated cases) +
                                      premises-emergency carve-out
9. DYNAMIC CONTEXT (LAST)  (~250)     current date/time, TODAY'S STATUS, RICHA'S LINE,
                                      vacation block, greeting variant
```

### 5b. What LEAVES the prompt entirely

| Content | New home | Mechanism |
|---|---|---|
| "pass 24h HH:MM", "YYYY-MM-DD", "slot's value" | tool parameter descriptions | toolSchemas.ts |
| notOffered/ambiguous handling | tool result `note` field | "No service matched '<X>'. Never say a name wasn't found in the system — ask naturally what they'd like done." |
| Staff-name-as-service (the Richa flub class) | tool code | roster match → `{staffMember, note: "…is the stylist, not a service — every service is with her; ask which service"}` |
| closed-day / fully-booked phrasing rules (READING RESULTS block) | availability result `note` | tool already computes salonOpenThatDay/closedRightNow — attach the coaching to the data |
| retry-once-then-escalate (×3) | one numeric rule in INSTRUCTIONS + error-result `note` | "tool error → say a brief natural line and retry once; >2 failures in a call → offer Richa" |
| list_appointments empty/error branches (×2 flows) | tool result `note` | same pattern |

### 5c. Rules that must survive verbatim (test-locked today, keep test-locked)
Recording disclosure in greeting · privacy section · never-invent family ·
confirm-before-write · recognized-caller skip (steps 0/10 compressed but
semantics identical) · vacation gating · transfer-window trust-verbatim ·
end_call discipline. These are compliance/large-blast-radius rules; the rework
compresses their WORDING, never their MEANING, and
`twilioStream.prompt.test.ts` is updated first so every one stays pinned.

## 6. Rollout plan — eval-gated, one family per deploy

**Phase 0 — harness (no behavior change):** snapshot current prompt to a
fixture; restructure prompt tests into per-rule semantic assertions (not
line-position); add a token-count regression test with a budget ceiling.
**Gate:** 339+ tests green.

**Phase 1 — tool-layer moves (D2, D4 — highest value, lowest risk):**
`note` fields on notOffered/ambiguous/error/empty results; staff-name
detection; arg formats into schemas; delete the prompt prose they replace
(READING RESULTS block shrinks ~60%). **Gate:** tests + live test call from
5169 replaying the Glenda shape ("is Richa free at X?") + /call-review on next
real traffic.

**Phase 2 — skeleton restructure (D1, D5, D7):** reorder into 5a; dedup
globals; add unclear-audio block, pronunciations, numeric thresholds; CAPS
diet (caps only on the ~10 truly critical rules); dynamic block to the end.
**Gate:** same as Phase 1 + a scripted multi-intent test call (book + price +
hours in one call).

**Phase 3 — flow compression (D3, D6):** state-based CONVERSATION FLOW
replaces the 4 scripts; NON-CLIENT collapses to triage principle + exemplars.
**Gate:** full test-call matrix (book, reschedule, cancel, late, job-seeker,
vendor, spam, silent) — the 8/24–8/25 call-review scenarios rerun.

**Phase 4 — measure & iterate (the guide's "iterate relentlessly"):**
/call-review twice daily is the standing eval; each flub → first ask "which
layer?" (tool note → schema → code → flow → only THEN prompt prose). lessons.md
gains this as a rule.

Expected end state: **~5,555 → ~3,300 instruction tokens (−40%)**, every rule
≤1 place, situational coaching delivered at decision time, and a prompt whose
sections match the official skeleton so future contributors know where things
go — no more sediment.

## 7. Risks & mitigations
- **Prompt is prod-critical; big-bang rewrite = regression roulette.** → 4
  phases, each deployable/revertable alone, each behind the test suite + a
  live scripted call before real traffic.
- **Realtime models are wording-sensitive** (guide: "inaudible" vs
  "unintelligible"). → semantic tests pin meaning; call-review catches drift
  within hours; each phase touches one family.
- **Tool-note guidance can conflict with prompt prose during migration.** →
  each phase DELETES the prose it replaces in the same commit (rule-conflict
  audit is part of review).
- **Session token freeze risk** (lessons.md, 40k TPM): smaller instructions
  directly reduce per-turn input tokens — this rework helps.

## Sources
- OpenAI Realtime Prompting Guide (cookbook): developers.openai.com/cookbook/examples/realtime_prompting_guide
- Retell AI Prompt Engineering Guide: docs.retellai.com/build/prompt-engineering-guide
- 2026-08-25 3-agent prompt-research sweep (state.md summary: unclear-audio,
  numeric thresholds, booking invariants, rule-conflict audit, dynamic-vars-at-end)
- Live evidence: Glenda call CA7b608d06… (this doc §1), Holly call 8/24,
  job-seeker call 8/25.
