# Erica prompt audit — 2026-09-01

Audited: the live prompt at commit `ade8b16` (Railway deployment
`51d62be6-07e1-4352-81dd-d463aa14b34a`, 2026-08-29 11:49 ET) — core
instructions, tool contracts, caller-context notes, tool-result coaching, and
the session config — against (1) the 34 production calls since the last
`/call-review` (2026-08-27 15:59 ET → 2026-08-29 11:23 ET; all from Aryan's
test phone ending 5169, so none are customer damage, but they are the only
evidence of the model's current failure modes), (2) the OpenAI Realtime
prompting guide, and (3) the ElevenLabs and Vapi enterprise prompting guides.

Everything below is grounded in a transcript, a rendered prompt, or a live
API probe run today. Where a claim could not be verified, it says so.

---

## 0. Shipped in this pass (local, tested, NOT deployed)

Richa is away 2026-09-01 → 2026-09-09; the salon reopens Thursday 2026-09-10.
Rendering the prompt as of today showed three live defects, all fixed:

| Defect (rendered prompt, 2026-09-01 5:09 PM) | Fix |
| --- | --- |
| `RICHA'S LINE: a live transfer to Richa is POSSIBLE right now` sat two lines above `Erica cannot connect a caller to Richa while she's away`. The status line only looked at the 9–21 calling window; the away gate lived in prose the model had to reconcile on every call. | `richaLine` now folds the active closure in: "NOT possible right now — Richa is away from the salon until Thursday, September 10; offer to pass a message along instead." |
| `next open Thursday at 12 PM` on a Tuesday inside a 9-day closure. THIS Thursday (Sep 3) is itself closed; the real reopen is Thursday Sep 10. Same bare-weekday label fed the `suggest_availability` closed-day note. | `getHoursStatus.nextOpen` names the date when the next opening is ≥7 days out ("Thursday, September 10 at 12 PM"). Within the coming week a bare weekday is still unambiguous and unchanged. |
| The section header read `═══ VACATION (Richa is away) ═══`, `get_business_hours` returned a `vacations` key, and MESSAGE MODE said "during an active vacation" — three places handing the model the one word the owner does not want said. | Header → `RICHA IS AWAY FROM THE SALON`; tool key → `awayClosures` with a `reopens` date and a note; MESSAGE MODE → "while Richa is away from the salon". An explicit wording rule: say only that Richa is away from the salon; never say vacation, holiday, or trip; never guess why. A test locks that the word now appears nowhere in the rendered prompt except inside that ban clause. |

Also shipped:

- **Decision-moment coaching for closure dates.** `suggest_availability` on any
  date inside a closure now returns the away story itself ("Richa is away from
  the salon that day; the salon is closed September 1 through September 9 and
  reopens Thursday, September 10 … never call a closed day fully booked")
  instead of the generic closed-day note. Uses a new `getVacationForDate()`
  in `hours.ts`, so it also covers a caller asking in August about a
  September date.
- **Message-vs-FYI disambiguation in all three text-instead-of-transfer notes**
  (away, after-hours, failback). See conflict C4 below for why.
- **Four permanent read-only diagnostics** in `scripts/`:
  `render-prompt.ts` (today's CURRENT STATUS tail, constraint-word counts,
  quoted candidate-reply lines), `validate-session-fields.ts` and
  `validate-transcription-fields.ts` (live-validate a session field before
  shipping it — the lessons.md rule, now one command), `probe-client-history.ts`
  (what history signals Phorest actually holds for a client).

Verification: 42 files / 402 tests green, `tsc` clean, `git diff --check`
clean. Effective prompt estimate 4.14k tokens (was 4.02k; budget test <4.2k
still passes).

**Deploy is Aryan's call.** Direct-dial acceptance for the away period:

1. "Can I come in tomorrow for brow threading?" → hears Richa is away from the
   salon, reopens Thursday September 10, offered to check Sep 10+. Never the
   word vacation, never "fully booked".
2. "Is Richa there?" → the clarification question, no dial (ade8b16 guard),
   then on "connect me" → "can't connect her right now, she's away from the
   salon; I can pass a message" — no promise of a transfer.
3. "What are your hours this week?" → closed through Sep 9, back Thursday Sep
   10 at 12 PM. Not "this Thursday".
4. Cancel a Sep 10 appointment → cancelled, goodbye, `end_call`. No "Richa's
   got the message as a text" at the goodbye (C4 mitigation).

Rollback point: deployment `51d62be6-07e1-4352-81dd-d463aa14b34a`.

---

## 1. Instruction conflicts in the live prompt

Ranked by how often the transcripts show the conflict actually costing a turn.

| # | Conflict | Evidence | Layer (fix ladder) | Status |
| --- | --- | --- | --- | --- |
| C1 | RICHA'S LINE "POSSIBLE" vs away block "cannot connect" | Rendered prompt today | Code (precompute the combined truth) | **Fixed** |
| C2 | "next open Thursday" during a closure longer than a week | Rendered prompt today; `getHoursStatus('2026-09-02')` | Code | **Fixed** |
| C3 | "VACATION" header / `vacations` tool key / "active vacation" vs owner's wording | Rendered prompt; `get_business_hours` result shape | Prompt + tool result | **Fixed** |
| C4 | MESSAGE MODE "also text Richa a brief FYI" after a self-handled cancel → `transfer_to_owner` → its note says "tell the caller their message has just reached Richa" → the caller hears about a text they never asked for, at the goodbye, and `end_call` never fires | Call 9:50 PM Aug 27 (CA4cf3…): after "No, that's it" Erica said "All set—Richa's got the message as a text and she'll follow up as soon as she can. Take care" — caller had to hang up. During the away period every cancel of a Sep 10 appointment ("next open day while the salon is closed") re-triggers this. | Note layer (shipped): all three notes now say "if this was only your own FYI after a change you already handled, say nothing about it." Proper fix = code: send the FYI from `handleCancel`/`handleReschedule` deterministically and delete the prompt sentence. | **Mitigated; P1 to finish** |
| C5 | Unrecognized caller with an existing appointment is asked "Is the number you're calling from the best one for your file?" — but the server already looked that number up at pickup and it missed (`caller_id_match: NONE`). The model can't know that, so it burns a turn and then says "I couldn't find a record with that number." | 5:24 PM, 5:50 PM, 5:22 PM, 5:52 PM Aug 27 (CA623d…, CA73a0…, CA1120…, CAf088…) — four calls, same wasted turn. | Caller-context note: state that the calling number has already been checked and has no account; for an existing appointment ask for the number it was booked under or first and last name. | **Open — P1** |
| C6 | Tool-failure threshold stated three ways: prompt "MORE THAN 2 tool failures → offer Richa"; result notes "retry once, if it fails again offer Richa" (= 2); `transfer_to_owner` "a tool that keeps failing AFTER you retried it" | 9:42 PM Aug 27 (CAdb83…): 2 failures → transfer → after-hours text | Prompt + tool desc: one rule, "one retry; a second failure → offer Richa/a message" | **Open — P2** |
| C7 | `end_call` closing: CLOSE says "ONE warm goodbye" but the model announces mechanics | 10:26 AM Aug 29 (CAb53e…): "Alright, I'll wrap this up for you now."; 8:59 PM Aug 27 (CAd987…): "Call ended. The appointment was successfully canceled." spoken aloud | `end_call` description: "the closing is a goodbye to the caller, never an announcement that the call is ending or being wrapped up" | **Open — P1** |
| C8 | Preamble promises a check, then the staff-name note makes Erica ask a question instead | 11:38 PM, 10:02 PM Aug 27; 5:15 PM Aug 28: "Let's check Richa's availability… give me just a moment." → "So, which service would you like?" | `staffMember` note: "if you already said you'd check, don't explain or apologize — just ask which service" | **Open — P2** (post-rework the model asks first without calling: 10:26 AM Aug 29) |
| C9 | NEVER INVENT covers appointments/services/times/prices, not explanations | 5:02 PM Aug 27 (CAfcd3…): "It might be that the online calendar updates a bit slow sometimes" — invented | OPERATING RULES: add "never invent a reason for a result; say what the system shows and offer the next option" | **Open — P2** |
| C10 | IDENTIFY: "Identity comes from verified caller-ID state or lookup, never a name alone" vs the name-lookup path two lines later | Prompt text | Reword: "never from a name the caller merely states — a name must resolve through lookup_customer" | **Open — P2** |
| C11 | Constraint-word density: `never` ×37, `only` ×27, `exactly` ×5, `immediately` ×6 in ~4.1k tokens. The OpenAI guide: "Remove overlapping always, never, only, and must rules unless they are truly required." Every extra hard word dilutes PRIORITY, PRIVACY and the write gates that genuinely need one. | `scripts/render-prompt.ts` counts | Prompt prose trim (candidates in §7) | **Open — P2** |
| C12 | No variety instruction; the guide's "Do not repeat the same sentence twice" is absent | Same closer in every call: "Anything else I can help you with?" / "Is there anything else…" | RESPONSE SHAPE: one line, vary check-ins and closers | **Open — P2** |
| C13 | UNCLEAR AUDIO lacks the guide's "don't repeat the same clarification twice" | 5:52 PM Aug 27 (CAf088…): three consecutive "what would you like to do with it?" variants | REASONING & UNCLEAR AUDIO | **Open — P2** |

---

## 2. Bugs and edge cases seen in the 34 test calls

Builds: calls before ~6:36 PM Aug 28 ran `gpt-realtime` with the pre-rework
prompt; 6:36 PM Aug 28 was the first `gpt-realtime-2.1` call (old prompt);
the four Aug 29 calls ran the reworked 2.1 prompt.

| # | What happened | Where | Status |
| --- | --- | --- | --- |
| B1 | "Is Richard available?" → `transfer_to_owner` in 255 ms, no question asked | 11:23 AM Aug 29; 7:52 PM Aug 27 | Fixed in `ade8b16` (prompt + tool contract + deterministic transcript guard). **Not yet heard on a call.** |
| B2 | Identity bundled with the service question, then re-asked twice; caller: "I just confirmed that… why are you asking me one more time" | 6:36 PM Aug 28 (first 2.1 call) | Fixed by the 2.1 rework. Aug 29 calls ask once and wait (10:26, 11:00). |
| B3 | Post-cancel goodbye announces a text to Richa; no `end_call` | 9:50 PM Aug 27 | C4 — mitigated at the note layer today; code fix P1 |
| B4 | Meta-narration spoken: "Call ended. The appointment was successfully canceled." | 8:59 PM Aug 27 | "Never narrate…" in the rework; tool-layer fix C7 pending |
| B5 | Cancel right after booking: model passed the new **appointment id** as `list_appointments.clientId`, twice → 2 failures → transfer → after-hours text; caller told "I wasn't able to process that cancellation" | 9:42 PM Aug 27 | Parked 2026-08-27 as "fix only if it recurs". It is a 3-line guard (booking result note "cancel THIS one by id", clientId param description, code short-circuit). Recommend un-parking: P1. |
| B6 | Caller transcripts arrive in Korean, Urdu, Chinese, Thai script for an English speaker; spelled names come out as `ہاویانا ایچ یو ایم ایم` | 18 of 34 calls have at least one such line | `gpt-4o-mini-transcribe` auto-detects language per utterance. This is not cosmetic: the ade8b16 transfer guard *reads the transcript*, and QA cannot verify names. `audio.input.transcription.language: 'en'` and a `prompt` with salon vocabulary were both **accepted live today** (`keywords` is rejected for this model). P0 after one live call validates the shape. |
| B7 | Partial speech "Hey, this is…" answered with "Hi there!", then again "Hi there! How can I help you today?" | 9:50 PM Aug 27 | UNCLEAR AUDIO rule exists post-rework; not observed since. Semantic VAD is the structural fix for "let the caller finish" (validated accepted; needs a listening test). |
| B8 | Invented excuse for a full day | 5:02 PM Aug 27 | C9 |
| B9 | "if it's a bit unique, feel free to spell it out" | 7:03 PM Aug 27 | Fixed by the neutral name contract (`2badc9d`) |
| B10 | "Thanks for your patience" after a routine lookup; "Give me just a moment" preambles before a question | 11:38 PM Aug 27 | Banned in PREAMBLES post-rework |
| B11 | First name three times in one call ("Great, Aryan!… Thanks, Aryan!… Aryan, tomorrow…") | 10:02 PM Aug 27 | "use the first name sparingly" post-rework |
| B12 | 7:30 PM asked on a Saturday (closes 6) → "outside today's hours", offered 5:15/5:30/5:45 | 11:00 AM Aug 29 | Correct behavior |
| B13 | Stream died mid-call after a successful cancel | 5:52 PM Aug 27 | Infra; 1 of 34; the cancel had completed |
| B14 | Silence check-in fired right after Erica asked a question | 5:24 PM Aug 27 | By design (20 s) |

Positive signals worth keeping: result-first phrasing after tools ("There's a
5:30 PM slot available today for Brow Threading. Please say yes to confirm"),
the price volunteered at booking ("The price will be $15"), correct
closed-vs-booked distinction, no invented slots in any call, no write without
an explicit yes in any call.

---

## 3. What would make Erica sound more human (ranked)

1. **`reasoning.effort: 'low'`** — the OpenAI guide's explicit starting point
   for production voice agents ("start with low … tune from there"). The
   session currently omits it (provider default). Accepted live today. Expect
   lower first-audio latency and fewer spoken deliberations; A/B by ear on the
   staging number, measure `⏱ response latency`.
2. **Transcription in English with salon vocabulary (B6).** Cleaner transcripts
   make every transcript-driven guard and every review sharper. Zero effect on
   what the caller hears; large effect on what we can verify.
3. **Flow states with exit criteria.** The guide's `Goal / How to respond / Exit
   when` shape for BOOK, RESCHEDULE, CANCEL, RUNNING LATE. The 2026-08-26
   revert lesson was exactly this: the compressed paragraph flows lost the
   ask→WAIT→act beats. States make the wait explicit without adding rules.
4. **Variety + no repeated clarification** (C12, C13): two lines, removes the
   most audible "bot" tell in the transcripts.
5. **Goodbye contract on `end_call`** (C7): kills "I'll wrap this up" and
   "Call ended".
6. **Trim hard constraints** (C11) so the ones that matter stay salient.
7. **Semantic VAD listening test** — `eagerness: 'low'` waits for semantic
   end-of-turn; addresses B7 and the "pounced on a mid-sentence pause" note in
   lessons. Accepted live today with `create_response`/`interrupt_response`
   off, so the greeting handshake survives. Staged calls only.
8. **Do not** add disfluencies ("um", "uh") the way the Vapi guide suggests —
   the owner asked for natural, not theatrical, and Realtime 2.1's prosody
   already carries it. **Do not** use `audio.output.speed` — the guide says
   pace belongs in the prompt; the greeting-only pace line already works.

---

## 4. Parallel and proactive tool calling

What is already true in the code (verified in `twilioStream.ts` /
`openaiSession.ts`):

- At pickup, **before** the OpenAI handshake, the caller-ID lookup and the
  catalog fetch start in parallel; the recognized caller's upcoming
  appointments warm in the background; hours, today's status and transfer
  status are precomputed into the prompt. `lookup_customer` with no args and
  `list_appointments` for that client answer from memory with zero Phorest
  round-trips.
- Each `function_call` is handled independently (`handleEvent` is not awaited
  serially), so if the model emits two calls in one turn they run
  concurrently; RT-2 defers the duplicate `response.create`. **Realtime 2.x
  can and does emit multiple tool calls in one response** and speaks while
  they run (async function calling; the `commentary` phase).

What to add, by payoff:

1. **Say it in the prompt: two dates = two calls in the same turn.** TOOLS
   already says "No day → today AND tomorrow"; add "call suggest_availability
   for both dates together in one turn, then answer once." Today the model
   does them sequentially with a preamble between (10:02 PM, 11:38 PM Aug 27:
   two `suggest_availability` calls, two spoken updates). Zero code.
2. **Pre-warm availability for recognized callers** (pairs with §5): once the
   usual service is known at pickup, fetch the next open day's slots for it in
   the background (60 s cache, off the critical path). The A1 fresh re-check
   before every write already guards staleness. Then "your usual brow
   threading? I have 2:15 or 3:30 Thursday" is one turn, not three. Measure
   `⏱ tool suggest_availability` on Railway first — local `dev.log` is
   truncated on every boot, so this audit could not quote a number.
3. **Do not** set `parallel_tool_calls` — accepted live but not echoed back in
   `session.updated`, so its effect on Realtime is undefined. **Do not**
   speculatively call tools on unclear intent — the 2026-08 lesson ("don't
   assume intent") stands; prefetch is server-side and invisible, which is the
   right kind of proactive.
4. **Instrument `phase`.** `response.done` output items carry
   `phase: commentary | final_answer`. Log it per item; it turns "duplicate
   preamble?" from an ear judgement into a count (the REALTIME_2_1_ANALYSIS
   open item).

---

## 5. Service history: "your usual brow threading with Richa?"

**Data exists.** Probed live today on the test client: the Phorest client
record carries `firstVisit`, `lastVisit`, `clientSince`, `preferredStaffId`;
past appointments come from `/appointment?client_id=…&from_date&to_date`
(31-day cap → three parallel windows cover 90 days) with `serviceName`,
`state` (`BOOKED` / `PAID`), `activationState`. The test client shows two past
`BOOKED` rows (never checked out) and `lastVisit` 2025-10-21 — so `lastVisit`
reflects real checkouts, and "usual" should be computed from appointment rows,
not from `lastVisit` alone.

**Design (no new model-facing tool):**

- **Where it computes:** in `adoptRecognizedCaller`, alongside the existing
  appointments warm — three `listAppointments`-style windows in parallel, off
  the greeting path. Derive `usualService` = most frequent `serviceName` in
  the last 90 days with ≥2 visits, else the most recent visit's service;
  exclude cancelled rows; count `BOOKED` and `PAID`. Also `lastVisitDate`.
- **How the model sees it:** two data lines in the recognized-caller context
  (`usual_service: Brow Threading (3 of last 4 visits)`,
  `last_visit: July 17`), with the rule: *after identity is confirmed, if the
  caller wants to book and has not named a service, offer the usual one as a
  question; otherwise never mention it. Never recite history.* For callers
  identified by phone or name mid-call, `lookup_customer` returns the same
  fields (computed in the background after the match; the note tells the model
  to offer, not assume).
- **The sample line needs one change.** "Hi Brenda, do you want to do your
  usual eyebrow threading appt with Richa?" as the *opening* conflicts with the
  owner's recorded decision (lessons.md: greeting a recognized caller by name
  before they have spoken felt surveillant) and with the fixed recorded-line
  greeting. The natural placement is the second turn: caller says "I'd like to
  book" → "Sure — am I speaking with Brenda?" → "Yes" → "Great. Your usual
  brow threading with Richa?" Same warmth, no cold-open name, identity gate
  intact.
- **Privacy:** history is account data; it rides the same `UNCONFIRMED` →
  `CONFIRMED` contract as appointments and is never exposed to a rejected or
  unresolved match.
- **Cost:** three Phorest GETs per recognized caller, parallel, cached for the
  call. **Effort:** ~1 day including mock-adapter parity (`PhorestPort` must
  stay a mirror) and a contract test above the parse seam.
- **Test data:** the test client already has back-dated Brow Threading rows
  (Jul 17, Aug 3) — enough to hear "your usual brow threading?" on a staging
  call without touching a real client.

---

## 6. Alignment with the OpenAI Realtime guide and enterprise practice

| Guide recommendation | Erica today | Gap |
| --- | --- | --- |
| Labeled sections: Role, Personality, Language, Reasoning, Message channels, Preambles, Verbosity, Tools, Unclear audio, Entity capture, Escalation | Has all but Verbosity-by-task and Entity capture | Add a 4-line verbosity table (direct answer / clarifier / tool result / escalation); add digit-by-digit read-back for a dictated phone number |
| `reasoning.effort: low` to start | Omitted | §3.1 |
| Preambles: one short sentence, describe the action, vary wording | Matches ("at most one action update… describes the action") | Add "vary the wording" |
| Sample phrases with "DO NOT ALWAYS USE THESE, VARY" | Deliberately none (three production incidents of parroted examples) | Keep descriptions. If an example is ever needed, give ≥3 variants plus the vary note — never one |
| Unclear audio: don't guess, no tool, no preamble, **don't repeat the same clarification twice** | First three yes | C13 |
| Tool eagerness table (read-only on clear intent; confirm before writes) | Yes, and mirrored in tool descriptions | — |
| Escalation: explicit ask, distress, **2+ failed tool attempts or 3+ no-match** | Has ask/upset/>2 failures | C6 + add the no-match count |
| Conversation flow states with exit criteria | Paragraph flows | §3.3 |
| "Remove overlapping always/never/only/must" | Dense | C11 |
| Reference pronunciations, short and updated from errors | "Richa = REE-cha; Risha/Rishka" | Add the ASR variants seen: Richard, Rich, Raja, Recharge, "the judge", "the Chai" — as *hearing* hints, not speech |
| Message channels: commentary vs final_answer | Streamed, not persisted | §4.4 |
| ElevenLabs: a dedicated Guardrails heading "models pay extra attention to" | Split across PRIORITY / OPERATING RULES / PRIVACY | Fine as is; PRIORITY does the job |
| ElevenLabs: keep instructions short and action-based; <2k tokens | 4.1k with the catalog | Realtime caches the stable prefix (96–98% hit); cost is fine, latency effect modest. Trim per C11, do not move the catalog back behind a tool |
| Vapi: identity lock, one question per turn, spoken number/date forms | Yes / yes / n/a (speech-to-speech) | — |
| Vapi: 2–4 disfluencies per turn | No | Keep no (§3.8) |

---

## 7. Plan

**P0 (before the next deploy)**
- [ ] Deploy this pass's away-period fixes after the four direct-dial checks in §0.
- [ ] Transcription `language: 'en'` + salon-vocabulary `prompt` behind env
      (`OPENAI_INPUT_TRANSCRIPTION_LANGUAGE`, `_PROMPT`); one live call to
      confirm the session shape, then on. Snapshot test that the payload is
      byte-identical when unset.

**P1 (this week, each its own commit + ear test)**
- [ ] C4 finish: FYI SMS from `handleCancel`/`handleReschedule` (today or next
      open day, salon closed now) — record the served appointment's date at
      surface time; delete the MESSAGE MODE sentence; update prompt test 206.
- [ ] C5: unrecognized-caller context says the calling number was already
      checked; existing-appointment path asks for the booking number or name.
- [ ] C7: `end_call` goodbye contract.
- [ ] B5 un-park: booking result note + `clientId` param description + code
      short-circuit when a served appointmentId lands in the clientId slot.
- [ ] `reasoning.effort` env knob (default unset) + staged A/B.
- [ ] Log `phase` per output item.
- [ ] TOOLS: "two dates → both calls in one turn".

**P2 (next prompt release, one ear-test round)**
- [ ] Flow states (Goal / How / Exit) for BOOK, RESCHEDULE, CANCEL, LATE.
- [ ] C6, C8, C9, C10, C12, C13 wording; C11 trim (candidates: "Never call a
      closed day fully booked" ×2 → once in the note; "only" in IDENTIFY ×4;
      "immediately" in BOOK/CLOSE where WAIT already carries it).
- [ ] Verbosity table + digit-by-digit phone read-back.
- [ ] Pronunciation *hearing* hints for Richa's ASR variants.
- [ ] Service history (§5) — behind a flag, recognized callers first.
- [ ] Pre-warm next-open-day availability for the usual service (§4.2) after
      measuring Phorest latency on Railway.
- [ ] Semantic VAD listening test (`eagerness: low`), staging only.

**Not recommended:** `parallel_tool_calls`, `audio.output.speed`, injected
disfluencies, moving the catalog behind a tool, more prompt paragraphs for
scenario fixes (fix ladder: note → schema → code → flow → prose).

---

## Appendix — live probes run today

`scripts/validate-session-fields.ts` against `gpt-realtime-2.1`
(production session shape + one candidate field each; fresh WS per variant):

| Field | Result |
| --- | --- |
| `reasoning.effort: low` / `minimal` | accepted, echoed |
| `audio.output.speed: 1.05` | accepted, echoed |
| `audio.input.turn_detection: semantic_vad, eagerness: auto` (+create/interrupt off) | accepted, echoed |
| `server_vad.idle_timeout_ms: 20000` | accepted, echoed |
| `parallel_tool_calls: true` | accepted, **not echoed** |
| `tool_choice: auto` | accepted (default) |
| `max_output_tokens: 400` | accepted, echoed (the GA name; the beta `max_response_output_tokens` in lessons.md is still invalid) |
| `audio.input.transcription.language: 'en'` | accepted, echoed |
| `audio.input.transcription.prompt: "<salon vocabulary>"` | accepted, echoed |
| `audio.input.transcription.keywords: [...]` | **rejected** — "not supported for this model" |

`scripts/probe-client-history.ts` (test client): raw client fields include
`clientSince`, `firstVisit`, `lastVisit`, `preferredStaffId`,
`smsReminderConsent`; past-appointment rows carry `serviceName`, `state`,
`activationState`, `source`; a 90-day range in one request → HTTP 400 "Max
date range allowed is 31 days".
