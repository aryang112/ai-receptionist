# GPT-Live implementation coordination

Authorized September 12: Aryan asked Codex to own implementation, use workers and deploy as necessary. Customer intake stays disabled; owner listening remains an external acceptance step. No real customer writes or owner notifications during the taste test.

Workspace: `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`, branch `codex/gpt-live-taste-test`, baseline `8533e61`. Baseline: 592 tests / 51 files and build pass. Main checkout has unrelated dirty work; do not edit it.

## Ownership

- Parent: controller integration (`twilioStream.ts`), routes/engine selection, canonical service seam, simulated proposal flow, final review/deployment. Owns this file and state.
- Live worker (Sol): new `src/voice/liveSession.ts`, protocol/audio helpers and own tests. Do not edit controller/env/prompts.
- Simulation worker (Terra): `src/services/phorest.ts`, new simulated Phorest wrapper, ownerSms/blocklist/digest boundaries, `src/config/env.ts`, own tests. Do not edit controller/routes/CallStore.
- Prompt worker (Luna): new `src/voice/livePrompts.ts`, rendering script and own tests. Do not edit production prompt/controller or other workers' files.

Workers post their own `tasks/handoffs/<role>.md` with decisions, files, test evidence and limitations. Send direct messages for dependency decisions and blockers; parent records shared decisions here. No nested agents, external messages, deployment, real Phorest writes or phone calls from workers. Commit only owned files. Report unrelated test/build failures rather than editing someone else's work.

## Agreed boundaries

- Use a Live session adapter inside existing controller, with explicit Live branches; do not assume energy segments mean turn completion or playback.
- Live worker exports `OpenAILiveSession` with existing session methods where meaningful: connect/configureSession/registerTool/injectContext/requestGreeting/requestResponse/appendTwilioAudio/close. Configuration can add liveInstructions/backendInstructions/backendModel. Realtime-specific methods must be explicit compatibility no-ops, not silent evidence assertions. Communicate additions before integration.
- Live options extend existing handler callbacks with explicit `onOutputSpeechStarted`, `onOutputSpeechStopped`, and `onLiveUsage` if needed; continuous silence must not keep playback busy. Parent owns actual Twilio marks/clear/drain behavior.
- Simulation settings: `PHOREST_WRITE_MODE=real|simulate`, `OWNER_SMS_MODE=real|simulate`, `VOICE_ENGINE=realtime|live`, `OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-terra|gpt-5.6-luna`, optional backend effort default omitted. A single derived `isVoiceTestMode` (Phorest simulate) must force owner SMS/digest/blocklist/transfers safe even if secondary setting is omitted. Live real writes forbidden until later acceptance. Parent handles transfer/fatal dial gates and test-only inbound allowlist.
- Simulation overlay process-wide, explicitly reset between comparison variants. Must overlay client lookup too for newly simulated clients and never leak sim IDs to real reads. Preserve real return shapes.
- Prompt functions accept pre-rendered production instructions + compact catalog/current public facts, avoiding import cycles with controller. Send chosen signatures to parent. Strip Realtime-only procedure lines, preserve salon policy, dedicated proposal-tool instructions added by parent if needed.
- No separate visit planner in first test. Backend gets actual catalog IDs, existing read tools and simulated actions. Identity mismatch/loading/error remain truthful even if full revision engine deferred.
- Keep store:false, default backend effort initially; validate both actual first delegations. Never assume test/default retention or audio safety from a flag.
- Protocol probes run centrally/sequentially to avoid shared rate limits. Workers may fetch official documentation, but no billed API probes without notifying parent.

## Progress

- [x] Verified production baseline and isolated worktree.
- [x] P0 simulated side-effect boundary.
- [x] P1 Live adapter, prompts, actual API and synthetic audio checks (human listening pending).
- [x] P2 caller context.
- [x] P3 canonical service IDs.
- [x] P4 simulated proposals/messages and evidence.
- [x] P5 hosted owner-ready test and comparison evidence (human acceptance pending).

## Integration review and real-model findings

- Full source suite at milestone: 655 tests, 61 files, TypeScript build passing.
- Both Terra and Luna have completed actual Live backend delegations through the full controller and real read-only Phorest. Terra resolved the brow/lip bundle and offered real dates/times; Luna quoted its $23 price. Hours answered directly without backend usage.
- Fixed observed premature contact collection before availability. Goodbye-only probe exposed missing frontend delegation; prompt worker is correcting it before final phone checks.
- Live keeps its continuous stream during interruption; it does not clear Twilio then resume the same segment. Acoustic segment boundaries plus unique Twilio marks govern playback; these are not proof of complete semantic turns.
- Caller account context goes only to backend; loading, clean miss and failed lookup remain distinct. Raw transcript fragments retain timing offsets and are approximate; simulated messages are model-relayed.
- New authenticated bearer-only /admin/voice-test endpoints switch idle calls among Terra, Luna and Realtime and reset the simulated overlay. Settings are in-memory and restart returns to deployment defaults.
- Test records have separate admin test views and are excluded from normal ROI/digests; optional post-call Responses summaries are completely suppressed in test mode.
- Before deployment, actual Railway runtime is still the recorded 8533e61 release. Twilio has no in-progress calls; its number still points to the existing Railway webhook. External forwarding is not changed.

## Completed engineering handoff — September 12

- Final validation: 662 tests / 61 files, TypeScript build and whitespace checks pass.
- Runtime `254499c` deployed as Railway `8d932448-3b96-4c7d-9bca-40ed46aa6519`; six local/container hashes agree. Documentation-only commits after this source do not require another release.
- Hosted synthetic Terra, Luna and Realtime comparisons all quoted the correct $23 brow/lip bundle. Default restored to Terra; simulated overlay reset; zero active calls; two approved callers. Unauthorized variant requests and unapproved callers rejected.
- Ten normal synthetic greeting probes include recording disclosure; direct hours uses no backend; seven-second read delay recovers; bare Richa availability asks appointment vs. speaking clarification. Closing has explicit farewell evidence and playback drain guards. Final repeated partial goodbye fragment remains NEEDS LISTEN.
- Owner handset/speakerphone acceptance remains pending. No real booking, SMS, transfer, or unsolicited owner call was made. Release report and guide contain the remaining scenarios and limitations.
