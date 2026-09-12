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
- [ ] P0 simulated side-effect boundary.
- [ ] P1 Live adapter, prompts, actual API and audio checks.
- [ ] P2 caller context.
- [ ] P3 canonical service IDs.
- [ ] P4 simulated proposals/messages and evidence.
- [ ] P5 hosted owner-ready test and comparison evidence (human acceptance pending).
