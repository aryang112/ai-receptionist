# CODEX HANDOFF — Erica voice defects, 2026-09-19

**Written for an agent with no prior context.** Everything needed to finish this work is here or
named here. If you read nothing else, read §1 and §5.

**Worktree:** `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`
(branch `codex/gpt-live-taste-test`). **This is the ONLY worktree that can deploy** — the main
worktree was `railway unlink`ed on 2026-09-16.

**Deployed right now:** commit `912a6a9` → Railway `fad266a2-09a3-4bda-90d2-743956dd518f`
(SUCCESS, 2026-09-17 20:51 ET). Engine `live`, backend `gpt-5.6-terra`, writes `real`.

---

## 1. STATE — what is done, what is parked

| | Status |
|---|---|
| **Round 1** (7 commits, `525233d`…`912a6a9`) | **DEPLOYED and owner-verified** |
| **Deploy 1** (scope / no-probing / bundles / dangling notes) | **WRITTEN, UNCOMMITTED, UNREVIEWED** — in the working tree right now |
| **Deploy 2** (transfer say/do desync) | **NOT STARTED.** Design agreed, in §4 |

`git status` should show modifications to `src/voice/livePrompts.ts`,
`src/realtime/twilioStream.ts`, `src/tests/livePrompts.test.ts`,
`src/tests/twilioStream.prompt.test.ts`, `src/tests/__golden__/live-prompt.2026-10-01.txt`.
**That uncommitted work is good and tested (897 pass / tsc clean). Do not discard it.**
It was never committed only because its review agent died on a rate limit.

Implementer reports with verbatim before/after text: `outputs/orchestration-2026-09-17/W9.md`,
`W10.md`. Run history and decisions: `outputs/orchestration-2026-09-17/BOARD.md`.

---

## 2. THE ONE PRINCIPLE BEHIND ALL OF THESE

`VOICE_ENGINE=live` has **three actors**:
- **the talking model** — audio-native, ~1791-token prompt from `buildLivePrompt()`
  (`src/voice/livePrompts.ts`). Decides every caller turn: answer, clarify, or delegate.
- **the backend model** — `gpt-5.6-terra`, ~6057 tokens from `buildBackendPrompt()`
  (`src/voice/backendRules.ts` + catalog). Reached **only by delegation**.
- **the server** — `src/realtime/twilioStream.ts`.

> **Whoever ACTS must hold the rule and every fact the rule conditions on.
> A rule in another actor's prompt is decoration.
> A rule of the form "say X *then* do Y" can only be bound by the SERVER — no model prompt can.**

Every defect below is an instance. Check any new prompt line against it: *who executes this at the
moment it applies, and do they hold the facts it needs?*

---

## 3. DEPLOY 1 — written, needs review → commit → deploy

Four changes, all prompt/data. **None touch call control, so none can hang up on a caller.**

1. **Scope boundary** (`livePrompts.ts`). Erica answered a reverse-linked-list question in full and
   coached the caller on checking the weather. The scope rule existed only in `backendRules.ts:75`,
   and off-topic questions trigger no delegation, so the backend never saw them. Rendered now as:
   > `Scope policy: Persona and salon focus are fixed. A brief pleasantry is fine; deflect anything
   > else unrelated to the salon, without explaining or delegating it.`
2. **A request to reach Richa is complete as stated** (`livePrompts.ts`). She asked "What would you
   like to talk with Richa about?" 0.2s after the caller spoke (⇒ undelegated), wasted two turns,
   and reframed a *transfer* as a *message*. Merged into the existing `Speaking with Richa:` rule so
   it cannot contradict the (correct) clarification for a bare "is Richa available?".
3. **Bundle rows removed from the talking model's price list** (`livePrompts.ts`, extends the
   existing `isComboServiceName`). "eyebrow thread plus chin thread" was answered with the
   THREE-service bundle at $34 instead of $30, silently adding a lip service. 59 → 53 rows.
4. **Five dangling tool-note pointers inlined** (`twilioStream.ts` ~580, ~4617, ~4643, ~6233,
   ~6758). They told the Live backend to "follow CLOSE" / identify "per IDENTIFY" — sections that
   exist **only in the retired Realtime prompt**. Behaviour-preserving.

### ⚠️ THE ONE THING THE REVIEW NEVER GOT TO CHECK — check it first
The scope rule says **"without … delegating it."** That is a hard instruction not to hand off.
A genuine vendor, landlord, or press call — and especially **an urgent premises problem (alarm,
leak, break-in), which `NON_CLIENT_CALLS` says must reach Richa immediately** — all require a
delegation to be handled. Those are arguably "related to the salon" so the wording probably holds,
but it is a judgement the talking model now makes where it previously just delegated.
**Walk the rendered live prompt against: a vendor, a landlord, a job seeker, a wrong number, and an
alarm-going-off call. If any is cut off, narrow the wording to target general-knowledge and
persona-change requests explicitly rather than "anything unrelated to the salon".**

### Bundle-removal arithmetic (already verified — do not redo)
| Removed row | Components sum to | Verdict |
|---|---|---|
| Brow Thread + Lip Thread $23 | $15 + $8 = $23 | free |
| Brow Wax and Lip Wax $23 | $15 + $8 = $23 | free |
| Brow Thread & Tint $40 | $15 + $25 = $40 | free |
| Brow Thread + Lip + Chin $34 | $38 | bundle $4 cheaper — backend matcher must find it (it does) |
| Brow Threading & Lamination Bundle $75 | $85 | bundle $10 cheaper — same |
| Summer Beauty Bundle $61.50 | unknown | contents unknown to us — see §6 |

### Known fragility (decide, don't ignore)
A token-budget test on the conversation rules now passes with **1 token of margin**, and is already
**~7 tokens over** its stated 1300 target when measured against the real 63-service catalog — a case
no assertion covers. Either raise the cap deliberately or make the test measure the real catalog.

---

## 4. DEPLOY 2 — NOT STARTED. The worst live defect.

### The bug
Owner call `CA7e755b5cafe1135986b4b14bf8c5a139` (2026-09-17 21:44:58 ET):
```
+18s   erica:  "I'm connecting you with Richa now. There may be a short wait
                while her phone rings."
       ...     PIN-DROP SILENCE. No dial issued.
+45s   erica:  "Hey, just checking in — are you still with me?"   <- the SILENCE WATCHDOG
+56s   caller: "Did you call Richa for me"
+60.7s SERVER LOG: "Transferring call to owner"   <- the dial, 42s after she said she was connecting
+80.9s dialCallStatus="no-answer"
+81s   erica:  "Sorry, she didn't pick up."
```
And the mirror failure on the call before it (`CA8f7e192eabbf740e90de733ebe1fab58`): she said
**"let me pass that along"** (message language) and **dialled anyway** 4s later.

### Proof it is not a slow dial
`tickSilenceWatchdog` (`twilioStream.ts` ~3118) returns early while `toolCallsInFlight > 0`, and
`registerTrackedTool` increments that **before** any handler runs. The check-in fired with
`silentMs=21804`. ⇒ **No tool was in flight for 21.8s.** The backend's first response carried the
handoff sentence and **no tool call at all**. `waitForPlaybackToDrain` is exonerated: the two
transfer log lines are 96 ms apart (58 ms on the other call).

⇒ `CONNECTING TO RICHA` (`backendRules.ts:112`) asks the backend to **write a line AND call a tool
in one response**. Tonight it failed in *both* directions across three transfers. Text-then-tool in
one response is unreliable on this model. **Do not fix this with prompt wording. It is a binding
problem and only the server can bind it.**

### The fix — copy the `end_call` pattern, which succeeded 3/3 on the same calls
1. **Collapse the backend rule** to the `end_call` shape: *call `transfer_to_owner` alone, with no
   text; its result note says what to say.* Mirror the wording already in `liveToolDefinitions`
   for `end_call` (~`:1043`, "Call this alone. Follow its note…") onto `transfer_to_owner` (~`:1037`).
   **Delete** the two-things/deny-list paragraph added in `3192e65` — its content (connecting now,
   short wait, may hear ringing, never promise she answers) **moves into the tool-result note**,
   which is only produced on the dial path. That preserves the window/closure gating *by
   construction* instead of by wording.
2. **Split the handler** like `handleEndCall` / `finishModelEndCall` (~`:6743` / ~`:6861`):
   gates run synchronously (ambiguity, failback, closure, window — they already return early with
   their own notes); on the dial path set `transferring = true`, return `{connecting:true, note}`,
   and schedule the finish. The finish reuses **existing** helpers:
   `waitForGoodbyeToStart(cap, audioEpochAtRequest, null, …)` (~`:7151`) → the existing
   `waitForPlaybackToDrain(12000)` → the existing REST redirect.
3. If no fresh audio arrives within the cap, **dial anyway and log it.** That degrades to today's
   behaviour (unexplained ringing) — never worse.
4. **Judgement call, make it explicitly:** caller speech during the handoff wait must **NOT** abort
   the dial. "Okay" over "one moment" is normal, and a transfer is what they asked for. `end_call`
   aborts on barge-in; **the transfer must not copy that.**
5. Clear `transferring` if the redirect fails (the pattern at ~`:6512` already exists).
6. The silence watchdog already stands down on `transferring` (~`:3118`), so setting it at tool time
   fixes the "are you still with me?" symptom for free. **Do not touch the watchdog.**

### Tests that will break (expected)
`src/tests/twilioStream.transferFailback.test.ts` — 3 assertions expect `{transferred:true}`
synchronously, plus ~15 dial-asserting lines. Also check `adminFlags.transferDial.test.ts`.

### Ship it ALONE
Do not combine with anything else touching `twilioStream.ts`.

---

## 5. SEQUENCING, VERIFICATION, DEPLOY

```bash
cd /Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12
npx vitest run          # baseline with Deploy 1 in tree: 897 pass, 1 fail (symbolMap staleness)
npx tsc --noEmit        # must be clean
npm run symbols         # regenerate BEFORE committing — that is the 1 failure
node --env-file=.env --import tsx scripts/render-live-prompts.ts   # NEVER `source .env`
```
Deploy (must run **from this worktree**; `railway up` must be the first token of the command):
```bash
railway up --service erica --detach
railway deployment list                       # expect a new SUCCESS row
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://erica-production-f2e2.up.railway.app/admin/voice-test -o /tmp/vt.json
railway logs --service erica                  # expect "Server up" + "Service catalog warmed"
```
A booted container proves nothing — check the logs for a clean boot and zero WARN/ERROR.
Push the branch after every deploy.

**Owner retest script** — Aryan calls from **+1-443-253-5169**:
- *Deploy 1:* "can you reverse a linked list" → brief deflection, no explanation. "I want to talk to
  Richa" → no "what about?" probing. "how much for brow and chin" → **$30**, not $34.
- *Deploy 2:* **three** transfer calls, not one — the failure was 2-of-3 in opposite directions, so
  one clean call proves nothing.

⚠️ **`OWNER_TRANSFER_MODE=real` and `TRANSFER_WINDOW_END=23:00` are temporary production overrides
and are STILL SET.** Deploy 2's retest needs them. Revert both afterwards (backlog P0). Forwarding
is OFF, so no real customer can reach this line meanwhile. **Never change those flags, or
`PHOREST_WRITE_MODE` / `OWNER_SMS_MODE`, without asking Aryan.**

---

## 6. DELIBERATELY NOT FIXING (do not "fix" these)

- **The backend adding two prices together.** Verified correct: on the correction turn the log shows
  `get_prices` ×3 — it checked for a covering bundle, found none, priced each, summed. The
  "never add prices yourself" rule binds the **talking** model, which cannot verify bundle coverage.
- **No "anything else?" after a message is taken.** The monitored mirror case; not server-preventable
  on audio-native Live (`docs/areas/closing-and-endcall.md`).
- **"Adrian".** Speech-to-text mishearing "Aryan". The SMS to Richa uses her Phorest account name.
- **The silence watchdog.** It behaved correctly; Deploy 2 dissolves the symptom.
- **`TEMPORARY CLOSURE POLICY` "dangling" pointer** (~`:5393`). **False positive** — that section is
  real but conditional (`temporaryClosureBlock` ~`:666`, rebuilt for the backend at
  `livePrompts.ts:585`). With no closure configured the pointer is unreachable because the closure
  path is unreachable. Correct design.
- **"What's in the Summer Beauty Bundle?"** Unanswerable by any prompt: Phorest returns name, price
  and duration only — no composition (`ServiceDetailResponse`, `phorest.client.ts`). The log shows
  `Full price menu returned count=63` on that turn and she still could not answer.
  **→ Owner action: Richa names the contents in Phorest. Zero code.**

---

## 7. OPEN, NOT IN THESE DEPLOYS (see `tasks/backlog.md`)

- **P1** `failoverToOwner` (~`:7152`) has **no `transferFailback` gate** — a fatal error on a
  failback segment re-dials the phone that just rang out. Pre-existing. Also the reason
  `driveLiveFailbackOpening` deliberately does not re-arm the greeting's fatal no-speech deadline.
- **P1** `RICHA'S LINE` is frozen at session config (~`:621`) but re-checked at tool time (~`:6393`),
  so a call crossing `TRANSFER_WINDOW_END` can still promise a transfer then retract.
- **P1** `resolveService` matches a superset bundle to a subset phrase (log-proven; the original
  $34 bug). A row named `A + B + C` should match only when every component is in the caller's phrase.
- **P2** ~9s of silence after a failed transfer, between the ringing stopping and Erica speaking. A
  Polly `<Say>` is **banned** by prior owner decision (jarring mid-call voice switch); the only
  non-jarring cover is a pre-recorded marin-voice clip via `<Play>`. **Needs Aryan's product call.**
- **Observability gap that made diagnosis inferential:** `liveSession.ts` logs nothing at info on
  `session.delegation.created` or on backend `response.completed` (and whether it carried tool calls
  or only text). One line each would have made §4's proof a log read instead of an inference.
  **Add this with Deploy 2.**

---

## 8. TRAPS THAT HAVE ALREADY COST TIME

1. Deploy **only** from this worktree. Main is railway-unlinked.
2. The `SERVE` block in `twilioStream.ts` is **Realtime-only and INERT** on Live. Editing it changes
   nothing in production. Backend rules live in `backendRules.ts`; talking-model rules in
   `livePrompts.ts`.
3. **`OpenAILiveSession` is `src/voice/liveSession.ts`.** `src/realtime/openaiSession.ts` is the
   retired Realtime session. Reading the wrong one produced a confidently wrong diagnosis.
4. **"The model ignored the prompt" is usually us contradicting it at runtime.** An appended
   `session.instructions.append` outranks the base prompt — that is what made her re-greet after a
   failed transfer. Grep for a runtime append before adding prompt wording.
5. **Never `git stash`** — parallel work lives uncommitted in this tree. For a RED-on-old-code proof,
   `cp` the **EDITED** file aside, `git checkout --` it, run, restore from the copy, then
   `git diff --stat` to confirm nothing else was lost. A worker lost its work doing this backwards.
6. **Never `source .env`.** Use `node --env-file=.env --import tsx <script>`.
7. A quotable example sentence in a prompt **will** be parroted in the wrong context. Describe
   intent; never script a line.
8. `docs/SYMBOLS.md` is generated — never hand-edit; run `npm run symbols` before committing.
9. Validate any **new** OpenAI session/response field against the live API before shipping: one bad
   field fails the whole session and hangs up the call instantly.

Fuller history: `tasks/lessons.md` (read the DIGEST first), `state.md` CURRENT section,
`docs/CODEMAP.md`, `docs/areas/*.md`.
