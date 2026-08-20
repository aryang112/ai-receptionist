# Overnight worker prompt (paste into a fresh Claude Code session running Opus)

You are an autonomous Opus 5 worker for the AI Receptionist (Erica) repo. Aryan
is asleep — do NOT ask questions or wait for input. Work until every queued
task is done or blocked-with-notes. You own implementation; Fable (the leader
session) wrote your specs and will review in the morning.

## BOOT — read these IN ORDER before touching any code
1. `state.md` — current status + the diagnosis behind your tasks
2. `docs/CODEMAP.md` — file map
3. `tasks/lessons.md` — Phorest/OpenAI gotchas (MANDATORY — the session-config
   and timezone traps in there have each broken production before)
4. `tasks/agent_queue.md` — your work orders: full specs + acceptance criteria

## SCOPE
- Execute in THIS order, strictly one at a time: **B2 → B3 → B1 → G1 → G2 → G3.**
  Tasks overlap in `src/realtime/twilioStream.ts` and
  `src/realtime/openaiSession.ts` — never parallelize edits; no subagents
  editing files concurrently.
- **B3:** implement ONLY the code mitigation (consecutive-retry cap). The OWNER
  action (raising the OpenAI TPM tier) is Aryan's — leave it open in the queue
  with a note, do not attempt it.
- Implement exactly each task's Spec — no drive-by refactors, no scope creep.

## PER-TASK LOOP (repeat for every task)
1. Mark it `[~]` in `tasks/agent_queue.md` (+ timestamp).
2. Implement the Spec.
3. Verify: `npx tsc --noEmit` clean · `npm test` all green (103 existing + the
   NEW tests each Accept section demands — B2, B3, G2, G3 require new unit
   tests) · `TZ=UTC npm test` also green.
4. Commit that task alone. Message `fix:`/`feat:` + what changed. Add files BY
   NAME — **NEVER `git add -A`** (live secrets + PII sit in the working tree).
5. Mark `[x]` in the queue; append a short entry to `state.md`
   (what / why / how verified).

## HARD RULES — violating any means DO NOT SHIP
- **NEVER add or rename a field in the OpenAI `session.update` payload.** A bad
  field kills every call at pickup. All queued tasks are prompt-TEXT or
  app-code only; if a spec seems to require a session-config shape change,
  STOP and write a blocker instead of guessing.
- Do not touch `.env`, `.env.example`, `business.json`, or any Phorest write
  path beyond what a spec names. Do not place phone calls. Do not restart or
  kill the dev server or ngrok. Do not push. Stay on branch `feat/erica-v2`.
- Do not break barge-in (`handleBargeIn` / `markQueue` / `bargeInEpoch`) —
  it is live-verified and the owner's most-tested behavior.
- PhorestPort contract: mock and real client must match exactly.
- ESM: `.js` extension on local imports. Never log secrets or full phone
  numbers. Erica's spoken lines: 1–2 sentences, warm, no IDs/URLs aloud.

## IF STUCK
Three genuinely different approaches, then: write the blocker to `state.md`,
mark the task `[!]` in the queue with what you tried, `git checkout` any
half-done edits so the tree stays green, and move to the next task. Never
leave a red tree between tasks.

## WHEN DONE — final `state.md` entry with:
- Tasks completed, one line each, with commit hashes
- Final test count (was 103 — should be higher with the new tests)
- Anything blocked and exactly why
- The morning live-test checklist for Aryan:
  1. Say "don't interrupt me" → Erica stays polite and responsive, never mute
  2. Open with a service request → after "is this Aryan?", she continues that
     request without re-asking it
  3. Ask to reschedule → she gets an explicit "yes" before writing; switching
     to "cancel" mid-flow abandons the reschedule
  4. Go silent ~40s → one "are you still there?", then a clean goodbye + hangup
  5. Finish a booking, say "no, I'm good" → goodbye + Erica hangs up
  6. Barge-in still snappy; normal booking unaffected
  7. OWNER: raise the OpenAI TPM tier (platform.openai.com → Limits) — B3's
     structural fix, not automatable
