# Operations and agent protocol

## Start every work session

1. Read the newest entries at the top of `state.md`.
2. Read `tasks/lessons.md` in full before touching Phorest times or Realtime
   session fields.
3. Read `docs/CODEMAP.md` and this folder's `README.md`.
4. Run:

   ```bash
   git status
   npm test
   ```

5. Inspect uncommitted files before editing. They belong to the user unless the
   current task clearly created them.
6. Reconcile the requested work with the newest `state.md` pending section.
   Old unchecked plan items are not permission to act.

At the 2026-08-28 handoff baseline, `AGENTS.md` and `outputs/` are unrelated
untracked paths. Preserve them and do not stage them as part of project work.

## Source-of-truth precedence

When documents conflict, use this order:

1. current owner instruction;
2. current code and deployed/runtime evidence;
3. newest dated entry at the top of `state.md`;
4. `tasks/lessons.md` invariants;
5. `docs/CODEMAP.md` and this synthesized handoff;
6. older `state.md` sections, `PLAN.md`, and historical audit documents.

Do not silently rewrite history to remove a conflict. Add a dated correction at
the top and link the evidence.

## Change protocol

### Before editing

- State the intended behavior and the layer that should own it.
- Locate the model-facing schema, runtime schema, handler, provider adapter,
  and existing tests that cross that path.
- For production behavior, inspect a recent real call rather than relying only
  on prompt text.
- For any new Realtime session field, verify the official current schema and
  validate it against the live API before deployment.

### While editing

- Use `.js` extensions in imports.
- Keep full phone numbers and secrets out of logs, fixtures, docs, and commits.
- Preserve unrelated working-tree changes.
- Put deterministic safety policy in code/tool boundaries, with prompt text as
  conversational guidance.
- Run targeted tests after each small change, then the full suite.

### Before committing

```bash
npm test
npm run build
git diff --check
git status --short
git diff --stat
```

Inspect the staged diff and confirm no `.env`, customer data, raw recordings,
call-store data, or unrelated untracked files are included. Commit each
completed unit with a specific message.

## Live-call testing

Vonage forwarding is currently OFF. This gives the direct Twilio number a safe
staging role, but it does not make production writes harmless: the deployment
uses real Phorest credentials.

Use this sequence:

1. Test/build locally.
2. Validate any changed Realtime session payload against the live API without
   a customer call.
3. Deploy during a quiet window; Railway replacement can drop an in-flight
   WebSocket even though shutdown is graceful.
4. Confirm `/health` and session acknowledgement.
5. Make a direct Twilio test call with a scripted scenario.
6. Review the call-store record, tool results, assistant/user transcript,
   recording, latency, usage, cache hit, warning logs, and any Phorest write.
7. Update `state.md` with deployment and call evidence.
8. Re-enable Vonage forwarding only on explicit owner direction.

Never use a real booking/cancel/reschedule scenario unless the intended test
record and cleanup are understood.

## Finding a call and reconstructing evidence

The protected admin surface is the preferred human review path:

- calls endpoint: joined duration, outcome, tool history, booking, usage/cost,
  and flags;
- transcript endpoint: chronological both-side entries;
- recording endpoint: authenticated proxy to Twilio dual-channel audio;
- stats endpoint: day-level call, revenue, cost, spam, and after-hours metrics.

The underlying `CallStore` is append-only JSONL. A logical call can span two
media-stream segments after a failed live transfer, so joining by call SID and
timestamp semantics matters. Do not paste the admin token, recording URL,
provider credentials, full caller number, or raw customer conversation into
documentation or issue text.

For production logs, identify the exact Railway deployment that handled the
call. A generic “latest logs” query may point at a replacement container and
miss the event. Useful markers are listed in `docs/CODEMAP.md`.

When speech recognition is disputed, compare tool arguments and dual-channel
audio before treating the input transcript as ground truth.

## Diagnosing common failure classes

| Symptom                             | First evidence to inspect                                   | Likely layer                                                      |
| ----------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Call hangs up at pickup             | `session.update` error/ack and OpenAI close code            | Invalid Realtime session field or auth                            |
| Wrong person/service interpretation | Tool arguments, handler guard result, recording             | Prompt/tool schema/entity guard; not necessarily input transcript |
| Wrong appointment time/day          | Raw provider timestamp and normalized salon time            | Phorest adapter timezone boundary                                 |
| Model offers unavailable slot       | Offered-slot cache, fresh-check result, snapped slots       | Slot policy or provider race                                      |
| Repeated spoken filler              | Response phases and transcript around tool call             | Realtime preamble + prompt overlap                                |
| Name requested twice                | Identity state and exact previous caller answer             | Conflicting prompt/state flow                                     |
| Silent caller after a tool          | Active response/pending response-create and tool completion | Response collision/retry orchestration                            |
| Call drops mid-sentence             | Twilio error, OpenAI close, Railway deploy lifecycle        | Telephony/network/container rather than prompt                    |
| Richa receives no transfer          | transfer window, vacation, Dial status/failback, SMS result | Transfer policy or carrier outcome                                |

## Rollback posture

- Keep the last known-good deployment identifiable before changing the call
  path.
- Roll back a model/session/prompt release when pickup reliability, writes,
  privacy, or core task completion regresses; do not leave a risky release live
  merely to gather more examples.
- After rollback, verify health and make a direct staging call. Record the
  rollback and evidence at the top of `state.md`.
- Never roll back by discarding unrelated user work from the local tree.

## Handoff checklist

Every meaningful agent handoff should answer:

- What behavior was requested?
- What was observed directly, and from which call/test/deployment?
- What is analysis rather than fact?
- What files and contracts changed?
- What tests/build/live calls passed?
- What production state is active: model, voice, forwarding, deployment?
- What remains unimplemented or needs an owner decision?
- What is the exact safest next action?
- What rollback point exists?

For the current handoff, the safest next action is a focused prompt/state design
for one-preamble-per-tool and single-question identity confirmation, followed
by tests and a direct Twilio call. The early-arrival policy should remain a
separate subsequent implementation, as requested by the owner.
