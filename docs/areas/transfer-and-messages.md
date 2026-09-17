# Transfer and owner messages

**Purpose.** Get a caller to Richa (live dial, within her calling window) or
take a message for her — including the after-hours/vacation closure policy
and the failover path when something goes fatally wrong mid-call.

**Key code** — `src/realtime/twilioStream.ts`:
- `handleTransferToOwner` — `transfer_to_owner` tool handler. A timed
  `<Dial>` with an `action` callback to `/twilio/dial-status`; the
  TEMPORARY CLOSURE gate returns `{transferred:false, messageRequired:true}`
  with no dial at all during an active salon closure.
- `handleLeaveMessageForOwner` — `leave_message_for_owner`; takes NO
  model-authored content, delivers only exact caller transcript text
  correlated by OpenAI item ID (never a generated summary).
- `richaLine` — precomputed "Richa is ..." status line, built from the SAME
  closure/hours truth as the rest of CURRENT STATUS (never re-derived).
- `failoverToOwner(reason)` — the emergency path on a fatal error; dials the
  owner directly via Twilio REST, independent of the transfer tool; does
  NOT fall back to Realtime (confirmed 2026-09-16 — Realtime removal changes
  nothing about this path).
- `env.ts` — `TRANSFER_WINDOW_START`/`TRANSFER_WINDOW_END` (Richa's calling
  window, default 09:00–20:00, distinct from salon opening hours),
  `OWNER_TRANSFER_MODE`, `OWNER_SMS_MODE` (independent simulate/real
  switches — see `appointments-and-writes.md` for how `PHOREST_WRITE_MODE`
  is a THIRD, separate switch).

**Guarded by:**
- `twilioStream.transferHours.test.ts` — owner calling window gating.
- `twilioStream.transferFailback.test.ts` — timed dial + `/dial-status`
  action URL, bare-dial fallback, no duplicate start/recording rows.
- `twilioStream.failbackWiring.test.ts` — the failback reconnect wiring.
- `twilioStream.ownerMessage.test.ts` — exact multi-turn message capture,
  offer-vs-content consent, item/content dedupe, abandonment/correction races.
- `twilioStream.vacation.test.ts` — closure gate on transfer + messages.

**Traps:**
- A salon closure (business.json `vacations`) and one provider's personal
  absence are DIFFERENT facts (2026-09-02 lesson) — do not let a
  single-stylist's day off trigger the salon-wide closure policy.
- `TRANSFER_WINDOW_END` and `OWNER_TRANSFER_MODE=real` are CURRENTLY set to
  temporary taste-test values (`23:00` / `real`) in production — revert once
  Aryan finishes the transfer-fail test (tracked in `tasks/backlog.md`); do
  not assume the `.env`/CLAUDE.md-documented defaults are what's live.
  Verify via `GET /admin/voice-test`, never assume from source.
- A fatal error inside the transfer window ALSO dials Richa, not just a
  deliberate `transfer_to_owner` call — don't reason about this path as
  "only when the model chooses to transfer."
- Owner messages must stay separate from generated call recaps (2026-09-03
  lesson) — an exact caller message is never paraphrased.

**Verify:**
```bash
npx vitest run src/tests/twilioStream.transferHours.test.ts src/tests/twilioStream.transferFailback.test.ts src/tests/twilioStream.ownerMessage.test.ts src/tests/twilioStream.vacation.test.ts
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/admin/voice-test   # confirm live OWNER_TRANSFER_MODE/window before testing
```

**Do not:**
- Dial Richa's real phone in a test without confirming `OWNER_TRANSFER_MODE`
  first — it may currently be `real`, not `simulate`.
- Let `leave_message_for_owner` pass through any model-generated text as the
  message body — exact transcript only.
- Assume the closure policy and the transfer gate read different truths —
  both derive from `getActiveOrUpcomingVacation()`/`getVacationForDate`.
