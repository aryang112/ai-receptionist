# Production parity and shared review baseline — 2026-09-08

## Conclusion

Fable's `4f8c52f` branch did not include all of the later production fixes. It descends from the August 24 GitHub baseline `72aae0f`; production was subsequently released from local commits that had not been pushed. This is a source-history gap, not evidence that Fable deliberately removed fixes.

PR #2 reconciles those fixes with Fable's current work. PR #3 adds the service-information prototype on top. Neither PR has been deployed. The working review baseline for joint review is PR #2, not PR #1 alone. Do not deploy the PR #1 tree as a replacement for the later production tree.

## Evidence and limits

- Recorded production source: `117ada0`. Railway's configured Erica production service still reported successful deployment `981138c1-6e73-4952-9daa-1087109f1647`, dated September 3, with that commit in its release message on this audit.
- Fable source reviewed: `4f8c52f` (`claude/production-call-bug-diagnosis-mlpld8`).
- Reconciled source reviewed: `390705f` (PR #2). Prototype source reviewed: `b243025` (PR #3). Later commits that add this report only change documentation.
- The user's report of a newer deployment remains unverified. Confirm the actual live source before releasing either branch. Source comparison does not inspect a running container's files or prove live call behavior.
- Of 29 files outside `src/tests` in the recorded production source, 23 are byte-identical in PR #2. The six differing files are `openaiSession.ts`, `toolSchemas.ts`, `twilioStream.ts`, `booking.ts`, `phorest.client.ts`, and `phorest.mock.ts`.
- TypeScript syntax-tree comparison found 172 existing top-level functions/class members unchanged in `twilioStream.ts`, five changed, one added, and none removed. Changes are the unrecognized-caller context, main instructions, session creation/tool registration, and the lookup-miss note; the new member is `handleWaitForUser`.
- In `phorest.client.ts`, 45 existing top-level functions/class members are unchanged; only `createClient` changed and `isPlaceholderEmail` was added. In `openaiSession.ts`, 54 existing functions/class members are unchanged; the three changed methods and new set implement silent tool completion.

These comparisons establish preservation at the source level. They do not turn prompt assertions or mocked tests into proof of production audio quality.

## Shared feature inventory

| Area | Gap in Fable's older source | Reconciled review behavior and evidence |
| --- | --- | --- |
| Exact messages for Richa | No later argument-free caller-message capture path | `handleLeaveMessageForOwner`, item/content deduplication, multi-turn capture, delivery outcomes and tests are retained from production. Generated summaries cannot replace an explicit caller message. |
| Owner call recaps | No post-call summary module or notification ledger | `postCallSummary.ts`, `callStore.ts`, and `ownerSms.ts` are byte-identical to production; recap and teardown tests are present. Feature remains environment-controlled. |
| Closure handling | Older closure/transfer behavior lacked the later global policy and gates | `hours.ts` is identical; availability/write closure guards, need-discovery before message collection, and transfer suppression remain in the unchanged handlers. |
| Client creation and identity | Older resolution lacked later single-flight, ranked contact matching and uncertain-create reconciliation | 45 existing adapter functions are unchanged; only `createClient` differs. No repeat-create protection or shared-phone ownership guard was removed. |
| Missing email | Production omitted absent/blank email; Fable reports tenant rejection | Fable's placeholder fallback and disabled email marketing/reminder consent are retained for absent/blank email inside the newer create path. Real supplied email remains trimmed and preserved. Offline POST-body tests pass; no fresh provider write was performed here. |
| Service matching | Production missed Fable's newest spoken variants/filler handling | Fable's `booking.ts`, phrase-test file and call-level matching regression were byte-identical when reconciled. The revised mock catalog also retains the production phone-normalization helper. |
| Phone normalization | Older code lacked the later bare-number normalization fixes | Later production normalization and regression tests are retained; no production phone or environment value was changed. |
| Call ending and message timing | Older branch lacked later goodbye, media inactivity and exact-message reliability work | Existing production call-handler functions/members were not removed. Goodbye, media-watchdog, caller-message and notification regressions are included. |
| Conversation cleanup | Unpublished work beyond the recorded production source | Silent `wait_for_user`, less repetition and read-back before writes are included in PR #2. Runtime silence behavior still needs an ear test. |
| Ask-once/contact questions | Fable's shorter contact flow conflicted with older sequential instructions | Caller note, IDENTIFY, booking-tool description and lookup-miss note now agree: related name/number questions may share a turn; await both answers and retain final booking approval. |
| Service information | Separate unfinished local worktree | PR #3 contains the knowledge tool, data, scripts and tests. It is additional review work, not an existing production feature. |

## Decisions still requiring Fable's review

1. Fable's matcher drops words absent from the catalog, and its prompt chooses the first candidate after an unclear repeat. This can narrow an unfamiliar request too aggressively. That behavior was preserved, not silently redesigned; judge it against realistic phrases and the required final service read-back and approval.
2. Confirm the combined contact question is the intended change from the older owner-approved separate number/name turns. The integrated wording still requires both answers and number consent.
3. Review service-information sources, missing/conflicting facts, high-risk responses and owner approval. Also deliberately review its public provider-availability/private-calendar distinction.
4. Confirm deployment identity and require live-model/listening validation before any release. No claim that these draft branches are already live is warranted.

## Validation and coordination

PR #2: 46 test files / 554 tests passed, build passed. PR #3: 48 test files / 568 tests passed, build passed. Both used dummy service configuration. Instructions are in `CODEX_HANDOFF_2026-09-08.md`.

Read PR #2 first, then PR #3. Approve, request changes, or reject particular behavior explicitly. Keep review separate from merge/deployment authorization. This report and a coordination comment on PR #1 provide a shared record; they do not claim Fable has already read or accepted it.
