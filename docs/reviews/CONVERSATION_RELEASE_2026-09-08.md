# Conversation consistency production release — September 8, 2026

Status: DEPLOYED AND VERIFIED; Railway SUCCESS. Five-minute production
observation completed with 31 healthy samples and zero warnings.

## Release identity

- Exact deployed source: `bc39b09ecdcc4a3d12146f91ae93f8143792742e`.
- Release branch: `codex/conversation-consistency-2026-09-08`.
- PR: https://github.com/aryang112/ai-receptionist/pull/4 (targets the previous
  production branch, deliberately excluding main's unreleased drafts).
- Railway deployment: `ee43e7fe-9fd0-4dd7-9dcf-f907c6cfcd1a`.
- Image: `sha256:ed4fc5b03e2e642aca62e586a7ef10da938c1adaf22959b1b004a1d6c3602686`.
- Container started 23:18:58 UTC; complete client index at 23:19:04 UTC
  (approximately 7:19 PM ET).
- Rollback source: `fcee0d8ca23304918167fe31102f7ef2813e493e`; redeploy a clean
  archive of that source. It retains today's email integration and synonym fixes.
- User explicitly authorized implementation, tests, production deployment,
  GitHub updates, smoke/sanity checks, and project documentation in this session.

## Changes

Only existing instructions in `src/realtime/twilioStream.ts` changed runtime behavior:

1. CLOSE honors a settled ending and the specific non-client ending rules.
   Message-success coaching uses the same rule. Interrupted/pending closing notes
   no longer independently insist on an additional question. The existing
   tool-only end_call and result-owned farewell remain intact.
2. Booking name description reuses a complete supplied or identified-account name;
   IDENTIFY asks for missing name parts. Number confirmation still precedes name
   collection, with a separate WAIT between them. Identity verification remains.
3. TOOLS owns one safe retry limit. Availability/list recovery notes stop after
   the second failure and only offer transfer when current status permits it;
   otherwise they offer a message. Uncertain writes and no-retry results remain
   non-retryable. No runtime retry mechanism or state machine was added.

Live evaluation exposed another ambiguity in the same booking contract: the name
instruction's old “continue without a ritual” could skip the existing appointment
approval step. It now explicitly means no redundant NAME confirmation, and the
booking description requires exact service/date/time approval after contact
collection. This preserves the existing intended booking safeguard.

No application control flow, session configuration, model, voice, dependencies,
Phorest adapter, matcher, business hours, or forwarding setting changed. The
runtime diff is 12 changed instruction lines. Test/probe/CI additions are
engineering tooling and are not imported into the running application.

## Validation before production

- 568 regression tests in 48 files passed; TypeScript build and changed-file
  formatting passed. The prompt remains under its existing limit (~4,195 tokens
  using the project's characters/4 estimate); no limit was raised.
- GitHub Actions test/build passed with dummy credentials:
  https://github.com/aryang112/ai-receptionist/actions/runs/34289914016
  PR validation also passed:
  https://github.com/aryang112/ai-receptionist/actions/runs/34290078765
- Eight live `gpt-realtime-2.1` scenarios passed saved-output assertions: settled
  goodbye, message+goodbye, job inquiry, supplied name, sequential new contact,
  two failed reads, uncertain message, and a new request after a closing offer.
- Three spoken-input scenarios passed: goodbye, message+goodbye, and complete
  booking contact/read-back/approval flow. Synthetic speech was streamed as
  8 kHz mu-law through the live Realtime API using Marin output.
- Automated listening with `gpt-audio-1.5` evaluated the actual saved audio for
  intelligibility, clipping, repeated questions/farewells, and booking approval.
  Final clips passed. This is automated audio evaluation, not an owner ear test
  or a PSTN carrier call. Inserted harness gaps do not measure production latency.
- Initial probes caught premature booking approval and were retained as failures;
  the final name/booking contract reruns passed. Concurrent synthetic probes also
  hit the shared API TPM limit; final affected cases were rerun after spacing
  requests. This was test traffic, not a Railway incident.
- Business tools in the probes were simulated. No real appointment, message to
  the owner, phone call, or customer-record write was created by these checks.

Reproduce from this release checkout (load credentials without copying .env into
an archive):

```sh
node --env-file=/absolute/path/to/.env --import tsx scripts/probe-conversation-consistency.ts
node scripts/check-conversation-probe.mjs outputs/conversation-consistency/results.json
```

Use `PROBE_CASES` (comma-separated scenario names), `PROBE_OUTPUT`, and
`AUDIO_INPUT=1` for focused reruns. Audio input requires macOS `say` and ffmpeg.
Probe business tools are canned, and the fixed September 8 clock makes this a
historical regression replay. Full customer recordings are not used.

## Deployment and production smoke

- Zero queued/ringing/in-progress Twilio calls immediately before upload.
- Clean git archive: 138 tracked files byte-checked against the commit; no .env,
  local outputs, node_modules, call data, or untracked AGENTS.md uploaded.
- Railway running-container source hashes match the release for twilioStream,
  openaiSession, booking, phorest.client, and business.json. Compiled prompt/name
  contracts also checked inside the container.
- Runtime configuration verified: gpt-realtime-2.1, Marin, real Phorest,
  gpt-4o-mini-transcribe, and existing owner recaps enabled.
- Warmed 63 services and 4,187 clients across 28 pages, incomplete=false.
- HTTP 200: health, services, protected stats, protected warning logs.
- Unauthenticated admin access returns 401.
- Signed Twilio /voice returns valid Connect/Stream TwiML with a stream token.
- Production media WebSocket upgrade succeeds; no synthetic start/media event
  was sent, so no fake call row, recording request, or recap was created.
- Twilio's inbound webhook still points to the production Railway /twilio/voice.
- Compiled matching in production: eyebrow threading -> Brow Threading;
  lash tinting -> Lash Tinting; henna brows -> notOffered.

Detailed private operational evidence is untracked in main's
`outputs/conversation-deployment-2026-09-08/`. Probe results/audio are untracked in
the release worktree's outputs directories. Source hashes and deployment IDs
above are sufficient to identify and reproduce the exact released code.

## Handoff and remaining scope

Start future production work from this release, not main. Main still contains
older unreleased broad matching, combined-contact, silent-wait, and other review
work. Do not bulk-deploy it. The held service-knowledge PR #3 and transfer outcome
ordering work are separate. No new follow-up automation was created.

First natural caller use and carrier-specific pacing/interruption behavior remain
unverified by these synthetic tests. Some optional procedural preambles still
appear in model probes; this release does not claim to eliminate all verbosity.
Rollback if production shows session rejection, broken call entry, incorrect
writes, or a material new failure attributable to this release.

## Final observation and GitHub marker

- Observation: 23:20:00.707–23:25:03.711 UTC (September 8): 31/31 health
  and protected admin checks returned HTTP 200; warning count remained zero.
- Final sanity at 23:25:18 UTC: health/services/admin HTTP 200, 63 services,
  zero active Twilio calls, zero warnings. No natural caller reached the new
  release during this check, so no production voice-latency claim is made.
- Annotated GitHub tag `production-2026-09-08-conversation` points to the exact
  deployed source `bc39b09`, not a later documentation or merge commit.
- Release/handoff documentation is synchronized in the production worktree
  and main. Main application code remains a separate unreleased working line.
