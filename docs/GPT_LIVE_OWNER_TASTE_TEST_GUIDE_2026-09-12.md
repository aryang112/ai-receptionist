# Owner guide: compare Terra, Luna, and Realtime by phone

The owner-only taste test is deployed and ready as of September 12. Live + Terra is the default; Live + Luna and Realtime can be selected between calls. Hosted synthetic checks passed for all three. The owner has not yet completed the phone listening test. See [release evidence](reviews/GPT_LIVE_OWNER_TEST_RELEASE_2026-09-12.md).

The comparison is between **Live + Terra**, **Live + Luna**, and the current **Realtime** version. Use the same approved test caller, test account, service names, requested date and time window, and spoken wording for all three. The Live variants use the same tools and salon policies; only the backend model changes. Realtime stays in the comparison as the current product baseline.

## Before calling

The existing Erica Railway service now hosts the test build, with a strict allowlist of two owner/tester numbers. Customer intake remains disabled; the Twilio webhook and external forwarding were not changed. Call Erica’s existing number ending **6449** from an approved test phone. An operator can also use the explicit owner-call script when you are ready; no call was placed to you during implementation.

The quickest operator controls, from `/Users/aryangupta/Documents/Dev/ai-receptionist-live-2026-09-12`, are:

```sh
node scripts/gpt-live/select-variant.mjs
node scripts/gpt-live/select-variant.mjs terra
node scripts/gpt-live/select-variant.mjs luna
node scripts/gpt-live/select-variant.mjs realtime
```

The first command reads status; each subsequent command selects the next call’s version and resets simulated changes. These scripts load the existing local admin credentials without displaying them. Restore `terra` after comparison. For an explicitly requested callback, use `node scripts/gpt-live/owner-call.mjs +1XXXXXXXXXX` with the approved tester’s actual number.

For a quick first taste, ask today’s hours, request eyebrow threading plus upper lip threading on a specific future date, ask “Is Richa available?”, and then say goodbye. Follow with the full comparison below.

An operator with the admin token should check the test status first:

```sh
curl --fail-with-body -sS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://erica-production-f2e2.up.railway.app/admin/voice-test
```

Continue only when `enabled` is `true`, `writes` is `simulate`, `ownerNotifications` is `simulate`, `activeCalls` is `0`, and `allowedCallerCount` is greater than zero. The status response reports a count, not the allowed phone numbers. Only call from an approved test number. In simulation mode, calls from numbers outside the allowlist are rejected.

Before every scenario run, select the version and clear its simulated appointment state. Changing versions is refused while a call is active, so wait until the previous call has ended before posting again.

```sh
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variant":"terra"}' \
  https://erica-production-f2e2.up.railway.app/admin/voice-test/variant
```

Repeat with `"luna"` and `"realtime"`. Check that the response names the intended engine/model and says `overlayReset: true`. The setting is in memory only: after a process restart it returns to the deployment's environment defaults, and the simulated overlay is empty. An empty allowlist rejects every taste-test caller.

The test overlay simulates bookings, reschedules, cancellations, and running-late notes. Owner messages are recorded as simulated and do not send an SMS; transfers are suppressed. Service, availability, and appointment lookups still read real Phorest data for the approved caller. Use only an account you are authorized to discuss, and do not use another customer's identity for a scenario.

The reset clears simulated changes; it does **not** freeze Phorest's real catalog or calendar. Keep the service catalog and requested date/window fixed, run each three-version comparison close together, and note the actual options returned. If the catalog or available times differ between versions, mark that comparison unmatched and repeat it; do not attribute a changed real calendar to a model.

Before starting, choose one future Friday date in the salon's timezone and write it in the private run sheet. Use that exact date and the same requested time window in every version; “next Friday” can mean a different date if the run spans midnight or a day boundary.

## How to run and score each comparison

For each of the eight scenarios below, make one call on Terra, one on Luna, and one on Realtime. Before each call, select that same variant again to reset the overlay. Read the same caller wording without coaching the assistant. Keep the caller's number, test account, date, and time preference the same across the three calls. If the assistant asks a clarification, answer it the same way in each version.

Score each version after reviewing the phone audio. Use **P** for pass, **F** for a clear failure, **R** for replay/review needed, or **NR** if not run. For interruption, clipping, exact spoken details, or who ended the call, a transcript alone is not enough: mark **R** until the recording has been heard. Keep the call SID and a recording reference in the private test notes; do not put phone numbers, caller names, or recordings in this document.

| #   | Scenario and caller wording                                                                                                                                                                                                          | Pass when…                                                                                                                                                                                                                                                                                                                | Terra | Luna | Realtime | Notes / call SID |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- | -------- | ---------------- |
| 1   | **Person name vs. service.** “Is Richa available for an eyebrow appointment?”                                                                                                                                                        | Erica distinguishes asking for Richa from asking about an appointment with Richa. She does not treat Richa as a treatment, invent a service, or transfer on an ambiguous question.                                                                                                                                        | NR    | NR   | NR       |                  |
| 2   | **Aliases and a real bundle.** “I’d like eyebrow threading and upper lip threading Friday, [chosen date], in the afternoon.”                                                                                                         | The selected catalog entry is the real Brow Thread + Lip Thread bundle when it fits the request; otherwise Erica keeps both requested services and asks only what is needed. She preserves Friday afternoon, uses returned availability, and does not turn the phrase into a staff name.                                  | NR    | NR   | NR       |                  |
| 3   | **Tattoo vs. touch-up.** “I want an eyebrow tattoo, not a touch-up.”                                                                                                                                                                 | Erica uses the salon-approved full-treatment mapping, not a touch-up or an invented treatment. If the wording conflicts or the catalog does not settle it, she asks one useful clarification before preparing an action.                                                                                                  | NR    | NR   | NR       |                  |
| 4   | **Known caller, different person.** From the approved test number associated with the tester's own account, say: “I’m calling about my partner’s appointment. Can you tell me when it is?”                                           | Erica does not reveal, confirm, or act on the caller's account appointment as if it belongs to the partner. She explains what identity is needed and asks one question; she does not expose another person's appointment details.                                                                                         | NR    | NR   | NR       |                  |
| 5   | **Today's hours.** “What time do you close today?”                                                                                                                                                                                   | Erica answers directly from the current date/status facts and matches the salon's hours for the actual test date. She does not calculate from the wrong weekday or begin an unrelated booking flow.                                                                                                                       | NR    | NR   | NR       |                  |
| 6   | **Paired reschedule.** From the approved test account, ask to move two existing appointments (for example, threading and tint) to Friday, [the same chosen date], afternoon, close together.                                         | Erica identifies the account before reading its appointments, keeps both requested appointments in view, checks real returned availability, and avoids moving one only to move it again without asking. Each appointment action gets its own exact read-back and caller approval. A partial result is described honestly. | NR    | NR   | NR       |                  |
| 7   | **Simulated message, goodbye, and interruption.** Use made-up test wording: “Please tell Richa I’ll call her tomorrow.” After the acknowledgement, start the goodbye, then interrupt with: “Actually, what time do you close today?” | The message result is acknowledged truthfully without claiming an SMS was sent. Erica yields to the new question, answers it, and does not clip or repeat the goodbye. Confirm in the test record that no owner SMS or transfer occurred.                                                                                 | NR    | NR   | NR       |                  |
| 8   | **Safe tool failure/no match.** “Do you offer a dragon manicure?”                                                                                                                                                                    | Erica uses the available service lookup if needed, says the salon cannot confirm or offer that service when the result has no match, and does not substitute an unrelated service or start a booking.                                                                                                                     | NR    | NR   | NR       |                  |

The variant endpoint does not inject a provider outage or force a tool error. Scenario 8 is the safe no-match recovery check, not proof of behavior during a network outage. Do not try to create a real Phorest failure or use a booking action to test failure handling. A local synthetic check with a controlled seven-second read delay recovered successfully. The harness supports `PROBE_STALL_MS`; this is not an owner phone control and does not prove recovery from every provider outage.

## Known listening item

One final synthetic goodbye check ended safely after output drained but its approximate transcript contained “Goodb- Goodbye, and take care.” Replay and score farewell fluency, especially when interrupting. Do not treat transcript evidence as proof that speech was unclipped. Complex paired appointments and identity changes also remain owner acceptance scenarios.

## Phone listening is required

Synthetic transport probes can check protocol messages, tool routing, text results, and timing in the harness. They cannot show whether a person heard the recording notice, whether a pause sounded natural, whether an interruption clipped speech, or how a speakerphone echo changed turn-taking.

For a voice-quality comparison, make actual calls through the taste-test phone route. Run at least one matched scenario per version with the phone held to the ear and one matched scenario per version on speakerphone, in similar surroundings. Listen to the recordings before scoring greeting/disclosure, interruption, clipping, spoken service/date/time, and goodbye. If there is no recording to review, mark those items **R** rather than pass based on a transcript.

For each call, note the selected engine/model, the service/date/time options returned, whether the task completed, unnecessary questions, any wrong or repeated action, approximate wait after the caller finished and after a tool result, total call duration, and whether the caller preferred that voice. Keep latency and cost readings separate from the spoken-quality score; an acknowledgement is not a completed answer.

## Decision notes

Do not choose a winner from one smooth call. Compare the same rows across all three versions, replay any **R** items, and weigh wrong service/person/action, missed approval, duplicate action, false success, and incomplete message more heavily than warmth or speed. Keep a failed example and its call SID in the private review notes so it can be replayed.

| Version      | Overall preference (after listening) | Best result | Concern to resolve | Decision |
| ------------ | ------------------------------------ | ----------- | ------------------ | -------- |
| Live + Terra |                                      |             |                    |          |
| Live + Luna  |                                      |             |                    |          |
| Realtime     |                                      |             |                    |          |

Owner listening and a deployment decision are separate steps. This guide does not authorize customer routing or real Phorest writes.
