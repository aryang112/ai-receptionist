# Test-call script — prompt rework verification (2026-08-26)

Call from **your 5169 test phone**. The build under test: tool-result
coaching (Phase 1) + restructured prompt (Phases 2+3) + the transfer-FYI
text (4b17308). Note: calls hit the **deployed** server, so the order is
deploy → test immediately → confirm or roll back:

```
railway up --service erica --detach     # deploy (watch: railway logs --service erica)
# if a scenario fails badly: git revert 0cab41d ba7da39 && railway up   (or Railway dashboard → redeploy previous)
```

Between calls, glance at the logs for WARN/ERROR. I'll do a full
/call-review sweep on the transcripts after you're done.

---

## MUST-PASS (the reasons this rework exists)

**1. The Glenda replay — staff name as service**
Say: *"Hi, I wanted to know if Richa is available today around [30–40 min from now]."*
- ✅ PASS: she never says "service", "system", or "not found" — she asks which
  service you'd like with Richa, then offers times near what you asked.
- Also verifies your Phorest lead-time change: a slot ~20–30 min out should
  now be offered.
- 🚨 FAIL: any variant of "we don't have Richa in the system."

**2. Unknown service name**
Say: *"Do you guys do microneedling?"* (not in the catalog)
- ✅ PASS: natural response — asks what you're looking for or offers the
  closest real services. Never "that's not in our system/catalog."

**3. Full booking, two services**
Book **brow threading**, confirm a time, then when she asks "anything else"
add an **upper lip** too.
- ✅ PASS: both booked, each confirmed back (service + day + time + your
  name) BEFORE she books; times only from what she offered; no transfer
  talk; ends with one goodbye and a clean hangup.
- Then check the Phorest calendar: both appointments on Richa's column.

**4. Ask for Richa (live transfer + FYI text)**
Say: *"Can I speak to Richa?"* (inside her 9 AM–9 PM window)
- ✅ PASS: one short handoff sentence, then her phone rings.
- **Richa gets the new FYI text** ("I just transferred a call…") whether or
  not she picks up — have her check.
- If she doesn't answer (no voicemail-screening this time): Erica comes BACK
  on the line, apologizes, offers to take a message.

## QUICK CHECKS (30–60 seconds each)

**5. Ambiguous service** — *"I'd like a wax."* → asks which kind, conversationally, max ~3 options.

**6. Price + hours combo** — *"How much is a lash lift, and are you open right now?"* → instant exact price and instant open/closed answer, no stalling, no wrong Monday-hours bug.

**7. Closed-day ask** — *"Can I come in this Sunday?"* → "we're closed Sunday"-style answer + offers the next opening. 🚨 FAIL if she says "fully booked."

**8. Reschedule → cancel pivot** — ask to move one of your test bookings, then mid-flow say *"actually, just cancel it."* → she abandons the reschedule instantly, confirms exactly which appointment, cancels only after your yes, claims success only after it worked. (This also cleans up scenario 3's bookings — cancel both.)

**9. Mumble test** — say something deliberately garbled/quiet. → she asks you to repeat it in her own words; never guesses and acts.

**10. Job seeker** — *"Are you guys hiring?"* → website pointer, warm, no transfer, offers to wrap up.

**11. Spam pitch** — *"I'm calling about your Google Business listing…"* → ONE polite decline, then she ends the call. Never transfers, never engages.

**12. Off-topic bait (regression)** — *"Before I book — how do I reverse a linked list?"* → one deflection, steers back to salon business (passed on 8/25 build; must still pass).

**13. Silent open** — call and say nothing. → one check-in, then a polite goodbye and hangup.

---

## Verdict
Reply with which numbers passed/failed (e.g. "all pass except 4"). On a
fail, I'll pull the transcript + logs for that callSid and fix at the right
layer (fix ladder, lessons.md) before we call it done. When you confirm,
this deploy stands as the new baseline.
