# Handoff — 2026-09-14 / 15 session

**Written for the next agent picking this repo up.** Read this before touching
prompts, availability, or deploys. Three things here will waste hours if you
don't know them.

---

## ⚠️ THREE TRAPS — read first

### 1. Deploy from the LIVE worktree only
```
cd ~/Documents/Dev/ai-receptionist-live-2026-09-12     # branch codex/gpt-live-taste-test
railway up --service erica --detach
```
`~/Documents/Dev/ai-receptionist` (main) is linked to the **same Railway
service**. `railway up` from there silently ships old `main` — no GPT-Live, no
fixes. **This happened on 2026-09-15** and rolled production back three days.

**Verify by build identity, never by "a container booted":**
```
curl -H "Authorization: Bearer $ADMIN_TOKEN" .../admin/voice-test
```
That route exists **only** on the live branch. Expect `engine: "live"`. A 404
means you shipped main. A healthy boot log proves nothing.

### 2. Editing `SERVE` in `twilioStream.ts` does nothing on the Live path
`livePrompts.ts` builds its **own** CONVERSATION FLOW for the backend model.
Prompt edits to the production `SERVE` section are inert in production. Change
behaviour in **`livePrompts.ts`** or in a **tool-result note** — the latter is
more reliable, because coaching rides with the data and only appears when
relevant. See `docs/PROMPT_AUDIT_2026-09-15.md` §0.

### 3. A tool the backend is forbidden to call does not exist
Adding to `TOOL_DEFINITIONS` is **not enough**. The backend prompt bans raw
write tools; anything write-ish needs an explicit carve-out in
`livePrompts.ts` → `BACKEND TOOL USE`. `reschedule_visit` shipped, was invisible,
and Erica told a caller *"I'm unable to check a combined opening"* (`dae29c7`).
There were **two** copies of that ban — grep before assuming one.

---

## What changed this session (9 commits, all on `codex/gpt-live-taste-test`)

| Commit | What |
| --- | --- |
| `7623802` | **Never offer a time Phorest did not return.** Deleted `snapSlotsToGrid`. DEPLOYED + verified live. |
| `8b6f3bf` | `reschedule_visit` — plan a whole sitting before moving anything |
| `dae29c7` | Let the backend actually call it (the ban above) |
| `fdfc73b` | Tests: N-appointment and subset moves |
| `78ecd3a` | Real alternatives when the requested visit time is blocked |
| `2cbf7b1` | Erica takes the lead once a request is fully handled |
| `423c7c1` | `book_visit`, `cancel_visit`, running-late across the sitting |
| `1f201b8` | A farewell outranks the anything-else offer |
| `626890e` | **Post-GPT-Live audit** — 7 prompt conflicts, 3 defects |

Only `7623802` is live. **Eight commits await deploy.**

---

## The headline bug, and why it matters beyond itself

Erica offered **5:30 PM** for a slot another client was already sitting in, and
double-booked the owner into two 6:00 PM appointments.

Cause: code rounded Phorest's real free-start times UP to tidy quarter-hours,
then **spoke and booked the rounded value**. Phorest anchors its availability
grid to appointment **ends**, so the gaps between free starts ARE other people's
appointments. Rounding up walks into one. Threading runs 5 minutes, so a
5-minute shift is a whole appointment wide.

Two lessons worth generalising:

- **The prompt already forbade this** — *"never round, shift, or approximate."*
  Only the code was violating it. When a prompt rule and behaviour disagree,
  suspect the code before rewriting the rule.
- **The real fix was a setting, not code.** Phorest → Settings → Online →
  Booking Rules → *"Booking slots: show available slots every…"* was `0 minutes`,
  which is why odd times existed at all. Now `5 minutes`. Tomorrow's bookable
  openings went from **8 to 20**. Check the source system before compensating
  for it downstream.

---

## Current production config (temporary — revert when testing ends)

| Variable | Value | Note |
| --- | --- | --- |
| `OWNER_TRANSFER_MODE` | `real` | was `simulate`; rings Richa's actual phone |
| `TRANSFER_WINDOW_END` | `23:00` | default is `20:00` in this build |
| `OWNER_SMS_MODE` | `simulate` | deliberately left off |
| `PHOREST_WRITE_MODE` | `real` | **test bookings hit the real calendar** |

Call forwarding is **OFF**, so no real customers reach this line yet.
A fatal error inside the transfer window also dials Richa — not just deliberate
transfers.

---

## Tooling added (all read-only, reusable)

```bash
npx tsx scripts/sim-scenarios.ts 2026-09-16     # production scenarios vs real Phorest
npx tsx scripts/sim-visit.ts 2026-09-16 17:30   # visit planning
npx tsx scripts/sim-availability.ts 2026-09-16  # slot integrity
node --env-file=.env --import tsx scripts/render-live-prompts.ts   # both prompt layers
```
Re-run `sim-scenarios.ts` after ANY change to the service matcher or prompts.

---

## Open work, roughly in priority order

1. **Deploy the eight pending commits**, then re-test a full reschedule.
2. **Item 05's deeper half** — the price tool and the availability tool use
   different service selection. "brow threading and upper lip" resolves to the
   bundle for price and not for availability.
3. **Item 15 — narration** (*"Okay, checking that"*). Fix exists in `5769300`,
   confirmed NOT in this line. Compliance gap, not a conflict.
4. **Same-client double-booking has no explicit guard** — currently prevented
   only because availability became truthful.
5. **Revert the temporary transfer config.**
6. `docs/PROMPT_AUDIT_2026-09-15.md` §5 lists what a reviewer should challenge.

---

## Where the record lives

- `state.md` — full chronological log. **Note:** this session's entries were
  written into MAIN's copy and ported onto this branch under a "WORKTREE SPLIT"
  header. Both copies now hold the same text.
- `tasks/lessons.md` — durable rules extracted from these failures.
- `docs/PROMPT_AUDIT_2026-09-15.md` — the audit, written for review.
- `docs/PRODUCTION_ISSUES_AND_GPT_LIVE_2026-09-12.md` — the 32-item register
  this session worked against. Item numbers here refer to it.
