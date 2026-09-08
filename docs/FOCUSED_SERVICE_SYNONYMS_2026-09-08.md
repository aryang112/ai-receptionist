# Focused service wording — September 8, 2026

Prepared on `codex/focused-service-synonyms-2026-09-08`, based on deployed
`1425f8c`. Not deployed. The production prompt, sequential number-then-name
questions, model/session settings, client-create fix and catalog cache are retained.

## Decision and alternatives

Aryan requested a small vocabulary for eyebrows/threading and lashes, with latency
as a priority. Use ten word substitutions in the existing matcher: eyebrow,
eyebrows, brows → brow; eyelash, eyelashes, lashes → lash; thread, threaded →
threading; tint, tinted → tinting. Apply them to queries and catalog names.
Five existing phrase aliases remain after removing redundant entries. No new
waxing, lamination slang, perm, facial, or other service vocabulary is added.

| Alternative | Assessment for this change |
| --- | --- |
| Prompt-only synonym instruction | No additional model call, but depends on the model consistently rewriting tool arguments; the matcher still rejects raw variants. |
| A separate AI/embedding matching request | Adds another request/dependency and is unnecessary for four small word families. Not implemented or benchmarked. |
| A large literal phrase list | Local and fast, but repeats equivalent phrases and grows with wording variations. |
| Small local normalization map | Selected: deterministic, reuses existing matching, no new API call or prompt tokens. |

This is consistent with OpenAI's recommendation to avoid unnecessary requests and
use traditional code when sufficient:
https://developers.openai.com/api/docs/guides/latency-optimization

Ten known conversational words can be removed only from brow/lash queries and only
when the remaining words fully name a service or existing alias. Unknown treatment
words and negations survive. Fable's catalog-vocabulary filter is excluded.
Bare threading/tinting/lashes remain ambiguous when the catalog contains alternatives.
Equivalent names on different service IDs also return ambiguity. The mock catalog
now uses the real Brow Threading name, removing the fictitious duplicate that had
masked the original bug.

## Validation

- 568 tests across 48 files passed with dummy credentials; TypeScript build and
  formatting checks passed. The initial isolated test run lacked required dummy
  configuration; the corrected run uses the documented fake OpenAI/Twilio settings.
- Seventeen phrase contracts pass against the saved September 8, 63-service catalog.
  All 63 full catalog names still resolve to their exact original service IDs.
- Existing call-handler regressions continue to return actual availability for
  eyebrow-threading wording. No calls or appointments were created for this evaluation.
- Local benchmark: 1,500 warmups per version, 20,000 measurements per version,
  alternating version order across four rounds, identical phrase mix and catalog.

| Matching only | Deployed baseline | Focused candidate |
| --- | ---: | ---: |
| Mean | 0.123 ms | 0.180 ms |
| Median | 0.155 ms | 0.141 ms |
| 95th percentile | 0.164 ms | 0.385 ms |

Average added local matching cost is approximately 0.056 ms. These are local
warm-catalog measurements, not production call/audio/network latency. No added
OpenAI or Phorest request is introduced; listServices retains its existing cache.
Artifacts and the runnable benchmark are in this worktree's untracked `outputs/`.
Grow the vocabulary only for demonstrated production misses with regression cases.
