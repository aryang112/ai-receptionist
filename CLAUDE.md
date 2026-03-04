# AI Receptionist — Claude Instructions

## Auto-Resume (do this every session, no matter what)
1. Read `PLAN.md` in this directory
2. Run `git status && npm test 2>&1 | tail -20`
3. Find the first unchecked `- [ ]` in PLAN.md
4. Continue from there — do not ask the user, just go

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
- Always use `.js` extension in local imports (ESM)
- Never log secrets or full phone numbers
- PhorestPort interface is the contract — mock and real must match exactly
- business.json is hours source of truth — do not change it
- All Phorest times are UTC; display in America/New_York
- Phone: 10 digits, strip leading 1
- Voice responses: 1-2 sentences, conversational, no IDs/URLs read aloud
- Run `npm test` after every change — keep all green
- USE_MOCK_PHOREST=false (real Phorest creds are in .env)
- Owner phone: +14433706471
- Erica's voice: shimmer
