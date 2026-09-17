# SMS concierge — deployment handoff

## Status update 2026-09-16 22:45 ET — LIVE for Aryan's handset

- **Deployed:** commit `9796bd0` (includes the `12c26d5` Terra migration) → Railway
  deployment `42e617d5` SUCCESS at 22:40 ET. Texts are now answered by `gpt-5.6-terra`.
- **Webhook flipped:** `SmsUrl` → `https://erica-production-f2e2.up.railway.app/twilio/sms`
  (POST) at 22:39 ET; `voice_url` verified unchanged. The 22:15 entry below saying the flip
  and deploy were pending is superseded.
- **Next:** the taste-test table further down, from +14432535169 only.

## Status update 2026-09-16 ~22:15 (Jarvis/Fable, verified live) — superseded above

**Supersedes the "It is NOT deployed" line below — true on 09-14, stale since 09-15.**

- The SMS concierge route **is deployed**. Railway deployment `8e018ae6` (2026-09-15)
  shipped the code through commit `ebdc52d`; tonight's deployment `df5b822e` (commit
  `8ff1416`) shipped it again. `POST /twilio/sms` answers **403** in production (route
  present, signature check) — verified tonight.
- Railway config (set 2026-09-15, still current): `SMS_ENABLED=true`, `SMS_SEND_MODE=real`,
  `SMS_ALLOWED_NUMBERS=+14432535169` (Aryan only), `SMS_OWNER_PHONE=+14432535169`,
  `SMS_STORE_PATH=/app/data/sms.jsonl`, `SMS_OPEN_TO_ALL` unset (fail-closed),
  `OWNER_SMS_MODE=simulate` (escalation texts logged, not delivered).
- **The number's `SmsUrl` webhook flip is still PENDING ARYAN.** Tonight's session
  attempted it and was blocked by its own permission classifier (Feature Flag Writes
  gate). Verified read-only: `sms_url` is still `""`, `voice_url` unchanged. Aryan needs
  to run Step 3 below himself (Twilio console or the curl), then GET the number back to
  confirm `voice_url` stayed untouched.
- Separately, commit `12c26d5` moves the text agent from `gpt-4.1` to `gpt-5.6-terra`
  over the Responses API (new `OPENAI_SMS_MODEL` default, new `OPENAI_SMS_EFFORT`; see
  `src/tests/smsAgent.test.ts`). Committed and tested (837/837, clean `tsc`/build),
  smoked locally against real read-only Phorest — but **not deployed**. Until it ships,
  production text replies still come from the gpt-4.1 build, which is fine for the
  taste test. HEAD on this branch is now `60593d8` (a docs commit on top of `12c26d5`);
  both are pushed to origin.
- Net effect: flipping the webhook today makes Aryan's handset able to text Erica
  against the ALREADY-DEPLOYED gpt-4.1 build. Nothing else changes until 12c26d5 also
  deploys, at which point the text agent starts reasoning on gpt-5.6-terra instead.

---

**Written 2026-09-14 for whoever deploys Erica.** The feature is built, merged and tested.
~~It is NOT deployed.~~ **Superseded — see the status update above: it was deployed on
2026-09-15.** Production has no `/twilio/sms` route (verified: unsigned POST returns
404, while `/twilio/voice` returns 403 — so the probe works and the route genuinely is
absent). *(This was true when written; no longer current — see above.)*

Design and rationale: `docs/SMS_CONCIERGE_2026-09-14.md`.

---

## What is already done

- Code merged into `codex/gpt-live-taste-test`. 757/757 tests, clean `tsc`.
- Five variables set on Railway service `erica` (production). **Setting them appears to
  have triggered a redeploy at 00:04:52Z on 09-15 despite `--skip-deploys`** — the
  container restarted at 00:06:34. No call was active, nothing was dropped, and no new
  code shipped (it re-ran the existing build). Flagging it so the restart in the logs is
  not a mystery.

  ```
  SMS_ENABLED=true
  SMS_SEND_MODE=real
  SMS_ALLOWED_NUMBERS=+14432535169     # Aryan only
  SMS_OWNER_PHONE=+14432535169         # escalations go to Aryan, not Richa, during the test
  SMS_STORE_PATH=/app/data/sms.jsonl   # on the Railway volume — see below
  ```

  `SMS_OPEN_TO_ALL` is deliberately **unset**. The reply gate is fail-closed: an empty
  allowlist means NOBODY. Reaching every client requires ADDING that variable, never
  forgetting one.

- The number's `SmsUrl` was blanked (it pointed at Twilio's retired demo endpoint and had
  delivered 57 "Configure your number's SMS URL" auto-replies to 50 real clients between
  Nov 2025 and Sep 10 2026). Inbound texts are still logged by Twilio, so nothing is lost
  while the lane is dark.

---

## The one open question before deploying

`railway up` uploads the whole directory. This worktree is ahead of the runtime recorded
in `state.md` (`b53d436`). Excluding the SMS files, that delta is:

```
src/realtime/twilioStream.ts    +7    "tell the Live speech model a transfer already rang out"
src/voice/livePrompts.ts        +9/-3 "carry earlier caller details into Live availability lookups"
(+ 2 test files)
```

**~16 lines of voice behaviour.** Their own doc commit (`312493f docs: record carry-over
and transfer-failback production deploy`) says they were already deployed, and the
running logs show the current GPT-Live/Terra stack (`model=gpt-live-1`,
`backendModel=gpt-5.6-terra`), which is consistent with that. But Railway has no git
metadata for this service (deploys are file uploads) and the app prints no version on
boot, so **it cannot be confirmed from outside.**

**If you know the last commit you deployed and it is at or past `3eda50a`, the delta is
zero and this is a pure SMS deploy.** That is the fastest way to close this out.

---

## Deploy sequence

```bash
cd /Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12

# 0. NEVER deploy while a call is in progress — it restarts the container.
#    Check: Twilio Calls.json?Status=in-progress  (or the Twilio console)

# 1. deploy
railway up --service erica --detach

# 2. confirm the route now exists (403 = present; 404 = still missing)
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://erica-production-f2e2.up.railway.app/twilio/sms

# 3. point the number's SMS webhook at it
#    PN SID: PNfc3e21b482274d41df93674589456851
curl -fsS -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/PNfc3e21b482274d41df93674589456851.json" \
  --data-urlencode "SmsUrl=https://erica-production-f2e2.up.railway.app/twilio/sms" \
  --data-urlencode "SmsMethod=POST"
```

Send ONLY `SmsUrl` in step 3. `voiceUrl` is not in the payload and therefore cannot be
touched — verify it afterwards regardless.

---

## Then test, from +14432535169 only

| Text | Expected |
|---|---|
| "do you have anything thursday for brow threading?" | 3 real times, **no self-introduction** |
| "wait is this richa or a bot?" | "Erica, Richa's assistant" — never claims to be Richa |
| "2:15 works" | reads back service + day + date + time, asks for a clear yes |
| "yes" | **books it in Phorest for real** — `PHOREST_WRITE_MODE=real`. Cancel the fixture after. |
| "can I get a refund" | escalates: Aryan gets "Erica needs you — #A7 …" |
| reply "A7 tell her yes that's fine" | Erica sends it to the client and confirms back |
| "STOP" | opt-out confirmation, and the number is suppressed permanently |

**Known gap:** `OWNER_SMS_MODE=simulate` on production, by earlier deliberate choice, and
`sendOwnerSms` honours it — so **escalation texts will be logged but not delivered**.
Everything else tests end to end. Setting it to `real` also un-suppresses VOICE owner
notifications (post-call summaries, transfer notices), so that is a real decision rather
than a toggle.

---

## Rollback

`railway variables --service erica --set "SMS_ENABLED=false"` — the route still records
every inbound message and answers nobody. The webhook does not need reverting. For a full
stop, blank `SmsUrl` again.

---

## Do not skip

- `SMS_STORE_PATH` must stay under `/app/data` (the Railway volume). Off the volume, every
  redeploy wipes thread history **and the durable opt-out ledger** — a client who sent
  STOP would start receiving messages again.
- A fresh worktree of this repo has no `.env` and no `node_modules`; without `.env`, 36
  voice tests fail on empty Twilio credentials. That is an artifact, not a regression —
  symlink both from the main checkout.
- Before any outbound campaign (not built): Phorest's native rebooking SMS is ON, so a
  cross-system cap of ≤1 message per 48–72h is mandatory, and the A2P campaign
  description (currently "asking for Google reviews") should be broadened to cover
  booking. The campaign is Low Volume Mixed, so multiple use cases are permitted.
