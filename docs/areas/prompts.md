# Prompts (Live voice + backend rules)

**Purpose.** What the two GPT-Live models actually read: a small
conversation-only VOICE prompt, and a rules+facts+catalog BACKEND prompt.
Realtime is retired (Aryan, 2026-09-16) — `VOICE_ENGINE=live` is the only
production path. `docs/REALTIME_RETIREMENT_PLAN_2026-09-16.md` §b is the
map of what's still shared vs. dead.

**Key code** — `src/voice/livePrompts.ts`:
- `buildLivePrompt` — the VOICE model's prompt (~900 est. tokens,
  conversation only; delegates everything factual).
- `buildBackendPrompt` — assembles `src/voice/backendRules.ts` constants +
  computed facts + catalog + caller context. No regex rewriting of rule text
  remains (as of the 2026-09-16 `backendRules.ts` refactor).
- `productionFacts` / `parseSections` — still parse COMPUTED facts (CONTEXT,
  CURRENT STATUS, TEMPORARY CLOSURE POLICY) out of `buildInstructions()`'s
  rendered string; this regex-parsing layer is the one piece not yet
  replaced by a typed facts function (retirement plan Stage 1 step 4).

`src/voice/backendRules.ts` — the THINKING model's RULES as authored plain
string constants (`PRIORITY`, `OPERATING_RULES`, `SERVE_AND_IDENTITY`,
`BACKEND_TOOL_USE`, etc.). **Edit Live behavior here**, or (preferred) in a
tool-result `note` — the latter rides with the data and only appears when
relevant.

`src/realtime/twilioStream.ts` `buildInstructions()` — builds the REALTIME
production prompt; still exists only because computed facts are parsed out
of its rendered output. Its `═══ CONVERSATION FLOW ═══` IDENTIFY/SERVE/CLOSE
block is REALTIME-ONLY and INERT on Live (banner comment above it says so).

**Guarded by:**
- `src/tests/livePrompts.test.ts` — golden-prompt tests (byte-identical
  against `src/tests/__golden__/*.txt`) plus the SHA-256 tripwire on the
  Realtime production prompt (`73cecffe…07505eaf`, unchanged since
  2026-09-16 — only its failure MESSAGE was fixed to explain where to
  actually make a Live-behavior change).
- `twilioStream.prompt.test.ts` — LOCATION/VACATION/SPAM section presence in
  the Realtime prompt.

**Traps:**
- 2026-09-15: "GPT-Live has TWO prompts; the one you edit may be inert" — a
  visit-aware RESCHEDULE rewrite of `SERVE` in `twilioStream.ts` passed its
  tests and never reached the Live backend model, because `backendSections()`
  replaced that section wholesale. **Always** run
  `render-live-prompts.ts` and read what the model actually receives.
- 2026-09-15: a tool the backend prompt bans "does not exist" even if
  registered — `BACKEND TOOL USE` had TWO separate ban copies; grep every one.
- 2026-09-16: before restructuring prompt plumbing, pin the rendered output
  byte-for-byte FIRST (golden test), then make the refactor reproduce it
  exactly; change wording in a separate commit from changing plumbing.
- An instruction written to stop rambling can forbid something you want
  (2026-09-15) — e.g. "confirm in ONE sentence, then stop" also banned the
  closing follow-up question. Name what a restrictive instruction must NOT
  suppress.

**Verify:**
```bash
node --env-file=.env --import tsx scripts/render-live-prompts.ts
npx vitest run src/tests/livePrompts.test.ts src/tests/twilioStream.prompt.test.ts
UPDATE_GOLDEN=1 npx vitest run src/tests/livePrompts.test.ts   # only when a wording change is deliberate; then review the diff
```

**Do not:**
- Edit `SERVE`/`IDENTIFY`/`CLOSE` in `twilioStream.ts` expecting it to affect
  the Live path — it does not.
- Regenerate goldens without reading the diff — only the intended sentences
  may differ.
- Add a write-ish tool without a carve-out in `BACKEND_TOOL_USE` (see
  `visit-tools.md`).
