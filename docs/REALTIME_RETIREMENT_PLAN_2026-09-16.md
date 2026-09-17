# Realtime retirement plan

**Written by:** Workstream G (docs/planning only — no code in this session).
**Date:** 2026-09-16. Repo: `ai-receptionist-live-2026-09-12`, branch
`codex/gpt-live-taste-test`. Working tree was dirty at the time of this audit
(Waves 1–3 editing `src/realtime/twilioStream.ts`, `src/services/booking.ts`,
`src/realtime/toolSchemas.ts` concurrently) — every file:line reference below
was re-checked against the on-disk state as read; line numbers will drift as
those streams land. Re-grep before trusting a line number more than a day old.

## a. Decision and date

Aryan (owner), 2026-09-16: **the OpenAI Realtime engine is retired for good.**
`VOICE_ENGINE=live` is the only path going forward. Quote: *"Anything and
everything we need from it should be fetched now and planned for."* This
document is that fetch: what the Realtime path currently owns, what of it the
Live path still depends on, and a staged plan to remove the rest safely.

Two related, separate decisions from the same day (not actioned here):
tool compaction (visit tools take one service; retire the
`prepare_appointment_action`/`confirm_appointment_action` pair) goes to
`tasks/backlog.md`, and the temporary production config
(`OWNER_TRANSFER_MODE=real`, `TRANSFER_WINDOW_END=23:00`) stays until Aryan
finishes a transfer-fail test, then reverts.

---

## b. Inventory

### i. `buildInstructions()` in `src/realtime/twilioStream.ts` — computed vs. static

`buildInstructions()` (function starts at `twilioStream.ts:544`, returns at
`:772`) builds the **PRODUCTION prompt** — historically what was sent verbatim
to the Realtime session, and today the single shared source `livePrompts.ts`
filters to build both Live prompts (see next section). It has 18 `═══ NAME
═══` section headers (`grep -n '═══' twilioStream.ts`, lines 626–768). Checking
each section's body for a `${...}` template interpolation splits them:

| Section | Header line | Computed (`${…}`)? |
| --- | --- | --- |
| TEMPORARY CLOSURE POLICY | 626 | **Yes** — whole block conditional on `getActiveOrUpcomingVacation()` |
| PRIORITY | 666 | No — static rule |
| PERSONALITY & TONE | 669 | No |
| LANGUAGE | 673 | No |
| RESPONSE SHAPE & TURN-TAKING | 676 | No |
| REFERENCE PRONUNCIATIONS | 684 | No |
| CONTEXT | 687 | **Yes** — `businessHours.location.*`, `buildHoursLine()` |
| SERVICES & PRICES | 693 | **Yes** — `servicesSection` (live catalog or tool-first fallback) |
| REASONING & UNCLEAR AUDIO | 696 | No |
| PREAMBLES | 700 | No |
| TOOLS | 705 | No |
| OPERATING RULES | 715 | No |
| PRIVACY — NEVER GIVE OUT DETAILS | 721 | No |
| CONVERSATION FLOW | 727 | **Partly** — only the `GREETING` sub-block (`greetingSection`) is computed; IDENTIFY/SERVE/CLOSE below it (`:730`–`:744`) are static authored rules |
| SAFETY & ESCALATION | 746 | No |
| SPAM & TELEMARKETING | 759 | No |
| NON-CLIENT CALLS | 764 | No |
| CURRENT STATUS (…) | 768 | **Yes** — fully computed: current date/time, today's hours status, RICHA'S LINE |

So five sections carry genuinely computed facts (closure policy, context,
services, the greeting line inside CONVERSATION FLOW, current status); the
other thirteen are static authored rules, word-for-word regardless of engine.

**How `livePrompts.ts` derives from it (verified, not assumed):**
`buildInstructions()` runs once per call regardless of engine
(`twilioStream.ts:2327`, unconditional). Its output (`productionInstructions`)
is then either:
- sent as-is to `OpenAIRealtimeSession.configureSession({ instructions: … })`
  (`twilioStream.ts:2395`, the `else` branch), or
- passed into `buildLivePrompt(productionInstructions, …)` and
  `buildBackendPrompt(productionInstructions, …)`
  (`twilioStream.ts:2377`/`:2382`, the `this.session instanceof
  OpenAILiveSession` branch).

`buildBackendPrompt` (`livePrompts.ts:419`) calls `backendSections()`
(`livePrompts.ts:360`), which `parseSections()`s the production prompt by its
`═══` headers and, per section name, either **drops** it (`SERVICES & PRICES`,
`PREAMBLES`, `TOOLS` — `continue` at lines 370/374–376), **rewrites** it via a
regex transform (`RESPONSE SHAPE & TURN-TAKING`, `REASONING & UNCLEAR AUDIO`,
`CONVERSATION FLOW`, `SAFETY & ESCALATION`, `SPAM & TELEMARKETING`,
`NON-CLIENT CALLS`, `OPERATING RULES`, `CURRENT STATUS`, `TEMPORARY CLOSURE
POLICY`), or **passes through unchanged** (everything else). `rewriteConversation`
(`livePrompts.ts:240`) is the one that replaces IDENTIFY + SERVE wholesale —
this is the "two prompts" trap documented in `tasks/lessons.md` (2026-09-15
entry) and `docs/AUDIT_REVIEW_2026-09-15.md` §1: editing `SERVE` in
`twilioStream.ts` is inert on the Live path.

**Workstream B landed during this session** (confirmed via its `state.md`
completion entry and a re-read of the code, both after the paragraph above
was first drafted from a pre-landing snapshot — corrected here rather than
left stale). `src/voice/backendRules.ts` now exists (22KB, authored plain-text
constants: `PRIORITY`, `PERSONALITY_AND_TONE`, `LANGUAGE`,
`RESPONSE_SHAPE_AND_TURN_TAKING`, `REFERENCE_PRONUNCIATIONS`,
`REASONING_AND_UNCLEAR_AUDIO`, `OPERATING_RULES`, `PRIVACY`,
`SERVE_AND_IDENTITY`, `TRANSFER_FAILBACK_CALL_CONTEXT`, `SAFETY_AND_ESCALATION`,
`SPAM_AND_TELEMARKETING`, `NON_CLIENT_CALLS`, `TEMPORARY_CLOSURE_POLICY_RULES`,
`BACKEND_TOOL_USE`, `CANONICAL_SERVICE_CATALOG_HEADER`). `backendSections()`
(`livePrompts.ts:270`) no longer calls a `rewriteConversation`-style regex
transform on the production prompt's rule sections at all — it `push()`es each
authored constant in production order, and separately extracts only three
still-genuinely-computed bodies out of `productionInstructions` by section
name: `CONTEXT`, `CURRENT STATUS (…)`, and `TEMPORARY CLOSURE POLICY`
(`livePrompts.ts:272–280`). The `livePrompts.test.ts:219–237` SHA-256 tripwire
was also fixed in place: same pinned hash (`73cecffe…07505eaf` — unchanged,
confirmed by `state.md`'s "Hash itself untouched" note), but
`expect(digestBefore, message).toBe(hash)` now carries an explanatory message
naming `backendRules.ts`/`buildLivePrompt` as where to make a Live-behavior
change instead of failing silently on `SERVE`. A `// REALTIME-ONLY — inert
when VOICE_ENGINE=live` banner comment was also added directly above the
`═══ CONVERSATION FLOW ═══` line inside `buildInstructions()`'s template
(`twilioStream.ts:727–729`), naming this very plan doc.

**What this changes for Stage 1, concretely:** the backend-prompt *rule*
extraction problem (§1 of the audit review) is now solved — there is no more
regex rewrite of authored rule prose. What is **not** yet solved, and is
still exactly Stage 1 step 4's job, is the *facts* extraction: both
`backendSections()` (for the backend prompt) and `productionFacts()`
(`livePrompts.ts:81`, for the Live/voice prompt) still get their computed
facts by textually re-parsing `buildInstructions()`'s rendered string —
`parseSections()`-by-header-name plus ad hoc regexes (e.g.
`productionFacts()`'s `dateLine.match(/Right now it is (.+?) at the salon/)`
at `:106`). That is the fragile layer the audit review's §1 flagged
("the regex-transform layer is the fragile part... collapsing more onto it
adds more of that, not less") and it still exists, just narrowed to facts
only. Replacing it with one typed facts function (computing
`{ salonName, address, hours, todayStatus, richaLine, temporaryClosure, … }`
directly from the same inputs `buildInstructions()` uses, rather than by
parsing `buildInstructions()`'s own output) is the real remaining piece of
Stage 1 step 4 — smaller now than originally scoped, but still real work.

### ii. `REALTIME_CONTEXT_NOTES` and shared tool-result notes

`REALTIME_CONTEXT_NOTES` (`twilioStream.ts:527`–`542`) is a misleadingly-named
constant: despite the name, it is **used by both engines**. It's consumed only
through `this.session.injectContext(note)` (6 call sites: `:2852`, `:2882`,
`:2938`, `:2976`, `:6473`, `:6507`, plus two direct reads at `:6339`/`:6340`
for the end-call goodbye note), and `injectContext` is implemented by **both**
session classes — `OpenAIRealtimeSession.injectContext` (`openaiSession.ts:406`)
and `OpenAILiveSession.injectContext` (`liveSession.ts:298`). Neither
implementation is a no-op stub; both feed the note into their respective
model. There is no `voiceEngine` guard around any `injectContext` call site —
every one of the six fires identically for both engines.

Tool-result `note` fields (per the CODEMAP's "state-specific coaching lives in
tool-result note fields") are likewise engine-agnostic by construction: they
are plain strings returned from tool handlers (`handleSuggestAvailability`,
`handleReschedule`, etc.) and both `OpenAIRealtimeSession` and
`OpenAILiveSession` relay a tool's JSON result (including its `note`) back to
their respective model the same way. This is *why* the visit-aware
`list_appointments` note worked live when the `SERVE` prompt edit did not
(`docs/AUDIT_REVIEW_2026-09-15.md` §1, `tasks/lessons.md` 2026-09-15 entry) —
notes ride with tool-result data on both paths; the production prompt's
`SERVE` section does not.

### iii. Every `voiceEngine` branch in `twilioStream.ts`

`grep -n voiceEngine src/realtime/twilioStream.ts` → **28 occurrences**
(re-checked after workstream B's Stage-0 edit landed; line numbers below are
current as of that recheck, not the earlier snapshot — expect further drift
from A/C/D/E/F), of which:
- **1** field declaration: `private readonly voiceEngine = env.VOICE_ENGINE;` (`:1425`)
- **1** telemetry read (not a branch): `engine: this.voiceEngine` inside a
  `CallStore.recordVoiceEvent('configuration', …)` payload (`:2367`)
- **20** `=== 'live'` branches: `:1446, :1845, :1924, :2073, :2086, :2486,
  :2621, :2753, :4137, :5100, :5141, :5220, :5381, :5465, :6223, :6236, :6273,
  :6358, :6363, :6939`
- **6** `=== 'realtime'` branches: `:1841, :1878, :2571, :2578, :2585, :2606`
- **0** `!== 'live'` occurrences (none exist — every branch is written as a
  positive `=== 'live'` or `=== 'realtime'` check, never a negation)

Separately, one **class-selection branch is not textually `voiceEngine ===`**
but is the master fork: `createSession()` (starts `:1816`, per the same
recheck) constructs `new OpenAILiveSession(...)` when
`this.voiceEngine === 'live'`, else `new OpenAIRealtimeSession(...)`, at the
ternary around `:1845`. That line is already counted above in the 20
`=== 'live'` branches.

Downstream of session construction, several branches key off
`this.session instanceof OpenAILiveSession` rather than `voiceEngine` directly
(e.g. `:2377` at the prompt-build call site) — these are not captured by the
`voiceEngine` grep but are the same fork in different clothing and must be
collapsed in Stage 1 alongside the 26 `voiceEngine` branches.

### iv. Realtime-only modules vs. shared modules

Checked by import, not by directory name — `src/realtime/` is **not** a
reliable proxy for "Realtime-only":

| File | Verdict | Evidence |
| --- | --- | --- |
| `src/realtime/openaiSession.ts` | **Mixed.** The `OpenAIRealtimeSession` class (`:94`) is Realtime-only — its only non-test consumer is `twilioStream.ts:1876`. But it also **exports shared types** (`ToolDefinition`, `RealtimeHandlers`, `RealtimeUsage`) imported by `twilioStream.ts:5–10` (used to type the shared `TOOL_DEFINITIONS`, `:1035`, and `liveToolDefinitions()`, `:961`) and by `src/voice/liveSession.ts:3–7` (`RealtimeHandlers`, `ToolDefinition`, `ToolHandler`) and `src/voice/liveProtocol.ts:1` (`RealtimeUsage`). **Cannot be deleted outright** — the types must be extracted to a shared module first (Stage 2). |
| `src/realtime/twilioStream.ts` | **Shared** (the whole file). Owns both engines' call handling, `buildInstructions()` (shared facts source), and every write-guard both engines rely on. |
| `src/realtime/toolSchemas.ts` | **Shared.** Consumed by `twilioStream.ts` (`parseToolArgs`) and by `src/voice/appointmentProposals.ts` (Live-only feature) — despite living in `src/realtime/`. |
| `src/voice/liveSession.ts` | Live's counterpart to `openaiSession.ts` — the `OpenAILiveSession` class. Live-only, as expected. |
| `src/voice/liveProtocol.ts`, `mulawAudio.ts`, `appointmentProposals.ts`, `testAccess.ts`, `testControl.ts`, `livePrompts.ts` | Live-only, confirmed by directory and import graph. |

**Net finding:** there is exactly **one** Realtime-only *class* to delete
(`OpenAIRealtimeSession` in `openaiSession.ts`) plus its dedicated test file;
there is no Realtime-only *module* that can be deleted wholesale without a
type-extraction step first.

### v. Env vars (`src/config/env.ts`, grepped fresh)

| Var | Line(s) | Default | Used by |
| --- | --- | --- | --- |
| `OPENAI_REALTIME_MODEL` | 42–43 | `'gpt-realtime-2.1'` | Realtime-only (`openaiSession.ts`) |
| `OPENAI_REALTIME_VOICE` | 46 | `'cedar'` | **Realtime-only** — `openaiSession.ts:151` (`this.voice = env.OPENAI_REALTIME_VOICE`). **Not read anywhere in the Live path.** `liveSession.ts` hardcodes `this.voice = voice ?? 'marin'` (`:193`) and `twilioStream.ts` never passes a `voice` option when constructing `OpenAILiveSession` — so today's production voice is a hardcoded default, not env-tunable. **`CLAUDE.md`'s current claim that Erica's voice is "env-tunable via OPENAI_REALTIME_VOICE" is already false for the live production path** — worth fixing in Stage 3 regardless of Realtime's fate. |
| `OPENAI_INPUT_TRANSCRIPTION` | 247 | `'off'` | Realtime-only wiring (`openaiSession.ts:324–333`, GA `audio.input.transcription.model`), **but** one shared consumer: `twilioStream.ts:6938` reads `env.OPENAI_INPUT_TRANSCRIPTION !== 'off'` **or** `voiceEngine === 'live'` to decide `transcriptionInFlight` before closing a call — i.e. Live is *unconditionally* treated as if transcription were on (Live is audio-native and has no such toggle; see `tasks/lessons.md` 2026-09-12 entry). **Keep this env var** through Stage 2 (it still gates a real Realtime session field) but the `twilioStream.ts:6938` condition simplifies to always-true once Realtime is gone. |
| `VOICE_ENGINE` | 78–83 | `'realtime'` | The switch itself. `type VoiceEngine = 'realtime' \| 'live'` (`env.ts:5`), used only at `env.ts:83`'s cast — no other file imports the `VoiceEngine` type. Narrowing this is a small, contained change. |
| `OPENAI_LIVE_BACKEND_MODEL` | 84–89 | `'gpt-5.6-terra'` | Live-only |
| `OPENAI_LIVE_BACKEND_EFFORT` | 91–95 | unset | Live-only |

### vi. Realtime-only scripts

| Script | Verdict | Evidence |
| --- | --- | --- |
| `scripts/test-openai-realtime.ts` | **Realtime-only.** Directly imports and instantiates `OpenAIRealtimeSession` (`../src/realtime/openaiSession.js`). |
| `scripts/validate-session-fields.ts` | **Realtime-only.** Opens a raw WS with `type: 'realtime', model: OPENAI_REALTIME_MODEL` — validates the GA Realtime `session.update` schema live, per the `lessons.md` rule ("validate any NEW session field against the live API"). No Live equivalent exists; Live's session-shape validation lessons live in the `GPT-Live-1 gotchas` `lessons.md` entry instead, evidenced against a different API shape entirely. |
| `scripts/validate-transcription-fields.ts` | **Realtime-only.** Same `type: 'realtime'` raw-WS pattern, validating `audio.input.transcription.*`. |
| `scripts/render-prompt.ts` | **Realtime-view, not Realtime-only code.** Imports `buildInstructions` from `twilioStream.ts` (the shared facts function) and prints what would be sent to the *Realtime* session verbatim. Once Realtime stops receiving `buildInstructions()`'s output directly, this script's specific view is moot — but the function it calls must survive (it becomes the facts source for both remaining prompt builders). Superseded by `scripts/render-live-prompts.ts` for the Live view. Safe to delete in Stage 2; do not delete `buildInstructions()` itself. |
| `scripts/test-twilio-openai-integration.ts` | **Not import-tied to Realtime** (only imports `ws`, no `openaiSession` import) but **written against Realtime-era server log lines** ("Speech started detected by OpenAI VAD", "response created") that don't describe Live's continuous-audio protocol. Effectively obsolete either way; recommend deleting alongside the Realtime scripts rather than trying to "port" it. |

Not in the task's list but found alongside it, same shape:
`scripts/test-integration-simple.ts` — same verdict as
`test-twilio-openai-integration.ts` (no direct Realtime import, but built
against pre-Live log-line expectations).

### vii. Tests that only exercise Realtime

| Test file | Verdict | Evidence |
| --- | --- | --- |
| `src/tests/openaiSession.test.ts` | **Realtime-only**, 30 test cases (`grep -c '^\s*it(' `), every one instantiating `OpenAIRealtimeSession` directly. Safe to delete once the class goes, **after** extracting the shared types it also happens to exercise indirectly (none — it only imports the class). |
| `src/tests/twilioStream.transferFailback.test.ts`, `twilioStream.greetingRace.test.ts`, `twilioStream.recording.test.ts` | **Not Realtime-behavior tests** — they `vi.mock('../realtime/openaiSession.js', …)` only because `twilioStream.ts` imports `OpenAIRealtimeSession` at module scope (confirmed by `greetingRace.test.ts:27`'s own comment: "module is otherwise never touched by A2's fix... mocked because module-level import"). Once `twilioStream.ts` no longer imports the Realtime class (Stage 1), these mocks become unnecessary but the tests themselves (transfer failback, greeting race, recording) describe engine-agnostic call-control behavior and must be kept, just with the mock removed. |

70 test files total in `src/tests/` today (`ls src/tests/*.test.ts | wc -l`) —
1 is Realtime-only outright; the rest are either Live-only or genuinely
engine-agnostic with an incidental Realtime-class mock.

### viii. `CLAUDE.md` rules and docs describing Realtime as current

- `CLAUDE.md:33` — "Validate any NEW OpenAI session.update field against the
  live API before shipping" — this rule is written for the Realtime
  `session.update` shape specifically (the failure mode it describes —
  "a bad field fails the whole session → instant call hangup" — is the
  Realtime GA contract). Live has its own, differently-shaped validation
  lesson already captured (`tasks/lessons.md` "GPT-Live-1 gotchas" entry —
  different API, `session.start` not `session.update`, immutable
  `instructions`/voice, `delegation.type` required). Stage 3 should fold both
  into one current rule, or replace the Realtime-specific wording outright.
- `CLAUDE.md:40` — "Erica's voice: marin (natural FEMALE Realtime voice…)
  env-tunable via OPENAI_REALTIME_VOICE" — **factually wrong for the current
  production engine today**, not just after retirement (see §v above: Live's
  voice is hardcoded in `liveSession.ts`, not env-driven). Needs correcting in
  Stage 3 regardless of the retirement's pace.
- `docs/CODEMAP.md:213–214` — "For a current architecture, Realtime 2.1,
  quirks, and operations handoff, start with `GPT-SOL/README.md`" — actively
  points readers at Realtime-as-current docs. The CODEMAP does have later,
  correct sections ("GPT-Live owner taste-test path", "Prompt layers
  (GPT-Live)") that describe the real current state, but the pointer at the
  top is stale and contradicts them.
- `docs/GPT-SOL/` (6 files) all describe Realtime as the live architecture:
  `README.md` (6 Realtime mentions incl. "Calls use... OpenAI Realtime
  speech-to-speech"), `PROJECT_HANDOFF.md` (11 mentions, incl. line ~138 "The
  active runtime is `gpt-realtime-2.1`, Marin, real Phorest"),
  `PROMPT_ARCHITECTURE.md` (9), `QUIRKS_AND_INVARIANTS.md` (2),
  `REALTIME_2_1_ANALYSIS.md` (15, entirely about the Realtime model). None of
  these have been updated since the GPT-Live split; all are candidates for a
  Stage 3 rewrite or an explicit "superseded, historical" banner.

### ix. Admin routes / telemetry that report engine

- `src/voice/testControl.ts:14–29`, `voiceTestStatus()` — returns
  `engine: env.VOICE_ENGINE` directly, served at `GET /admin/voice-test`
  (mounted `src/index.ts:73`). This is the route the 2026-09-15 session used
  to verify a deploy actually shipped the Live branch (`engine: "live"`).
- **Load-bearing finding for Stage 1**: `src/voice/testControl.ts:30–46`,
  `selectVoiceTestVariant(variant: 'terra' | 'luna' | 'realtime')` — can set
  `env.VOICE_ENGINE = 'realtime'` **at runtime**, and
  `src/routes/voiceTest.ts:30–45` (`POST /admin/voice-test/variant`) exposes
  exactly that, validating `variant` against `['terra', 'luna', 'realtime']`
  (`voiceTest.ts:32`). `scripts/gpt-live/select-variant.mjs` is the operator
  CLI for it. This is how the owner taste-test A/B's against Realtime today.
  It is gated by `isVoiceTestMode()` (`env.ts:317`, `=== PHOREST_WRITE_MODE
  === 'simulate'`) — **currently inert in production** because
  `PHOREST_WRITE_MODE=real` right now (the temporary test config) — but it is
  live code, not dead code, and narrowing `VOICE_ENGINE`'s type to a single
  literal in Stage 1 will not compile (or will silently stop working) until
  this endpoint's `'realtime'` option is also removed. Treat it as part of
  Stage 1, not an afterthought.
- `src/routes/admin.ts:178,302,440,465` — the per-call dashboard reads a
  persisted `voiceEngine` field off each call's start record (`start.voiceEngine
  === 'live'` at `:440`) for historical display. This is a read of **recorded
  history**, not a live switch — safe to leave alone; it will just always read
  `'live'` for every call going forward once Realtime can't be selected.

---

## c. Staged plan

**Stage 0 (this session, workstream B): DONE**, verified in code and in
`state.md`'s completion entry. SERVE marked Realtime-only with a banner
(`twilioStream.ts:727`); backend rules authored into
`src/voice/backendRules.ts`; the SHA-256 tripwire's failure message now
explains the Live-path trap instead of failing silently. See §b.i for the
detail. Stage 1's "extract fact computation" sub-step is now smaller than
originally scoped (rules are already out; only the facts-parsing regex layer
remains) — see the note at the end of §b.i.

### Stage 1 — Make `live` the only accepted engine; delete Realtime session wiring

**Do:**
1. `src/config/env.ts`: change `VOICE_ENGINE` to always resolve to `'live'`
   (either drop the env var and hardcode it, or keep it as a no-op
   documented-deprecated var that still defaults to `'live'` and rejects
   `'realtime'` outright with a clear boot error — prefer the former, it's
   simpler and the audit found no external caller depends on setting it to
   `'realtime'` other than the taste-test endpoint below).
2. `src/voice/testControl.ts` + `src/routes/voiceTest.ts`: remove `'realtime'`
   from the variant union and the accepted-values array. Decide whether the
   owner still wants a documented "Realtime is retired" error on that
   endpoint or a silent drop of the option — Aryan's call, flag it rather than
   guessing.
3. `src/realtime/twilioStream.ts`: delete all 26 `voiceEngine` branches
   (§b.iii), keeping only the Live-branch body of each; delete the
   `this.session instanceof OpenAILiveSession` fork at the prompt-build call
   site (§b.i) — always call `buildLivePrompt`/`buildBackendPrompt`. Delete
   the `createSession()` ternary (§b.iv) — always construct
   `OpenAILiveSession`. Remove the `OpenAIRealtimeSession` import and its
   class usage from `twilioStream.ts`; **keep** the `ToolDefinition`,
   `RealtimeHandlers`, `RealtimeUsage` type imports for now (still exported
   from `openaiSession.ts` — full deletion is Stage 2, after type extraction).
4. Workstream B already did the *rule*-extraction half of this (Stage 0,
   §b.i) — `backendRules.ts` now supplies every authored section, and
   `backendSections()` only pulls three genuinely computed bodies (`CONTEXT`,
   `CURRENT STATUS`, `TEMPORARY CLOSURE POLICY`) out of the rendered
   production prompt. What remains is the *facts* half: both that extraction
   and `buildLivePrompt`'s `productionFacts()` (`livePrompts.ts:81`) still
   get their values by regex-parsing `buildInstructions()`'s rendered text
   rather than computing them directly. Replace both with one typed facts
   function — e.g. `computePromptFacts(now, businessHours, temporaryClosure)`
   returning `{ salonName, address, hours, todayStatus, richaLine,
   temporaryClosure, … }` — called once per session and consumed by
   `buildLivePrompt`, `buildBackendPrompt`, and (if `SERVICES & PRICES` and
   the `GREETING` sub-block get the same treatment) `buildInstructions()`
   itself, instead of `buildInstructions()` rendering a string that two
   other functions then re-parse. Smaller than originally scoped now that
   Stage 0 landed, but still the most judgment-heavy sub-step here — size it
   separately from the rest of Stage 1's mechanical branch deletion.
5. Rename/rework `REALTIME_CONTEXT_NOTES` (§b.ii) to drop the misleading name
   now that there's only one engine — e.g. `CALL_CONTEXT_NOTES`.

**Tests that prove it:** full `npx vitest run` green (baseline 797/69 as of
2026-09-15, will shift with concurrent Wave 1–3 work); `npx tsc --noEmit`
clean; the three tests that mock `openaiSession.js` for module-load reasons
(§b.vii) updated to drop that mock; `livePrompts.test.ts`'s SHA-256 tripwire
re-pinned against the new facts-module output (expect it to need a new hash —
that's a deliberate, documented change, not a regression); a manual run of
`scripts/render-live-prompts.ts` diffed before/after to confirm the model-facing
text is unchanged (only the internal plumbing moved).

**Rollback:** `git revert` the Stage 1 commit(s). Since `VOICE_ENGINE` no
longer exists as a env-settable fork, rollback is "restore the old file", not
"flip an env var" — this stage is a one-way architectural commitment once
merged. Recommend a feature-branch soak (this branch, `codex/gpt-live-taste-test`,
already is one) with a full sim-scenario sweep before merging to main.

**Size: L.** Touches the highest-risk file in the repo (7,000+ lines),
requires the facts-module extraction judgment call, and needs the full test
suite plus a live prompt diff to trust.

### Stage 2 — Delete Realtime-only modules, scripts, tests, env vars

**Do:**
1. Extract `ToolDefinition`, `ToolHandler`, `RealtimeHandlers`, `RealtimeUsage`
   type definitions out of `src/realtime/openaiSession.ts` into a shared
   location (e.g. `src/realtime/types.ts` or fold into `toolSchemas.ts` since
   that file is already the cross-engine tool contract home). Update the two
   consumers (`twilioStream.ts`, `liveSession.ts`, `liveProtocol.ts`) to import
   from the new location.
2. Delete `src/realtime/openaiSession.ts` (the `OpenAIRealtimeSession` class)
   and `src/tests/openaiSession.test.ts` (30 tests).
3. Delete `scripts/test-openai-realtime.ts`, `validate-session-fields.ts`,
   `validate-transcription-fields.ts`, `render-prompt.ts`,
   `test-twilio-openai-integration.ts`, and (found alongside, same vintage)
   `test-integration-simple.ts`.
4. `src/config/env.ts`: delete `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`.
   **Keep `OPENAI_INPUT_TRANSCRIPTION`** — confirmed still consulted by a
   shared code path (`twilioStream.ts:6938`'s `transcriptionInFlight` check),
   though that specific condition should simplify to drop the
   `env.OPENAI_INPUT_TRANSCRIPTION !== 'off'` half since it's now vacuous
   (Live is unconditionally true there). Re-verify this specific line number
   at Stage 2 time since it will have shifted from Stage 1's edits.
5. Simplify the `transcriptionInFlight` condition per the above.

**Tests that prove it:** full suite green with one fewer test file (30 fewer
Realtime-specific cases, net); `tsc --noEmit` clean confirms no dangling
imports of the deleted types; grep the repo for `OpenAIRealtimeSession`,
`OPENAI_REALTIME_`, and `gpt-realtime` to confirm zero remaining references
outside historical state.md entries (which should NOT be edited —
they're history).

**Rollback:** `git revert` the Stage 2 commit. Lower risk than Stage 1 since
this stage only removes already-dead code paths (Stage 1 already stopped
calling any of it) — a revert just brings back unused files.

**Size: M.** Mechanical once Stage 1 is done and stable; the type-extraction
sub-step is the only part requiring care.

### Stage 3 — Rewrite docs; remove the "two prompts" trap text once there is one

**Do:**
1. `CLAUDE.md`: rewrite the voice line (§b.viii — it's already wrong today)
   and the session.update-validation line to describe Live's actual
   validation lesson (session.start shape, delegation.type, etc.) instead of
   Realtime's.
2. `docs/CODEMAP.md`: remove the "For a current architecture... start with
   GPT-SOL/README.md" pointer (or repoint it at a rewritten doc); update the
   `src/realtime/` and `src/voice/` sections to reflect that
   `OpenAIRealtimeSession` no longer exists and `buildInstructions()` now
   returns fewer sections (post-extraction, if the facts module absorbed
   some of them). Update the "Prompt layers (GPT-Live)" section (currently
   accurate) to drop language like "the production prompt's SERVE section"
   once SERVE itself is gone from `twilioStream.ts`.
3. `docs/GPT-SOL/*.md` (6 files, §b.viii): either rewrite each for the
   Live-only architecture or add a one-line "SUPERSEDED 2026-09-16 — see
   [new doc]" banner at the top of each and leave the historical Realtime
   detail intact below it for archaeology. Given the volume (6 files, ~1,200
   lines total, 47 Realtime mentions), a banner-and-preserve approach is far
   cheaper than a rewrite and loses less institutional knowledge — recommend
   that unless Aryan wants a clean rewrite.
4. Once Stage 1's SERVE deletion is real, remove the "two prompts, the one
   you edit may be inert" trap language from `tasks/lessons.md`,
   `docs/SESSION_HANDOFF_2026-09-15.md`, and `docs/AUDIT_REVIEW_2026-09-15.md`
   — or rather, **do not edit those dated files** (they're historical
   records of a real incident); instead add a new `tasks/lessons.md` entry
   dated at Stage 3's completion noting the trap no longer exists because
   there is only one prompt path now.

**Tests that prove it:** none (docs-only) — verification is a human read-through
plus grep for stale claims (`grep -ri realtime docs/CODEMAP.md CLAUDE.md`
should return only historical/comparison references, not "current state"
claims).

**Rollback:** trivial, `git revert` — docs-only commits.

**Size: S–M** depending on the banner-vs-rewrite choice for `GPT-SOL/`.

---

## d. Risks

1. **The fatal-error failover path already does not depend on Realtime.**
   Confirmed by reading `failoverToOwner()` (`twilioStream.ts:6829–6868`): on
   any fatal error or unexpected session close (`onClose` handler,
   `createSession()`'s `handlers.onClose`, wired identically for both engine
   classes), the method redirects the live Twilio call via REST
   (`client.calls(this.callSid).update({ twiml: ... })`) straight to
   `<Dial>${env.OWNER_PHONE}</Dial>` (if within the transfer window) or a
   `<Hangup/>` apology otherwise. **It never falls back to a Realtime
   session.** This means Realtime's removal has zero effect on the
   emergency-failover safety net — there was never a "retry with the other
   engine" behavior to lose.
2. **The SHA-256 tripwire in `src/tests/livePrompts.test.ts:219–237`** pins
   `buildInstructions()`'s full byte output as a deliberate-change guard.
   Workstream B (Stage 0) fixed its failure *message* without changing the
   pinned hash or `buildInstructions()`'s output. Stage 1's remaining
   facts-extraction work (§b.i, §c Stage 1 step 4) will legitimately change
   `buildInstructions()`'s output if `SERVICES & PRICES` or the `GREETING`
   sub-block move out of it — expect (and re-pin) a new hash with a comment
   explaining exactly what changed, per the test's own existing convention
   (see the 2026-09-14 RESCHEDULE-edit comment already in that test, and
   workstream B's message-only fix, as the pattern to follow). Do not treat a
   hash mismatch here as a bug to route around; treat it as the test doing
   its job.
3. **`scripts/gpt-live/` (9 files) are entirely Live-only already** — `README.md`,
   `controller-probe.mjs`, `live-fields.mjs`, `live-greeting-ab.mjs`,
   `live-probe.mjs`, `live-tool-probe.mjs`, `live-update-probe.mjs`,
   `owner-call.mjs`, `select-variant.mjs`. None reference `OpenAIRealtimeSession`
   or the Realtime WS shape; `select-variant.mjs` is the one exception worth
   flagging (§b.ix) because it's the *client* for the `'realtime'` variant
   switch that Stage 1 removes — update its usage string and allowed-values
   check in lockstep with `testControl.ts`/`voiceTest.ts`, or it will send a
   request the server now rejects with a confusing 400.
4. **Concurrent edits.** This plan was written while three other workstreams
   (A, C, D per `tasks/todo.md`'s Wave 1/2) were actively modifying
   `twilioStream.ts`, `toolSchemas.ts`, and `booking.ts`. Every line number
   above is a snapshot; re-verify with the grep commands shown before acting
   on Stage 1, since a rebase or merge will shift them.

## Claims I could not fully verify

- The exact current `npx vitest run` pass count — not re-run directly in this
  session (docs-only workstream, and other streams were mutating source
  files concurrently, which would make a fresh run's result attributable to
  whatever commit happened to be on disk at that instant, not a stable
  number). Workstream B's own completion entry in `state.md` reports
  815/815 passed, 70 files after its change; that is the most current number
  seen, cited secondhand rather than independently re-run here.
- Whether workstreams A, C, D, E, F (the other concurrent Wave 1–3 streams
  per `tasks/todo.md`) have landed by the time this plan is read — checked
  once, at session start and again when workstream B's completion was
  noticed; not continuously monitored after that.
- Whether Aryan wants the `/admin/voice-test/variant` `'realtime'` option
  removed silently or replaced with an explicit "Realtime is retired" error
  (§c, Stage 1, step 2) — flagged as an open decision, not resolved here.
