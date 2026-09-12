# Live long-call disconnect and Richa transfer policy

Owner call: `CA3059bfa27891d40fbfbdb8746ecfe1b0`, September 12, 7:09:44 PM Eastern. Application duration 140.6 seconds; Twilio completed duration 145 seconds.

## Verified disconnect cause

At 7:12:05 PM, our Live adapter reported `GPT-Live speech audio exceeded the 400ms outbound queue bound`, with 21 queued frames. The controller classified it as fatal, invoked the test-mode failover (connection-problem announcement plus hangup), and closed the stream. Twilio completed the call at 7:12:09 PM. There was no end_call request and no OpenAI session timeout error in the correlated ending logs. The application initiated this termination; this is not inferred solely from a transcript or the generic call-end label.

The 400 ms fatal threshold was overly strict. In addition, the old timer waited 20 ms after each callback, accumulating processing/timer delays, and treated each partial audio-event tail as if it were a full 20 ms frame. Either can make playback lag over a longer call. We did not capture the original raw audio-event sizes or timer-lateness metrics, so the exact contribution of timer drift versus transport batching in this call remains an inference. The fatal threshold and our resulting hangup are VERIFIED.

The replacement retains the same adapter and Twilio playback marks:

- Join partial event tails into complete 160-byte/20 ms frames, preserving speech order.
- Advance a monotonic audio deadline, with at most five overdue frames sent per event-loop wake, rather than adding callback overhead to every frame.
- Treat 400 ms as a soft buffering target. Collapse only digital silence, not quiet speech. A brief speech backlog does not terminate the call.
- Retain a separate pathological five-second backlog guard and bounded retained frame storage; do not hide sustained failures or silently discard speech.

OpenAI documents arbitrary chunk boundaries and application-owned ordered playback, with no output-audio completion event: [WebSocket audio handling](https://developers.openai.com/api/docs/guides/voice-websockets?api=live). The existing Twilio mark/drain logic remains the authority for completed playback. This patch does not switch telephony providers or add a second voice system.

## Richa schedule and transfers

The owner requested morning transfers even before salon opening, and no transfers from 8 PM onward. The existing reusable transfer-hours helper now defaults to **9 AM inclusive–8 PM exclusive, salon timezone**, independent of the salon's public opening hours. Both normal transfers and technical-error failover obey that cutoff. Public opening hours in business.json are unchanged.

Public questions about when Richa works at the salon use published salon hours, without claiming knowledge of her personal movements or guaranteeing she is present. Appointment availability still comes from actual service/calendar lookups. Transfer eligibility means we may try her phone; it does not prove she will answer.

In the reported call, transfer_to_owner returned a simulated outcome. No real call to Richa was attempted. Erica turned that into “she's not available,” which was unsupported. The simulated tool now evaluates the real eligibility rules and reports that an eligible handoff was simulated; it explicitly forbids interpreting simulation as personal unavailability. The 8 PM message path is exercised in simulation too.

No actual appointment was created in the interrupted call; it ended during a read-back. The latest available QA report was September 12 AM and did not cover this call. Clipping, the exact heard fallback announcement, and voice mannerisms remain NEEDS LISTEN; the cause of our termination is established independently from logs and code.

## Validation and deployment

Integration results and release verification: All owner calls remain allowlisted and appointment changes/messages remain simulated.

- Final source suite: **676 tests across 61 files**, TypeScript build and whitespace checks pass. New coverage preserves a 420 ms speech burst, reconstructs arbitrarily split audio bytes, tests 150 seconds of deliberately late timer wakes, caps catch-up work, retains a one-shot pathological-backlog guard, and prevents audio after close. Transfer tests cover before opening, 7:59 PM, exactly 8 PM, and late-night fatal failover.
- Local real-Live/Terra replay: 195 seconds with eight caller turns, caller recognition, a simulated eligible transfer, public Monday hours, real availability and a simulated confirmed booking. The application remained connected until the harness stopped it. It tolerated a 500 ms soft backlog without terminating. This longer test covers the failure duration that the initial short probes missed.
- The local replay still paraphrased the simulated transfer as “I wasn't able to connect you.” The final tool description/backend clarification was strengthened before deployment so test-mode suppression is not treated as Richa declining/unavailable. Hosted wording verification is recorded below.
- Runtime source: `79f5363`. Helpers/prompts and multi-turn probe were developed by Terra; Sol independently reviewed pacing and added regression tests; parent integrated, reviewed, and deploys the result.

- Railway release `7a0c5978-53a6-4e43-88cf-77699608efcd` SUCCESS, created September 12 at 23:27:52 UTC / 7:27 PM Eastern. Seven running source/build hashes match local `79f5363`; the transfer-end environment override is unset, so the new 20:00 default applies. No active application or Twilio calls were present before upload.

- Hosted actual-Live/Terra replay `CA_probe_1789255757445` ran the full195-second harness (193.6 seconds recorded by the application), with all eight caller utterances replayed. The harness ended it; no fatal queue error or spontaneous disconnect occurred. The sampled hosted log contained only the expected recording error for the non-Twilio synthetic SID, not an upstream/model or pacing failure.
- Hosted transfer wording explicitly stated the handoff was simulated. Richa-at-salon question answered Monday's public noon–5 PM hours. Account prefetch recorded recognized:true.
- Hosted booking was **not completed**: Erica asked to spell the first name after the TTS caller said “Yes, I am Aryan” (approximate transcript rendered “Arian”); the fixed script instead proceeded to booking confirmation and did not answer that clarification. It later switched successfully to hours/address. Keep this as a separate identity/conversation replay item; do not treat the soak as an end-to-end hosted booking pass. The local replay did complete a simulated booking.
- Final status: zero active calls, Live+Terra, two allowed callers, writes/owner notifications simulated. No real owner transfer, Phorest change, or unsolicited phone call was made.
- Durable local evidence: `outputs/live-taste-test/audio-transfer-fix/` contains the scenario, local/hosted timing summaries and transcript/tool evidence. Owner handset listening remains the next acceptance step for voice quality.
