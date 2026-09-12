# Simulation boundary handoff

## Delivered

- `src/config/env.ts` validates `PHOREST_WRITE_MODE=real|simulate`,
  `OWNER_SMS_MODE=real|simulate`, `VOICE_ENGINE=realtime|live`, and the exact
  Live backend model IDs. `OPENAI_LIVE_BACKEND_EFFORT` is optional. Exported
  `isVoiceTestMode()` derives dynamically from `PHOREST_WRITE_MODE` so tests
  and comparison variants do not retain an import-time safety value.
- `VOICE_ENGINE=live` with real Phorest writes rejects at startup. The default
  backend is `gpt-5.6-terra` and default effort is omitted.
- `src/services/phorest.simulated.ts` adds a process-wide overlay plus
  `resetSimulatedPhorestOverlay()`. It delegates reads, keeps every create,
  update, cancel, and note local, creates `sim_client_*`/`sim_appt_*` records,
  merges simulated appointments and real-record mutations into appointment
  lists, and never gives simulated IDs to real read methods.
- `src/services/phorest.ts` selects that overlay when the write mode is
  simulated, independent of voice engine.
- Owner SMS short-circuits to a typed `{ queued: true, simulated: true }`
  result in either simulation condition. Digest scheduling and blocklist
  persistence are disabled whenever `isVoiceTestMode()` is true.

## Evidence

- `npx vitest run src/tests/phorest.simulated.test.ts src/tests/ownerSms.test.ts src/tests/blocklist.test.ts src/tests/digest.test.ts`: 48 tests passed.
- `npm test`: 52 test files / 600 tests passed.
- `npm run build` passed; `git diff --check` passed.
- New overlay tests prove no underlying create/update/cancel/note function is
  called, cover unknown simulated IDs, overlay client lookups, simulated
  appointment mutation/cancel, real-record overlay mutation/cancel, and reset.

## Integration notes and limits

- Parent should call `resetSimulatedPhorestOverlay()` between comparison
  variants and use `isVoiceTestMode()` for transfer/failover gates.
- The overlay deliberately delegates ordinary Phorest reads. It has no
  persistence and clears on process restart.
- No live API, Phorest write, phone call, or deployment was performed.
