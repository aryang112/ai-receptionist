# September 10 reopening — deployed September 9, 2026

Aryan requested removal of the expired away/closed notice before September 10.
The existing system prompt already stops injecting the September 1–9 notice at
midnight America/New_York. Investigation found a separate stale-data path:
get_business_hours returned every configured closure, including expired dates
and the old public explanation. This release closes that path.

## Exact production release

- Source: `0b70df63d3f429d64296db3b7208ae977154a338`.
- Branch: `codex/reopening-cleanup-2026-09-09`, pushed to origin.
- Railway: `24184059-17cf-4ba1-a80d-92aab7684013`, SUCCESS.
- Image: `sha256:a527c7a38a32925deb08acaae1b443ab3ec789bdd2652fb13fd0141af15a8bbd`.
- Deployed at approximately 11:44 PM ET on September 9, before the local
  midnight reopening-date transition.
- Rollback source: `bc39b09ecdcc4a3d12146f91ae93f8143792742e`;
  previous deployment `ee43e7fe-9fd0-4dd7-9dcf-f907c6cfcd1a`.
- Worktree: `/Users/aryangupta/Documents/Dev/ai-receptionist-reopening-2026-09-09`.
- Uploaded a clean archive: all 139 files byte-verified against the commit.
  No local probe scripts, outputs, node_modules symlink, or credentials uploaded.

## Change

Only the get_business_hours handler in src/realtime/twilioStream.ts changes
runtime behavior. It excludes closure entries whose final date is before today
in the salon timezone. It retains active closures through their last local day,
and keeps future closures. With no remaining closure, the tool note directs a
brief answer from current status and regular hours, without commentary about
staff absences or reasons for closure.

business.json remains unchanged and authoritative. Base prompt generation,
session fields, model, voice, matching, bookings and transfer implementation are
unchanged. The eyebrow-tattoo alias candidate is separate and NOT included.
Nearby-date search is still a proposal, not a deployed feature.

## Tomorrow's verified behavior

| Eastern time | Temporary closure | Salon hours | Transfer window |
|---|---|---|---|
| September 9, 11:59:59 PM | Still active | Closed for closure | Unavailable |
| September 10, midnight | Expired; no old reason in hours response or current prompt status | Opens at noon | Unavailable before 9 AM |
| September 10, 9 AM | None | Opens at noon | Available |
| September 10, noon | None | Open noon–7 PM | Available |
| September 10, 9 PM | None | Closed after regular business hours | Unavailable |

The generated current-status block no longer includes the old return-date story
on September 10. General conditional rules for future closures remain; they are
not an active absence announcement. New calls build their initial prompt from
the current salon date; no midnight deployment or server restart is needed.

## Validation

- 572 tests / 49 files passed using the existing CI dummy credential environment;
  TypeScript build, changed-file formatting and git diff checks passed.
- Four new regressions cover the last Eastern second (already September 10 UTC),
  Eastern midnight expiry, future-closure retention, and reopening prompt/transfer
  status. Existing temporary-closure and business-hours checks still pass.
- Live Realtime model probes used September 10 noon, the exact candidate prompt
  and actual hours-handler result, with business tools simulated and telemetry
  disabled. Hours replies gave noon–7 PM; speak-with-Richa requests called the
  simulated transfer tool. No real phone call, transfer, SMS or booking was made.
- Early probes exposed extraneous generalizations about staff absence and salon
  hours. The empty-closure note was narrowed. Final probes did not claim the
  salon was closed or Richa was away. Some unnecessary privacy/transfer wording
  remained in the direct-answer path; this release does not claim a general
  conversational polish fix. Probes were text input/audio-transcript output,
  not human listening or a PSTN ear test; session/audio transport is unchanged.
- Zero queued, ringing or in-progress Twilio calls immediately before upload.
  Release occurred after normal business hours under the user's request to
  ensure the notice is gone before tomorrow.
- After deployment, five running-container source hashes matched the archive:
  twilioStream, openaiSession, booking, phorest.client and business.json.
- The compiled code inside a separate diagnostic process was checked at all
  five timestamps above. Its simulated Luxon clock and telemetry stub affected
  only that diagnostic process, not the live server, system clock or call ledger.
  An initial diagnostic used a different Luxon module instance and therefore
  failed to simulate time; the corrected ESM import passed all checks.
- New container warmed 63 services and a complete 4,187-client / 28-page phone
  index (`incomplete=false`). Health and protected admin returned 200, with zero
  new warning-ring entries across seven checks over one minute. Final smoke at
  11:46 PM ET: health/services/authenticated admin 200, unauthenticated admin
  401, 63 services.

Private evidence: `outputs/reopening-2026-09-10/` in the main workspace contains
the pre/post-deploy prompt checks, original/final model probe outputs, source
hash manifest, active-call snapshot, startup logs and health samples.

## Outstanding unrelated work

The daily call review's booking approval gap, generic microblading/touch-up
matching, nearby-date availability, and hangup/close reporting remain separate.
Main still contains unreleased drafts. Do not deploy main as production parity.
