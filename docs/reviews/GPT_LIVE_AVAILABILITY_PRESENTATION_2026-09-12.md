# Short, natural availability offers

The owner reported Erica reading a long list of Monday appointment times. The shared availability handler returns up to ten real choices, spread across the day or selected near the requested time. Its prior result note required valid times but imposed no spoken limit. Live also had no explicit limit for spoken appointment options.

## Change

The shared availability result now instructs Erica to offer at most three choices per reply, then ask which works and wait. A matching exact-time request gets one confirmation. Otherwise, prioritize the stated time or part of day; without a preference, spread the choices across the returned day. Read individual starts, never imply an unverified continuous range. Offer other returned choices when the caller asks or rejects the initial options. Live's speech prompt reinforces the three-time maximum.

The existing returned slots and booking checks are retained. A time absent from the sampled result is not necessarily unavailable: recheck using the existing preferredTime argument before rejecting it. This also replaces the old misleading instruction that every unlisted time was closed. No extra service, slot-ranking subsystem, API session field, or mandatory network request was added.

## Validation

- 676 tests / 61 files pass; TypeScript build and whitespace checks pass. The existing Live prompt size check remains within its 900-token estimate ceiling.
- Local actual Live + Terra replay with real Phorest reads: the tool returned ten Monday Brow Threading slots. Erica initially offered noon, 2:30 and 4:30; on request, offered 12:15, 3:00 and 4:15; then confirmed 12:15 individually. No appointment was written. The model still used brief checking narration, and after the exact-time question it moved into contact collection; these are separate conversation-quality items, not fixed by this focused change.
- Hosted replay and release verification: pending below.
- This is model presentation guidance, not a deterministic audio-output cap. Owner handset listening remains the acceptance check for conversational delivery.
