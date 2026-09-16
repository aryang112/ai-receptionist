# Review of the 2026-09-15 prompt audit

**Written for:** Aryan and the next agent on this repo. Reviews
`docs/PROMPT_AUDIT_2026-09-15.md` §5 — the reasoning, not the diffs.
**Reviewer:** Jarvis (Fable 5.1), 2026-09-15 evening. Read-only session: no
code changed, no deploy, no config change.

## What I verified before forming a view

| Check | Result |
| --- | --- |
| `npx vitest run` on the live worktree | 797 passed, 69 files |
| `npx tsc --noEmit` | clean |
| `GET /admin/voice-test` on production | `engine:"live"`, backend `gpt-5.6-terra`, writes real, owner transfers real, notifications simulate |
| Railway variables | `OWNER_TRANSFER_MODE=real`, `TRANSFER_WINDOW_END=23:00`, `PHOREST_WRITE_MODE=real` — the temporary config is still in place |
| `render-live-prompts.ts` | Live prompt ~908 tokens, backend ~5,879 tokens; sections as the audit describes |
| `sim-scenarios.ts 2026-09-16` | every row matches the audit's §2–§3 claims |
| Tool surface the backend actually sees | 14 tools (15 defined, 3 raw writes removed, 2 proposal tools added) |

## Verdicts on the five questions

| # | Audit's lean | My call |
| --- | --- | --- |
| 1 | Collapse both prompts to one source | **Disagree.** One source of *facts*, separate authored *rules*. The regex-transform layer is the fragile part, and "one source" means more of it. |
| 2 | Stopword list, uncertain | **Workaround, keep as safety net.** The real defect is in the shared service resolver, not the staff matcher, and it bites harder than the audit found (see 2.3). |
| 3 | Prose precedence for closing, maybe server state | **Prose stays for the judgement; server takes the mechanics.** The server cannot compute "caller is done" on the Live path at all. |
| 4 | `cancel_visit` needs no planning phase | **Disagree.** It should get a cheap planning call. The phase is not about computing options; it is about the server authoring the read-back. |
| 5 | Three visit tools, not one | **Agree, for a different reason.** Then go further: let the visit tools take one service and retire the proposal pair. |
| — | Non-null assertions | 30 sites; 4 rest on an invariant defined far away. Turn on the lint rule. |

---

## 1. The duplicated prompt flow

**What actually happens.** `buildBackendPrompt` in `src/voice/livePrompts.ts`
takes the production prompt, drops some sections, regex-rewrites others, and
*replaces* the whole IDENTIFY + SERVE block with its own text
(`rewriteConversation`). So the backend already IS "one source, filtered" for
every section except the flow — and the filtered sections are where the
`.replace()`-silently-becomes-a-no-op class of bug lives. Collapsing the flow
into the same mechanism adds more of that, not less.

**The tripwire already exists and already fired.** `livePrompts.test.ts`
pins a SHA-256 of the production prompt. The 2026-09-14 RESCHEDULE edit broke
that test; the editor updated the hash (the comment in the test records
exactly that edit) without realising SERVE never reaches the backend. So the
missing thing was not a test. It was a failure message that says *why* the
test exists.

**Realtime is not a runtime fallback.** `voiceEngine` is read once from
`VOICE_ENGINE` at boot. The failover path goes to Richa's phone, never back
to the Realtime model. The production SERVE section is only read if someone
flips the env var. That weakens the main argument for keeping two rule sets
in lock-step.

**Recommendation, in order.**
1. Now: change the hash test's failure message to say "SERVE and IDENTIFY are
   replaced on the Live path; edit `rewriteConversation` in livePrompts.ts."
   Five-minute change, closes the trap that cost the most.
2. Next: move the backend rule prose out of `rewriteConversation` into its own
   plain text file that a reviewer can read without reading regexes. Share only
   the *computed* blocks (CURRENT STATUS, catalog, closure) between the two
   prompts. Rules for two different models doing two different jobs should be
   authored, not transformed.
3. When Realtime is formally retired: delete SERVE from `twilioStream.ts`.
   Until then a one-line banner above it: "INERT when VOICE_ENGINE=live".

One leftover from the audit's conflict #1: the softened copy of *"prepare at
most one appointment action at a time"* is still in BACKEND TOOL USE. It is
qualified now, but it is the exact phrase the model previously obeyed
literally. Reword to "one `prepare_appointment_action` at a time".

## 2. The staff matcher

### 2.1 The bound *can* be tightened, per name length
The audit says the edit-distance bound cannot be tightened because Richa is
heard as "Richard" and "Rishka" (both distance 2). True for a single global
bound. A bound that scales with name length is different: allow 2 edits for
names of 5+ letters, 1 edit for 4-letter names. "Richard" and "Rishka" still
match Richa (5 letters). "and" no longer matches Manu (4 letters, distance 2).
Half the letters of a four-letter name is not a match, it is a coin flip.

### 2.2 The call site can be gated without touching the matcher's contract
The staff check runs only when the resolver says `notOffered`
(`twilioStream.ts` ~3620). It ignores what came back with it. For "eyebrow
threading and upper lip" the resolver returned three service candidates —
that is a service phrase by any definition. Rule: if `closest` is non-empty,
skip the staff match. That is the audit's "more principled" option, and it
lives at the call site, so the matcher's contract is untouched.

### 2.3 The filler word is the resolver's bug, not the staff matcher's — and it is worse
The same word "and" breaks the **service** resolver, silently. Probed
read-only against the real catalog:

| Caller phrase | `resolveService` result |
| --- | --- |
| "brow threading and upper lip" | notOffered, closest = Brow Thread + Lip Thread |
| "brow threading lip" | ambiguous between the 2-service and 3-service threading bundles |
| **"brow and lip"** | **match → "Brow Wax and Lip Wax"** |

At a threading salon, "brow and lip" means threading. The resolver picks
**wax** because the wax entry's own name contains the word "and" and the
threading bundle's "+" normalises to nothing. So the catalog's filler decides
the match. This is the register's O06 class (silent substitution) and it is
new. `get_prices` would quote the wax price with full confidence.

Two fixes in one place, `normalize()` in `src/services/booking.ts`:
- Strip conjunctions ("and", "plus", "with", "+") from both catalog names and
  queries.
- Score coverage on token *sets*, not counts. "Brow Thread + Lip Thread"
  normalises to `brow threading lip threading`; the duplicate "threading" is
  why "brow threading lip" only reaches 0.75 coverage and falls into ambiguity
  with the 3-service bundle. As sets, the query names that bundle exactly.

Then add "brow and lip → must not be wax" to `sim-scenarios.ts`.

**Keep the stopword list** as a belt-and-braces guard on the staff matcher,
but shrink it to actual function words. "book", "time", "date", "upper",
"lower", "half", "full" in the current list are service vocabulary, not
filler; they are there because the list is doing the resolver's job.

## 3. Closing behaviour: prose or server state?

**The analogy to transfer eligibility does not hold.** Transfer eligibility
is a fact about the world: clock plus config. "The caller is done" is an
interpretation of what they just said. On the Live path the server never
sees caller text at all — `OPENAI_INPUT_TRANSCRIPTION` defaults to `off` and
Live is audio-native. There is nothing for the server to compute from.

**What the server can own is the mechanics, and it already owns half.**
`liveHasCurrentFarewell()` regex-detects Erica's own goodbye before allowing a
hangup. The same pattern gives you the other invariant:
- Count the "anything else?" offer from the model's output text. After one,
  every later tool-result note carries "you have already asked; close instead."
  The "never twice" rule stops being prose.
- The success notes on the three visit tools say *"then ask once if they need
  anything else"*. That note contradicts the prompt precisely when the caller
  says "great, thanks, bye" in the same breath. Reword the notes: "unless they
  have already signalled they are done".

**Make the failure observable instead of trying to make it impossible.**
Register item 14 (more-help question after goodbye) is already a QA check.
Add the mirror image, "completed action with no offer and no goodbye", to the
twice-daily call review. Silent-on-a-call is acceptable when the next sweep
catches it.

## 4. `cancel_visit` should get a planning phase

The audit argues there is nothing to compute. Correct, and beside the point.
In `book_visit` and `reschedule_visit` the first call is not really planning.
It is the server writing the read-back from its own records and handing the
model text to say. Only then does `confirmed:true` mean something.

Why `cancel_visit` is different in a way that matters:
- **The read-back is model memory.** The server holds service, date and time
  for every served appointment (`servedAppointmentServices/Dates/Times`) and
  never uses them here. If the model misremembers a day, the caller says yes to
  the wrong thing and the server cannot tell.
- **The flag is free.** `confirmed` is a required literal `true` in the
  schema. A model can only ever send `true`. It is consent theatre unless a
  prior call produced something to consent to.
- **Subset risk has no echo.** Pass one extra served id and it is cancelled.
  In `reschedule_visit` the options would name the extra service and the
  caller would hear it. Here nothing is named by the server.
- **It is the most irreversible write.** Erica cannot un-cancel, and the slot
  may be taken by the time anyone notices.
- **It breaks an invariant every other write keeps.** Even a single cancel
  goes prepare → confirm through `AppointmentProposals`.

Identity is *not* the gap: on the real-write path `list_appointments` refuses
any client not matched by phone (`twilioStream.ts` ~5343), and name-only
lookups do not serve ids (~5175). Verified.

**Recommendation.** Call without `confirmed` → server returns
`{appointments:[{service,date,time}…], note:"read these back, one yes"}` from
the served maps and remembers the id set. Call with `confirmed:true` → server
requires the same set. Cost: one extra tool round-trip. Bonus: all three visit
tools now have the same shape, which helps §5.

## 5. Three tools vs one with an action parameter

Three is right, but the stated reason ("clearer model-facing semantics") is
the weaker one. The structural reason: per-tool schemas let the API validate
arguments before your code sees them. An action-parameter tool needs an
untyped `arguments` bag — exactly what `prepare_appointment_action` already
is, and that bag is why its cancel summary reads "Cancel the selected
appointment" with no date or time. Tool count was never the model's problem;
reachability was.

**The bigger simplification is elsewhere.** The model still has to decide
"one service → proposal pair, two or more → visit tool". That decision is the
one it gets wrong (register, Sept 10 3:17: moved threading, discovered tint,
moved threading again). Let the visit tools accept one service, then retire
the proposal pair for appointments. 14 tools become 12 and the branch
disappears. Direction, not for this week.

## 6. Non-null assertions

30 sites in `twilioStream.ts`. Classified:

| Class | Count | Verdict |
| --- | --- | --- |
| Edit-distance table indices | 6 | Safe by construction |
| `plan[i]!`, `chosen[i]!` after `planConsecutive` | 12 | Safe while `items.length === durations.length` — an invariant in another function |
| `results[0]!` after `length === 1` | 5 | Safe |
| Luxon `toISODate()!` on `now` | 4 | Safe |
| `canonicalNames.get(date)!` (~3492) | 1 | **Not a crash, a silent weakening**: a missing name yields key `undefined`, the offered-slot gate then fails open on that date |
| `canonical!.name` (~3573) | 1 | Safe only because `resolveService` throws on an unknown id |
| `this.prefetch!.clientId` (~3904) | 1 | Safe; `?.` expresses it better |

The `spreadAcross` bug the audit fixed was not the second `!`-turned-crash,
it was the second one *noticed*. Turn on
`@typescript-eslint/no-non-null-assertion` as an error in `.eslintrc.cjs`
(the plugin is already installed, the `lint` script already runs eslint), fix
the 30 sites in one mechanical pass. Fifty minutes of work, then the class
is gone.

## 7. Open items from audit §4, with a view on each

- **Item 05 deeper half — "two selectors".** There is one selector.
  `get_prices` and `suggest_availability` both call `resolveService`. They
  differ only in what they do with `notOffered`: prices returns the closest
  three *with prices* (so Erica quotes the bundle), availability tells Erica
  to ask. Unifying selectors chases a split that does not exist. Fix the
  resolver once (§2.3) and both tools improve.
- **Item 15 narration.** Do not port `5769300`. It is 133 lines of production
  prompt changes bundled with transfer-recovery work, and the production
  prompt is inert on Live (trap 2). The Live prompt already says "Do not
  narrate your reasoning, tools, checking, waiting". This is a voice-model
  compliance problem: measure it in the QA sweep, and consider a note on the
  slower tools ("reply with the answer only").
- **Same-client double booking.** The fresh re-check before every booking
  write protects the *slot*, not the *intent*. The warmed
  `prefetch.appointments` list already holds the caller's upcoming visits; a
  guard "this client already has this service on this date — confirm they want
  a second one" is cheap and turns a data property back into a rule.
- **`log_running_late` note text.** Agree it should name the service. Minor.

## Suggested order of work

1. Hash-test failure message (§1.1) and BACKEND TOOL USE rewording (§1) — minutes.
2. Resolver: strip conjunctions, set-based coverage, sim case for "brow and lip" (§2.3).
3. Staff matcher: length-scaled bound, gate on `closest` (§2.1–2.2), shrink stopwords.
4. `cancel_visit` planning phase (§4).
5. Offer counter and reworded success notes (§3).
6. Lint rule and the 30-site sweep (§6).
7. Revert `OWNER_TRANSFER_MODE` and `TRANSFER_WINDOW_END` when testing ends — still live.

## Reproducing this review

```bash
cd ~/Documents/Dev/ai-receptionist-live-2026-09-12
npx vitest run && npx tsc --noEmit
node --env-file=.env --import tsx scripts/render-live-prompts.ts
npx tsx scripts/sim-scenarios.ts 2026-09-16
# the resolver probe (read-only):
node --env-file=.env --import tsx -e "import('./src/services/booking.js').then(async m=>{for(const q of ['brow threading and upper lip','brow threading lip','brow and lip']){const r=await m.resolveService(q);console.log(q,'→',r.kind,r.service?.name??'',(r.candidates||r.closest||[]).map(s=>s.name))}process.exit(0)})"
# production identity:
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://erica-production-f2e2.up.railway.app/admin/voice-test
```
