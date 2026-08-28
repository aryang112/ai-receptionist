# GPT-SOL project handoff

Last refreshed: 2026-08-28

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
6. [`REALTIME_2_1_ANALYSIS.md`](REALTIME_2_1_ANALYSIS.md) — model controls,
   latest test-call evidence, and the two newly exposed conversation issues.
7. [`OPERATIONS_AND_AGENT_PROTOCOL.md`](OPERATIONS_AND_AGENT_PROTOCOL.md) — how
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
- Production is staged on `gpt-realtime-2.1` with the Marin voice. The code
  default remains Cedar, so do not infer the production voice from `env.ts`
  alone.
- Realtime reasoning effort is not explicitly configured. No reasoning-level
  change was made as part of this documentation pass.
- Vonage forwarding is OFF. Production can be tested only by calling the
  direct Twilio number until the owner deliberately re-enables forwarding.
- The test baseline at this refresh is 42 test files and 384 passing tests.
- Call records, tool history, both-side transcripts when enabled, recording
  references, usage, cost estimates, and warnings are available through the
  protected admin surface and the append-only call store.

## Highest-value open work

1. Resolve Realtime 2.1's duplicate spoken preambles without damaging latency
   or tool reliability. The latest call exposed a conflict between the model's
   native preambles and the prompt's “before every tool call” filler rule.
2. Resolve recognized-caller identity flow so Erica never asks two questions in
   one turn or re-asks a name after an ambiguous reply.
3. Design and implement the owner-defined squeeze-in policy. It is not yet in
   production: an early caller may be accepted during another appointment only
   when the in-progress service permits multitasking; facials, haircuts, and
   Brazilian waxing explicitly do not.
4. Keep monitoring the Richa-as-service safeguard. The latest 2.1 call handled
   it correctly, but a single successful sample is evidence, not proof.

## Documentation convention

These documents label claims as:

- **Observed** — directly established by code, tests, deployed configuration,
  stored call records, or official documentation.
- **Analysis** — the best explanation of an observed behavior.
- **Proposed** — future work; it is not implemented merely because it appears
  in this folder.

Never put secrets, full customer phone numbers, raw customer transcripts, or
unguarded admin URLs in project documentation.
