# SMS concierge

**Purpose.** Two-way texting with Erica on the salon's real number: work out what an inbound text actually is (owner instruction, carrier keyword, review-request "thanks", or a genuine booking request), and let the booking lane reuse the exact same Phorest-backed tools voice already trusts.

**Key code:**
- `src/routes/sms.ts` — `POST /sms`, `twilioSignature()`-guarded. Persists the inbound message FIRST, before anything else can throw. One in-flight agent turn per phone (`inFlight` set) — a second message mid-turn is recorded, not dropped, and joins the thread history for that turn. `SMS_ENABLED` kill switch still records, never replies.
- `smsRouter.ts` — `routeInbound` picks one of four lanes: `owner` (Richa/Aryan's own number), `compliance` (STOP/START/HELP, outranks everything), `review_reply` (a bare "thanks"/"done" — `isAcknowledgment` — within `REVIEW_REPLY_WINDOW_MS`, 7 days, of a review request, and only with no booking intent), `booking` (everything else). `isAllowedForAgent` is the fail-closed taste-test gate: owner always, else the allowlist, else only if `SMS_OPEN_TO_ALL===true`.
- `smsStore.ts` — `SmsStore`, append-only JSONL at `SMS_STORE_PATH` (must live on the Railway volume). Thread refs like "A7" (`mintRef`, alphabet excludes I/O/0/1 — unambiguous on a phone keyboard). Opt-out is a durable `state` event, replayed on boot, so STOP survives a restart.
- `smsSender.ts` — `sendClientSms` is the ONLY exit point to a client; every send re-checks opt-out state. `force` exists solely for the STOP confirmation carriers require even to a now-suppressed number.
- `smsCompliance.ts` — `detectComplianceKeyword`/`isUnambiguousStart`, exact whole-message match only (so "cancel my 3pm" is never read as an opt-out).
- `smsOwner.ts` — `handleOwnerMessage`/`parseOwnerCommand`: Richa or Aryan replies `"A7 <instruction>"`; no ref falls back to the most recently escalated thread.
- `smsAgent.ts` — `runSmsAgent`, the same six booking tools voice uses (`check_availability`/`book_appointment`/.../`escalate_to_owner`), over `openai.responses.create` (`OPENAI_SMS_MODEL`, default `gpt-5.6-terra`), `MAX_SMS_CHARS` 320, `MAX_TOOL_ROUNDS` 3. Persona rule: never introduce herself when the client texted first — only when the salon opened the thread.
- Taste-test script: `docs/SMS_CONCIERGE_HANDOFF.md` (7-text table, from +14432535169 only).

**Env vars (production values, 2026-09-16):** `SMS_ENABLED=true`, `SMS_SEND_MODE=real`, `SMS_ALLOWED_NUMBERS=+14432535169` (Aryan only), `SMS_OWNER_PHONE=+14432535169`, `SMS_STORE_PATH=/app/data/sms.jsonl`, `SMS_OPEN_TO_ALL` unset (fail-closed — empty allowlist means nobody), `OWNER_SMS_MODE=simulate` (escalation texts logged, not delivered), `OPENAI_SMS_MODEL`/`OPENAI_SMS_EFFORT` unset (default `gpt-5.6-terra`/`low`).

**Rollback:** `SMS_ENABLED=false`, or blank the number's `SmsUrl` — either way every inbound message is still recorded, just answered by nobody.

**Guarded by:** `smsRouter.test.ts` (lane selection, ack detection, fail-closed allowlist), `smsOwner.test.ts` (ref parsing, opt-out guard, thread-ref alphabet), `smsAgent.test.ts` (Responses-API request shape, tool round-trip, `MAX_SMS_CHARS` truncation).

**Traps:**
- 2026-09-14: a dead `SmsUrl` silently dropped 57 real client replies over ten months before anyone noticed — every inbound message is now persisted before any other logic runs, kill switch included.
- 2026-09-16: `gpt-5.6-terra` 400s when function tools are combined with `reasoning_effort` on `/v1/chat/completions` — `smsAgent.ts` must call `openai.responses.create`, never chat completions.
- `SMS_OPEN_TO_ALL` unset does not mean the route is broken — everyone but the owner and the allowlist is recorded and answered by nobody, by design.
- `OWNER_SMS_MODE=simulate` today: an escalation looks sent in the logs but never reaches a real phone — don't assume a taste-test escalation was seen.

**Verify:**
```bash
npx vitest run src/tests/smsRouter.test.ts src/tests/smsOwner.test.ts src/tests/smsAgent.test.ts
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://erica-production-f2e2.up.railway.app/twilio/sms   # expect 403, unsigned
node -e "require('dotenv').config({quiet:true}); require('twilio')(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN).incomingPhoneNumbers('PNfc3e21b482274d41df93674589456851').fetch().then(n=>console.log(n.smsUrl,n.voiceUrl))"
```

**Do not:**
- Set `SMS_OPEN_TO_ALL=true`, or change `SMS_OWNER_PHONE`/`OWNER_SMS_MODE`, without Aryan's explicit go-ahead.
- Blank or alter `voice_url` while touching this number — verify it reads back unchanged after every `SmsUrl` change.
- Answer any of the 57 historical review-request replies — they are archival, not a backlog to clear.
- `source .env` in a shell to run a probe — it mangles special characters; read secrets via node's dotenv instead.
