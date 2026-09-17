# Appointments and writes (single-appointment, Live path)

**Purpose.** The single-appointment book/reschedule/cancel path on
`VOICE_ENGINE=live`: a two-step prepare→confirm proposal instead of raw
write tools, plus the identity and freshness gates that keep a real write
from hitting the wrong slot or the wrong client.

**Key code:**
- `src/voice/appointmentProposals.ts` — `AppointmentProposals` class:
  immutable prepare/confirm proposal, approval barrier, unknown-outcome
  latch (an uncertain real write blocks further action on that call).
- `src/realtime/twilioStream.ts`:
  - `prepare_appointment_action` / `confirm_appointment_action` — the tool
    pair; only path to a single-appointment write on Live.
  - `handleBookAppointment` — includes the A1 fresh re-check immediately
    before every booking WRITE (rejects a stale slot against the current
    list; fail-open on Phorest errors, logs "rejected — time no longer
    available on fresh re-check").
  - `hasPhoneMatchedClient` / `isLiveRealWrite` — identity gates: on the
    real-write Live path, a write is only allowed for a client whose phone
    was actually matched — never a model-supplied client ID.
  - `servedAppointmentIds` — ownership guard; an appointmentId must have been
    server-resolved (list_appointments/lookup) before it can be acted on.
- `env.ts` `PHOREST_WRITE_MODE` — real vs simulate; independent of
  `OWNER_TRANSFER_MODE`/`OWNER_SMS_MODE` (those guard communications, this
  guards the calendar).

**Guarded by:**
- `appointmentProposals.test.ts` — prepare/confirm/latch unit coverage.
- `liveProposalIntegration.test.ts` — proposal pair wired into a Live call.
- `liveRealWrites.test.ts` — real-write mode identity/verification behavior.
- `twilioStream.booking.test.ts` — book_appointment end-to-end.
- `twilioStream.freshCheck.test.ts` — A1 stale-slot rejection + fail-open.
- `twilioStream.slotIntegrity.test.ts` — no invented times reach a write.

**Traps:**
- 2026-09-15: the fresh re-check protects the SLOT, not the caller's INTENT —
  a same-client double-booking guard does not exist yet (backlog item).
- The A1 re-check is a re-run of `fetchOpenSlots` (see `availability.md`), so
  a change there changes write safety too — re-run `sim-availability.ts`
  after touching either.
- On the Live real-write pilot, `OWNER_TRANSFER_MODE`/`OWNER_SMS_MODE` stay
  independently simulated even when `PHOREST_WRITE_MODE=real` — do not
  assume one flag implies the other.
- 2026-09-15: "verify capability claims by running them" — a claim like "can
  she move three appointments" needs an actual test; reading the code missed
  a real ordering bug in the visit planner.

**Verify:**
```bash
npx vitest run src/tests/appointmentProposals.test.ts src/tests/liveProposalIntegration.test.ts src/tests/liveRealWrites.test.ts src/tests/twilioStream.freshCheck.test.ts
npx tsx scripts/sim-availability.ts <date>
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/admin/voice-test   # confirm writes mode before testing live
```

**Do not:**
- Let a tool write using a clientId that didn't come from `hasPhoneMatchedClient`
  or `servedAppointmentIds` on the real-write Live path.
- Skip the A1 fresh re-check "because suggest_availability already checked" —
  the whole point is the slot may have changed since.
- Treat an uncertain real-write outcome as success — the latch in
  `AppointmentProposals` exists to stop further action, not to be bypassed.
