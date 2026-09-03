# Project handoff

## Product purpose

Erica is a voice receptionist for Richa's salon. She answers calls, checks
live availability, books/reschedules/cancels Phorest appointments, quotes
prices and hours, records running-late notes, and connects callers to or sends
messages to Richa. The product goal is a short, natural call that completes a
real salon task safely—not an open-ended general assistant.

The current product advantage is that calls can act on the real appointment
book, rather than merely taking a message. That makes calendar correctness,
identity, consent, and write-path validation more important than stylistic
prompt improvements.

## Architecture

```text
Caller
  │ PSTN
  ▼
Twilio Voice webhook: POST /twilio/voice
  │ returns TwiML <Connect><Stream> plus signed call context
  ▼
Twilio Media Stream: WSS /twilio/stream
  │ G.711 mu-law frames, passed through without transcoding
  ▼
Per-call TwilioRealtimeCall orchestrator
  ├── OpenAIRealtimeSession ──► OpenAI Realtime speech + tool selection
  ├── PhorestPort ─────────────► Phorest clients/services/calendar/writes
  ├── CallStore ───────────────► append-only JSONL audit records
  ├── Twilio REST ─────────────► recording, SMS, transfer, hangup
  └── safety state ────────────► identity, offered-slot, ownership, retry,
                                 transfer, silence, and duration guards

Protected /admin surface
  └── joins call-store rows and proxies Twilio recordings without exposing
      provider credentials to the browser
```

This is a modular monolith. A process hosts HTTP routes, WebSockets, per-call
state, adapters, and operational timers. It uses external systems for voice,
reasoning, and the appointment system rather than introducing internal queues
or services.

### Why this shape is appropriate now

- Direct PCMU passthrough minimizes latency and removes a fragile audio
  transcoding/resampling layer.
- Per-call state belongs naturally in one `TwilioRealtimeCall` instance.
- Tool execution is close to the Realtime socket, making spoken preambles and
  tool-result continuation easier to coordinate.
- `PhorestPort` provides the important boundary: the voice/orchestration layer
  does not need to know whether the appointment implementation is real or mock.
- The app is still single-salon. Microservices or speculative multitenancy
  would add failure modes without solving a current bottleneck.

The first extraction pressure at salon number two should be tenant
configuration and tenant-keyed caches, not a wholesale service split.

## Component responsibilities

| Component                               | Responsibility                                                                                          | Important boundary                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/routes/twilio.ts`                  | Voice webhook, Media Stream TwiML, blocklist rejection, transfer status/failback                        | Authenticates/constructs the call edge; it does not make salon decisions   |
| `src/realtime/twilioStream.ts`          | Prompt, tools, per-call state machine, tool handlers, barge-in, transfer, recording, cleanup            | Main orchestration “brain”; business writes still go through `PhorestPort` |
| `src/realtime/openaiSession.ts`         | GA Realtime socket and session schema, audio/events, response collision control, retries, usage/latency | Provider transport; salon policy should not accumulate here                |
| `src/realtime/toolSchemas.ts`           | Runtime validation for model-supplied tool arguments                                                    | Must mirror tool JSON schemas                                              |
| `src/services/phorest.client.ts`        | Real Phorest adapter and all endpoint-specific normalization                                            | Owns Phorest timezone and query quirks                                     |
| `src/services/phorest.types.ts`         | `PhorestPort` contract and shared domain types                                                          | Mock and real implementations must remain identical                        |
| `src/services/booking.ts`               | Service matching, aliases, suggestion/booking helpers                                                   | Catalog matching, not caller conversation state                            |
| `src/services/callStore.ts`             | Append-only audit persistence and sanctioned reader                                                     | Avoid ad-hoc readers that reinterpret row semantics                        |
| `src/routes/admin.ts`                   | Read-only owner dashboard/API and recording proxy                                                       | Must remain authenticated and avoid credential/PII leakage                 |
| `src/core/hours.ts`                     | Salon hours, temporary salon closures, independent transfer window                                      | `business.json` is the hours source of truth                               |
| `src/core/slots.ts`                     | Clean-grid normalization of Phorest availability                                                        | Always rounds starts upward and preserves valid runway                     |
| `src/services/ownerSms.ts`, `digest.ts` | Best-effort owner messages and summaries                                                                | Failures must not break a live call                                        |

See [`../CODEMAP.md`](../CODEMAP.md) for the complete map.

## Live call lifecycle

1. Twilio validates/accepts the inbound call and rejects an already-blocked
   spam number before an OpenAI session is opened.
2. The app signs the WebSocket context and starts a Media Stream.
3. A per-call object starts the audit record and dual-channel recording,
   connects to OpenAI, and races caller-ID/Phorest warming against the greeting.
4. The app sends a GA `session.update`, waits for acknowledgement, injects
   dynamic caller/business context after the stable cached prompt prefix, and
   requests the greeting.
5. PCMU frames travel unchanged in both directions. Server VAD closes caller
   turns and enables barge-in after the protected greeting phase.
6. Model function calls are validated, executed against deterministic handlers,
   persisted, returned as tool output, and followed by a guarded response.
7. On completion, transfer, error, silence timeout, or duration cap, the app
   drains spoken audio, closes both legs, and appends usage/outcome/transcript
   records.

### Important state carried per call

- recognized caller/client and server-resolved client names;
- appointments exposed to this call and appointment-to-service mappings;
- slots actually offered, keyed by service and date;
- whether the caller is currently speaking, a response is active, or a tool is
  in flight;
- active assistant audio item and Twilio playback marks for barge-in;
- greeting protection and early-speech context;
- transfer/failback/temporary-closure state;
- silence and maximum-duration timers;
- transcript, token usage, cost estimate, outcome, and booking data.

This state is why handlers must not be reduced to “model asked, API wrote.”

## Safety model

The safest behavior is implemented in layers:

1. Prompt policy tells Erica the desired conversational behavior.
2. Tool descriptions constrain what the model is supposed to send.
3. Runtime schemas reject malformed arguments.
4. Deterministic server checks reject unsafe but syntactically valid actions.
5. The Phorest adapter normalizes provider-specific semantics.
6. Fresh reads immediately before writes reduce stale-calendar races.
7. Call-store evidence makes failures diagnosable after the call.

Examples already in production include appointment ownership checks, an
offered-slot whitelist, a fresh availability recheck, explicit booking and
reschedule consent, person-as-service rejection, temporary-closure transfer,
caller protections around blocklisting, and bounded retries.

When a behavior is safety- or write-critical, a prompt-only fix is incomplete.

## Current deployed state

**Observed, 2026-09-02:**

- Production behavior is commit `eca23f1`; Railway deployment
  `de80d873-ce67-4f6d-a892-30e8ee53b663` is `SUCCESS`.
- The active runtime is `gpt-realtime-2.1`, Marin, real Phorest, and
  `gpt-4o-mini-transcribe`. Reasoning effort and parallel tool calls are not
  explicitly configured.
- Vonage forwarding is ON. Deploy only in an owner-confirmed after-hours quiet
  window after confirming no active call. A direct Twilio call is not isolated
  staging: it reaches this production service and can write to real Phorest.
- The health endpoint passed after deployment; the container warmed 63 services
  and loaded a complete 4,188-client, 28-page phone index.
- The immediate rollback code baseline is commit `e1e5268`. Its old Railway
  deployment is superseded/removed, so rollback means redeploying that commit,
  not switching traffic to a still-running container.
- `main` may contain documentation-only commits newer than the production
  behavior commit. Do not infer a runtime mismatch from those docs commits.

## Latest behavior and release evidence

The current release combines three caller-facing reliability changes:

1. One global temporary-closure policy is built from the configured salon-wide
   range, public explanation, and reopen date. Richa questions lead with
   Richa's unavailability; hours questions lead with the salon closure; booking
   requests for affected dates offer to check from reopening onward; questions
   about another provider never claim that provider is away.
2. Live transfer and message-taking are separate. Message delivery accepts no
   model-authored summary; it sends only captured caller transcript content
   after the caller actually supplies a message. Erica acknowledges accepted
   delivery once without describing SMS/tool mechanics or promising a callback.
3. New-client creation omits email entirely when the caller did not provide
   one. It trims and preserves a real supplied email and never manufactures an
   `@placeholder.richasthreading.com` address.

The closure is reinforced below the prompt: known closed dates are rejected
before availability/write calls, and owner transfer is suppressed while the
salon closure is active. Tool results carry structured closure dates and the
configured public explanation so the model does not have to reconcile
duplicated scenario prose.

Verification passed in 44 files / 512 tests locally and under `TZ=UTC`, plus a
clean TypeScript build and prompt-budget checks. Live `gpt-realtime-2.1`
text-to-audio-transcript probes covered today/tomorrow hours, explicit and bare
Richa requests, an affected booking request, another provider, and a three-turn
hours conversation. These probes exercised the live model but intercepted
business tools; they are not a direct-phone ear test or a real Phorest write.

See [`PROMPT_ARCHITECTURE.md`](PROMPT_ARCHITECTURE.md) for the implemented
prompt policy, [`REALTIME_2_1_ANALYSIS.md`](REALTIME_2_1_ANALYSIS.md) for model
behavior, and
[`../FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md`](../FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md)
for remaining reliability work.

## Requirements that are documented but not implemented

### Multi-provider availability and absence

`business.json.vacations` currently represents a **salon-wide closure**. That
is correct for Richa's one-person salon: the salon is closed because Richa is
away. It is not a general stylist-time-off model.

Before onboarding a salon where one provider can be away while others work,
add tenant/provider data that answers independently:

- whether the salon is open;
- which provider the caller asked about;
- whether that provider is working;
- whether another qualified provider may serve the request.

The conversational policy can remain subject-aware, but provider identity and
availability must come from deterministic data. Never put one stylist's absence
into the salon-wide closure list, and never infer a provider's whereabouts from
the salon being closed.

### Remaining write and response coordination

The current release fixes known-closure gating, in-process new-client
single-flight, exact message provenance, SMS outcome handling, and cancelled-
appointment reschedule rejection. It does **not** yet provide the full per-call
appointment mutation queue, semantic operation idempotency, restart-durable
write reconciliation, source-response settlement barrier, or deterministic
appointment-subject binding. Follow the current statuses and acceptance tests
in
[`../FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md`](../FUNCTIONAL_RELIABILITY_BACKLOG_2026-09-02.md).

### Early-arrival / squeeze-in policy

The owner has specified this behavior for a caller who already has a later
appointment but wants to arrive early:

- If Richa is free at the requested earlier time, Erica may accept the earlier
  arrival using the normal calendar flow.
- If Richa is occupied, she may still multitask and squeeze the caller in for
  most services.
- She may **not** squeeze the caller in when the in-progress appointment is a
  facial, haircut, or Brazilian waxing service.

**Current status:** requirement captured only. Do not tell a caller this policy
is active until code, tests, and a staged call prove it.

**Analysis:** this belongs in a deterministic policy/tool result, not solely in
the prompt. The server must inspect appointments overlapping the requested
time, classify their services through canonical service IDs/names, and return
an explicit allowed/blocked answer. A vague “availability” result is
insufficient because ordinary Phorest availability will mark all occupied time
as unavailable and does not encode multitasking exceptions.

### Parked issues

- The appointment-ID-as-client-ID failure now has a deterministic short-circuit
  and tool-contract guidance. Keep its regression test; it is no longer merely
  parked.
- “Usual service” personalization is designed but not implemented.
- The owner explicitly chose no phone-on-file updates and no last-four identity
  check. The prompt preserves the resolved account and does not ask for a new
  number when a known caller mentions one. Multiple phone-match handling
  remains parked.
- Historical Twilio 31924 disconnects have additional forensics. Escalate to
  Twilio support with a call-specific evidence bundle if they recur.
- Tony Stark's already-existing placeholder email was not cleaned up by the
  code release. New placeholder creation is fixed; modifying old customer data
  remains an explicit, separate operation.

## Independent architecture assessment

The architecture is sound for the current stage. The greatest risk is not
scalability; it is policy spread across prompt prose, tool descriptions,
runtime guards, provider quirks, and historical notes. The right next move is
to keep consolidating decision-critical behavior into named, tested server
policies while using the prompt for conversation—not to split the service.

Realtime model upgrades should be treated as behavioral migrations even when
the wire schema remains compatible. The 2.1 call is a clear example: the model
upgrade improved the target entity interpretation but made existing prompt
conflicts audible. Model version, prompt, tools, and server guardrails together
form the effective application.
