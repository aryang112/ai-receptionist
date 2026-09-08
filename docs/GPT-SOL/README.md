# GPT-SOL project handoff

Last refreshed: 2026-09-08 (release pointer; deeper architecture pages retain their dated context)

This folder is the durable orientation package for an agent joining the AI
Receptionist project. It synthesizes the current implementation, production
state, operational constraints, and the latest Realtime 2.1 call findings. It
does not replace the canonical sources below.

## Read order

1. [`../../state.md`](../../state.md) — current status and pending decisions.
   Read from the top: newer dated entries override older summaries farther down.
2. [`../../tasks/lessons.md`](../../tasks/lessons.md) — bugs and invariants that
   must be understood before changing Phorest time logic or OpenAI session
   configuration.
3. [`../CODEMAP.md`](../CODEMAP.md) — file-level orientation.
4. [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md) — architecture, responsibilities,
   current state, and design assessment.
5. [`QUIRKS_AND_INVARIANTS.md`](QUIRKS_AND_INVARIANTS.md) — the short list of
   rules that prevent expensive regressions.
6. [`PROMPT_ARCHITECTURE.md`](PROMPT_ARCHITECTURE.md) — the implemented prompt
   layers, natural-conversation policy, rationale, limitations, and release
   evaluation gate.
7. [`REALTIME_2_1_ANALYSIS.md`](REALTIME_2_1_ANALYSIS.md) — model controls,
   test-call evidence, the prompt changes it motivated, and remaining risks.
8. [`OPERATIONS_AND_AGENT_PROTOCOL.md`](OPERATIONS_AND_AGENT_PROTOCOL.md) — how
   to inspect, change, test, deploy, and hand the project off safely.

`PLAN.md` and `tasks/todo.md` are useful history, but their old unchecked items
are not automatically current work. Confirm every item against the newest
`state.md` entry and the code before acting.

## Current snapshot

- The application is a single-process, single-tenant TypeScript service on
  Railway. That is an intentional fit for the present stage, not an accidental
  architecture that needs immediate decomposition.
- Calls use Twilio Media Streams and OpenAI Realtime speech-to-speech with G.711
  mu-law passthrough. Phorest is the source of client, service, appointment,
  and availability data.
- Production behavior is commit `bc39b09`, Railway deployment
  `ee43e7fe-9fd0-4dd7-9dcf-f907c6cfcd1a` (`SUCCESS`). See
  [release handoff](../reviews/CONVERSATION_RELEASE_2026-09-08.md). The model is
  `gpt-realtime-2.1`, the voice is Marin, and real Phorest is enabled.
- Realtime reasoning effort is not explicitly configured. No reasoning-level
  change was made as part of this documentation pass.
- Vonage forwarding is ON. Do not deploy code, prompt, configuration, model,
  voice, or Realtime session changes during business/live hours. A direct
  Twilio call still reaches the production service and real Phorest.
- The current prompt release is deployed. One config-driven temporary-closure
  policy adapts its answer to the subject: questions about Richa describe
  Richa's unavailability; hours questions describe the salon closure; affected
  booking requests offer to check from reopening onward; questions about a
  different provider never invent that provider's whereabouts.
- Exact caller-message delivery is separate from live transfer and uses captured
  caller transcript content. New Phorest clients no longer receive synthetic
  placeholder email addresses when no email was supplied.
- The test baseline at this refresh is 44 test files and 512 passing tests,
  repeated successfully under `TZ=UTC`; the TypeScript build is clean.
- Call records, tool history, both-side transcripts when enabled, recording
  references, usage, cost estimates, and warnings are available through the
  protected admin surface and the append-only call store.

## Highest-value open work

1. Monitor real forwarded calls for closure wording, exact message capture,
   unnecessary narration, and any skipped/odd speech. Compare the transcript
   with the dual-channel recording before treating transcription as truth.
2. Before the salon becomes multi-provider, add provider-specific schedules
   and absence state. `business.json.vacations` currently means the whole salon
   is closed and must never represent one stylist's time off while others work.
3. Add the remaining appointment mutation coordinator, semantic idempotency,
   timeout reconciliation, and response-settlement protections in
   [`../FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md`](../FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md).
4. Add response-phase instrumentation and deterministic server-owned identity
   state if live evidence shows prompt guidance is insufficient.
5. Keep service-history personalization, squeeze-in policy, reasoning/VAD
   experiments, and external spam scoring behind the reliability work.

## Documentation convention

These documents label claims as:

- **Observed** — directly established by code, tests, deployed configuration,
  stored call records, or official documentation.
- **Analysis** — the best explanation of an observed behavior.
- **Proposed** — future work; it is not implemented merely because it appears
  in this folder.

Never put secrets, full customer phone numbers, raw customer transcripts, or
unguarded admin URLs in project documentation.
