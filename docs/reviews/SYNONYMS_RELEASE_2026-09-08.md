# Focused synonyms release — September 8, 2026

Deployed after Aryan explicitly requested production release. Railway reports
SUCCESS for `5affb66c-af42-4c96-9cad-b0fb7ab0ef51`, created 22:20:10 UTC
(6:20 PM ET); application boot completed approximately 6:21 PM ET.

- Exact source: `fcee0d8ca23304918167fe31102f7ef2813e493e` on
  `codex/focused-service-synonyms-2026-09-08`.
- Image: `sha256:b0741205058047d78982d4b43fa9915a4b23b5828ac7175946a422d7c7d014be`.
- Previous source / rollback: `1425f8c89924c547e8a2ca1f130a940276bfed5f`,
  deployment `111fbb86-6401-45cb-bfc5-a1901a95a141`. Rollback preserves the earlier
  placeholder-email client-create fix.
- Uploaded a clean git archive: all 134 tracked files verified byte-for-byte;
  no environment files, local outputs, dependency links, or call data included.
- Immediate pre-upload check at 22:20:09 UTC: zero queued/ringing/in-progress
  Twilio calls; health, service catalog and protected admin HTTP 200.

## Scope and evidence

Ten substitutions for brow/eyebrow, lash/eyelash, thread/threading, tint/tinting;
five existing phrase aliases retained; known conversational filler accepted only
for complete brow/lash service matches. Unknown treatment words are preserved.
The mock catalog was corrected and regression tests added. No prompt, session,
model, voice, forwarding, environment, or contact-flow changes were deployed.

- Fresh release tests: 568 tests across 48 files passed; build passed. Earlier
  formatting checks and 17 phrase contracts plus 63 service-identity checks passed.
- Fresh production catalog was byte-identical to the evaluated 63-service snapshot.
- Running-container source hashes match the release for booking, Phorest client,
  call/prompt handling and Realtime session handling.
- Compiled matcher executed inside the new container: "I want to do my eyebrows"
  → Brow Threading, "eyelash tinting" → Lash Tinting, "lash extensions" →
  Eyelash Extensions - Regular; threading/tinting/lashes ambiguous; henna brows
  notOffered. Read-only checks; no appointment or call created.
- Startup warmed 63 services and 4,187 clients across 28 pages, incomplete=false.
- Runtime whitelist confirmed gpt-realtime-2.1, marin, real Phorest, owner recaps
  enabled, gpt-4o-mini-transcribe. Phone confirmation still precedes name collection.
- Post-release health/services/admin HTTP 200; zero warnings in the new container.
  Short health observation and sanitized evidence are in
  `outputs/synonyms-deployment-2026-09-08/` (untracked, not uploaded).
- One pre-existing warning from 21:39:50 UTC was an OpenAI WebSocket close code
  1005 with no status/reason. It predates this release; no impact conclusion is
  drawn from that log alone.

Local warm matching cost averaged 0.180 ms versus 0.123 ms for the previous
release (20,000 samples/version). No additional model or network request.
This is not production end-to-end voice latency. First real caller use remains
the end-to-end confirmation of the new wording in a live conversation.

## Remaining branches and conversation work

The September 3 draft `37d1d93`, plus later reconciliation on main / the
conversation-review branch, remains unreleased. Its useful parts are:

1. Reduce repeated questions and closers, retain clearly supplied answers, vary
   wording, and replace conflicting retry instructions with one consistent rule.
2. `wait_for_user` silent tool for noise/side conversation. Text-input probes and
   tests exist; audio listening is still required before shipping this behavior.
3. Put explicit service/date/time read-back and caller approval next to booking
   and rescheduling tools. Preserve meaningful confirmations and waiting turns.

Do not port the draft wholesale: Aryan rejected the combined name/number question;
the first-candidate fallback after unresolved ambiguity also needs revision.

The September 1 remote audit branch `8b26fa2` contains a transfer outcome race fix
not yet ported: mark transfer state before the asynchronous redirect can close the
stream, with failure recovery. Its old broad post-hangup response suppression must
not replace the newer production farewell behavior.

PR #3, `codex/service-knowledge-review-2026-09-08`, remains open and held. It adds
service explanations/preparation/aftercare information; its content needs owner
review and its privacy wording needs correction before release.

Other backlog experiments (transcription hints, turn-detection tuning, reasoning
settings) are not ready fixes and were not included. Prioritize a small repetition
cleanup and listening test while retaining the existing contact sequence.
