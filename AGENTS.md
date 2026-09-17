# AI Receptionist — Codex Instructions

## Auto-Resume (do this every session, no matter what)
1. Read the `## CURRENT` section of `state.md` (not the whole file),
   `docs/CODEMAP.md` (file map), `docs/SYMBOLS.md` (generated: `npm run
   symbols`), the `docs/areas/*.md` file for the area you are touching, and
   the `## DIGEST` at the top of `tasks/lessons.md`. `PLAN.md` is the older
   feature plan (context only). Read state.md's full RECENT LOG / history,
   or the rest of `tasks/lessons.md`, only when a question needs it.
2. Run `git status && npm test 2>&1 | tail -20`
3. When reviewing recent/daily calls, also inspect the latest available
   `erica-call-qa` report. Independently verify every reported issue against the
   call metadata, full transcript, tool evidence, and recording when the claim
   depends on timing/audio. Label it VERIFIED, LIKELY, NEEDS LISTEN, or FALSE
   POSITIVE; never treat the automated QA email as ground truth.
4. Pick up from the "PENDING — action items" in `state.md`
5. Continue from there — do not ask the user, just go

## Mid-Task Recovery
If interrupted mid-task:
1. `git status` — see modified but uncommitted files
2. `npm test` — see what's failing
3. `npm run build` — see TypeScript errors
4. Read the partially-modified file(s) to understand state
5. Resume from exact point of interruption

## Commit Rules (critical)
- Commit after EVERY checkbox in PLAN.md, not just major tasks
- Format: `feat: [description of the specific sub-task completed]`
- This makes mid-task recovery surgical — exact restore point is always known

## Core Rules
- Append new `state.md` entries at the TOP of RECENT LOG (newest first); keep
  CURRENT ≤ 1 page and rewrite it, never append to it.
- Always use `.js` extension in local imports (ESM)
- Never log secrets or full phone numbers
- PhorestPort interface is the contract — mock and real must match exactly
- business.json is hours source of truth — do not change it
- ⏰ Phorest timezone is INCONSISTENT per endpoint (NOT all UTC!): GET /appointment
  returns salon-LOCAL time, /appointments/availability returns UTC, writes send
  local wall-clock. Normalize to salon-local in phorest.client.ts. See tasks/lessons.md.
- Phorest query params are snake_case (client_id, from_date) — camelCase is silently ignored
- Validate any NEW OpenAI session.update field against the live API before shipping (a
  bad field fails the whole session → instant call hangup)
- Phone: 10 digits, strip leading 1
- Voice responses: 1-2 sentences, conversational, no IDs/URLs read aloud
- Automated QA is a lead generator, not an oracle. Transcript-only evidence
  cannot confirm interruption, clipping, exact spoken numbers, or who hung up.
- Run `npm test` after every change — keep all green
- USE_MOCK_PHOREST=false (real Phorest creds are in .env)
- Owner phone: +14433706471
- Erica's voice: marin (natural FEMALE Realtime voice — chosen for a women's salon; cedar is the male alt — env-tunable via OPENAI_REALTIME_VOICE; change needs a dev-server restart, not just tsx reload)
