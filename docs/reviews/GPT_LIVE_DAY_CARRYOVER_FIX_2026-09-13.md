# Live carry-over fix — a detail the caller already gave is asked for again

## The defect

Owner call `CA3d5d6bb3f6a00adcd2fe5d11b83d2ed3` (2026-09-13 10:25 ET, Live +
Terra, real writes). The caller said "tomorrow" while asking about Richa and
hours, then asked to book. After resolving the service Erica asked "What day
would you like?" and the caller answered "I already told you tomorrow."

No instruction tells Erica to ask for the day. The opposite: the released
production prompt's TOOLS section says `No day → today AND tomorrow, a couple
from each` — check, do not ask. `backendSections()` in `src/voice/livePrompts.ts`
drops the whole TOOLS section (`case 'TOOLS': continue;`) when building the
backend prompt, so that rule never reached the Live stack. The SERVE rewrite
replaced it with "first resolve the requested service, date, and public
availability", which with a missing date resolves to a question.

Two counterweights exist but are scoped too narrowly to help: "never make the
caller repeat a request" sits inside IDENTITY & CONTACT (names/phones only),
and the suggest_availability description tells Erica to park a day the caller
gave and ask for the service first, without ever saying to pick the day back up.

## Same class, real customer, opposite direction

`CA85c9db416495728578a30a9b5e0ec42c` (2026-09-06): caller asked for "eyebrow
threading and upper lip", Erica quoted $23, asked the day, got "Today at 5:15",
then asked "Which service would you like to book?" — dropping the service she
had just priced. Issue register entry 12 covers repeated *identity* questions
only; service/date carry-over was uncovered.

## Change

`src/voice/livePrompts.ts` only. The released production prompt is unchanged
(its locked sha256 test still passes), so the legacy Realtime path is untouched.

- Live speech prompt: a `Carry-over:` rule — keep service/day/time/name given
  anywhere in the call, never ask twice, and a day named while asking about
  hours or about Richa is still the requested day.
- SERVE: a `CARRY OVER` bullet stating that asking the service first does not
  discard the day.
- SERVE BOOK: take the date from what the caller already said; only when no day
  has been mentioned at all, check today and tomorrow and offer a couple from
  each instead of asking.
- SERVE RESCHEDULE: reuse a new day already named.
- BACKEND TOOL USE: the same carry-over and no-day fallback for the tool side.

`src/tests/livePrompts.test.ts` locks all five strings.

## Verification — actual Live + Terra replays

`scripts/gpt-live/controller-probe.mjs`, local, real OpenAI Live + Terra + real
read-only Phorest, writes forced to simulate, no phone dialed. Scenario
`scenario-faithful.json` reproduces the owner call turn for turn.

| Build | Runs | Re-asked the day |
|---|---|---|
| Before | 5 | 2 (base-1, base-3 — "What day would you like to come in?" / "What day would you like?") |
| After | 6 | 0; all six called suggest_availability with date 2026-09-14 |

The defect is intermittent (~40%), which is why single test calls passed.

No-day control (`scenario-noday.json`, caller never names a day), 3 runs after
the fix: 2 checked today (closed) then tomorrow and offered three times; 1 asked
which day. No run assumed a day the caller had not given — the fallback is
preferred behavior, not a safety property, and asking remains acceptable.

701 tests / 62 files and `tsc --noEmit` pass. No code deployed; no real Phorest
write made by this work.

## Adjacent findings, not fixed here

- `CAd163ac9ef7fdac009382931f110add23` (09-06): new client completed service,
  time, phone and name, then got "a system issue" and no booking. This is issue
  23 (Phorest EMAIL_REQUIRED), fixed 09-08 in `acbed9c`. Closed; recorded as the
  cost of a last-step integration failure.
- `CA4692de2d1423d376a85443f9ae049dbd` (09-06): failed transfer returned a fresh
  greeting, the caller repeated himself, and Erica promised the transfer a second
  time before admitting she could not reach Richa. This is issue 30; its fix is
  recorded as local-only in `5769300` and NOT deployed, and the Live stack is on
  a different branch. Verify before the next owner taste test.
- `CA0d5e586f24051ef7e1d8f5ee0c45a79a` (09-06): three sequential reschedules for
  one visit — the grouped-visit gap (issue 08), design only in
  `docs/GPT_LIVE_GROUPED_VISIT_PLAN_2026-09-12.md`, deliberately not implemented.
  That transcript also shows garbled caller input ("Á.", "Every.") accepted as
  approval of a 3:00 PM move. An approval guard for unintelligible input is worth
  scoping separately from grouping.
