# Fable review handoff — 2026-09-08

This is draft review work in the existing repository. It has not been deployed. Main and the existing Fable branch were not modified.

## Base and production evidence

The review starts at Fable's latest available branch, `claude/production-call-bug-diagnosis-mlpld8`, commit `4f8c52f`. On preparation, Railway reported successful active deployment `981138c1-6e73-4952-9daa-1087109f1647` from September 3 with release message identifying `117ada0`. The user mentioned a recent deployment, but no newer one was visible through the configured Railway project; Fable's PR also still said NOT DEPLOYED. Treat `4f8c52f` as the latest source baseline, not a verified deployed commit. Recheck the deployment identity before any release.

## Why the first PR is larger than a prompt edit

Fable's branch descends from the August 24 GitHub tree. Local source and the verified September 3 release contain later reliability behavior that is absent there. The first PR reconciles that existing production source and tests before applying the unpublished conversation cleanup from `37d1d93`. It does not import local Git history, operational call reports, recordings, credentials, or research outputs.

Production behavior carried forward includes exact caller-message delivery, owner recaps, closure gates, client resolution/reconciliation, caller phone normalization, and call termination safeguards. These are baseline alignment, not a claim that they are all new features.

Fable's new service matcher, revised mock service names, phrase tests, and call-level regression are retained. Its synthetic-email fix and disabled email marketing/reminder consent are applied inside the newer client-resolution code, retaining single-flight and uncertain-create protection. Real supplied email is still trimmed and preserved. Tests now cover absent, blank, and real supplied email under the newer requirement.

## Conversation cleanup and overlap decisions

- Preserve the reduced-repetition prompt and silent `wait_for_user` tool.
- Keep Fable's ask-once rule and combined name/number-on-file turn, while requiring both answers and explicit consent to use the calling number. Already supplied information is retained.
- Update the caller-context note, IDENTIFY flow, booking-tool description, and lookup-miss note consistently. Related contact questions can share a turn; unrelated service/date/time questions cannot be bundled with identity.
- Preserve final booking read-back and explicit approval. The ask-once rule is not permission to skip write consent.
- Fable's first-candidate fallback after an unclear service clarification is retained, with the final read-back/approval guard explicit. Review that tradeoff carefully: the matcher can narrow unfamiliar wording aggressively.

## Validation

Conversation/reconciliation branch: 46 test files / 554 tests passed and TypeScript build passed using fake configuration, no production credentials. This includes the newer client-resolution regressions and Fable's matcher regression. Test-run reproduction:

```sh
npm ci
OPENAI_API_KEY=review-dummy OPENAI_REALTIME_API_KEY=review-dummy TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000 TWILIO_AUTH_TOKEN=review-dummy USE_MOCK_PHOREST=true OWNER_PHONE=+12025550100 TWILIO_NUMBER=+12025550101 LOG_FILE=off npm test
npm run build
```

The fake numbers are reserved fictional numbers. Existing tests mock clients but expect some nonempty configuration. Never supply production credentials just to satisfy these tests.

No live API probes, Phorest writes, calls, listening tests, or deployments were run during this reconciliation. `scripts/probe-prompt-live.ts` is provided for later explicitly authorized live-model validation; do not run live scripts as part of a routine offline review.

Review this PR first, then the service-information PR stacked on its branch. Do not deploy or merge as part of review. The old private review repository is superseded.

## Service-information draft (review second)

The second PR ports all 3 modified and 10 new prototype files from the separate Codex worktree onto the reconciled conversation branch. It adds `get_service_information`, local service-knowledge configuration, source/benchmark/validation scripts, and unit/integration tests. See `docs/SERVICE_KNOWLEDGE_PLAN_2026-09-04.md` for the original proposed design; that document's historical findings are not a new production approval.

It also changes the PRIVACY section so public provider working hours and bookable openings may be discussed, while private whereabouts/calendars/client appointments remain protected. Fable should deliberately approve or reject that functional change rather than treating it as incidental to knowledge lookup.

The original prototype exceeded the existing prompt budget once combined with Fable's ask-once behavior. Only its new knowledge/privacy wording was shortened; function-call-only output, returned-fact grounding, qualifiers, verbatim high-risk responses, provider confirmation for missing facts, and private-calendar protections remain explicit. The existing budget ceilings were retained and now pass. Corresponding wording assertions were updated without removing their behavior coverage.

Final service-information branch: 48 test files / 568 tests passed; TypeScript build passed, with the same dummy-only configuration above. The integration still needs live-model and listening evaluation before release. The knowledge content remains a prototype for owner review.
