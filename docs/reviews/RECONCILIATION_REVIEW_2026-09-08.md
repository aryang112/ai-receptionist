# Reconciliation review — 2026-09-08

Dev-lead review of three stacked drafts and the decision on what lands on `main`.

| PR | Branch | Base | Verdict |
| --- | --- | --- | --- |
| #1 | `claude/production-call-bug-diagnosis-mlpld8` (Fable, cloud) | GitHub main `72aae0f` (Aug 24) | Source changes **accepted** and ported; prompt edits re-authored; branch **superseded** |
| #2 | `codex/conversation-review-2026-09-08` (Codex) | PR #1 tip `4f8c52f` | Faithful re-port of local main; source delta **accepted** (one prompt rule narrowed); docs/scripts deletions **rejected**; branch **superseded** |
| #3 | `codex/service-knowledge-review-2026-09-08` (Codex) | PR #2 tip | **Not merged.** Code: revise. Privacy rewrite: reject as written. |

## Why the branches could not be merged as branches

GitHub `main` had been stuck at `72aae0f` (2026-08-24). Local `main` was 100 commits ahead and is
the real source of production (`117ada0` deployed 2026-09-03; `37d1d93` lean prompt + `wait_for_user`
not yet deployed). The cloud Fable session branched from the stale GitHub tree, and Codex then re-ported
local main's source onto that branch by hand. Git therefore sees no shared history: a dry-run merge of
either branch into local main conflicts in `twilioStream.ts`, `phorest.client.ts`, the prompt test,
and `CODEMAP.md`, and taking Codex's tree would have deleted ~4,200 lines of local docs, `state.md`,
`lessons.md`, `todo.md`, and five local scripts that Codex simply never had.

The correct move was to treat Codex's branch as a source snapshot: `git diff main codex-branch -- src/`
differs from local main in exactly Fable's changes plus the re-authored prompt lines. That delta was
applied to local main as three atomic commits, tests were run there, and `main` was pushed so future
cloud sessions branch from the truth.

## Root cause confirmed: the lost booking on 2026-09-07

- Prod `createClient` sends no email for new callers because `e1e5268` (2026-09-02) removed the
  placeholder to keep synthetic addresses out of marketing. Phorest's live tenant answers
  `400 EMAIL_REQUIRED` (the published reference marks email optional). Every first-time caller's
  booking has failed since that deploy; recognized callers never hit the create path, which is why
  test calls from known numbers looked fine.
- Evidence that the placeholder approach works: Erica created the "Prashanna KC" test client on
  2026-08-27 through this exact path when the placeholder was still sent. The cloud branch's note
  that "no client create has ever succeeded in prod" is wrong on that point; the 08-27 failures it
  cites were the invented-service and zombie-stream bugs recorded in `state.md`.
- Fix: placeholder restored under `PLACEHOLDER_EMAIL_DOMAIN`, with `emailMarketingConsent` and
  `emailReminderConsent` set false. Both field names verified against Phorest's `createClient`
  reference on 2026-09-08. The 2026-09-02 lesson ("missing optional data should stay missing") is
  reversed for this tenant; the marketing concern is handled by the consent flags instead.

## Per-change decisions

1. **Placeholder email + consent opt-outs** (`phorest.client.ts`): accept. Integrated inside the newer
   single-flight / uncertain-create code, which Codex preserved intact (45 adapter functions unchanged).
2. **Service matcher** (`booking.ts`, mock, tests, probe script): accept. Reviewed the algorithm:
   synonyms are applied symmetrically to catalog names and queries, filler stripping only ever
   produces a full-name or alias match, and scoring is unchanged. Mock probe: all contract phrases
   resolve. Known trade-off kept: a dropped content word plus the bare `brow` alias lands on threading
   ("henna brows"); the read-back is the net. **Owed:** run the probe against the live 63-service
   catalog before deploy (`npx tsx scripts/probe-service-phrases.ts`), which the sandbox blocked here.
3. **Ask-once prompt rules**: accept with one change. The cloud wording auto-picked "the first
   candidate" on `notOffered` too, where the closest list is only token overlap ("chin threading"
   → Brow Threading). Narrowed: first-candidate fallback applies to `ambiguous` only; `notOffered`
   offers the closest services once and never substitutes a service the caller did not accept.
4. **Name + number-on-file in one turn**: accept, flagged for the ear test. This changes the 08-27
   owner contract (number ask first, name second, one question per turn). The integrated wording still
   requires both answers and explicit consent before the calling number is used, so the consent hole
   stays closed. If callers answer only half the question in practice, revert to sequential asks.
5. **Codex doc/script deletions**: reject. Local `state.md`, `lessons.md`, `todo.md`, audits, and the
   five scripts (`render-prompt`, `validate-session-fields`, `validate-transcription-fields`,
   `test-call-local.sh`, `probe-client-history`) stay. Codex's two review records are kept under
   `docs/reviews/` for the audit trail.
6. **PR #3 service-information prototype**: not merged. Findings from the code review:
   - Privacy rewrite drops the explicit bans on "when Richa arrives or leaves" and "who's working
     today" for a one-provider salon and contradicts two surviving rules (public closure reason as the
     only whereabouts detail; "is Richa there?" must be clarified). Reject as written; re-propose keeping
     the ban list and defining "working hours" as salon HOURS only.
   - Verbatim `safeResponse` texts say "the salon does not have approved guidance", which speaks
     internal review vocabulary aloud, against the prompt's own rule. All 20 voice-ready facts were
     self-approved by the drafting agent; Richa has not signed off.
   - `validate-service-knowledge.ts` is not offline (top-level live Phorest read); split into a schema
     check and a `probe-*-live` script.
   - Lookup misses inflections ("lash lifts", "laminating"); tied candidates truncate silently.
   - Wiring is correct and adds no session-level field, so no hangup risk.

## Validation on main after the port

- `npm test`: 46 files / 554 tests passed. `tsc --noEmit` clean. Prettier clean on changed files.
- Mock-catalog phrase probe: every contract phrase resolved.
- Not run: live-catalog probe, live-model probe, ear test, deploy.

## Still owed before deploy

1. Live-catalog probe run locally.
2. Optional: `scripts/diag-create-client.ts --try placeholder` writes one labelled test client to
   prove the tenant accepts the consent fields; delete it in the Phorest UI afterwards.
3. Ear test of the combined name/number turn and the narrowed clarification rule.
4. Owner go-ahead, then `railway up`. Note that this release also carries `37d1d93` (lean prompt and
   silent `wait_for_user`), which has not been live yet.
