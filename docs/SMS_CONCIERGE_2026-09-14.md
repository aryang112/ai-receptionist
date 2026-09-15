# SMS concierge — two-way booking over text

**Home:** this repo. Moved here 2026-09-14 from `salon-review-automation/docs/`, where it
was drafted only because that is where the session started. It is Erica's feature and
belongs with Erica's code.

**Status:** BUILT and merged into `codex/gpt-live-taste-test`. Not deployed.

## Why this lives in Erica, not the review project (decided 2026-09-14)

Twilio allows exactly ONE `smsUrl` per number, so exactly one service receives every
inbound text — it cannot be split by message type. Given that, the front door belongs
where the expensive half already works:

| | Work | Status |
|---|---|---|
| Handle a review-request reply | recognize it, stay silent | ~40 lines |
| Handle a booking | availability, service match, client lookup, calendar write, confirmation | thousands of lines, live |

Putting the front door in the review project would mean rebuilding the booking half —
giving **two systems writing to Richa's Phorest calendar**. That is the one thing that
must not happen.

**Standing rules that came out of this decision:**
1. **One writer to the Phorest calendar — Erica.** The review project stays read-only on
   Phorest.
2. **One owner for the phone number's webhook config — Erica** (`voiceUrl` AND `smsUrl`).
   That config lives in the Twilio console, in neither repo and in no test: it is how a
   dead demo webhook sent 57 auto-replies to 50 clients over ten months before anyone
   noticed.
3. **Cross-project calls go over a narrow HTTP contract — never a shared database.**
   Currently ZERO such calls are needed: the review-reply check reads Twilio's own
   message log, so the two projects are fully decoupled.

When `salon-os` T-000 (the monorepo) happens, these files move into `apps/receptionist`
with the rest of the repo. Nothing here is throwaway.

## Behaviour as shipped

- **Review-request replies get NO reply** (Aryan, 2026-09-14: "no impact on us"). They are
  still RECORDED — that is the whole point, 57 were previously lost. The lane exists to
  keep "Done!" away from the booking agent; anything with booking intent ("Thanks! Can I
  come Thursday?") still reaches it.
- **Persona:** introduce only when the SALON opened the conversation. If the client texted
  first, answer directly. If asked who this is, say plainly "Erica, Richa's assistant" —
  never claim to be Richa.
- **Escalation:** Erica texts Richa (`SMS_OWNER_PHONE`, else `OWNER_PHONE`) with a short
  thread code; Richa replies "A7 <what to tell them>"; Erica sends it on the salon's
  number and confirms back to her.
- **Reply gate is FAIL-CLOSED:** an empty `SMS_ALLOWED_NUMBERS` means NOBODY. Reaching
  every client requires setting `SMS_OPEN_TO_ALL=true`, never forgetting a variable.
- **STOP/HELP** are honoured from any number, allowlist or not, and the opt-out ledger
  survives restarts.

## Phase 0 — Stop dropping replies (small, high value, ship first)

1. `POST /twilio/sms` on Erica, guarded by the existing `twilioSignature()` middleware
   (mirror `src/routes/twilio.ts:89`).
2. Persist every inbound message. Never drop.
3. Correct STOP / HELP / START handling with a durable opt-out ledger.
4. Anything else -> the agent handles it (see Phase 1). No forwarding to Richa's cell.
   Unhandleable threads are flagged to the dashboard queue + digest, and the client is
   told Erica will come back to them.
5. Point the number's `smsUrl` at it. **Outward-facing change to a production number —
   needs Aryan's explicit go.**

Acceptance: reply to the number from a test handset; message stored, Richa notified,
STOP suppresses. No Phorest writes in this phase.

## Phase 1 — The text agent

6. `smsConversationStore` — thread per phone, state machine, idle TTL, one in-flight
   turn per thread. Mirror `callStore.ts`; do not invent a second pattern.
7. Text-turn agent with **the same tool set the voice agent has**. No new booking logic.
   Text-specific rules: <=320 chars, at most 3 slot options, always echo back the exact
   date/time before writing, never promise a slot that was not just verified.
8. Reuse the fresh-availability-refusal and pending-write-blocking invariants from the
   voice real-write pilot verbatim. They are the reason voice writes are trusted.
9. Ships with `PHOREST_WRITE_MODE=simulate`. Flip to `real` only after a taste test,
   exactly as voice did.
10. Escalate to Richa on: low confidence, ambiguity, complaint, price negotiation,
    anything not book/reschedule/cancel.

Acceptance: from a test handset, book / reschedule / cancel each complete and read
back correctly against real Phorest, with a clean owner notification.

## Phase 2 — Outbound ("Erica texts some clients")

11. **Inbound router.** One number, three lanes. Rule: if a review request went to this
    phone recently and no booking thread is open -> review-reply lane; if an outbound
    Erica campaign message went out -> booking lane; else -> booking lane with a
    generic opener. This must be explicit and tested, not implicit.
12. Audience: reuse the retention-loop `audience.service.js` segments rather than a new
    list, or a Richa-approved CSV shortlist for the first wave.
13. Suppression, non-negotiable, all enforced before send:
    - Phorest native rebooking SMS + email are ON -> cross-system cap <=1 msg / 48-72h.
    - 90-day review-request cooldown: untouched.
    - Already-reviewed ledger: untouched.
    - Future-booked clients excluded (they do not need a booking nudge).
    - Quiet hours from `business.json` working days.
14. First wave: <=15 clients, Richa reviews the list, holdout arm so lift is measurable.

## Phase 3 — Before volume

15. Update the A2P campaign description to include appointment booking.
16. Kill switch + a dead-man's-switch alarm on the outcome (replies answered), not just
    process liveness — per the Fable audit rule.
17. Dashboard thread view for Richa.

---

## Sequencing note

Erica is mid-migration (GPT-Live) with several deploys on 2026-09-12 and an owner taste
test still pending. Phase 0 is additive and safe to land now. Phase 1 should not start
until the taste test closes, or it collides with live prompt work.
