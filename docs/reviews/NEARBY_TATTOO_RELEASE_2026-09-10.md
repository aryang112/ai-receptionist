# Nearby availability and eyebrow tattoo — deployed September 10, 2026

Aryan authorized packaging the nearby-date behavior with the eyebrow-tattoo
entry in the existing matcher and deploying both. Production source is
`8533e61c1bebaac51b16d49c3cdfb355e187c582` on
`codex/nearby-dates-tattoo-2026-09-10`, based on the production reopening release.
Railway deployment `c71fcdd2-5ec2-4ed8-b353-bad1df386848` succeeded around
12:41 AM Eastern. Image:
`sha256:f2c735078737d77aa5907cbcda9c3a05f9e729116585c330ed66bb13c4db433e`.
Rollback source: `0b70df63d3f429d64296db3b7208ae977154a338`.

## Behavior

- Existing `TOKEN_SYNONYMS` plus one `SERVICE_ALIASES` entry maps eyebrow tattoo,
  brow tattoo, and eyebrows tattoo to full **Micro Blading/ Shading**, $500,
  240 minutes. Threading and explicit touch-ups retain their identities. The
  tattoo test file is regression coverage, not a separate runtime matcher.
- An empty requested date automatically checks the next seven calendar days,
  skipping salon closures, using the existing Phorest/zone/grid/duration pipeline.
  It returns up to three dates with up to three actual start times each, favoring
  the requested time or spreading choices across the day. Dates/times are live
  data, not hardcoded appointments.
- Nonempty requested dates make no extra availability requests. Two nearby reads
  run at a time. The additional wait budget defaults to 2,500 ms; timed-out reads
  may finish privately but cannot publish late offers or change the offer cache.
  Partial results remain usable; failures are not represented as fully booked.
- The optional `searchNearby:false` tool argument preserves explicit caller date
  restrictions. It survives argument validation, suppresses nearby reads, and
  coaches Erica not to push another date unless the caller relaxes the restriction.
- Nearby offers use canonical service keys in the existing booking gate. The
  existing fresh availability check still runs when a caller chooses an offer.
- `NEARBY_AVAILABILITY_DAYS` defaults to 7 (bounded 1–14) and
  `NEARBY_AVAILABILITY_BUDGET_MS` to 2500 (bounded 250–5000). These are search
  bounds; service durations and hours remain authoritative existing data.

## Prompt and latency

The main prompt replaces one existing tool-guidance line: 217 → 216 characters,
**zero added lines**. The optional tool parameter has a short description;
state-specific coaching travels with the result. No session/model/voice change.
The existing prompt token ceilings passed without being raised.

Three read-only real-Phorest baseline/fallback pairs measured 456/743 ms,
76/433 ms, and 62/361 ms. The two warmed pairs added 357 and 299 ms. The deployed
container's real complete fallback took **442 ms**. These are availability-tool
measurements, not end-to-end telephone latency or a percentile guarantee. The
2.5-second ceiling bounds the additional nearby wait, not the original request
or model speech generation. Real four-hour availability at verification returned
September 17 at noon, 12:15 and 12:30; that snapshot will change with bookings.

## Verification

- **592 tests / 51 files**, TypeScript build, formatting, and diff checks passed.
  Thirteen new handler tests cover successful-day cost, opt-out validation,
  duration/closure filtering, canonical cache keys, time preference, search
  horizon, failed reads, timeout/late results, disconnects/concurrency, and
  stale chosen-slot rejection. Seven tattoo matcher tests passed.
- GitHub Actions run `34437932885` passed for the exact source commit:
  https://github.com/aryang112/ai-receptionist/actions/runs/34437932885
- All 63 live catalog names retained exact identities; seven alias/wording
  checks passed. Live Realtime accepted the tool schema. Three synthetic
  text-input/Marin-audio scenarios exercised real handler code with a saved live
  availability snapshot or controlled multi-date fixtures. Erica directly offered
  available dates/times. A first restricted-date probe exposed an unwanted
  another-date question; the corrected probe preserved the restriction.
- Automated audio review with `gpt-audio-1.5` heard the intended dates/times and
  described the two offer recordings as clear and evenly paced. The first audio
  assessment request returned a provider model error; a simpler retry succeeded.
  This was automated audio review, not human listening or a real Twilio call.
- Zero queued, ringing, or active calls immediately before deployment. The clean
  git archive contained 142 files, all byte-verified. Seven running-container
  source hashes match the release, including unchanged session, Phorest adapter,
  and business.json. Compiled live matcher, live availability, simulated
  three-date results, restriction behavior, and reopening state all passed.
- Production warmed 63 services and all 4,187 clients over 28 pages, with
  `incomplete:false`. Seven health/admin-log samples over one minute returned
  HTTP 200 and zero warnings; services/admin smoke checks passed, including
  HTTP 401 for unauthenticated admin access.

The September 10 reopening cleanup remains deployed: hours noon–7 PM and no
expired away notice. Existing sequential phone-first/name-second flow is
preserved. Broader microshading matching, final booking readback/approval,
reporting fixes, and unrelated main-branch drafts are separate pending work.
No real appointment, telephone call, or owner message was created by these probes.
The first real caller interaction with the new fallback remains unobserved.

Rollback if source verification, core health, service identity, or valid-date
selection fails: redeploy a verified clean archive of `0b70df6`; do not bulk-deploy
main. Local evidence and synthetic recordings are in
`outputs/nearby-2026-09-10/` (untracked). The release worktree also retains the
read-only and voice probe scripts under its `outputs/` directory.
