# Area briefings

Short per-area files so an agent working one part of the call stack reads
~1k tokens for that area instead of hunting through `twilioStream.ts` (7,000+
lines) or `state.md`. Each file: purpose, key symbols (by name, not line —
line numbers go stale; `docs/SYMBOLS.md`, the generated symbol index, has
line numbers), the tests that lock it, dated traps, verify commands, and
things not to do.

**Read which file when:**
- Booking a service by name, price quotes, staff-name confusion → `service-matching.md`
- `book_visit`/`reschedule_visit`/`cancel_visit` (multi-service sittings) → `visit-tools.md`
- Single-appointment book/reschedule/cancel on the Live path → `appointments-and-writes.md`
- Slot offering, nearby-date search, grid/rounding → `availability.md`
- Anything about what the model reads (Live voice or backend rules) → `prompts.md`
- Goodbye/hangup, "anything else" offer, end_call → `closing-and-endcall.md`
- Caller-ID prefetch, lookup_customer, list_appointments privacy → `identity-and-lookup.md`
- transfer_to_owner, leave_message_for_owner, closure/vacation → `transfer-and-messages.md`
- Deploying, verifying a deploy, env vars, admin routes → `deploy-and-ops.md`
- Texting Erica, `/twilio/sms`, SMS lanes, opt-out, SMS taste test → `sms-concierge.md`

**Rule:** keep each file ≤ 70 lines; update the file when you change the area.
