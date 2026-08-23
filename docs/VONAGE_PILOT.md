# VONAGE → ERICA: Production Pilot Plan (2026-08-22)

> How Erica goes live on the salon's REAL number (hosted on Vonage) without
> porting anything, in three reversible stages. Companion:
> `docs/MARKET_RESEARCH_2026-07-18.md` (why observability sells trust) and
> the Round-4 observability stack (dashboard `/admin`, recordings, digest).

## The core idea

The salon number stays on Vonage. Vonage FORWARDS calls to Erica's Twilio
number (+1 410-304-6449) under rules we control. Erica answers as if the
caller dialed the salon. Rollback at any stage = flip the forwarding rule off
in the Vonage portal. No porting, no risk to the number, seconds to revert.

## Connection options through Vonage (in order of usefulness)

1. **Schedule-based forwarding (THE PILOT).** Vonage Business Communications
   supports business-hours schedules / call-routing rules: during open hours
   ring the salon phone as today; outside hours forward to the Twilio number
   instead of voicemail. This is Stage 1 below. (Exact menu naming varies by
   Vonage plan — look for "Business Hours / Schedules" or "Call Routing" on
   the number's settings; if the account is bare-bones Vonage, "Call
   Forwarding — when unanswered/after hours" achieves the same.)
2. **Forward-all.** One rule: every call goes to Erica. Used during Richa's
   vacation (Stage 2) and, if the pilot earns it, full-time (Stage 3).
3. **No-answer overflow.** Ring the salon phone 3–4 rings first; unanswered →
   forward to Erica. This is the best LONG-TERM daytime mode (Richa answers
   when free, Erica catches the rest — she's mid-client most of the day).
   Slightly worse caller experience (longer ring) — evaluate after Stage 1.
4. **NOT recommended now:** porting the number to Twilio (irreversible-ish,
   days of paperwork, zero pilot benefit) or Vonage's own SIP/API products
   (we'd be rebuilding the Twilio media-stream plumbing for no gain).

### ⚠️ The one thing to verify on day 1: caller-ID passthrough
Everything smart in Erica keys off the CALLER's number arriving in Twilio's
`From` (caller-ID prefetch/recognition, client-guard, spam blocklist). Vonage
forwarding NORMALLY passes the original caller ID through, but some configs
substitute the Vonage number. **First forwarded test call: check the dashboard
/ logs — if `From` shows the salon's own number instead of the caller's,**
fix the Vonage forwarding config (caller-ID passthrough setting) before the
pilot proceeds. If it can't be fixed, recognition/blocklist degrade gracefully
(Erica just asks for the phone number like an unrecognized caller) — but we
want passthrough.

Also expect `StirVerstat` values to change on forwarded legs (attestation is
per-leg) — another reason S2 keeps STIR log-only.

## Rollout stages

### Stage 0 — now (ngrok, Aryan's phone only)
- Run the Round 3+4 live-test checklists (state.md).
- Flip `OPENAI_INPUT_TRANSCRIPTION` on for one call → greeting plays =
  session accepted → leave it on (caller-side transcripts).
- Confirm a recording appears and plays in `/admin`.

### Stage 1 — AFTER-HOURS pilot (target: this week)
Vonage: after-hours rule → forward to +1 410-304-6449. Salon closes 5pm
Mon / 7pm Tue–Fri / 6pm Sat / Sun closed — evenings + Sundays are Erica's.
**Why this stage is free upside:** those calls currently hit voicemail; the
market's own data says a huge share of salon bookings happen after hours
(vendors cite 30–50% — our dashboard will measure OURS precisely).
Prereq: the server must be reachable 24/7 — see Deployment below.
Success gates to advance (dashboard makes these one-glance):
- ≥ 2 weeks, ≥ ~20 handled after-hours calls
- 0 wrong-write incidents (booking/reschedule/cancel against wrong intent)
- "needs review" flags trending down; no unresolved "acting weird" reviews
- after-hours bookings captured > 0 (the ROI story writes itself)

### Stage 2 — VACATION (Sept 1–9, dates TBC)
Vonage: forward-ALL. Erica's vacation mode (already built) answers
everything: books post-return, takes messages → SMS to Richa, explains
closure. This is the full-load dress rehearsal while expectations are low —
callers know the owner's away.

### Stage 3 — ALWAYS ON (earned, not scheduled)
Choose per Stage-1 data: forward-all (Erica is the receptionist, transfers to
Richa on request) vs no-answer overflow (Richa first, Erica catches). Revisit
prompt-trim (todo 3.4) before this — per-turn cost matters at full volume.

## Deployment (prereq for Stage 1)
ngrok on a laptop is not a pilot. Needs: a long-lived Node process (in-memory
caches + WS — NOT serverless, per state.md), a stable HTTPS URL for the
Twilio webhook, US region. Simplest candidates: Railway / Fly.io / Render
(~$5–10/mo) or a small VPS. `data/` must persist across deploys (volume).
Set the Twilio number's webhook to the permanent URL (scripts/
set-twilio-webhook.sh). **Owner gate still standing before any git push:
rotate the Phorest secret buried in git history (PLAN.md).**
Env for prod: WS_AUTH_SECRET (fail-closed), ADMIN_TOKEN set, RECORD_CALLS
true, DIGEST_TO = Richa + Aryan.

## What we measure (the pilot's report card — all on /admin)
- **Trust:** flagged-call rate + Aryan/Richa listening to recordings —
  "helpful or weird" is judged from evidence, not vibes.
- **Capture:** after-hours calls handled, bookings that would have been
  voicemail. This number is the whole pitch.
- **Revenue booked** (sum of booked service prices) vs **cost** (per-call
  token estimate + Twilio ~$0.0085/min + recording ~$0.0025/min) →
  revenue-per-dollar.
- **Quality:** outcome mix, transfer rate, spam blocked, duration cap /
  silence hangup rates.
- Daily SMS digest to Richa keeps the pilot visible without asking her to
  check anything.

## Cost ballpark (so nobody's surprised)
A typical 3-min call ≈ $0.10–0.30 OpenAI (post-TPM-raise, prompt-cached) +
~$0.03 Twilio+recording. Even 10 calls/day ≈ $1–3/day — one brow thread
($10+) per WEEK covers it. The dashboard replaces this guess with real
numbers.
