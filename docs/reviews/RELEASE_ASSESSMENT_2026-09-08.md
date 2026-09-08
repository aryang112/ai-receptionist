# Release assessment — September 8, 2026

Assessment only, requested by Aryan before deciding how to integrate and deploy.
No runtime code, production configuration, Phorest records, forwarding, or deployment
changed. Existing worktrees were inspected without modifying them.

## Recommendation

Do not deploy current `main` or the detached hotfix unchanged. Use the September 3
production baseline for a small release: restore client-creation email with the
consent opt-outs, and add a narrowly scoped eyebrow/threading matching correction.
Keep the broad vocabulary filter, prompt rewrite, combined identity question, and
service-information prototype out until their separate validation is complete.

The email-only candidate already exists as `acbed9c` on top of production. The
two-fix candidate `9d619df` also exists, but contains the matcher regression below.
These are existing candidates, not newly approved or deployed releases. A narrowed
matcher candidate still needs implementation and validation after the scope decision.

## Verified release and branch inventory

| Item | Observed state | Release implication |
| --- | --- | --- |
| Railway production | Active successful deployment `981138c1-6e73-4952-9daa-1087109f1647`, created September 3 at 7:35 PM ET; release message identifies `117ada0`. Health HTTP 200. | September 3 remains the production baseline. This is deployment metadata evidence, not a running-container source hash. |
| Local and GitHub main | Both `c39a41e` after fetch; tracked working tree clean before this assessment. | Fable's fixes have already been brought into the main checkout. No additional branch merge is needed to obtain them. |
| PR #1 / Fable cloud branch | Closed, superseded by ports `9101f95`, `f270e17`, `5644669` on main. | Original branch starts from the older August 24 tree; do not deploy its standalone tree. |
| PR #2 / conversation reconciliation | Closed, superseded. Its source matches main except main narrows the first-candidate prompt fallback to ambiguous results. | Production reconciliation is already present. |
| Detached Fable hotfix worktree | `117ada0` → `acbed9c` (email) → `9d619df` (matcher); only untracked dependency symlink. | Already separates the two code fixes from the unpublished prompt rewrite. Its three service implementation files are identical to main. |
| PR #3 / service knowledge | Open; still based on the closed conversation branch. | Keep separate. Privacy wording removes explicit schedule bans; validator reads live Phorest; owner approval of knowledge remains outstanding in the review record. |
| Original knowledge worktree | Detached `b80241c`, modified prompt/schema/test files and untracked knowledge files/scripts. | Uncommitted work remains; preserve it. Do not deploy this dirty directory. |
| September 1 audit branch `8b26fa2` | Not fully ported. Closure and schedule-change notification behavior has newer equivalents, but the transfer outcome ordering fix is absent. | Selectively port/reproduce the remaining transfer race; do not mark the whole branch reconciled or bulk-merge its older prompt/session code. |
| Older technical approach branch `78e7a8d` | Earlier conversation/Polly experiment remains a remote ref. | Separate historical experiment; not required for the September 7 booking fix. |

`117ada0` is an ancestor of main. Of 29 production files under `src` excluding
tests, 23 are byte-identical. The six differing files are `openaiSession.ts`,
`toolSchemas.ts`, `twilioStream.ts`, `booking.ts`, `phorest.client.ts`, and
`phorest.mock.ts`. Owner summaries, notification storage, hours, configuration,
routes, and other unchanged source files are preserved. The adapter diff changes
client email construction and adds a placeholder predicate; the later client
resolution/reconciliation functions are retained. No model/voice/session-level
configuration field, dependency manifest, or business-hours file changed.

## September 7 incident and QA reconciliation

Reviewed the full persisted transcript, call metadata/tool outcomes, and historical
Railway logs for the September 7 approximately 1:03 PM ET client call, last four 8919.
The requested appointment in tool logs is September 10 at 1 PM, Brow Threading.

- **VERIFIED:** both booking attempts failed during client creation with Phorest
  HTTP 400 `EMAIL_REQUIRED`. The call has two failed `book_appointment` records and
  no booking rows; Erica reported failure. This supports the urgent email fix.
- **VERIFIED:** the transcript contains three service-clarification questions;
  the production matcher also independently returns `notOffered` for “eyebrow
  threading” against today's live catalog. Main resolves it to Brow Threading.
- **LIKELY systemic exposure:** new-client requests without email follow the same
  broken production path. This is not proof of the number of other affected callers.
- **NEEDS LISTEN:** who hung up, clipping, interruptions, exact spoken numbers, and
  whether “eyeball” was spoken or transcribed incorrectly. No recording was listened
  to in this assessment. The September 7 QA email overstates hangup attribution.
- Latest QA email, **September 8 AM:** its zero-call coverage is **VERIFIED** against
  fetched call metadata for its stated September 7 5:38 PM–September 8 8:38 AM window.
  Its clean result excludes the incident, and is not evidence of a repaired booking path.
- Incident QA email, **September 7 PM:** lost booking/root cause **VERIFIED** as above;
  no successful booking or message delivery is recorded for the incident. Its caller
  hangup attribution requires listening rather than inheriting its “verified” heading.

## Findings that change release readiness

1. **New matcher regression: unknown words can change the requested service.**
   `booking.ts:125–131` deletes every word absent from catalog names. Against the
   same live catalog, production returns `notOffered` for “henna brows” and “brow
   henna”; main returns a direct Brow Threading match. This bypasses ambiguous /
   not-offered handling and can produce the wrong price or availability before any
   booking read-back. Use explicit synonyms/aliases and bounded filler words instead
   of treating every unknown word as disposable. The prior review accepted this
   tradeoff; this assessment recommends withholding it from the urgent release.
2. **Live probe is red despite the green unit suite.** Five contract rows fail:
   “threading for my eyebrows” and “full leg wax” still return `notOffered` (also
   unresolved in production); “haircut”, “hair cut”, and “massage” have incorrect
   negative expectations because the real catalog includes Haircut and massage
   add-ons. A kind-only `match` assertion also cannot detect the wrong target service.
   Correct catalog-dependent expectations and assert the intended service identity.
3. **The recommended create diagnostic does not test the intended payload.**
   `scripts/diag-create-client.ts` omits both consent fields in its placeholder
   variant, while the app sends them. Its header also incorrectly says production
   already sends a placeholder. A successful run of that script would not prove
   acceptance of the actual release payload. Align it before the live create check.
   No test client was created during this assessment.
4. **Main is a broader conversation release.** It also includes never-deployed
   `37d1d93` (lean prompt and silent `wait_for_user`) and `5644669` (ask-once and
   combined name/number questions). These still need pre-production listening tests.
   A green unit suite cannot establish pacing, turn-taking, or caller consent behavior.
5. **An older unmerged fix is still missing: transfer outcome ordering.** The
   September 1 audit branch stamps the transfer outcome before awaiting Twilio's
   redirect and rolls it back on failure. Current main and production stamp it after
   the awaited redirect (`twilioStream.ts:4589–4617`). A Twilio `stop` during that
   await takes the generic “caller hung up” path and cleanup persists the previous
   outcome once. This source ordering is **VERIFIED**; actual production incidence
   was not measured in this assessment. Selectively port it with an early-stop and
   redirect-failure regression test. Other changes on that branch have newer
   equivalents (closure policy, dated reopening, deterministic schedule-change SMS).
   Its blanket `beginHangup` response suppression is not a safe automatic port:
   the current `end_call` explicitly needs its tool-result response to speak goodbye.

The live probe also surfaces existing concerns such as generic “microblading”
selecting a six-month touch-up and “underarm wax” selecting the beginner/girls line.
Both reproduce with the production matcher; they are not regressions introduced by
Fable's change and should be tracked separately.

## Validation and proposed release gates

- Fresh main validation: 46 test files / 554 tests passed; `npm run build` passed.
- Live read-only catalog probe: 63 services; five failed contract rows. Production
  versus main comparison used the same fetched catalog and executed no booking writes.
- Evidence artifacts are under local, untracked `outputs/release-assessment-2026-09-08/`.
  Raw transcript/call artifacts must remain local; do not include them in a source archive.
- After agreeing scope: prepare the narrow candidate, validate its exact create body
  with a labelled disposable client and confirmed consent values, run meaningful
  service regressions, and exercise the first-time-caller path before deployment.
- Broader prompt release additionally requires a listening test through the existing
  local/ngrok call harness, including both contact answers, service clarification,
  booking read-back/approval, and silence followed by resumed speech.
- Deployment remains a separate decision: owner go-ahead, after-hours window, zero
  active calls, and a clean archive of the exact tested commit. Retain `117ada0` as
  the immediate rollback baseline, with the explicit caveat that it restores the
  known missing-email bug too. Verify health, cache warm-up, and the first booking
  after release. Do not upload a dirty worktree or change forwarding to test a build.
