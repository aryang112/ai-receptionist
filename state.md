# STATE — AI Receptionist (Erica)

## CURRENT (read this; ≤ 1 page)

**Deployed:** commit `9796bd0` → Railway deployment `42e617d5-b631-4ff3-ad39-2c4533b0c756`
(SUCCESS, 2026-09-16 22:40 ET, clean `git archive` snapshot). `GET /admin/voice-test`
shows: engine `live`, backend `gpt-5.6-terra`, writes `real`, ownerTransfers `real`
(temporary), notifications `simulate`, activeCalls 0. Forwarding is OFF — no real
customer calls reach this line yet. `PHOREST_WRITE_MODE=real` — test bookings hit
the real calendar. This build includes `12c26d5` (SMS text agent → gpt-5.6-terra
over the Responses API) and the symbol-map tool.
**SMS concierge is LIVE for Aryan's handset only:** the number's Twilio `SmsUrl`
now points at `/twilio/sms` (flipped 22:39 ET, `voice_url` verified unchanged).
`SMS_ALLOWED_NUMBERS=+14432535169`, `SMS_SEND_MODE=real`, `SMS_OPEN_TO_ALL` unset
(everyone else is recorded, never answered), `OWNER_SMS_MODE=simulate` (escalation
texts logged, not delivered). Rollback: `SMS_ENABLED=false` or blank `SmsUrl`.

**Temporary config still in place — revert after Aryan's transfer-fail test:**
- `OWNER_TRANSFER_MODE=real`
- `TRANSFER_WINDOW_END=23:00` (unset/default is 20:00 — until reverted, a real
  10 PM caller can ring Richa's actual phone)

**Three traps that have already bitten us here:**
1. Deploy only from the live worktree
   (`/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`). The
   main worktree was `railway unlink`ed on 2026-09-16 and can no longer deploy.
2. Backend rules for the Live engine live in `src/voice/backendRules.ts` (plus
   `buildLivePrompt` in `src/voice/livePrompts.ts`). The `SERVE` block inside
   `twilioStream.ts` is REALTIME-ONLY and INERT when `VOICE_ENGINE=live` —
   editing it changes nothing in production.
3. A tool isn't reachable on Live just because it's in `TOOL_DEFINITIONS`: it
   needs BOTH a carve-out past the backend's write-tool ban in
   `backendRules.ts` AND a registered handler on the `live` engine branch in
   `twilioStream.ts`. `src/tests/toolRegistration.test.ts` guards this
   (asserts every tool the Live backend is offered has a handler).

**Read next:**
- `docs/CODEMAP.md` — file map
- `docs/SYMBOLS.md` (generate via `npm run symbols`) — symbol-level map
- the relevant `docs/areas/*.md` for the area you're touching
- the DIGEST at the top of `tasks/lessons.md` — read full history below it
  only if a question needs it
- `tasks/backlog.md` — P0/P1 tables

**Pending action items:**
1. Aryan: SMS taste test from +14432535169 — the 7-text script in
   `docs/SMS_CONCIERGE_HANDOFF.md` ("yes" books for real: cancel the fixture;
   "STOP" suppresses the number, START undoes). Then decide `OWNER_SMS_MODE=real`
   (also un-silences voice owner notifications), then `SMS_OPEN_TO_ALL=true` +
   `SMS_OWNER_PHONE` → Richa.
2. Aryan: run the transfer-fail test, then revert `OWNER_TRANSFER_MODE` and
   `TRANSFER_WINDOW_END` (backlog P0).
3. Backlog P1: expose build sha on `/admin/voice-test`; Realtime retirement
   Stage 1 (narrow `VOICE_ENGINE` to `live`, delete the 26 `voiceEngine`
   branches in `twilioStream.ts`).

**Verification commands:**
- `npx vitest run`
- `npx tsc --noEmit`
- `npm run lint`
- `node --env-file=.env --import tsx scripts/render-live-prompts.ts`
- `npx tsx scripts/sim-scenarios.ts <date>`

## RECENT LOG (newest first, since the 2026-09-12 GPT-Live split)

## 2026-09-16 22:40 ET — DEPLOYED `9796bd0` → Railway `42e617d5` (SUCCESS); Twilio SmsUrl FLIPPED — SMS concierge live for Aryan's handset

- Aryan confirmed all teammates/agents done and authorized the deploy. Branch tip
  `9796bd0` (= origin) verified first: 839 tests / 73 files, `tsc` and `npm run
  build` clean; zero in-progress Twilio calls before and after.
- Deployed from a clean `git archive 9796bd0` snapshot with `railway up --project
  … --environment production --service … --path-as-root <snapshot>` run as the
  FIRST token of the command — the `Bash(railway up:*)` allow rule does not match
  a command that starts with `cd`, which is why the earlier attempts were refused
  by the classifier. The live worktree is the only linked dir, but `-p/-e/-s`
  flags make the cwd irrelevant.
- Verified: health 200; `POST /twilio/sms` 403 and `POST /twilio/voice` 403 (both
  routes present); `/admin/voice-test` → engine live, backend gpt-5.6-terra,
  writes real, ownerTransfers real (temporary), notifications simulate,
  activeCalls 0. `OPENAI_SMS_MODEL` is not set on Railway, so the new
  `gpt-5.6-terra` default is what answers texts.
- Twilio number `PNfc3e21b482274d41df93674589456851`: `SmsUrl` set to
  `https://erica-production-f2e2.up.railway.app/twilio/sms` (POST) via curl with
  ONLY SmsUrl+SmsMethod in the payload; read back: `voice_url`/`voice_method`
  unchanged, no fallback URL. Credentials were read through node's dotenv, not a
  shell `source` (see lessons: shell-sourcing mangles secrets).
- NOT done: no text was sent to anyone; no Phorest write; `OWNER_SMS_MODE` still
  simulate. First real end-to-end text is Aryan's taste test.

## 2026-09-16 ~22:15 — SMS concierge: webhook flip PENDING ARYAN; text agent → Terra (12c26d5) DEPLOY PENDING ARYAN

- **Already deployed (2026-09-15, and again tonight):** the SMS concierge route
  is live in production. Railway deployment `8e018ae6` (2026-09-15) carried the
  SMS code through commit `ebdc52d`; tonight's `df5b822e` (commit `8ff1416`)
  carried it further. `POST /twilio/sms` answers **403** (route present,
  signature check) — verified live tonight. `docs/SMS_CONCIERGE_HANDOFF.md`'s
  "NOT deployed" line is stale; marked superseded there.
- **Webhook flip: PENDING ARYAN, not done.** Tonight's session tried to point
  the number's `SmsUrl` at `https://erica-production-f2e2.up.railway.app/twilio/sms`
  and was blocked by its own permission classifier (Feature Flag Writes gate).
  Verified read-only just now: PN `PNfc3e21b482274d41df93674589456851`'s
  `sms_url` is still `""`, `voice_url` unchanged. Railway already has the SMS
  env vars set and ready: `SMS_ENABLED=true`, `SMS_SEND_MODE=real`,
  `SMS_ALLOWED_NUMBERS=+14432535169` (Aryan only), `SMS_OWNER_PHONE=+14432535169`,
  `SMS_STORE_PATH=/app/data/sms.jsonl`, `SMS_OPEN_TO_ALL` unset (fail-closed),
  `OWNER_SMS_MODE=simulate` (escalation texts logged, not delivered).
- **Text agent migrated to gpt-5.6-terra, commit `12c26d5`, NOT YET DEPLOYED.**
  `smsAgent.ts` now calls `openai.responses.create` (flat FunctionTool shape,
  `function_call` → `function_call_output` loop, `store:false`,
  `max_output_tokens` 1200, `reasoning` only sent for gpt-5.x models).
  `OPENAI_SMS_MODEL` default `gpt-4.1` → `gpt-5.6-terra`; new
  `OPENAI_SMS_EFFORT` (low|medium|high, default low). New
  `src/tests/smsAgent.test.ts` (5 tests). 837 tests / 72 files, `tsc` + build
  clean.
- **Smoke evidence** (local, real read-only Phorest): "Yes—Thursday, Sept 17, I
  have brow threading at 12:00 PM, 12:30 PM, or 1:00 PM"; identity question →
  "I'm Erica, Richa's assistant"; 1.3–3.4s per turn.
- **Deploy blocked tonight:** the session's permission classifier blocked
  `railway up` (and even a read-only Twilio in-progress-calls check). A clean
  `git archive 12c26d5` snapshot is ready. Until 12c26d5 deploys, production
  texts are still answered by the gpt-4.1 build — fine for the taste test.
- HEAD on `codex/gpt-live-taste-test` has moved to `60593d8` (another session's
  docs commit on top of `12c26d5`); both pushed to origin.

**PENDING — action items:**
0. **Aryan flips the webhook himself** — Twilio console (Phone Numbers → the
   salon number → Messaging → "A message comes in" = Webhook, POST,
   `https://erica-production-f2e2.up.railway.app/twilio/sms`) or the curl from
   the handoff doc's step 3 (send ONLY `SmsUrl` + `SmsMethod`), then GET the
   number back and confirm `voice_url` is untouched.
1. Aryan deploys `12c26d5` from the live worktree
   (`cd ~/Documents/Dev/ai-receptionist-live-2026-09-12 && railway up --service
   erica --detach` — the worktree is dirty with another session's untracked
   files, so use `--path-as-root` on the `git archive` snapshot instead) and
   verifies `/admin/voice-test` engine live + `POST /twilio/sms` → 403.
2. Aryan runs the 7-text taste script from `+14432535169` (note: "yes" books
   for real — cancel the fixture afterward; "STOP" permanently suppresses the
   number — send START to undo).
3. Decide `OWNER_SMS_MODE=real` (also un-silences voice owner notifications).
4. Only then `SMS_OPEN_TO_ALL=true` and `SMS_OWNER_PHONE` → Richa.

### W1 — context diet: state.md restructured (2026-09-16)
- Split `state.md` into `## CURRENT` (one page) + `## RECENT LOG` (every entry
  dated 2026-09-12 or later, newest first — the 2026-09-14→09-16 entries that
  had been appended at the bottom out of order are now reversed into place)
  + a pointer to the archive. Entries moved VERBATIM, no wording changed.
  A concurrent worker (`smsAgent.test.ts added`) landed a new top-of-file
  entry while this pass was running; it's preserved, newest-first, right
  below this entry.
- Everything dated 2026-07-19 through 2026-09-11, plus the undated
  "Current status / Architecture / What's DONE / PENDING / How to run a live
  test / Diagnostics / Key files" block that used to sit mid-file, moved
  VERBATIM and in original order to
  `docs/archive/state-2026-07-19_to_2026-09-11.md`.
- **Word-count reconciliation** (`wc -w`): immediately before this pass,
  `state.md` was 51368 words / 118 `^## ` headings, all one file (that
  figure already includes the concurrent `smsAgent.test.ts` entry above).
  After: `wc -w state.md docs/archive/state-2026-07-19_to_2026-09-11.md`
  sums back to 51368 plus ONLY the words added by this pass — the new
  `## CURRENT` section, the `## RECENT LOG` heading, this entry, the
  one-line archive pointer, and the archive file's 2-line header. Nothing
  else changed, so nothing else moves the total.
  `grep -c "^## " state.md docs/archive/state-2026-07-19_to_2026-09-11.md`
  sums to 120 = 118 + 2 (the two new `state.md` section headings; this entry
  is a `###`, so it isn't counted). See this session's completion report for
  the exact after-numbers.
- Also updated `tasks/lessons.md` (added a DIGEST at the top, rest
  untouched) and `CLAUDE.md`/`AGENTS.md` Auto-Resume to read CURRENT +
  CODEMAP + SYMBOLS + the relevant area doc + the lessons DIGEST, not the
  full files. Docs only — no code, no commit, no deploy.

## 2026-09-16 — smsAgent.test.ts added (Sonnet worker)

- New `src/tests/smsAgent.test.ts` (5 tests) locks in `runSmsAgent`'s request
  shape after its migration from chat completions (gpt-4.1) to the Responses
  API (`openai.responses.create`) on `gpt-5.6-terra` with
  `reasoning: { effort: env.OPENAI_SMS_EFFORT }`.
- Mocks `openai` (default-export class, `responses.create`), `booking.js`
  (`suggestSlots`/`bookAppointment`), and `ownerSms.js` (`sendOwnerSms`) —
  via `vi.hoisted()` (a plain `const xMock = vi.fn()` next to `vi.mock(...)`
  proved hoist-order-flaky here: booking.js's factory saw `suggestSlotsMock`
  before initialization while an identically-shaped `openai` mock var didn't;
  `vi.hoisted()` sidesteps that).
- Asserts: `model`/`reasoning`/`store`/`tool_choice`/`instructions` fields,
  that all 6 tools are flat (`type`+top-level `name`, no nested `function`
  key), a full `function_call` → tool handler → `function_call_output`
  round trip, that the loop forces `tool_choice: 'none'` on round
  `MAX_TOOL_ROUNDS + 1` (4th call) and returns `reply: null` when the model
  still won't produce text, that a `gpt-4.1` fallback omits `reasoning`
  entirely, and that a long reply is truncated to `MAX_SMS_CHARS`.
- Verified: `npx vitest run src/tests/smsAgent.test.ts` (5/5), `npx tsc
  --noEmit` (clean), full `npx vitest run` — 837/837 passed (832 baseline +
  5 new), 72 test files. No other file modified.

## 2026-09-16 21:43 — DEPLOYED: commit `8ff1416` → Railway deployment `df5b822e-6805-4bb9-a65d-57f3de6fa560` (SUCCESS)
- Deployed from the live worktree after Aryan added `Bash(railway up:*)` / `deployment` / `logs` permission rules. Previous build 8e018ae6 replaced.
- Verified: `GET /admin/voice-test` → engine live, backend gpt-5.6-terra, writes real, ownerTransfers real (temporary), notifications simulate.
- Production now has: visit tools registered on Live (ea8bdc3), two-phase cancel_visit, resolver joiner fix, authored backend rules, staff-matcher bound, offer counter, no-non-null sweep.
- Still pending: Aryan's transfer-fail test → then revert OWNER_TRANSFER_MODE/TRANSFER_WINDOW_END.
## 2026-09-16 ~21:45 — ORCHESTRATED FIX SESSION COMPLETE (Jarvis/Fable orchestrating, 8 Sonnet worker runs); DEPLOY PENDING ARYAN
- All approved fixes landed on `codex/gpt-live-taste-test`, pushed to origin, HEAD `6b9ccc7`. 832 tests, tsc clean, `npm run lint` 274 pre-existing findings / 0 non-null assertions, `npm run build` ok. Real-data checks green: render-live-prompts (only intended sentences changed), sim-scenarios 2026-09-17 (all rows correct incl. new "brow and lip" cases), sim-visit, sim-availability (no invented times).
- Commits: 96e1624 + 9dbc13d resolver; 2812dd5 cancel_visit read-back; 2556524 authored backendRules + goldens; 39c0f95 staff matcher; e2dfb1c docs (retirement plan, backlog, QA mirror check); fa37bca closing offer counter + rule text; **ea8bdc3 visit tools registered on Live (production defect — they were Realtime-only)**; d5b8599 no-non-null-assertion sweep (106 sites); 6b9ccc7 flat eslint config.
- **NOT deployed:** `railway up` was blocked by the session's permission gate. Production still runs 8e018ae6 (2026-09-15 build) — in which reschedule_visit/cancel_visit/book_visit have NO handler on Live.
- Main worktree `railway unlink`ed (2026-09-16) — only the live worktree can deploy now.
- Token tally (harness-reported subagent tokens): A 145k · B 192k · C 155k · D 154k · E 238k · F 354k · G 262k · H 145k ≈ 1.65M Sonnet; Fable orchestration/review on top.
- PENDING — action items: (1) **Aryan: deploy** — `cd ~/Documents/Dev/ai-receptionist-live-2026-09-12 && railway up --service erica --detach`, then `railway deployment list` → SUCCESS and `/admin/voice-test` → engine live; (2) Aryan's transfer-fail test, then revert OWNER_TRANSFER_MODE / TRANSFER_WINDOW_END; (3) backlog P1: build sha on /admin/voice-test; Realtime retirement Stage 1.

## 2026-09-15 ~21:45 — REVIEW of the post-GPT-Live audit (Jarvis / Fable 5.1, read-only)
- Wrote `docs/AUDIT_REVIEW_2026-09-15.md` — verdicts on audit §5. No code, no deploy, no config change.
- Verified: 797 tests green, tsc clean, prod `/admin/voice-test` → engine live / terra / writes real / transfers real. Temporary transfer config (`OWNER_TRANSFER_MODE=real`, `TRANSFER_WINDOW_END=23:00`) is STILL in place.
- **New defect found (read-only probe):** `resolveService("brow and lip")` → **match "Brow Wax and Lip Wax"**. The catalog's own "and" wins over the threading bundle whose "+" normalises away. Silent substitution class (O06). Not fixed.
- Item 05 "two selectors" is a misdiagnosis: `get_prices` and `suggest_availability` share `resolveService`; they differ only in notOffered handling. Fix the resolver once.
- Positions: keep two authored rule sets + shared computed facts (not one regex-transformed source); staff stopwords = safety net, real fix is length-scaled bound + gate on `closest`; closing judgement stays prose, mechanics (offer counter, farewell detect) server-side; `cancel_visit` SHOULD get a planning phase; three visit tools right, next step is visit tools accepting one service; enable `no-non-null-assertion`.
- PENDING — action items: (1) Aryan decides which review recommendations to implement; (2) revert temporary transfer config when testing ends; (3) deploy-capability setup — see chat: unlink main worktree from Railway, standing deploy policy.

### Workstream A — resolver (2026-09-16)
Fixed the O06 silent-substitution bug from the 09-15 audit review §2.3:
`resolveService("brow and lip")` matched **"Brow Wax and Lip Wax"** because
that catalog entry's own name contains the filler word "and" while the
threading bundle's "+" separator normalizes away to nothing.

**Changed:** `src/services/booking.ts` `normalize()` — drop a small joiner
list (`and, plus, with, also, then, n`) and modifier list (`upper, lower`)
from BOTH catalog names and queries, verified against the real 63-service
catalog (`list-services.ts`) that nothing relies on those words to stay
distinct, and no active service name contains "upper"/"lower". Also replaced
count-based token coverage (`queryTokens.length/nameTokens.length`) with
SET-based coverage (`|querySet∩nameSet|/|nameSet|`) so a name with a repeated
token ("Brow Thread + Lip Thread" → brow/threading/lip/threading) no longer
under-scores a query that names the whole bundle.

**Probe (before → after, real catalog):**
- "brow and lip": match "Brow Wax and Lip Wax" → ambiguous [Brow Wax and Lip
  Wax, Brow Thread + Lip Thread, Brow Thread + Lip Thread + Chin Thread]
  (never wax alone).
- "brow threading and upper lip": notOffered → match "Brow Thread + Lip
  Thread".
- "eyebrows and upper lip": notOffered → ambiguous [wax bundle, 2-svc
  threading bundle, 3-svc threading bundle].
- "upper lip threading": notOffered → match "Lip Threading".
- "brow threading lip": ambiguous (2 vs 3-service bundle) → match "Brow
  Thread + Lip Thread" (decisive).
- All previously-correct baseline rows (eyebrow threading, eyebrow tattoo,
  microblading touch-up, henna brows→notOffered, wax→ambiguous, lash lift,
  brow, lip→ambiguous, chin threading, full face threading, brow/lash tint,
  brow lamination) unchanged.

**Tests:** new `src/tests/booking.serviceJoiner.test.ts` (8 tests, isolated
fixture with the 6 real bundle/wax/threading names, `vi.mock` pattern copied
from `booking.tattoo.test.ts`) including "brow and lip never silently becomes
wax". `scripts/sim-scenarios.ts` gained 3 rows for this fix (O06b + two
2026-09-16 rows), confirmed via
`npx tsx scripts/sim-scenarios.ts 2026-09-17` — all three resolve as expected.
Full suite: 813 vitest passing (was 807 baseline in this worktree +
resolver's own 8 — a `twilioStream.visit.test.ts` failure seen mid-run was
another worker's concurrent `cancel_visit` planning-phase landing, not this
change; re-run 60s later was green). `tsc --noEmit` clean.

No changes outside scope (`src/services/booking.ts`,
`src/tests/booking.serviceJoiner.test.ts`, `scripts/sim-scenarios.ts`). Not
committed (orchestrator commits).

### Workstream C — cancel_visit read-back (2026-09-16)
- `cancel_visit` now has the same plan-then-execute shape as `book_visit`/`reschedule_visit`, closing the gap AUDIT_REVIEW_2026-09-15.md §4 flagged: the read-back was model memory, `confirmed` was a free required literal, and an extra id was cancelled with no server echo.
- **Schema** (`toolSchemas.ts`): `confirmed` is now `z.boolean().optional()` (was `z.literal(true)`), `appointmentIds` unchanged (≥2). **TOOL_DEFINITIONS** description mirrors reschedule_visit's two-call wording; `confirmed` no longer `required`.
- **`handleCancelVisit`** (`twilioStream.ts`):
  - Phase 1 (no `confirmed`, or `false`): keeps the "never served on this call" guard; if any id is already in `cancelledAppointmentIds` returns `{cancelled:true, alreadyCancelled:true, note}` (mirrors `handleCancel`'s alreadyCancelled path); otherwise builds `appointments:[{appointmentId, service, date, time}]` from `servedAppointmentServices/Dates/Times` (same fields/format `list_appointments` hands the model), stores the id set in a new private field `pendingCancelVisitIds: Set<string> | undefined`, and returns `{planned:true, appointments, note:"Nothing is cancelled yet. Read every service, day and time back exactly as given, ask for ONE yes covering all of them, and wait. On yes, call cancel_visit again with the same appointmentIds and confirmed true."}`. No write happens.
  - Phase 2 (`confirmed:true`): requires `pendingCancelVisitIds` to exist and match the passed ids exactly (order-insensitive, dedup'd) — else `{error:"These are not the appointments that were read back. Call cancel_visit without confirmed first, read the list back, and get one yes."}` and nothing is touched. On a match, clears the pending set and runs the unchanged sequential cancel loop (partial/complete notes untouched).
  - Any new phase-1 call replaces the pending set (plain reassignment).
- **`handleListAppointments`**: one-line addition — a fresh listing clears `pendingCancelVisitIds` (comment: "A fresh listing means the caller may be choosing a different set to cancel — any earlier cancel_visit read-back no longer applies."). Nothing else in that handler touched.
- **Tests** (`twilioStream.visit.test.ts`, `describe('cancel_visit')` rewritten to the two-call flow, 8 tests): phase 1 returns the read-back with service/date/time and does NOT call the cancel mock; phase 2 after a matching phase 1 cancels all and reports them; phase 2 with no prior phase 1 is refused, nothing cancelled; phase 2 with a different id set is refused, nothing cancelled; an id never served is refused (phase 1); a re-listing clears the pending set so phase 2 right after is refused. Full suite green at the time of this change (813 tests, 70 files); `tsc --noEmit` clean.
- **NOT edited**: `livePrompts.ts` — its line "cancel_visit needs no planning phase" is now false and needs updating by whoever owns that file next (told not to touch it per the task brief; a later worker owns it).
- **Uncertain / worth a second look**: (1) the already-cancelled branch in phase 1 has no dedicated test — logic mirrors `handleCancel`'s proven path but wasn't independently exercised here; (2) an editor-format hook fired on every `Edit` call and reformatted whitespace in unrelated regions of `twilioStream.ts` (STAFF_MATCH_STOPWORDS array, `registerTrackedTool` indentation, a couple of long lines) — no logic changed and the full suite was green, but it widens the diff outside the stated edit scope and could add noise to a merge with concurrent workers on that file.
- Not committed (orchestrator commits), not deployed, .env/Railway untouched, no Phorest writes run outside mocks.

### Workstream B — authored backend rules (2026-09-16)
Made the Live BACKEND (thinking) model's RULES an authored file instead of a
regex-transformed copy of the Realtime prompt, per AUDIT_REVIEW_2026-09-15.md
§1 recommendation #2 ("move the backend rule prose out of `rewriteConversation`
into its own plain text file... rules for two different models doing two
different jobs should be authored, not transformed").

**New file:** `src/voice/backendRules.ts` — exports every STATIC backend rule
section as a plain string constant (no regex, no dependency on the Realtime
prompt's wording): `PRIORITY`, `PERSONALITY_AND_TONE`, `LANGUAGE`,
`RESPONSE_SHAPE_AND_TURN_TAKING`, `REFERENCE_PRONUNCIATIONS`,
`REASONING_AND_UNCLEAR_AUDIO`, `OPERATING_RULES`, `PRIVACY`,
`SERVE_AND_IDENTITY` (the CONVERSATION FLOW body — previously generated by
`rewriteConversation`, which fully REPLACED, never derived, the production
SERVE/IDENTIFY text), `SAFETY_AND_ESCALATION`, `SPAM_AND_TELEMARKETING`,
`NON_CLIENT_CALLS`, `BACKEND_TOOL_USE`, `CANONICAL_SERVICE_CATALOG_HEADER`,
`TEMPORARY_CLOSURE_POLICY_RULES`, `TRANSFER_FAILBACK_CALL_CONTEXT`. A block
comment at the top of the file lists the full computed-vs-authored split
(reproduced below).

**Computed vs authored** (determined by reading `buildInstructions` in
twilioStream.ts for `${...}` interpolation, not assumption):
- **COMPUTED** (still parsed from `productionInstructions` via
  `parseSections`/`productionFacts`/`rewriteClosure` in livePrompts.ts): the
  lead identity line, CONTEXT (address, weekly hours), CURRENT STATUS
  (today/tomorrow status, RICHA'S LINE, current date/time), TEMPORARY
  CLOSURE POLICY's summary line (dates + public reason), and the
  transfer-failback CALL CONTEXT suffix (text is authored/static; whether it
  appears is computed from the greeting context).
- **AUTHORED** (backendRules.ts): everything else that reaches the backend
  prompt — see the constant list above.
- **DROPPED** (unchanged from before): SERVICES & PRICES, PREAMBLES, TOOLS —
  never reached the backend prompt; the catalog/tool sections replace them.

**Changed:** `src/voice/livePrompts.ts` — `backendSections()` now assembles
sections in production order by pushing the authored constants directly
(via a small `push(name, body)` helper) interleaved with the computed
CONTEXT/CURRENT STATUS/TEMPORARY CLOSURE POLICY/CONVERSATION-FLOW-suffix
values; `buildBackendPrompt()` interpolates `BACKEND_TOOL_USE` and
`CANONICAL_SERVICE_CATALOG_HEADER` instead of inlining that text. Deleted
`rewriteResponseShape`, `rewriteReasoning`, `rewriteConversation`,
`rewriteSafety`, `rewriteSpam`, `rewriteNonClient` — no longer needed since
those sections are now authored text, not derived. Kept `rewriteClosure`
(now imports `TEMPORARY_CLOSURE_POLICY_RULES` instead of inlining it) and
`parseSections`/`productionFacts`/`section` (still used for the computed
facts and by `buildLivePrompt`, which is unchanged).

**Golden tests added FIRST** (`src/tests/livePrompts.test.ts`, new
`describe('golden prompts...')` block, 4 tests) — captured from the pipeline
*before* any implementation change, asserting byte-identical output against
committed fixtures in `src/tests/__golden__/`:
`backend-prompt.2026-10-01.txt`, `live-prompt.2026-10-01.txt`,
`backend-prompt.transfer-failback.txt` (transfer-failback greeting → CALL
CONTEXT suffix), `backend-prompt.caller-context.txt` (`callerContext` set),
`backend-prompt.closure-active.txt` (business.json's real 2026-09-01..09-09
vacation, same fixture `twilioStream.vacation.test.ts` uses, active on
2026-09-05 — matches the closure scenario the pre-existing "preserves retry,
privacy, current closure facts" test already covered). On mismatch the
helper `expectMatchesGolden` prints the first differing line with 2 lines of
context (unified-diff style, `-`/`---`/`+`) instead of the full ~19–20KB
prompt. All 4 passed BEFORE the refactor (confirming the harness) and passed
AGAIN AFTER (confirming the refactor changed WHERE the text lives, not WHAT
it says) — full suite 815/815, `tsc --noEmit` clean, both before and after.

**Tripwire message fixed** (the actual root cause named in the task: the SHA
test fired on 2026-09-14 and was dismissed because it didn't explain itself).
`expect(digestBefore, message).toBe(hash)` now reads: "The production
(Realtime) prompt changed. On the Live path the backend model does NOT
receive SERVE/IDENTIFY or any static rule section from this prompt — backend
rules are authored in src/voice/backendRules.ts and Live rules in
buildLivePrompt. If you meant to change Live behaviour, edit those. If this
Realtime-prompt change is deliberate, update the hash here and note what
changed." Hash itself untouched (`73cecffe22a2...07505eaf`).

**Realtime retirement banner** added in `twilioStream.ts` immediately above
the `═══ CONVERSATION FLOW ═══` template line: "REALTIME-ONLY — inert when
VOICE_ENGINE=live. Backend rules: src/voice/backendRules.ts. Realtime is
being retired; see docs/REALTIME_RETIREMENT_PLAN_2026-09-16.md." Since that
line sits inside one continuous template literal (a literal `//` there would
become part of the rendered prompt and break the hash tripwire), the
template was split into two backtick literals joined by `+` at the exact
character boundary, with the comment placed between them as real JS — the
concatenated string is unchanged (verified by the hash test staying green).
Nothing else in that file touched.

**Not changed, on purpose:** wording of any rule (would break the goldens —
that's the point); the stale "cancel_visit needs no planning phase" sentence
in BACKEND_TOOL_USE (Workstream C above found it's now false, but the task
brief said a later worker owns that edit — it's a one-line change in
backendRules.ts now, no regex to fight); `scripts/render-live-prompts.ts`
(ran clean, unchanged, ~909 live / prompt tokens as before).

**Verification:** `npx vitest run` → 815/815 passed, 70 files (2 more than
this task's own 813 baseline — Workstream A's concurrent
`booking.serviceJoiner.test.ts` growth, unrelated to this change and not a
conflict). `npx tsc --noEmit` → clean. No `!` non-null assertions in any new
code (backendRules.ts, the rewritten backendSections/rewriteClosure/
buildBackendPrompt in livePrompts.ts, the new golden tests) — pre-existing
ones in unmodified `parseSections`/`productionFacts` left as-is.

**Uncertain / worth a second look:** (1) `rewriteClosure` on the CURRENT
STATUS section body is now a guaranteed no-op (the ACTIVE NOW/UPCOMING line
always lands in a separate trailing TEMPORARY CLOSURE POLICY section per how
`buildInstructions` nests the `═══` header) — simplified to a direct push of
the computed body without calling the function there; flagged in a code
comment in case a future `buildInstructions` change breaks that assumption.
(2) Did not independently re-verify Workstream C's cancel_visit note beyond
preserving it verbatim as instructed.

Not committed (per task rules), not deployed, `.env`/Railway untouched, no
Phorest writes run.

### Workstream D — staff matcher (2026-09-16)
Made staff-name matching in `src/realtime/twilioStream.ts` principled instead
of stopword-driven, per AUDIT_REVIEW_2026-09-15.md §2.1/§2.2 and the
2026-09-15 lessons.md "fuzzy name matching must never see filler words" entry.

**Real staff first names** (read-only `listStaffNames()` probe against the
real Phorest catalog, `node --env-file=.env --import tsx`): **Bonnie, Manu,
Phorest, Richa** ("Phorest" is presumably a placeholder/house account, not a
person — left as-is, not in scope).

**1. Length-scaled edit bound.** New helper `maxEditsFor(name)` (~line 816):
5+ letters → 2 edits, 4 letters → 1 edit, ≤3 letters → 0 (exact only).
Applied to both the whole-query and per-token comparisons in `matchStaffName`
(replacing the old flat `n.length >= 4 && editDistance(...) <= 2`). Verified
by direct computation that Richard/Rishka/Risha (5-letter Richa, distance 2)
still match, and "and"/"can"/"want"/"any"/"then"/"than" (all distance 2 from
4-letter "manu") no longer do (distance 2 > bound 1).

**2. Call-site gate in `handleSuggestAvailability`** (~line 3702): the staff
check now only runs when `result.closest.length === 0` — a phrase that
produced service candidates is a service phrase and must never have a
coincidental name match eclipse those candidates. One-line comment added at
the call site. `matchCallerNamedStaff` has exactly one call site (checked via
grep); no other call site needed the same treatment.

**3. Shrunk `STAFF_MATCH_STOPWORDS`.** Verified by brute-force edit-distance
computation that EVERY word in the old 76-word list is now provably safe
against all 4 real staff names under the new bound alone (zero collisions).
Removed: all booking/scheduling vocabulary (book, time, date, today, plus,
upper, lower, full, half, next, last, new, old) and generic content verbs/
quantifiers (want, need, get, got, put, see, say, ask, just, like, one, two,
some, more, much, very, back) — and, since the bound alone provably blocks
them, also "and", "then", "than" (the headline register-item-05 words) so the
new test below exercises the bound, not the stopword shortcut. Left ~41
genuine closed-class function words (pronouns, articles, conjunctions,
prepositions, common auxiliary/modal verbs, wh-words, basic call filler like
"okay"/"yeah") as a belt-and-braces safety net, re-commented as exactly that.
Bare single-word stopword guard unchanged (returns null before any fuzzy
check runs).

**Tests:**
- `src/tests/staffMatch.test.ts` — kept the existing 4, added 4: the bound
  alone (not the stopword list) rejects "and"/"want"/"then"/"than" against a
  bare `['Manu']` roster (none of those 4 words are in the trimmed stopword
  set, so this genuinely isolates the bound); Richa's phone-mishearing
  variants (Richard/Rishka/Risha/"with Risha") still match; a 4-letter name
  tolerates exactly one edit ("Mano" → "Manu"); a 3-letter name requires exact
  ("Rob" does NOT match "Bob", "Bob" matches "Bob"). 8/8 green.
- `src/tests/twilioStream.serviceMatch.test.ts` — added a new describe block:
  "eyebrow threading and upper lip" (the mock catalog's separate Brow
  Threading / Lip Threading entries make this resolve notOffered WITH
  candidates) never returns `staffMember`; a bare "Richa" (no candidates)
  still does. 6/6 green in that file.

**Verification:** `npx vitest run` — 70 files, 821 tests, all green.
`npx tsc --noEmit` — clean. One `blocklist.test.ts`/`callStore.test.ts` ENOTDIR
warning is expected noise from a pre-existing tmp-dir test pattern, not a
failure (tests still pass).

**Uncertain / worth a second look:**
- Whether "Phorest" (7 letters, from the real staff list) is a real person or
  a house/system account — didn't investigate further since it's outside this
  workstream's scope and the matcher treats it like any other name.
- The stopword trim is a judgment call on where "genuine function word" ends;
  kept a conservative ~41-word set rather than reducing further, since the
  task asked for "small... as a safety net" rather than empty.
- Did not touch `isAmbiguousRichaAvailabilityRequest` or its own reuse of
  `matchStaffName(text, ['Richa'])` — it inherits the new bound automatically
  and wasn't in scope for a separate change.

**Not touched:** `livePrompts.ts`, `livePrompts.test.ts`, `booking.ts`,
`toolSchemas.ts`, and nothing beyond the matcher block/stopword list/one
call-site gate in `twilioStream.ts`. Saw an unrelated concurrent
`REALTIME-ONLY` comment land near line ~727 of `twilioStream.ts` mid-session
(another worker's change per the task brief) — left untouched. Not committed,
not deployed, `.env`/Railway untouched, no Phorest writes (only the one
read-only `listStaffNames()` probe).

### Workstream G — docs (2026-09-16)

Docs/planning only, no code. Wrote three files and edited a fourth, all
verified against the live code with `grep`/`Read`, not assumed:

- `docs/REALTIME_RETIREMENT_PLAN_2026-09-16.md` — decision (Aryan,
  2026-09-16: Realtime retired for good, `VOICE_ENGINE=live` only path).
  Full inventory: `buildInstructions()`'s 18 sections split
  computed-vs-static (5 computed: TEMPORARY CLOSURE POLICY, CONTEXT, SERVICES
  & PRICES, the GREETING sub-block, CURRENT STATUS; 13 static authored
  rules); `REALTIME_CONTEXT_NOTES` confirmed engine-agnostic despite its name
  (both `OpenAIRealtimeSession.injectContext` and
  `OpenAILiveSession.injectContext` consume it, 6 call sites, no
  `voiceEngine` guard on any of them); **28** `voiceEngine` occurrences in
  `twilioStream.ts` (1 field decl, 1 telemetry read, **20** `=== 'live'`
  branches, **6** `=== 'realtime'` branches, **0** `!== 'live'`); exactly one
  Realtime-only *class* (`OpenAIRealtimeSession`) but **no** Realtime-only
  *module* deletable outright — `openaiSession.ts` also exports shared types
  (`ToolDefinition`, `RealtimeHandlers`, `RealtimeUsage`) that `twilioStream.ts`,
  `liveSession.ts`, and `liveProtocol.ts` import, so type-extraction has to
  come before deletion; **4** Realtime-only scripts confirmed by import
  (`test-openai-realtime.ts`, `validate-session-fields.ts`,
  `validate-transcription-fields.ts`) plus `render-prompt.ts` (Realtime-view,
  shares the underlying `buildInstructions()` function which must survive);
  **1** Realtime-only test file (`openaiSession.test.ts`, 30 cases) out of 70;
  3 more test files mock `openaiSession.js` only because of a module-level
  import, not because they test Realtime behavior. New finding not in the
  task brief: `POST /admin/voice-test/variant` (`src/voice/testControl.ts`,
  `src/routes/voiceTest.ts`) can still flip `env.VOICE_ENGINE` to `'realtime'`
  at runtime for the owner taste-test A/B — currently inert in production
  (gated on `PHOREST_WRITE_MODE=simulate`, which prod isn't in right now) but
  live code that Stage 1 must update or it won't compile/will silently
  misbehave once the type narrows. Also found: `CLAUDE.md`'s voice rule
  ("marin... env-tunable via OPENAI_REALTIME_VOICE") is **already wrong
  today**, not just post-retirement — `liveSession.ts` hardcodes `marin` and
  never reads that env var; only `OpenAIRealtimeSession` does. Confirmed
  `failoverToOwner()` (`twilioStream.ts:6829` area) never falls back to
  Realtime on a fatal error — it dials the owner via Twilio REST directly, so
  Realtime's removal changes nothing about the emergency path. Four-part
  plan (narrow the type + delete branches + extract remaining facts; delete
  the dead modules/scripts/tests/env vars; rewrite CLAUDE.md/CODEMAP/GPT-SOL
  docs) with verification and rollback per stage. **Stage 0 landed mid-session**
  (workstream B, commit `2556524`) — corrected the plan in place rather than
  leaving it stale: `src/voice/backendRules.ts` now exists, the SHA-256
  tripwire's failure message was fixed (hash unchanged), and Stage 1's
  facts-extraction step is now smaller (only the regex-based facts parsing in
  `productionFacts()`/`backendSections()` remains, not the rule sections).
- `tasks/backlog.md` — new living backlog (links, doesn't duplicate, the
  2026-09-02 dated snapshot). Seeded per the task brief (revert temp transfer
  config; the three retirement-plan stages; visit tools taking one service +
  retiring the proposal pair; same-client duplicate-booking guard) plus a
  curated pass over `tasks/todo.md`'s older unchecked sections and the
  2026-09-02 `FUNCTIONAL_RELIABILITY_BACKLOG`'s FR-01…FR-20 items, most
  tagged `status: verify` since neither doc nor `state.md` confirms their
  current disposition. Updated two rows to `done` after noticing, mid-task,
  that workstreams A (`96e1624`, `9dbc13d`) and C (`2812dd5`) had committed
  during this session — the resolver conjunction fix and `cancel_visit`'s
  read-back phase, both listed as "being fixed today" in the original task
  brief, were in fact finished by the time this doc was written.
- `.claude/commands/call-review.md` — added a "Closing (register item 14 +
  mirror)" bullet to the rubric, right after "Endings". Note for whoever
  reads this later: the task brief described register item 14 as "the
  existing check" in this file, but it was not literally present as rubric
  text before this edit (only referenced in `docs/PROMPT_AUDIT_2026-09-15.md`
  and `docs/AUDIT_REVIEW_2026-09-15.md`) — added both the original item-14
  check and its mirror (completed action, no offer, no goodbye, silence)
  together in one bullet rather than editing something that didn't exist.

**Not verified / left open:** whether workstreams D (staff matcher — landed
per its own section just above) and E/F (closing mechanics, non-null lint)
had landed by session end at the time each part of this doc was drafted; did
not re-run `npx vitest run` myself (other streams were mutating source
concurrently — cited workstream B's own 815/815 and workstream D's 821/70
counts from their own `state.md` entries rather than re-running against an
unstable working tree). No code changed, no commit, no deploy, `.env`/Railway
untouched, per this workstream's rules.

### Workstream E — closing mechanics (2026-09-16)

Moved the MECHANICS of "ask once whether they need anything else, never
twice, never after a goodbye" (AUDIT_REVIEW_2026-09-15.md §3) into server
state, and reworded the backend rule text for the two-phase `cancel_visit`
another worker (Workstream C) had already landed.

**1. Offer detection** (`src/realtime/twilioStream.ts`). New standalone,
exported `isMoreHelpOfferText(text)` (placed just above `export class
TwilioRealtimeCall`, mirroring the style of the private
`liveHasCurrentFarewell` farewell regex a few hundred lines into the class):
`/\b(?:anything|something) else\b|\belse (?:i|we) can\b|\bhelp (?:you
)?with anything\b|\banything (?:more|further)\b/i`. New private field
`moreHelpOffered = false`. `recordLiveFragment('erica', …)` — the same
stream `liveClosingText` is fed from — now also tests the joined rolling
buffer against this regex after every push (joined, not just the new delta,
so a split like "anything" + " else" across two fragments still matches)
and sets the flag true the first time it matches. No mid-call reset method
was added: confirmed via `new TwilioRealtimeCall(...)` call sites and the
transfer-failback code (`/twilio/dial-status` reconnects the caller to a
**fresh** `TwilioRealtimeCall` instance with `transferFailed=1`, it does not
reuse the old one) that every call segment already gets a brand-new
instance, so the field's `false` initializer is the only reset needed.

**2. Delivery — ONE central place.** `registerTrackedTool` (the wrapper
every one of the 17 tool registrations already goes through) now pipes the
handler's result through a new private `applyMoreHelpOfferNote<T>(result)`
before returning it to the model. That method: no-ops if `moreHelpOffered`
is false, if the result isn't a non-null object, or if `result.ending ===
true`; otherwise it sets `moreHelpAlreadyOffered: true` and either appends
`"You have already asked whether the caller needs anything else on this
call. Do not ask again; when they are done, close."` to an existing string
`note`, or sets `note` to that sentence alone. No per-handler changes.

**3. Reworded success notes.** The three visit-tool success notes
(`book_visit`, `cancel_visit`, `reschedule_visit` in twilioStream.ts) each
said an unconditional "...then ask once if they need anything else." —
exactly the contradiction the audit named ("great, thanks, bye" in the same
breath). Each now ends "...then ask once if they need anything else —
unless they have already said they are done, in which case close instead."
before the trailing "Do not recount the steps..." clause. Grepped the whole
`src/` tree for the phrase outside `src/tests/`: only these three plus one
other `twilioStream.ts` occurrence — the `leave_message_for_owner` success
note, which already branches on "clearly done" before offering, so it was
left alone (not the same bug); and the Realtime-only SERVE line (inert on
Live per the 2026-09-15 "two prompts" lesson), also left alone.

**4. Backend rule text** (`src/voice/backendRules.ts`, `BACKEND_TOOL_USE`
only): (a) the two-phase description now says all three visit tools run in
two phases — book_visit/reschedule_visit called WITHOUT startTime,
cancel_visit called WITHOUT confirmed — replacing the stale "cancel_visit
needs no planning phase" sentence (already false since Workstream C's
read-back landed). Kept "Their returned options ARE the evidence of
combined feasibility, so never tell the caller you cannot check a combined
opening." verbatim. (b) "prepare at most one appointment action at a time"
→ "run one prepare_appointment_action at a time" (the 2026-09-15 lesson:
the old phrase was once read as a ban on the visit tools). (c) added "Tool
results tell you when the offer has already been made on this call." after
"A farewell outranks the offer." No other wording changed.

**5. Goldens.** Added an `UPDATE_GOLDEN=1` mode to `expectMatchesGolden` in
`src/tests/livePrompts.test.ts` (writes the actual output over the golden
file instead of asserting, documented in a comment on the function).
Regenerated with `UPDATE_GOLDEN=1 npx vitest run src/tests/livePrompts.test.ts`,
then ran again without the env var — 15/15 pass. `git diff
src/tests/__golden__` touches all 4 `backend-prompt.*.txt` goldens (not
`live-prompt.2026-10-01.txt`, as expected — the wording changes are all in
`BACKEND_TOOL_USE`) and the diff contains ONLY the three sentences from step
4, verified line-by-line. Also fixed one now-stale assertion in
`livePrompts.test.ts` ("at most one appointment action at a time" → "run one
prepare_appointment_action at a time"); no other test in the repo asserted
the old wording (grepped).

**6. Tests.** `src/tests/twilioStream.liveIntegration.test.ts` (already had
the `liveClosingText`/`voiceEngine='live'` injection pattern this task
pointed at): (a) `isMoreHelpOfferText` unit tests — 3 positive ("Is there
anything else I can help you with?", "Anything else for you today?", "Is
there something else you need?"), 3 negative ("Okay.", "Your brow threading
is booked for 4 PM.", "Goodbye, take care."). (b) a new
`buildTrackedCall()` helper whose mock `session.registerTool` captures
handlers in a `Map` (avoided `!` by throwing from a `getTool` helper instead
of asserting), then: a tool result before the offer has no
`moreHelpAlreadyOffered`; after `call.recordLiveFragment('erica', {delta:
'Anything else I can help with?'})`, the next result from the SAME
registered tool carries the field and the appended note; a bare result with
no prior `note` gets the sentence as its whole note; an `ending: true`
result is left byte-identical even after the offer; the offer is still
detected when split across two separate `recordLiveFragment` calls
("Anything" + " else for you today?"). 6 new tests, all passing.
`src/tests/twilioStream.visit.test.ts`'s existing
`/ask once if they need anything else/i` assertions on book_visit/
cancel_visit/reschedule_visit results still pass unchanged (the phrase is a
prefix of the new note, not replaced).

**7. Verification.** `npx vitest run` → 70 files, 827 tests, all green (827
= the 813 baseline this task inherited + Workstream D's +8 staff-matcher
tests + this workstream's +6). `npx tsc --noEmit` → clean. Grepped the diff
for `!` non-null assertions in every changed line — none introduced.

**Uncertain / worth a second look — NOT fixed, out of scope for this
workstream:** while reading the tool-registration block to find "the ONE
central place" (spec's hint), noticed `book_visit`/`reschedule_visit`/
`cancel_visit` are only registered via `registerTrackedTool` inside `if
(this.voiceEngine === 'realtime')` (twilioStream.ts ~1878-1897); the `else`
(live) branch registers only `prepare_appointment_action`/
`confirm_appointment_action`. But `liveToolDefinitions()` does NOT strip the
three visit tools from the schema handed to the Live backend model (it only
strips the raw single-appointment writes), and `backendRules.ts`
`BACKEND_TOOL_USE` instructs the backend to call them directly. If that
registration gap is real (not something registered elsewhere I missed),
calling `book_visit` on the Live path would find no handler. This predates
this workstream's changes, is not in `src/realtime/twilioStream.ts`'s
closing-mechanics area or `backendRules.ts`'s tool-use text I was asked to
touch, and touching the registration `if/else` felt too large a functional
change to make unreviewed inside a closing-mechanics task — flagging for
Aryan/the next worker rather than fixing silently.

Not committed (per task rules), not deployed, `.env`/Railway untouched, no
Phorest writes run (mocks only).

### Workstream H — visit tools registered on Live (2026-09-16)

Fixed the exact gap Workstream E flagged as "uncertain / not fixed" above:
`reschedule_visit`, `cancel_visit`, `book_visit` were registered only inside
`twilioStream.ts`'s `if (this.voiceEngine === 'realtime')` branch (mis-
indented, so it read as flat top-level registration on a skim) while
`liveToolDefinitions()` kept advertising all three to the Live backend model
and `backendRules.ts` told it to call them directly. On `VOICE_ENGINE=live`
in production, calling one landed in `liveSession.ts`'s `runTool` with no
handler, which returned a raw `{error: 'No handler registered for tool ...'}`
that the backend model swallowed — Erica told a caller on 2026-09-15 she
could not check a combined opening, previously mis-attributed entirely to a
prompt-side ban (already fixed under a different workstream).

**1. Fix** (`src/realtime/twilioStream.ts`, `createSession()` ~line 1895):
moved the three `registerTrackedTool('reschedule_visit'/'cancel_visit'/
'book_visit', …)` calls out of the `voiceEngine === 'realtime'` branch to
right after `suggest_availability`, with a comment explaining they're
two-phase tools with their own read-back and are the Live path's only
appointment writes besides the `prepare_appointment_action`/
`confirm_appointment_action` proposal pair. `book_appointment`/
`reschedule_appointment`/`cancel_appointment` stayed Realtime-only; the
proposal pair stayed Live-only. No handler logic, tool descriptions, or
prompt text touched.

**2. Accessors added** (both session classes, so a test doesn't have to
reach into the private `toolHandlers` map): `registeredToolNames(): string[]`
on `OpenAILiveSession` (`src/voice/liveSession.ts`, right after
`registerTool`) and on `OpenAIRealtimeSession` (`src/realtime/openaiSession.ts`,
same spot). Both just `Array.from(this.toolHandlers.keys())`.

**3. New test file** `src/tests/toolRegistration.test.ts` (5 tests, all
passing):
- `"every tool the Live backend is offered has a handler (2026-09-16: visit
  tools were Realtime-only and Erica said she could not check a combined
  opening)"` — two tests: constructs a call, sets `voiceEngine`, calls the
  real (private, but reachable via `call: any`) `createSession()`, then
  asserts every name in `liveToolDefinitions()` / `TOOL_DEFINITIONS` is in
  `call.session.registeredToolNames()`. This is the test that would have
  caught the defect — it fails red on the pre-fix code (verified before
  fixing) because `reschedule_visit`/`cancel_visit`/`book_visit` are
  advertised but not registered on the Live engine.
- `"reschedule_visit/cancel_visit/book_visit are dispatchable through a
  Live-engine session (not just callable directly)"` — three tests, one per
  visit tool. Each builds a Live-engine call, calls the real
  `createSession()`, then invokes `(call.session as any).runTool({name,
  arguments, callId})` — `OpenAILiveSession`'s own private dispatch method,
  the same path a real Live tool call takes (JSON-parse args → toolHandlers
  lookup → invoke → JSON-stringify result) — rather than calling
  `handleRescheduleVisit`/`handleCancelVisit`/`handleBookVisit` directly.
  Each asserts the result is the handler's own deterministic early-return
  (`reschedule_visit`/`cancel_visit` with unserved appointmentIds → "please
  call list_appointments"; `book_visit` on a closed Sunday, 2025-10-05, same
  fixture date `twilioStream.toolNotes.test.ts` uses → "closed on that
  date") and explicitly asserts the result does NOT match `/no handler
  registered/i`.

**4. Verification.** `npx vitest run` → 71 files, 832 tests, all green (832
= the 827 baseline this task inherited + this workstream's +5).
`npx tsc --noEmit` → clean. Grepped the diff for `!` non-null assertions —
none introduced. Diff touches only `src/realtime/twilioStream.ts` (moved 3
registration lines + comment), `src/voice/liveSession.ts` +
`src/realtime/openaiSession.ts` (one accessor method each), and the new test
file — no handler logic, tool descriptions, or prompt/backend-rule text
changed.

**5. Lessons.** Appended a 2026-09-16 addendum to the existing "a tool the
backend may not call does not exist" entry in `tasks/lessons.md`: the same
tool was also never registered on the Live engine; a contract test now
guards every advertised tool has a handler; a tool test that calls the
handler method directly does not prove the tool is reachable.

Not committed (per task rules), not deployed, `.env`/Railway untouched, no
Phorest writes run (mocks only, PHOREST_WRITE_MODE respected).

### Workstream F — no-non-null-assertion (2026-09-16)

Turned on `@typescript-eslint/no-non-null-assertion: 'error'` in
`.eslintrc.cjs` (with an `overrides` entry setting it back to `'off'` for
`src/tests/**` and `scripts/**`) and removed every `!` non-null assertion
from `src/**/*.ts` outside `src/tests/`.

**Baseline note:** `npm run lint` as written (`eslint . --ext .ts`) does not
run at all on this box — ESLint 9.36 requires `eslint.config.js` (flat
config) by default and refuses the legacy `.eslintrc.cjs` outright. Every
lint invocation in this workstream (including the baseline) used
`ESLINT_USE_FLAT_CONFIG=false npx eslint . --ext .ts`. That's a pre-existing
environment gap, not something this task touched — flagging it rather than
migrating the config, which was out of scope. Baseline (before adding the
rule): 279 problems, all `no-explicit-any` / `no-unused-vars` in test files
and two `liveSession.ts`/`liveSession.ts` spots — zero non-null-assertion
errors reported yet since the rule wasn't on. Live `!` count once the rule
was turned on: **106** sites across `src/**/*.ts` outside tests (audit's
~98 estimate was against an earlier revision; `smsRouter.ts`, which the
audit listed at 2, actually had zero real sites — just exclamation marks in
comments/strings).

| File | Sites | a (restructure) | b (optional chaining) | c (explicit guard/throw) |
| --- | --- | --- | --- | --- |
| `src/config/env.ts` | 1 | 0 | 0 | 1 |
| `src/routes/admin.ts` | 1 | 1 | 0 | 0 |
| `src/voice/liveSession.ts` | 2 | 2 | 0 | 0 |
| `src/services/smsOwner.ts` | 2 | 1 | 0 | 1 |
| `src/services/postCallSummary.ts` | 2 | 2 | 0 | 0 |
| `src/services/phorest.mock.ts` | 2 | 0 | 0 | 2 |
| `src/core/visits.ts` | 4 | 0 | 0 | 4 |
| `src/realtime/openaiSession.ts` | 4 | 4 | 0 | 0 |
| `src/services/phorest.simulated.ts` | 4 | 0 | 0 | 4 |
| `src/services/booking.ts` | 5 | 4 | 0 | 1 |
| `src/core/hours.ts` | 6 | 0 | 0 | 6 |
| `src/services/liveTestTelemetry.ts` | 7 | 7 | 0 | 0 |
| `src/services/phorest.client.ts` | 13 | 3 | 0 | 10 |
| `src/voice/livePrompts.ts` | 13 | 2 | 9 | 2 |
| `src/realtime/twilioStream.ts` | 40 | 6 | 1 | 33 |
| **Total** | **106** | **32** | **10** | **64** |

**The one intended behaviour change** (per the audit, §6): in
`twilioStream.ts`'s `findNearbyAvailability`, `canonicalNames.get(alternative.date)!`
used to silently coerce a missing canonical service name to `undefined` and
write an offered-slot key built from it — weakening the fresh-slot gate on
that date instead of crashing. Now: if the name is missing, we log a warning
(`'findNearbyAvailability: missing canonical service name — skipping
offered-slot write for this date'`) and skip writing that date's slot key
entirely, so the gate stays strict. In the current code this branch is
unreachable in practice (`canonicalNames.set` and the `alternativeDates.push`
that creates the corresponding entry happen together in the same `if`
block), but the fix removes the silent-weakening failure mode the audit
flagged, matching the task's explicit instruction.

**Representative patterns used (not one-off per file):**
- Edit-distance DP table in `twilioStream.ts`'s `editDistance` rewritten
  with named `prev`/`cur` row locals and cell guards — same O(n·m), all unit
  tests green.
- `spreadAcross` (twilioStream.ts) and `firstStart`/`planStartAt`
  (visits.ts / twilioStream.ts book_visit & reschedule_visit, 12 sites) get
  small local helpers that destructure-and-throw on the "impossible" branch
  instead of asserting past it — these are the audit's "safe while
  `items.length === durations.length`" class.
- `isoDateOrThrow` / `todayISO` helpers (added independently in
  `phorest.client.ts`, `phorest.simulated.ts`, `phorest.mock.ts`,
  `hours.ts`, `twilioStream.ts`) replace `DateTime.now()...toISODate()!` and
  validated-DateTime `toISODate()!` sites — these DateTimes cannot be
  invalid, so the throw path is unreachable; per the task's own instruction
  a comment says so at each helper.
- Regex match-group sites in `livePrompts.ts`'s `productionFacts` (9 of its
  13 sites) switched to `match?.[1]` + a truthy check instead of
  `if (match) …[1]!` — behaviourally identical since every affected group is
  `(.+?)` (at least one char).
- `only<T>(arr): T | undefined` helper in `booking.ts` replaces the
  `if (arr.length === 1) return arr[0]!` pattern (4 of its 5 sites).

**One incidental hardening beyond canonicalNames, flagged for visibility:**
`phorest.client.ts`'s `getTodayAppointments` and the tail of `listAppointments`
build `startLocal`/`start` from `DateTime.fromISO` on Phorest's own
`appointmentDate`/`startTime` fields with no prior `.isValid` check (unlike
`parseSalonDateTime`, which throws on bad input elsewhere in the same file).
Previously `.toISODate()!` would silently pass a literal `null` into a
`date: string` field if Phorest ever returned an unparseable date; now
`isoDateOrThrow` throws instead. This is consistent with the file's existing
throw-on-invalid convention and is not reachable by anything Phorest has
ever actually returned in this codebase's tests or manual probes, but it IS
a stricter failure mode than before for a hypothetical malformed Phorest
response, so it's called out rather than folded silently into the "no
behaviour change" claim.

**Not resolved without further restructuring:** none. Every site was fixed
without a cast (no `as T`, no `as unknown as`, no type-only cast) and
without an inline `eslint-disable`.

**Verification.** File-by-file: `npx tsc --noEmit` clean and the covering
test file(s) green after every file (see per-file `npx vitest run <pattern>`
runs during this workstream — `env`/`admin`, `smsOwner`/`postCallSummary`/
`phorest.mock`/`liveSession`, `visits`/`openaiSession`/`phorest.simulated`/
`phorest.client`, `hours`/`booking`, `liveTestTelemetry`,
`phorest.selector`/`appointment`, `livePrompts`, then per-cluster
`twilioStream.*` suites). Final: `ESLINT_USE_FLAT_CONFIG=false npx eslint .
--ext .ts` → 279 problems, all pre-existing `no-explicit-any`/
`no-unused-vars` (identical to baseline), **zero** `no-non-null-assertion`
errors. `npx tsc --noEmit` → clean. `npx vitest run` → 71 files, 832 tests,
all green (same 832 as before this workstream — no test files touched,
confirmed via `git diff --stat -- src/tests/ scripts/` showing no output).
Grepped the diff for new `as `-casts and `eslint-disable` comments — none.

Not committed (per task rules), not deployed, `.env`/Railway untouched, no
Phorest writes run (`PHOREST_WRITE_MODE` untouched, no write path exercised).

### Workstream F follow-up — ESLint 9 flat config migration (2026-09-16)

Replaced `.eslintrc.cjs` with `eslint.config.js` (flat config; package is
`"type": "module"` so it's a plain ESM default export) and changed
`package.json`'s `lint` script from `eslint . --ext .ts` to `eslint .` —
`npm run lint` now runs natively on ESLint 9.36 with no
`ESLINT_USE_FLAT_CONFIG=false` escape hatch and no deprecation warning.
`.eslintrc.cjs` deleted.

**Discovery that changed the plan slightly:** reproducing the old config
"exactly" isn't just copying rules — `eslint . --ext .ts` also implicitly
scoped every rule to `.ts` files only. Plain `eslint .` in flat config does
NOT get that scoping for free from `files: ['**/*.ts']` rule blocks alone:
ESLint 9's default target resolution still parses `.js`/`.mjs`/`.cjs` files
even when no config object's `files` pattern matches them, and surfaces
their parse errors. Proved this empirically — with only
`dist/**`/`node_modules/**`/`outputs/**` ignored, `eslint .` newly reported
two `Parsing error: 'return' outside of function` hits in
`tasks/swarm-defects.mjs` and `tasks/swarm-hardening.mjs` (bare top-level
`return`, valid as CommonJS-ish script-speak but not as strict ES module
top-level code) — files `--ext .ts` never touched. Fix: added
`**/*.js`, `**/*.mjs`, `**/*.cjs` to the top-level `ignores` array alongside
the three requested directories. This is necessary, not cosmetic — it's
what actually restores the old `--ext .ts` scope.

**Second discovery, reported rather than silently absorbed:** the "279
pre-existing problems" baseline from the main workstream already included 5
errors (`no-empty-object-type` x3, `no-explicit-any` x1, `no-unused-vars`
x1) from three `dist/*.d.ts` files. `dist/` is git-ignored and untracked
(confirmed via `git ls-files dist` → empty) and its build output on disk
predates this session (files timestamped Sep 14, two days before this
task) — it's stale local build output, not source, and `--ext .ts` only
ever caught it because `--ext` matches by suffix (`.d.ts` ends in `.ts`).
Ignoring `dist/**` (as instructed) correctly excludes it going forward, but
means the new baseline is genuinely **274**, not 279 — a real, expected
delta, fully accounted for (verified via a sorted `diff` of the old and new
full lint output: after excluding the two `.mjs` files and the three `dist`
files, every remaining line is byte-identical between old and new). Zero of
the 5 removed errors were `no-non-null-assertion`.

**`eslint.config.js` contents** (see the file for the full version with
comments): one `ignores`-only object (`dist/**`, `node_modules/**`,
`outputs/**`, `**/*.js`, `**/*.mjs`, `**/*.cjs`); one object scoped to
`files: ['**/*.ts']` combining `js.configs.recommended.rules`, the
`@typescript-eslint/eslint-plugin` legacy `eslintrc/eslint-recommended`
override rules (disables base JS checks TS already covers, e.g.
`no-undef`/`no-redeclare`/`constructor-super`; turns on `no-var`/
`prefer-const`/etc. — confirmed this was already active in the OLD config,
since `plugin:@typescript-eslint/recommended`'s eslintrc export chains
`extends: ['./configs/eslintrc/base', './configs/eslintrc/eslint-recommended']`
internally), `tsPlugin.configs.recommended.rules`, and
`'@typescript-eslint/no-non-null-assertion': 'error'`; one object for
`files: ['src/tests/**', 'scripts/**']` turning that rule back off.

**Before/after summary lines** (both via `npm run lint` — old required the
env-var workaround, new does not):
- Old: `ESLINT_USE_FLAT_CONFIG=false npx eslint . --ext .ts` →
  `✖ 279 problems (279 errors, 0 warnings)`
- New: `npm run lint` → `✖ 274 problems (274 errors, 0 warnings)` — same
  content minus the 5 stale-`dist/`-artifact errors, zero
  `no-non-null-assertion`, zero config warnings.

**Proof the rule fires:** appended `const x = ([] as string[])[0]!;` to
`src/config/env.ts`, ran `npm run lint` → 276 problems, including
`325:11  error  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion`
(plus an expected unrelated `325:7 'x' is assigned a value but never used`).
Removed the line; `npm run lint` back to 274/274, `git diff src/config/env.ts`
empty (confirmed no residual whitespace).

**Final verification:** `npm run lint` → 274/274, zero
`no-non-null-assertion`, zero warnings. `npx tsc --noEmit` → clean.
`npx vitest run` → 71 files, 832 tests, all green (unchanged).

Not committed (per task rules), not deployed, `.env`/Railway untouched. No
other files touched — `git status` also shows `tasks/lessons.md` modified,
but that's a concurrent workstream's edit, not this one's (verified via
`git diff --stat tasks/lessons.md` before touching anything, confirming
zero overlap with this change).

## 2026-09-15 ~22:00 ET — POST-GPT-LIVE PROMPT AUDIT (commits 1f201b8, 626890e)
First audit since the Live split. All prior audits (Sept 1, Sept 3) predate it.

### 🔴 STRUCTURAL FINDING — read this before editing any prompt
`livePrompts.ts` builds its **OWN** `CONVERSATION FLOW` block for the backend
instead of reusing the production prompt's SERVE section. **Every edit to SERVE
in `twilioStream.ts` is INERT on the Live path** — including this session's
RESCHEDULE rewrite. The visit-aware `list_appointments` note worked live only
because coaching rides with TOOL RESULTS, not the prompt.
⇒ When changing behaviour: edit `livePrompts.ts` (backend flow) or a tool note.
⇒ The main prompt now only really drives the Realtime fallback path.

### Conflicts fixed (7)
1. **"Do not build a separate visit plan; prepare at most one appointment
   action at a time"** — a SECOND copy of the ban `dae29c7` fixed, sitting
   EARLIER in the prompt. Would have re-broken all three visit tools.
2. RESCHEDULE "identify the exact one they mean" (singular).
3. CANCEL "prepare one cancellation proposal" — no route to `cancel_visit`.
4. BOOK "preparing one exact proposal" — excluded `book_visit`.
5. RUNNING LATE "find today's appointment" (singular), no `alsoAppointmentIds`.
6. Live "suggest another task" vs backend "ask once whether they need anything
   else" → "propose a specific task".
7. A farewell now outranks the anything-else offer (register item 14).

### Defects found by the scenario sweep (`scripts/sim-scenarios.ts`)
- **Register item 05 (open since Sept 10) REPRODUCED + FIXED.** "eyebrow
  threading and upper lip" → stylist **MANU**: the word **"and" is 2 edits from
  "manu"** and token matching allowed 2. The bound can't be tightened (phone
  renders Richa as "Richard"/"Rishka", both 2 edits), so filler words no longer
  reach the matcher. Now returns **"Brow Thread + Lip Thread"** as closest.
- **Ten CONSECUTIVE starts** offered when the requested time was gone
  (12:55/1:00/1:05/1:10 for a 6:45 PM ask). Nearest few kept, rest spread.
  Scoped to the same-day list — nearby-DATE summaries must stay close.
- **Latent divide-by-zero in `spreadAcross`** (mine, 78ecd3a): `max === 1`
  divides by `(max-1)` → `list[NaN]`. Caught by the nearby tests.

### Verified healthy by the same sweep
eyebrow threading → Brow Threading · eyebrow tattoo → Micro Blading/Shading ·
microblading touch-up → the 6-month touch-up (not the full treatment) ·
"henna brows" → no silent substitution (O06) · unknown service and closed day
both carry correct coaching · "Richa" correctly read as a person.

### Still open
- **Register item 15 (narration)** — `5769300` focused cleanup confirmed NOT in
  the deployed line. Heard live: "Okay, checking that", "Okay, rescheduling for
  you now". Prompt already forbids it; this is a compliance gap, not a conflict.
- **Item 05's deeper half:** the PRICE path resolves "brow threading and upper
  lip" to the bundle while the AVAILABILITY path does not — the two tools still
  use different service selection. Register recommends unifying them.
- `scripts/sim-scenarios.ts` is the reusable harness for this (read-only).

**NOT DEPLOYED (7 commits):** dae29c7, fdfc73b, 78ecd3a, 2cbf7b1, 423c7c1,
1f201b8, 626890e.

## 2026-09-15 ~21:35 ET — GPT-5.6 Terra/Luna deprecation rumour: FALSE
Owner asked about Sam Altman "discontinuing Luna or Terra". Searched: **no
deprecation**. What actually happened was a **price cut on 2026-07-30** — Luna
−80% ($1/$6 → $0.20/$1.20 per M tokens), Terra −20% ($2.50/$15 → $2/$12).
OpenAI's deprecations page lists no shutdown date for sol/terra/luna; GPT-6
Astra shipped 2026-09-03 above Sol without a GPT-5.6 sunset notice.
Our config is `OPENAI_LIVE_BACKEND_MODEL=gpt-5.6-terra` — **not affected**.
NOTE: Luna is now ~10× cheaper than Terra on both input and output. The
taste-test harness already supports switching (`POST /admin/voice-test/variant`
with terra|luna|realtime), so a Luna A/B is cheap to run if cost matters.

## 2026-09-15 ~21:30 ET — multi-appointment coverage completed (commit 423c7c1)
All three write paths now handle a sitting, plus running-late.
- **book_visit** — booking twin of reschedule_visit; the direct fix for the two
  stacked 6 PM appointments (booking one at a time only asks whether each
  service is individually free, never whether they fit together). Two phases,
  non-overlapping option spread, "will not all fit at 5:30" honesty, refuses to
  write without an identified caller.
- **cancel_visit** — no planning phase; one yes, one result, same scope
  discipline (only ids the caller agreed to).
- **log_running_late `alsoAppointmentIds`** (optional) — the SAME note on every
  appointment in the sitting. Previously Richa saw a late flag on the brow
  threading and nothing on the lip threading five minutes later.

All execute sequentially through the existing single-appointment handlers, so
every write guard applies unchanged; partial success reported honestly.
**Backend prompt updated in the same commit** — dae29c7's lesson: a tool the
backend is forbidden to call is a tool that does not exist. Tests now assert
all three tool names survive in the backend prompt. 792 green, tsc clean.

## 2026-09-15 ~21:00 ET — multi-appointment coverage: where the gaps are
Owner asked whether the visit work covers book / reschedule / cancel. It covers
**reschedule only**. Schema check: only `reschedule_visit` takes an array;
`book_appointment`, `cancel_appointment` and `log_running_late` are all single.

- **RESCHEDULE — done** (`reschedule_visit`, 8b6f3bf + dae29c7 + 78ecd3a).
- **BOOK — the dangerous half is fixed, the smooth half is not.** Same-time
  double-booking is now PREVENTED because availability is truthful. Proven in
  tonight's log: Brow booked 16:00 → the very next `suggest_availability` for
  Chin returned `3:25…3:50, 4:05…4:20` with **3:55 and 4:00 absent** (the new
  brow appointment), and Chin went to 16:05. But there is no joint plan: she
  books one, re-checks, books the next, narrating between — the same UX the
  visit tool removed for reschedules. Adjacency tonight was luck (nearest to
  the asked time), not design.
- **CANCEL — not grouped.** `list_appointments` now names both (visit-aware
  note), but cancelling is one call each with narration between and two
  confirmations. No scheduling risk — purely conversational.

Gaps the owner had NOT raised:
- **`log_running_late` takes ONE appointmentId.** A caller with a two-service
  visit running late gets only one appointment flagged; Richa's FYI text names
  one service and one time. Misleading for a grouped visit.
- **Adding a service to an existing visit** ("I have brow at 4, add lip right
  after") — no special handling; treated as an unrelated booking.
- **Mixed operations** (cancel one, move the other in the same call) — each
  runs separately; no combined read-back.

Suggested order if pursued: cancel grouping (cheapest, no planning needed) →
book-visit planning (most common call) → running-late for a visit.

## 2026-09-15 ~20:55 ET — closing: the missing half (commit 2cbf7b1)
`96dc707` taught Erica to close when the CALLER speaks first ("all right").
Nothing told her that FINISHING a job is itself the cue to lead — so she
confirmed a completed reschedule and went silent. Owner spotted it.

Why nothing covered it:
- book/reschedule/cancel success notes only describe what to do if the caller
  LATER wants to change the booking — nothing about the conversation ending.
- `CLOSE` only fires "when clearly done"; no rule sets that state.
- **Self-inflicted:** `8b6f3bf`'s reschedule_visit note said "…then stop",
  written to stop rambling but it forbade the follow-up question outright.

Fixed in the BACKEND closing rule (uncapped section — production prompt
untouched, voice still 899/900):
> "When the caller's request is fully handled — the booking, change,
> cancellation, or message is done, or their question is answered and nothing
> is pending — take the lead: ask once whether they need anything else, then
> wait. **Never ask this after an intermediate step, while any part of their
> request is still open, or a second time in the same call.**"

The guard is the important half: without it a mid-booking price question would
trigger "anything else?" and derail the flow. Covers short calls too (hours,
price) which previously just trailed off.
`then stop` → `then ask once if they need anything else` in the visit note.
Tests assert the rule, the guard, and the removal of "then stop". 785 green.

**NOT DEPLOYED (4 commits):** `dae29c7`, `fdfc73b`, `78ecd3a`, `2cbf7b1`.
Deploy from `~/Documents/Dev/ai-receptionist-live-2026-09-12` ONLY — deploying
from the main repo silently rolls production back (see 20:05 entry).

## 2026-09-15 ~20:35 ET — blocked-visit-time handling (commits fdfc73b, 78ecd3a)
Owner asked: 3 × 10-min services, caller wants 3 PM, another client at 3:15 —
does Erica shift the block? Tested rather than assumed. Two real defects found:

1. **Alternatives were near-duplicates.** Ranking plans purely by distance from
   the requested time returned **2:50 / 2:45 / 2:40** — three overlapping
   versions of one answer — and never surfaced the run AFTER the obstacle.
   Fixed: option starts must sit ≥ one whole visit apart (floor 15 min) ⇒
   `['14:50', '15:25']`. Same reasoning as the original selectOfferedSlots
   spread guard.
2. **She never said the requested time was the problem.** Plan result now
   carries `requestedUnavailable` (spoken form, e.g. "5:30 PM") and the note
   tells her to say so in the same breath as offering the nearest fit — "never
   present an alternative as if it were the time they asked for".

Already worked, now covered directly: shifting the whole run (3 PM blocked →
2:50/3:00/3:10, every start real, 3:00 never offered); N appointments (3 with
10/15/20-min services); subset moves (2 of 3 → exactly 2 writes, the unnamed
one never touched).

**Deliberate limitation:** the planner keeps a visit CONTIGUOUS and will not
split it around an obstacle (two before, one after). Splitting makes the caller
wait mid-visit; if wanted, it should be a deliberate offer, not a silent one.

**Known perf note:** availability is fetched once per appointment sequentially
(~150–350 ms each). Fine at 2–3; parallelise if 5-service visits become normal.

**NOT DEPLOYED:** `dae29c7`, `fdfc73b`, `78ecd3a`. Deploy from
`~/Documents/Dev/ai-receptionist-live-2026-09-12` ONLY.

## 2026-09-15 ~20:05 ET — deploy mishap + reschedule_visit was unreachable

**⚠️ Wrong directory deployed first.** `railway up` was run from
`~/Documents/Dev/ai-receptionist` (main, 577693d) instead of the live worktree.
BOTH folders are linked to the same Railway service, so it silently rolled
production back to Sept 12 — GPT-Live gone, Loretta bug live again. Caught by
`/admin/voice-test` returning **404** (that route exists only on the live
branch) while `/admin/api/calls` still returned 200.
**Verification rule from now on: a booted container proves NOTHING. Hit an
endpoint that exists only in the intended build.** Re-deployed from the live
worktree; `/admin/voice-test` now reports `engine: live`.

**✅ F1 confirmed fixed live** (call `CA4fc18ea61a5343563e751ca5721edcbe`):
> "I see Brow Threading at 4:00 PM and Chin Threading at 4:05 PM tomorrow.
>  Would you like to move the whole visit or just one service?"

**🔴 F2/F3 failed — reschedule_visit was never called.** Erica said
*"Sorry, I'm unable to check a combined opening for both services right now."*
Root cause was NOT the tool list (`liveToolDefinitions` only strips
book/reschedule/cancel_appointment, so reschedule_visit passed through). Two
BACKEND PROMPT rules forbade it:
- "Never call a raw booking, reschedule, or cancellation write tool."
- "prepare at most one appointment action at a time. Do not create an aggregate
  plan or promise combined feasibility without returned evidence."
She obeyed both, had no path left, and apologised.

**Fixed in `dae29c7`** — backend prompt carve-out naming reschedule_visit as
the one exception, with its two-phase contract and "its returned options ARE
the evidence of combined feasibility". Safe because
`AppointmentProposals.execute` calls the SAME `handleReschedule`, so write
guards are identical; the proposal layer's read-back/approve machine is
replaced by reschedule_visit's own plan → confirmed gate.
Guard test added so the ban cannot silently return.

**LESSON:** adding a tool to `TOOL_DEFINITIONS` is not enough on the Live path
— the BACKEND PROMPT must also permit it. Check `livePrompts.ts` BACKEND TOOL
USE for conflicting bans whenever a write-ish tool is added.

**Minor, not yet fixed:** caller said "both of them to 3 PM"; Erica then asked
"What day would you like to move both appointments to?" — carry-over miss on a
day already implied ("tomorrow" established earlier in the call).

**NOT DEPLOYED:** `dae29c7`. Owner must run `railway up --service erica
--detach` **from `~/Documents/Dev/ai-receptionist-live-2026-09-12`**.

## 2026-09-15 ~00:05 ET — F4 FIXED (commit 96dc707) — two sentences, no code
- **Voice model** (`livePrompts.ts` delegation policy): now delegates the
  done-close whenever the caller SIGNALS they are finished, including "a bare
  acknowledgement after something you completed". Describes the situation, not
  a keyword list (a list would miss "cool"/"yep"/"lovely" and grow forever).
- **Thinking model** (backend end_call bullet): "A request you have completed
  and confirmed, followed by an acknowledgement that asks for nothing further,
  counts as clearly done; when it is genuinely unclear, ask once whether they
  need anything else instead of ending." end_call's bar otherwise untouched.
- **Both prompts were AT their caps** (voice 899/900, main 4186/4200) so
  nothing could be appended. The delegation policy already restated "ending is
  an application action" one sentence after "the backend handles … call
  closing" and repeated the delegate-on-finish idea twice — merging those
  reclaimed 170 chars and paid for the wider trigger. **Voice prompt back to
  899/900, net zero.**
- Deliberately NOT done: no per-tool closing notes (one rule × four copies =
  drift); no change to `SILENCE_CHECKIN_MS` (dead-air backstop, not a
  conversation rule — shortening clips callers who pause to think).
- 777 tests green, tsc clean. `livePrompts.test.ts` now asserts the RULE and
  its widened trigger rather than the old sentence.

### ⚠️ Deploy state
`7623802` (slot integrity) is LIVE. `8b6f3bf` (visit planning) and `96dc707`
(closing) are committed but **NOT deployed** — owner runs
`railway up --service erica --detach` from the live worktree; the harness
blocks production deploys from the agent.

## 2026-09-14 ~23:20 ET — F4 ROOT CAUSE: Erica is forbidden from closing on her own
Investigated `CA57b7d8e37eb91ed3ecea117a3cdd3f34` (+142.7 s "All right" → total
silence → caller hung up 22 s later). It IS the prompt, and it is GPT-Live
specific.

**Direct cause — `src/voice/livePrompts.ts:188` (Delegation policy).** In the
Live split the voice model may NOT end a call itself; closing belongs to the
backend:
> "…and call closing. **Ending the phone connection is an application action:
> always delegate when the caller says "that is all", "goodbye", or asks to
> hang up.**"
Three literal triggers. "All right" / "okay" / "great" / "thanks" match NONE.
So the voice model had no permitted action for that turn and emitted nothing.
This is why the silence was TOTAL rather than a wrong reply.

**Compounding — main prompt biases hard toward silence:**
- L679 `LET THE CALLER LEAD`: "…An empty or noise-only turn gets silence, not
  another greeting, question, or menu. Clarify only intelligible but INCOMPLETE
  addressed speech." — "All right" is complete but contentless: unhandled.
- L698 `UNCLEAR AUDIO`: "Empty audio, noise, media, silence, and side
  conversation get no response."
- L711 `end_call`: "only when caller is CLEARLY done."

**Missing rule:** nothing routes her into `CLOSE` (L744) after she COMPLETES a
task. She confirmed the new times as instructed, then stopped. CLOSE only fires
"when clearly done" / "otherwise ask once if they need anything else" — but no
rule says a finished booking/reschedule/cancel enters CLOSE.

**Safety net too slow to matter.** `SILENCE_CHECKIN_MS`=20 000 and
`lastActivityAt` resets on caller speech, so the check-in was due ~02:44:00 —
the same second the caller hung up. No `🤫 silence check-in` line in the logs.
Even working perfectly that is 20 s of dead air after a finished task.

**Proposed fix — prompt/notes only, no code:**
1. `livePrompts.ts` delegation triggers: add closing acknowledgements
   ("all right", "okay", "great", "thanks", "perfect", "sounds good", "that's
   it") — but ONLY after a completed+confirmed task, so mid-conversation
   acknowledgements never end a call.
2. Completed-action result notes (book/reschedule/cancel/reschedule_visit):
   after confirming, ask ONCE if they need anything else. Coaching-rides-with-
   data idiom ⇒ zero global prompt tokens (budget has ~9 tokens spare).
3. Leave end_call's "CLEARLY done" bar alone — the backend still decides; this
   only lets the front-end hand the turn over.

RISK to respect: closing too eagerly is worse than closing late. Ambiguous
acknowledgement ⇒ "anything else?", never a direct hangup.

## 2026-09-14 ~22:50 ET — 4 new findings from the same call (NOT yet fixed)
Transcript + logs for `CA57b7d8e37eb91ed3ecea117a3cdd3f34`.

**F1 — only the soonest appointment is named. ROOT CAUSE FOUND, not a model
failure.** Two instructions explicitly order it:
- prompt line ~738: `RESCHEDULE: list_appointments → lead with the soonest,
  confirm it's the one they mean (if not, mention the next) → …`
- `handleListAppointments` success note: *"Sorted soonest-first. Lead with just
  the soonest one … never a long list."*
`list_appointments` DID return both (count=2). Erica obeyed. Fix = make the
note/flow VISIT-aware: appointments sharing the soonest DATE are one visit and
must be named together; "lead with the soonest / no long list" should only
apply ACROSS different days.

**F2 — narration between the two writes.** Sequence: reschedule lip → success →
spoke to caller → suggest_availability brow → spoke → reschedule brow. Two
separate confirmations, ~50 s apart.
KEY EVIDENCE it is fixable: at 02:41:59 the model emitted TWO
`suggest_availability` calls in the SAME millisecond (…115919 / …115920), and
`liveSession.ts` already batches ("One continuation only after every result in
this backend response batch"). So parallel tool calls WORK today — the model
serialises the WRITES only because the prompt walks it through one at a time.
Real constraint: moving appt A changes availability for B, so a blind parallel
write is unsafe — the server must compute the JOINT plan before writing.

**F3 — "together" not inferred.** Caller had to ask twice ("just make them
connected together") before Erica put them back-to-back. Final 5:45/5:50 was
correct but owner-steered.

**F1–F3 are one problem: the unit of work is the APPOINTMENT, should be the
VISIT.** Proposed: server-side visit planning (find times where the whole visit
fits consecutively) + one grouped write, serialised. REUSE: the same primitive
fixes the same-client double-booking found earlier today (register item 09/R03)
— booking lip+brow currently has the identical flaw. One build, two bugs closed.

**F4 — call does not close on "All right". NEEDS MORE DATA.** Caller said
"All right" at +142.7 s; Erica produced NO response at all; call ended 22 s
later by caller hangup. No `end_call`, no silence check-in logged
(`SILENCE_CHECKIN_MS`=20000). Note this build has NO `wait_for_user` tool, so
deliberate silence is not an available model choice — the empty turn is
suspicious and may be GPT-Live turn detection, not prompt. Prompt says end_call
only when caller is "CLEARLY done"; a bare "All right" after a completion
summary is not covered. Needs: response-level logging for empty turns, and/or a
recording listen.

## 2026-09-14 ~22:45 ET — Availability fix VERIFIED in production ✅
Call `CA57b7d8e37eb91ed3ecea117a3cdd3f34` on the new build: caller asked for
5:30 PM; Erica said *"5:30 isn't available, but I can move both to 5:25 or
5:40"* — the exact behaviour the old build got wrong. Zero invented times.
Side effect: the owner's two 6:00 PM rows are no longer double-booked (moved to
5:45 lip / 5:50 brow, back-to-back), so that cleanup item is closed.

## 2026-09-14 ~22:30 ET — ✅ Loretta bug FIXED (commit 7623802, branch codex/gpt-live-taste-test)
Two-part fix — one setting, one code change:

**1. Phorest setting (owner changed, verified reaching our API).**
Settings → Online → Booking Rules → **"Booking slots: show available slots
every…" 0 min → 5 min**. Verified with `scripts/diag-visit-2026-09-15.ts`:
2026-09-15 went from 8 odd-minute starts to **20 clean 5-minute starts**, and
the occupied times (17:30/17:35 = another client, 18:00 = the owner's own
double-booking) are now visibly ABSENT. NOTE: Minimum Gap Time was briefly set
to 5 min by mistake — must be back at **0**.

**2. Code (commit 7623802).** `snapSlotsToGrid` deleted.
- `core/slots.ts`: mutating snap → `isOnGrid` / `isOnGridValue` /
  `partitionByGrid` (selection only, nothing is moved).
- `fetchOpenSlots`: Phorest starts pass through verbatim.
- `selectOfferedSlots`: lead with quarter-hours; fall back to real odd-minute
  starts only when < `MIN_OFFERED_SLOTS` (3) tidy ones exist; an explicit
  `preferredTime` still wins with the nearest REAL starts. Shared by the
  ordinary AND nearby-date paths — rule defined once.
- `suggest_availability` note gains squeeze-in coaching ONLY when odd-minute
  starts surface (coaching-rides-with-data idiom; no global prompt prose).

**No prompt conflict.** The prompt already said "never round, shift, or
approximate" and "never invent a time" — only the code was violating it.

Verified live (`scripts/sim-availability.ts 2026-09-15`): normal ask →
5:00/5:15/5:45/6:15/6:30/6:45; asking for the taken 5:30 → nearest real starts,
never 5:30; **zero invented times on any path**. 762 tests green, tsc clean.

**Still open:**
- 🟠 Same-client double-booking has NO guard (register item 09 / R03). The two
  6 PM rows `beAHoej1teD8QaXaRM9j7Q` + `3mh20Q3lrQ7kVEy9VMP9Fg` on 2026-09-15
  are still on the real calendar and need cancelling.
- 🟡 Reschedule narrated only one of two appointments (register item 08).
- ⚙️ NOT DEPLOYED — prod still runs the 09-13 build. Needs `railway up`.
- ⏰ `TRANSFER_WINDOW_END=23:00` + `OWNER_TRANSFER_MODE=real` still temporary.

## 2026-09-14 ~21:00 ET — 🔴 P0 availability bug found during owner testing
Three findings from calls `MZ44e5a955…` (00:51Z) and `MZ78d40a7a…` (00:53Z):

1. **🔴 Erica offers times Phorest never said were free** (root cause).
   `snapSlotsToGrid` ceil-rounds real free starts to :00/:15/:30/:45 and the
   snapped value is both spoken AND written. Verified live against Phorest for
   2026-09-15: real starts `17:10 17:25 17:40 17:55 18:05 18:20 18:35 18:50`
   → offered `5:15 5:30 5:45 6:00 6:15 6:30 6:45`. Zero overlap.
   The gaps between real starts are OCCUPIED appointments — 5:30 PM is another
   client's slot (the "Loretta Douglas" collision the owner spotted), 6:00 PM
   held the owner's own two bookings and was STILL being offered.
   Availability and writes are both scoped to `PHOREST_PRIMARY_STAFF_ID`, so a
   second stylist does NOT explain it. See `tasks/lessons.md` 2026-09-14.
   Repro: `npx tsx scripts/diag-visit-2026-09-15.ts`.
2. **🟠 Same-client double-booking.** `list_appointments` returned Brow Threading
   6:00 PM; 30 s later `book_appointment` wrote Lip Threading at 6:00 PM for the
   same client. No check that the caller is already busy. Live records:
   `beAHoej1teD8QaXaRM9j7Q` (Brow) + `3mh20Q3lrQ7kVEy9VMP9Fg` (Lip), both 6 PM
   2026-09-15 — **real calendar rows, need cleanup.**
3. **🟡 Reschedule named only one appointment.** Tool returned BOTH (count=2);
   the model narrated only Lip Threading. Data was correct — model/prompt issue,
   matches register item [08] whole-visit planning.
   No write occurred on that call (no `reschedule_appointment` in the log), so
   the other client's 5:30 PM slot was NOT touched.

**Blocks the voice production push** — item 1 can double-book real customers.

## 2026-09-14 20:33 ET — "technical problem" on call CA55a06facf701baf045781615ca3b96e3
- Cause: `GPT-Live session.start acknowledgment timed out` — the OpenAI Live
  WebSocket CONNECTED (so auth/network fine), but OpenAI never acked
  `session.start` inside `startupTimeoutMs` (hardcoded **5 s**,
  `liveSession.ts:199`). Erica's session never came up ⇒ fatal error ⇒ failover.
- Normal ack latency on this build: **360–790 ms** (four prior calls today).
  This one exceeded 5,000 ms — a 6–14× outlier. OpenAI status page: operational.
  First call on new container `2c5b361cf27d` (booted 00:06Z, call at 00:33Z, so
  not a cold start). Single occurrence so far — treat as transient until it repeats.
- ⚠️ SIDE EFFECT of today's temp config: the fatal-error failover is gated by
  `isWithinTransferWindow()`. With `TRANSFER_WINDOW_END=23:00` +
  `OWNER_TRANSFER_MODE=real`, a fatal error at 8:33 PM **dialed Richa's real
  phone** ("technical problem — let me connect you with the salon"). Under the
  old 20:00 window it would have apologized and hung up instead.
- If it recurs: `startupTimeoutMs` has no env override — would need a small code
  change in `src/voice/liveSession.ts` to make it tunable / raise it.

## 2026-09-14 ~20:08 — SMS readiness check on +1 410 304-6449 (voice number)
- Number capabilities: SMS ✅ MMS ✅ Voice ✅ — one number can serve both lanes;
  Twilio routes voice and SMS to independent webhooks. No conflict by design.
- A2P 10DLC: brand `BN7913…` **APPROVED** (STANDARD); campaign `QE2c68…`
  **VERIFIED**, use case `LOW_VOLUME`. Number IS in Messaging Service
  `MGe6d6c080997f3dfa6469d103f06848c6` sender pool. Registration is NOT a blocker.
- ❌ **Inbound SMS webhook is still Twilio's demo URL**
  (`https://demo.twilio.com/welcome/sms/reply`). Anyone texting the salon number
  right now gets Twilio's canned demo reply. Messaging Service
  `inbound_request_url` is also unset.
- ⇒ Before the SMS lane goes live: point the number's SMS webhook at the app's
  `/twilio/sms` route (or set the Messaging Service inbound URL) — the SMS lane
  itself (`aab4d04`+) is also still undeployed.

## 2026-09-14 ~20:06 — Testing-window config (TEMPORARY — revert after testing)
- `TRANSFER_WINDOW_END=23:00` on Railway (was unset ⇒ 20:00 default in this build).
  Aryan asked for 11 PM so evening transfer testing is possible. **Revert to unset
  (or 20:00) when testing ends** — until then a real 10 PM caller can ring Richa.
- Still set from earlier today: `OWNER_TRANSFER_MODE=real`, `OWNER_SMS_MODE=simulate`.
- Deployment `31b58bc8` (2026-09-15T00:04Z) carries both.
- NOTE: this build's `isWithinTransferWindow` ALSO requires the salon to have hours
  that weekday (`8607ef1`) — Sundays stay transfer-free regardless of the window.

## 2026-09-14 ~19:38 — Transfer to Richa was disabled in prod (diagnosis + fix)
- **Symptom:** live test calls — Erica says "I'm not able to place that call in
  this test"; the failed-transfer failback fix could not be exercised.
- **Root cause:** Railway had `OWNER_TRANSFER_MODE=simulate` (GPT-Live taste-test
  guard). `twilioStream.ts` short-circuits BEFORE the Twilio `<Dial>`, records
  `transfer_to_owner ok:true {simulated:true}`, and returns a note instructing
  Erica to tell the caller the transfer was simulated. No dial ⇒ no ring-out ⇒
  `POST /twilio/dial-status` never fires ⇒ `transferFailed=1` failback is
  unreachable by design.
- Evidence: call `CA5e37463cdbd15ea42fadfdc15083e0ad` (19:26 ET) — transcript +
  `tools:[{transfer_to_owner, ok:true}]`, `outcome:none`. Window/vacation gates
  both passed (19:26 is inside 09:00–21:00; vacation ended 09-09).
- **Note:** prod runs branch `codex/gpt-live-taste-test` (worktree
  `../ai-receptionist-live-2026-09-12`), NOT `main` — main has no GPT-Live code,
  no `src/voice/`, and no `OWNER_TRANSFER_MODE`. Don't debug prod from main.
- **Fix applied (Aryan-approved):** `OWNER_TRANSFER_MODE=real` on Railway +
  `railway redeploy` (deployment `9b5f90c8`, 23:36 UTC). Verified live via
  `GET /admin/voice-test` → `ownerTransfers:"real"`.
  `OWNER_SMS_MODE` deliberately left `simulate` (no texts to Richa while testing).
- **Still open:** `OWNER_TRANSFER_MODE` should go back to `simulate` when taste
  testing resumes. `PHOREST_WRITE_MODE=real` — test bookings hit the real
  calendar (one Brow Threading 2026-09-15 18:00 booked during today's testing).

## 2026-09-13 — SMS BOOKING LANE BUILT (branch `feat/erica-sms-booking`, NOT deployed)

- Worktree `/Users/aryangupta/Documents/Dev/ai-receptionist-sms-2026-09-13`, branch
  `feat/erica-sms-booking` off `codex/gpt-live-taste-test` (59906ec), commit `aab4d04`.
  **Not merged, not deployed, by Aryan's explicit instruction.** The GPT-Live owner taste
  test is still open; deploying both at once would make a regression unattributable.
- **Why:** the number's `smsUrl` still points at `https://demo.twilio.com/welcome/sms/reply`,
  which Twilio retired — it 301s to HTML, so Twilio gets invalid TwiML and sends nothing.
  **57 real client replies have been received and silently dropped** (all warm, zero
  opt-outs). Verified against the live Twilio API this session.
- **What shipped:** `routes/sms.ts` (signature-verified inbound webhook, acks immediately
  and works async), `smsRouter` (four lanes on one number: owner / compliance /
  review_reply / booking), `smsStore` (append-only JSONL threads + durable opt-out),
  `smsAgent` (text turn over the EXISTING booking tools — no new Phorest logic),
  `smsOwner` (Richa texts instructions in, Erica carries them out), `smsSender` (single
  exit point so the opt-out check cannot be bypassed), `smsCompliance`.
- **Ships inert:** `SMS_ENABLED=false`, `SMS_SEND_MODE=simulate` by default.
  `SMS_SEND_MODE` is deliberately independent of `PHOREST_WRITE_MODE` — one protects the
  calendar, the other protects the client's handset, and a taste test wants real calendar
  writes with zero real texts.
- **Verified:** 752/752 tests (700 baseline + 52 new), clean `tsc`, and an end-to-end
  smoke through the real route with a valid Twilio signature. STOP opted out and
  confirmed; "anything Thursday for brow threading?" returned a correct three-option
  reply from a real availability lookup. Mock Phorest, simulated send — no customer
  texted, no calendar written.
- **Two real bugs caught by pinning tests to the actual dropped backlog** rather than to
  invented examples: (1) an iOS tapback emoji is wrapped in U+200B, which JS `\s` does
  not match, so a pure "🤗" read as a real message; (2) "cancel my 3pm" must never be an
  opt-out — whole-message keyword match only.
- **Note for a fresh worktree:** it has no `.env` or `node_modules`, and without `.env`
  36 voice tests fail on empty Twilio creds — that is an artifact, not a regression.
  Symlink both from the main checkout, as `ai-receptionist-live-2026-09-12` does.
- **Decisions (Aryan, 2026-09-13):** one number for now, second only if problems appear;
  persona is "Erica, Richa's assistant" and never claims to be Richa; out-of-scope →
  Erica texts Richa at `+14433706471`, Richa replies with an instruction, Erica acts and
  confirms; do not answer the 57 historical replies.
- **Next, in order:** (1) close the GPT-Live taste test; (2) merge and deploy with
  `SMS_ENABLED=false` — safe, changes nothing; (3) repoint the number's `smsUrl` to
  `<host>/twilio/sms` (**Aryan only** — outward-facing change to the number clients
  text); (4) `SMS_ENABLED=true` with `SMS_SEND_MODE=simulate` and taste-test from
  Aryan's handset; (5) flip `SMS_SEND_MODE=real`. Rollback at any point is
  `SMS_ENABLED=false`.
- **Not built (deliberate, Phase 2):** outbound campaigns. Before any outbound wave:
  Phorest's native rebooking SMS is ON, so a cross-system ≤1 msg/48–72h cap is
  mandatory, and the A2P campaign description (currently "asking for Google reviews")
  should be broadened to include booking.

## 2026-09-13 — GitHub main reconciled to the deployed line

- Aryan authorized pointing `main` at what actually runs. GitHub `main` had diverged from production on 2026-09-03 at `117ada0`: 20 commits on main that production never had, 57 on the deployed branch that main never had. Production was correct; `main` was a different, never-deployed Erica.
- REVIEW OF ALL 20 — nothing needed porting: 16 were documentation. Of the 4 code commits, `9101f95` (Phorest placeholder email) and `f270e17` (service-name matching) are ALREADY satisfied in production by different implementations — verified `PLACEHOLDER_EMAIL_DOMAIN` present, and "eyebrow threading plus upper lip" resolves to Brow Thread + Lip Thread in live calls via SERVICE_ALIASES rather than main's TOKEN_SYNONYMS. `37d1d93` is obsolete: its `wait_for_user` silent tool exists only to let the Realtime engine decline to speak on a non-addressed turn, which GPT-Live handles natively, and its prompt reorganization added no section production lacks while the deployed prompt has been revised many times since. `5644669` bundles phone and name into one question, which Aryan explicitly REJECTED — merging main would have silently reinstated it. There is no automatic live→realtime fallback; VOICE_ENGINE is explicit, so legacy code cannot re-enter service by accident.
- CORRECTION CAUGHT BEFORE ACTING: the 16 "documentation" commits were NOT superseded. They created 11 files that existed only on main, and the live CODEMAP/state.md link to 6 of them (nearby/tattoo release twice, the 09-03 prompt audit, booking hotfix, conversation release, release assessment, repetition review). All 11 were copied onto the deployed branch first — documentation only, no source/prompt/test touched — and every previously dangling link now resolves.
- SAFETY: `archive/main-pre-reconcile-2026-09-13` was pushed to GitHub at `a2fcd35` (main's exact pre-rewrite state) and verified BEFORE any rewrite. All 20 commits remain reachable; the reconciliation is fully reversible.
- `main` now equals the deployed line, so the obvious place to look is the code that actually runs. Do not resurrect `5644669`'s combined phone/name question from the archive.

## 2026-09-13 — Carry-over + transfer-failback fixes DEPLOYED

- Aryan authorized deployment of both fixes. Runtime source `3eda50a` on `codex/gpt-live-taste-test`, Railway deployment `6bfed3c4-876c-43a4-ad87-c05b3bcaeeb8` SUCCESS (project `adf5ecf3-d8d2-4809-93d7-0cb45e96f070`, service `c82cc5c8-fac5-4f0d-ad7b-800253007265`). 703 tests / 63 files and `tsc` passed before upload. Zero active calls confirmed before and after.
- Post-deploy state UNCHANGED and verified: health 200, `engine: live`, `backendModel: gpt-5.6-terra`, `writes: real`, `callerAccess: all`, `ownerTransfers: simulate`, `ownerNotifications: simulate`, activeCalls 0.
- Carry-over fix VERIFIED IN PRODUCTION by hosted read-only replay `CA_probe_1789340399907` (scenario reproduces the 10:25 owner call turn for turn). Erica asked "What service would you like to book **for tomorrow**?" and went straight to tomorrow's times — no "what day would you like?". One `suggest_availability`, outcome `none`, no appointment write. Pre-deploy that scenario re-asked the day in 2 of 5 local replays.
- Transfer-failback fix is NOT production-verified and deliberately so: proving it needs a real unanswered dial to Richa's phone. Covered at the wiring level by `src/tests/twilioStream.failbackWiring.test.ts` (reverting the one line fails both tests). It will show on the next genuine failed transfer — watch for a second-leg greeting that does NOT repeat the recording disclosure and does NOT offer to connect again.
- Grouped visits (issue 08): Aryan DECLINED implementation — low volume, and the change lands in the Phorest adapter where the known traps live. Design stays in `docs/GPT_LIVE_GROUPED_VISIT_PLAN_2026-09-12.md`, not scheduled. A read-only probe confirmed Phorest DOES return complete paired visits from one availability request (two services -> 5 whole-visit options vs 8 single-service, each with per-service start/end and the same staff member); evidence in `outputs/visit-availability-probe/`. Our adapter already builds the multi-service request shape and sends one service. If this is ever revisited, no scheduling logic is needed and the write path need not change.
- Garbled-input approval guard: DEFERRED by Aryan (legacy-engine incident, Live audio understanding is better). Note the production UNCLEAR AUDIO rule is still stripped from both Live prompts by `rewriteReasoning` — the protection is absent on Live even though that specific incident is likely a transcript artifact.
- PENDING: GitHub `main` remains behind deployed code. Reconciling it is a separate decision — state.md repeatedly warns not to deploy or bulk-merge main.

## 2026-09-13 — Live transfer-failback greeting WIRED (not deployed)

- `CA4692de2d1423d376a85443f9ae049dbd` showed a failed transfer returning a fresh greeting plus a second promise to connect. On Live the cause is wiring, not the prompt: `buildLivePrompt` was called at `twilioStream.ts` without `greetingContext`, so it defaulted to `new_call` and the written-and-tested `transfer_failback` branch was never reached in production. The backend prompt already received the continuation note, so only the speech model was wrong — hence the re-greeting AND the retracted transfer offer.
- Fix: pass `greetingContext: this.transferFailback ? 'transfer_failback' : 'new_call'`, and extend the existing failback branch with "her phone already rang out on this call, so never offer or promise to connect them again; a request to reach her can only become a message." The FAILBACK GATE in `handleTransferToOwner` already refused the second dial — no caller was ever dialed twice.
- New `src/tests/twilioStream.failbackWiring.test.ts` covers the CALL SITE, which is the gap that let this ship: reverting the one line makes both tests fail with `expected undefined`. 703 tests / 63 files and tsc pass.
- Owner decision: garbled-input approval guard is DEFERRED — that incident was on the legacy engine and Live's audio understanding is better; revisit if production shows it. The unclear-audio rule remains absent from the Live prompts (`rewriteReasoning` strips it); recorded, not fixed.
- Grouped visits: root cause identified as an INSTRUCTION, not a missing feature. `handleListAppointments` returns every appointment but its note says "Lead with just the soonest one ... never a long list", and SERVE RESCHEDULE says "identify the exact one they mean". That is why the 09-06 caller had to discover her own eyebrow-tint appointment. No grouping/linkage heuristic is needed to fix disclosure. Not implemented; awaiting owner decision.

## 2026-09-13 — Live day/service carry-over fix COMMITTED (not deployed)

- Owner call `CA3d5d6bb3f6a00adcd2fe5d11b83d2ed3` (10:25 ET): caller said "tomorrow", Erica asked "What day would you like?" after resolving the service. Root cause is a deletion, not a conflicting instruction: `backendSections()` in `src/voice/livePrompts.ts` skips the whole TOOLS section, dropping the production rule `No day → today AND tomorrow` (check, never ask) from both derived prompts.
- Fix is confined to `src/voice/livePrompts.ts`: a Carry-over rule in the Live speech prompt, a CARRY OVER bullet plus a no-day fallback in SERVE BOOK/RESCHEDULE, and the same pair in BACKEND TOOL USE. Five strings locked by `src/tests/livePrompts.test.ts`. The released production prompt is byte-for-byte unchanged (locked sha256 test passes); the legacy Realtime path is untouched.
- Verified with actual Live + Terra replays through `scripts/gpt-live/controller-probe.mjs` (local, real read-only Phorest, writes forced to simulate, no dial). Defect is intermittent ~40%: before 2/5 runs re-asked the day, after 0/6, all six calling suggest_availability with date 2026-09-14. No-day control 3 runs: 2 checked today then tomorrow, 1 asked; no run assumed a day the caller had not given. 701 tests / 62 files and tsc pass.
- Same defect class found in a real customer call `CA85c9db416495728578a30a9b5e0ec42c` (09-06) in the opposite direction: service quoted at $23, then re-asked. Issue register entry 12 covers identity questions only, so service/date carry-over was uncovered until now.
- Evidence: `docs/reviews/GPT_LIVE_DAY_CARRYOVER_FIX_2026-09-13.md`.
- PENDING: deploy decision for this fix. Separately verify whether issue 30 (failed transfer returns a fresh greeting and promises the transfer again — `CA4692de2d1423d376a85443f9ae049dbd`) is live; its fix is recorded local-only in `5769300` on a different branch. Grouped visits (issue 08) remain DESIGN ONLY per `docs/GPT_LIVE_GROUPED_VISIT_PLAN_2026-09-12.md` — deliberately not implemented. That same transcript shows garbled input ("Á.", "Every.") accepted as approval of a 3:00 PM move; an approval guard for unintelligible input needs separate scoping.
- Today's other call `CA3af8fd0c74f145a20499b1483fa048f7` (10:30, painting-services pitch) was correctly flagged spam, declined and ended. No defect.

## 2026-09-12 9:12 PM — Live REAL appointment writes, all direct callers DEPLOYED

- User explicitly authorized any direct caller and real Phorest appointment changes while external salon forwarding remains off. Runtime source `b53d436`, Railway `e47db2d5-d2c4-462c-aa49-d88c78b03bc8` SUCCESS. Eight source/build hashes match; 700 tests / 62 files and TypeScript build pass.
- Current status: Live + Terra, PHOREST_WRITE_MODE=real, callerAccess=all, zero active calls, health200. Owner SMS/transfers remain simulated; digest and post-call summary disabled; USE_MOCK_PHOREST=false. Legacy enabled=false means simulation disabled, not voice disabled. Retained two-number allowlist is inactive in real mode (kept for rollback).
- Existing single-appointment prepare/confirm tools now perform real writes with fresh-availability refusal on uncertainty, phone-matched client-ID binding, persisted provider verification and no automatic write retries. Pending writes block proposal replacement; unknown outcomes block subsequent mutations and invalidate cached appointment lists. Readback normalizes fractional seconds and retries only reads for delayed visibility; cancellation explicitly includes canceled records.
- Actual controller/Phorest create→reschedule→cancel validation PASSED after catching/fixing read-back issues. All three temporary Sep22 Brow Threading fixtures on Aryan Gupta were canceled; no active test appointment remains. Hosted unlisted-caller synthetic read-only check reached Erica and answered Monday hours without any write. No unsolicited phone call/SMS made.
- Next: owner actual phone booking/reschedule/cancel taste test. Grouped visits and acknowledgment polish are DESIGN ONLY, not implemented: `docs/GPT_LIVE_GROUPED_VISIT_PLAN_2026-09-12.md`. Reuse Phorest native aggregate availability/multi-service booking and batch cancellation, one complete visit read-back/approval; sequential grouped reschedules need per-item verification and partial-outcome handling.
- Release evidence: `docs/reviews/GPT_LIVE_REAL_WRITE_RELEASE_2026-09-12.md`; outputs/live-real-write-validation/. Continue in `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`, not older main. Remote probes now require explicit PROBE_ALLOW_REAL_BACKEND=true against this host; their local simulation env does not protect remote writes.
- Rollback to simulation: with no active calls set PHOREST_WRITE_MODE=simulate and restart/redeploy; keep owner communication suppression. Do not roll back a simulation-only binary while leaving real-write settings enabled.

## 2026-09-12 8:34 PM call — review complete, real writes still disabled

- Owner call `CAcfe25bad14206422258751a2b83f1e41` recognized Aryan and completed two simulated bookings: Monday Sep 14 brow 4:45 PM and chin 4:30 PM. Explicit read-backs/approvals and persisted booking rows verified. Direct real Phorest read found no Monday appointments for that profile, consistent with hosted writes=simulate.
- Three-choice availability and basic hours worked. Multi-service flow still promised options “for both” then committed brow before arranging chin, prompting caller correction. Repeated process narration / duplicate confirmation remain conversation-quality issues. Audio quality not assessed from transcript.
- Review: `docs/reviews/GPT_LIVE_CALL_REVIEW_2026-09-12_2034.md` in implementation worktree. No code, environment or real Phorest writes changed. Runtime remains `8607ef1`. A scoped real-write pilot requires implementation and verification; startup/proposal gates currently require simulation.

## 2026-09-12 evening — Owner transfer working-day correction DEPLOYED

- Runtime `8607ef1`, Railway `4d6dc922-bc44-4bf1-8699-b31c7f51db1f` SUCCESS (created 7:47 PM Eastern). Four deployed source/build hashes match; 682 tests / 61 files and TypeScript build pass. Health 200, zero active calls, Live + Terra, two approved callers, writes/notifications simulated.
- Owner clarified 9 AM–8 PM applies only on Richa's working days. Shared transfer helper now excludes Sundays, closedDates and recorded away closures using existing business.json calendar; before-opening and after-closing transfers within that window remain permitted on working days. This overrides earlier every-day/waking-hours policy. Calendar itself unchanged.
- Prompt status, requested transfers and fatal-error fallback share the guard. Tests verify days off, holidays, away days, reopening and boundaries. This single-provider calendar is the working-day source; individual time off must be recorded there, not inferred from zero appointment slots.
- Report: `docs/reviews/GPT_LIVE_TRANSFER_WORKDAYS_2026-09-12.md` in `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`. Continue in that worktree, not older main. Previous three-choice availability and audio pacing fixes retained. Owner listening / identity-spelling replay / real-write pilot remain pending.

## 2026-09-12 evening — Three-time availability presentation DEPLOYED

- Runtime `52610e0`, Railway `da9b8e45-4d13-472b-a6ba-be75a7ca76e6` SUCCESS (created 7:40 PM Eastern). Four running source/build hashes match. 676 tests / 61 files and TypeScript build pass.
- Shared availability result now instructs at most three spoken options per reply, spread across the day or near the caller preference; exact requested available time gets one confirmation. Live speech prompt reinforces the cap. Existing returned slots retained for follow-up; an unlisted requested time is rechecked with preferredTime rather than incorrectly declared unavailable.
- Local and hosted actual Live + Terra replays passed initial three-choice, three different alternatives, and exact 12:15 Monday confirmation. Hosted used one successful availability lookup and no appointment actions. Final status healthy, zero active calls, Live + Terra, two allowed callers, writes/notifications simulated.
- Evidence: `docs/reviews/GPT_LIVE_AVAILABILITY_PRESENTATION_2026-09-12.md` in `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`. Continue in that worktree; do not deploy the older main checkout.
- PENDING: owner handset listening; separate checking-narration / name-spelling replay items and separately scoped real-write pilot remain. Earlier long-call audio and transfer-hours fixes retained.

## 2026-09-12 evening — Long-call disconnect and transfer-hours fix DEPLOYED

- Current runtime `79f5363`, Railway `7a0c5978-53a6-4e43-88cf-77699608efcd` SUCCESS (created7:27 PM Eastern). Seven running source/build hashes match. 676 tests /61 files and TypeScript build pass.
- Owner call at7:09 PM (`CA3059bfa27891d40fbfbdb8746ecfe1b0`) was ended by our400ms audio-queue fatal guard at140.6 seconds. Not a model end_call or recorded OpenAI session timeout. Fixed cumulative timer drift/arbitrary-chunk pacing with complete frames, monotonic deadlines and bounded catch-up.400ms is now a soft jitter target; pathological5s backlog guard retained without dropping speech.
- Transfers now use reusable9 AM inclusive–8 PM exclusive gate, independent of salon opening. Normal and technical-error failover obey it. Public questions about Richa's salon schedule use published business hours without personal-schedule claims. Eligible test transfers report simulation rather than personal unavailability.
- Local195-second actual-model replay completed a simulated booking. Hosted195-second replay stayed connected throughout, correctly described simulation and gave public Monday hours. Hosted booking did not complete: fixed TTS script did not answer requested first-name spelling; keep that as a separate conversation replay item. Caller-ID prefetch was recognized:true.
- Final status Live+Terra, zero active calls, two approved callers, all writes/notifications simulated. No real dial or appointment change made. Details: `docs/reviews/GPT_LIVE_AUDIO_AND_TRANSFER_FIX_2026-09-12.md` in `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`; continue there, not older main.
- PENDING: owner handset/speakerphone taste test; identity-spelling replay; separately scoped real-write pilot. Do not enable customer intake or real writes based on these synthetic checks.

## 2026-09-12 7:05 PM — Owner phone corrected in Phorest; cache refreshed

- Aryan updated his own Phorest mobile. Direct client GET now verifies the number ending 5169 matches Aryan Gupta. Earlier 7474 mismatch is resolved.
- Restarted existing Railway release `6f211b18-0e1a-4281-ae75-0c8e737f63e1` after both application and Twilio showed zero active calls. No rebuild or source change. Boot completed full 4,189-entry client phone index at 23:05:11 UTC.
- Hosted synthetic call `CA_probe_1789254339661` is recognized:true. Caller supplied no name; Erica asked “Am I speaking with Aryan?” This verifies caller-ID prefetch after refresh. Final active calls zero; Live+Terra and simulated write/notification boundaries retained.
- Client-index TTL is the one-hour default (runtime override unset); refresh is lazy/background on lookup. Restart forces immediate reload after an external profile change. Before the owner corrected Phorest, restart would only reload the same wrong number.
- Remaining: owner actual phone test and separately scoped real-write pilot. No real profile/appointment edits were made by Codex.

## 2026-09-12 evening — Live caller lookup correction DEPLOYED

- Runtime `9851e8a`, Railway `6f211b18-0e1a-4281-ae75-0c8e737f63e1` SUCCESS. Four source/build hashes match; 666 tests / 61 files and build pass. Live+Terra default, two allowed callers, all writes/notifications still simulated; final active calls zero.
- Owner’s calling number ending 5169 has no real Phorest phone match. Aryan Gupta exists with mobile ending 7474. No profile data changed. Automatic recognition from 5169 will continue to miss until the actual record is corrected separately.
- Fixed an independent Live flow defect: explicit caller-ID lookup delegates before asking for contact details; no-argument lookup uses the server’s calling number, and a supplied full name is searched after a phone miss. Explicit different names/numbers retain priority. Name matches require identity confirmation before appointment disclosure/actions.
- Before-fix hosted replay asked for a number and ran no lookup despite supplied name. After-fix local and hosted actual-model replays found Aryan Gupta by name and asked for the account phone to confirm identity. Caller-ID-only local replay asks for full name after a clean miss, without claiming caller ID is unavailable.
- Evidence: `docs/reviews/GPT_LIVE_CALLER_LOOKUP_FIX_2026-09-12.md` in the implementation worktree `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`. Continue there; do not deploy the older main checkout.
- PENDING: owner next-call confirmation; separately resolve the Phorest mobile mismatch and real-write pilot scope. No actual booking/rescheduling/cancellation enabled by this correction.

## 2026-09-12 — GPT-Live owner taste test DEPLOYED; owner listening pending

- Aryan authorized implementation, agent delegation and deployment. Worktree `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`, branch `codex/gpt-live-taste-test`, derived from verified Railway production `8533e61`. Do not deploy the dirty main checkout.
- Implemented Live adapter, split Live/backend prompts, Terra/Luna/Realtime idle-call switching, real Phorest reads with a process-wide simulated-write overlay, canonical service IDs, call-scoped prepare/confirm proposals, background caller context, isolated test telemetry, and a strict owner/tester allowlist.
- No test appointment writes, messages, transfers, blocklist changes, digests or post-call summary model calls reach real side effects. Recording and ending an admitted test phone call remain real.
- Current engineering validation: 662 tests across 61 files and TypeScript build pass. Actual API probes have exercised both backend models, bundle selection, real availability, direct hours, a seven-second tool stall and greeting interruption. Ten normal greeting probes all contain disclosure in their transcript; first speech 1.46–1.84 seconds. Audio/handset quality still needs owner listening.
- Found and corrected early contact collection and the bare Richa-availability ambiguity. Closing required a distinct Live path: do not treat a backchannel as a farewell, do not force a duplicate farewell, wait for actual playback and abort if the caller speaks again. Final synthetic closing check ended after playback drain; a partial repeated goodbye fragment remains NEEDS LISTEN.
- Deployed runtime source `254499c` in Railway release `8d932448-3b96-4c7d-9bca-40ed46aa6519` (SUCCESS, September 12, approximately 2:27 PM ET). Six running source/build hashes match local. Hosted Terra, Luna and Realtime synthetic price checks all returned $23. Final status: Live+Terra, zero active calls, simulation enabled, two approved callers. Unauthorized admin switching returns 401; a signed unlisted incoming caller is rejected. Twilio webhook and external forwarding unchanged.
- Durable handoffs: `tasks/coordination.md`, `tasks/handoffs/`. Owner scenarios: `docs/GPT_LIVE_OWNER_TASTE_TEST_GUIDE_2026-09-12.md`.
- Release evidence: `docs/reviews/GPT_LIVE_OWNER_TEST_RELEASE_2026-09-12.md`. PENDING: owner compares handset/speakerphone Terra, Luna and Realtime. Customer intake and real writes remain disabled until a separate acceptance decision.

Older entries (2026-07-19 → 2026-09-11) are archived verbatim in docs/archive/state-2026-07-19_to_2026-09-11.md.
