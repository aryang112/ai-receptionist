# Short, natural availability offers

The owner reported Erica reading a long list of Monday appointment times. The shared availability handler returns up to ten real choices, spread across the day or selected near the requested time. Its prior result note required valid times but imposed no spoken limit. Live also had no explicit limit for spoken appointment options.

## Change

The shared availability result now instructs Erica to offer at most three choices per reply, then ask which works and wait. A matching exact-time request gets one confirmation. Otherwise, prioritize the stated time or part of day; without a preference, spread the choices across the returned day. Read individual starts, never imply an unverified continuous range. Offer other returned choices when the caller asks or rejects the initial options. Live's speech prompt reinforces the three-time maximum.

The existing returned slots and booking checks are retained. A time absent from the sampled result is not necessarily unavailable: recheck using the existing preferredTime argument before rejecting it. This also replaces the old misleading instruction that every unlisted time was closed. No extra service, slot-ranking subsystem, API session field, or mandatory network request was added.

## Validation

- 676 tests / 61 files pass; TypeScript build and whitespace checks pass. The existing Live prompt size check remains within its 900-token estimate ceiling.
- Local actual Live + Terra replay with real Phorest reads: the tool returned ten Monday Brow Threading slots. Erica initially offered noon, 2:30 and 4:30; on request, offered 12:15, 3:00 and 4:15; then confirmed 12:15 individually. No appointment was written. The model still used brief checking narration, and after the exact-time question it moved into contact collection; these are separate conversation-quality items, not fixed by this focused change.
- Runtime source `52610e0`, Railway release `da9b8e45-4d13-472b-a6ba-be75a7ca76e6` SUCCESS, created September 12 at 7:40 PM Eastern. Four running source/build hashes match the tested worktree. Application and Twilio had zero active calls immediately before upload.
- Hosted actual Live + Terra replay `CA_probe_1789256516630`: initial choices 12, 2:30 and 4:15; alternatives 12:15, 3:00 and 4:45; exact-time answer confirmed 12:15 on Monday for eyebrow threading. One successful suggest_availability call served the whole conversation. No appointment action occurred. The harness ended the call after 85 seconds. Final hosted status: healthy, zero active calls, Live + Terra, two approved callers, writes and owner notifications simulated.
- Scenario, timing summaries and transcripts are saved under `outputs/live-taste-test/availability-presentation/`. Brief checking narration also appeared in the hosted replay; this release addresses the excessive availability list.
- This is model presentation guidance, not a deterministic audio-output cap. Owner handset listening remains the acceptance check for conversational delivery.
