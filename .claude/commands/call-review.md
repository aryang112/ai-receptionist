# /call-review — twice-daily production call QA sweep

Review every production call since the last review for bugs and ungraceful
customer handling. Erica is live on the salon's real number (Vonage
after-hours forwarding) — this is the standing quality gate.

## Data sources
- Admin API: `https://erica-production-f2e2.up.railway.app/admin/api/...`
  Auth: `Authorization: Bearer <ADMIN_TOKEN>` — read the token from `.env`
  (`grep '^ADMIN_TOKEN=' .env`). NEVER print or log the token itself.
- Review state: `data/review-state.json` (local, gitignored) —
  `{ "lastReviewedTs": <ms>, "lastRunISO": "<iso>" }`. If missing, default
  lastReviewedTs to 48h ago.

## Procedure
1. Read `data/review-state.json`. Fetch `/admin/api/calls?days=7` and keep
   calls with `startTs > lastReviewedTs`. Report webhook-blocked entries as a
   count only (they worked as designed). If zero new calls: say so, update
   state, done.
2. For EACH new call, fetch `/admin/api/transcript/<callSid>` and reconstruct
   the dialogue (`entries[]` have `role: 'caller' | 'erica'`). A 404 on a
   call longer than ~20s is itself a finding (transcript persistence gap).
3. Judge each call against the rubric below. Cross-check factual answers when
   suspicious: hours/closed-dates against `src/config/business.json`, prices
   against the live catalog (`npx tsx scripts/list-services.ts` — read-only).
4. Sweep server logs for the same window:
   `railway logs --service erica 2>&1 | head -300` (note: current container
   only) — flag any WARN/ERROR lines that aren't already explained by a
   reviewed call.
5. Write the updated `data/review-state.json` (newest reviewed `startTs`).
6. Report, then propose (do NOT auto-apply) fixes for any real bug found.

## Rubric — what "less graceful" looks like
Per call, check:
- **Greeting**: plays fully, includes the recording disclosure, isn't skipped
  or truncated (watch the known call-2 greeting anomaly from state.md).
- **Listening**: Erica's replies actually answer what the caller just said —
  flag non-sequiturs, ignored corrections ("no, I said…"), repeated
  questions the caller already answered, talking over/cutting off (caller
  turn ends mid-sentence followed by Erica pivoting).
- **Accuracy**: hours, open/closed-now, prices, address must match
  business.json / the live catalog. Never-guess rules: flag any invented
  price, service, or availability.
- **Booking integrity**: service + date + time + name confirmed back before
  writing; outcome matches caller intent (wanted to book → booking row
  exists; flag "caller asked to book but outcome is 'none'").
- **Promises**: nothing impossible promised (transfers after hours should
  offer the message path; no "I'll call you back"; no reading IDs/URLs).
- **Endings**: no abrupt/mid-task hangups; `endReason` should make sense
  (flag `silence — no response` on a call where the caller was mid-flow,
  `duration cap` on any real conversation).
- **Frustration signals**: repeats, "hello?", sighs, hang-up right after an
  Erica turn, call-backs from the same number within minutes (check for
  same-`fromLast4` clusters).
- **Precomputed flags**: explain every flag the API already set
  (`tool-error`, `transfer-failed`, `silence-hangup`, `duration-cap`,
  `no-outcome`, `spam`) — a flag is a lead, not a verdict.
- **Cost sanity**: flag any call whose `estCostUsd` is way out of line for
  its duration (runaway retries).

## Verdicts + report format
Per call: **✅ clean** / **⚠️ minor** (name it) / **🚨 needs a listen**
(say exactly why + note the recording is at `/admin` for that callSid).
Then a short overall summary: calls reviewed, verdict counts, bookings,
revenue, total est cost, any PATTERN seen across calls (same failure twice =
propose a lessons.md entry and a fix). Lead with the worst finding.

Keep the report tight — Aryan reads this twice a day.
