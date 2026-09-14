# September 9, 2026 call review

Read-only production investigation requested by Aryan. Four calls through the
evening review (7:52 PM ET); all four independently reconciled with Twilio.
Recordings were supplied to Aryan for listening. This review has NOT listened
to the recordings and does not claim to establish audio quality or who hung up.
No runtime change, deployment, customer write, booking change, or outbound
message was performed by this review.

## Production and totals

- Health and protected admin endpoints return 200. Running twilioStream source
  SHA-256 matches the September 8 `bc39b09` release exactly. Current deployment
  logs are from `ee43e7fe-9fd0-4dd7-9dcf-f907c6cfcd1a`.
- Four completed inbound calls; seven recorded business/end-call tool operations,
  all successful. One booking, one caller message, two informational/short calls.
- $500 booked service value, not collected revenue. Estimated Realtime usage
  $0.4514; Twilio voice call charges $0.0425. These are not an all-in cost:
  recording, transcription, summaries, SMS, hosting, etc. are not included.
- Logged response latency: 22 measurements, 448–1,347 ms, median 715 ms.
  These measure the application's response phases, not caller-perceived round-trip
  delay or complete speech playback. No observed rate-limit or tool-retry incident.
- Local main baseline: 554 tests / 46 files pass. Main remains different from
  production; this is repository health, not validation of a new release.

## Calls and recordings

Private recordings and source evidence are in the untracked local directory
`outputs/call-review-2026-09-09/`. Times below are America/New_York. Durations
use the Erica session; Twilio's full call durations are slightly longer.

| Time / last four | Duration | Independent assessment | Recording file |
|---|---:|---|---|
| 8:23 AM / 2701 | 11s | Existing-client number; greeting transcript only, no completed caller transcript. No confirmed failure; physical silence/disconnection cause needs listening. | `0823-2701.mp3` |
| 12:16 PM / 4604 | 21s | Asked whether the shop was open; correctly told closed today and reopening September 10. Repetitive/long answer is a minor text-quality issue. No booking request. | `1216-4604.mp3` |
| 2:52 PM / 3677 | 1m53s | Existing-client booking completed; final approval safeguard skipped. Date-question exchange needs listening. | `1452-3677.mp3` |
| 7:24 PM / 1584 | 57s | Caller claimed Bank of America affiliation and requested a callback. Exact caller message accepted; closing did not reopen with another help question. Affiliation unverified. | `1924-1584.mp3` |

## VERIFIED: booking succeeded, required approval sequence did not

Transcript-relative times (approximate listening landmarks, not exact recording
timestamps):

1. ~0:15–0:25: caller requested an eyebrow tattoo and clarified shading. The
   selected catalog service was Micro Blading/ Shading.
2. First availability tool: September 10, zero offered slots. Second:
   September 15, one offered slot. Both returned successfully.
3. ~1:24: Erica offered September 15 at noon; caller said yes at ~1:31.
4. ~1:31–1:35: Erica asked whether she was speaking with the recognized caller;
   caller said yes. This was identity confirmation.
5. ~1:38: Erica said she would set it up and then confirm details. Successful
   lookup was followed immediately by book_appointment, without another caller
   turn or a full service/date/time approval question.
6. ~1:42: Erica announced the successful booking. Caller thanked her and ended.

Phorest read-only verification found the exact appointment ID from the production
success log still present: September 15, 12:00–16:00 local, Micro Blading/ Shading,
$500, state BOOKED, activationState ACTIVE. The Phorest `confirmed=false` field
is not evidence about spoken consent; the approval finding comes from the full
conversation and the tool sequence. The caller clearly wanted an appointment;
this is not a finding that an unwanted appointment was created.

The release's BOOK flow and book_appointment description explicitly require a
full service/date/time read-back AFTER contact collection and a NEW explicit yes.
That sequence was skipped. Existing-client success does not exercise the recently
fixed new-client email/create path.

### LIKELY contributing instruction gap; verified implementation boundary

Inspect the deployed `src/realtime/twilioStream.ts`, not main's draft version:

- `buildRecognizedCallerContext()` ends with "After confirmation" guidance to
  book on the matched account. In context, this refers to identity. It does not
  explicitly preserve the separate final appointment approval boundary.
- Successful `handleLookupCustomer()` returns identity data without a note
  reminding the model that identity confirmation is not appointment approval.
- `handleBookAppointment()` validates arguments, slots and fresh availability,
  but does not independently verify conversational approval. Its write boundary
  relies on model instructions.

These are plausible contributors, not a proven reconstruction of model reasoning.

Proposed first fix: clarify the existing recognized-context sentence and put a
short conditional booking-approval reminder in successful lookup results. Keep
phone-first/name-second flow, identity verification, and the booking contract.
Avoid another broad global prompt paragraph. Replay the actual recognized-caller
sequence with live model and simulated business tools: selected slot yes → identity
yes must yield a full read-back question, zero write, then exactly one write after
fresh approval. Also cover already-identified callers, rejected identity, changed
slots, supplied names, new callers, and cancellations/reschedules using lookup.

If the focused replay still bypasses approval, design a server-enforced approval
boundary tied to a specific proposed appointment and a later caller turn. A
model-supplied `confirmed:true` alone is not an independent safeguard. This would
be a separate reviewed implementation, with correction/barge-in tests and audio
validation before release. No candidate was implemented in this investigation.

## NEEDS LISTEN: repetitive date questions / possible transcription mismatch

At approximately 0:55–1:15 in the booking, Erica says she will pull up options,
then asks which day to check. The caller says "Hello?"; Erica repeats the question.
The next caller transcript says "Goodbye"; Erica says she did not catch it and
asks again. Caller then supplies September 15 and completes the booking.

The repetition and mismatch are visible in text. Whether the caller actually
said goodbye, had trouble hearing, or was affected by clipping is unresolved.
Do not change VAD or hangup behavior from the transcript alone. Logs in this
interval show response latencies of 636/864/690 ms and no tool retry or rate-limit
event. No tool ran during the first promise to pull up options: reducing that
unnecessary preamble is a reasonable small quality improvement if listening agrees.

The bank call repeats Richa's return date after a caller "Hello?". Speech/VAD
evidence supports a new caller turn; whether replay was unnecessary or the first
reply was inaudible remains an audio question. Its long final caller message is
captured as one final turn; no watchdog check-in appears during it.

## Spam/fraud status and message delivery

Zero calls today were classified spam or blocked. The live blocklist has one
entry below the configured two-strike threshold and zero currently blocked
numbers. These are operational counts, not proof of absence of fraud.

The evening caller's bank affiliation is self-stated and not authenticated by
Erica. All four calls have the same TN-Validation-Passed-C telemetry; that does
not establish this person's bank affiliation. The transcript contains a callback
request, no disclosed account credentials or financial action by Erica. Do not
classify the caller as a confirmed scammer or a verified bank representative.

Twilio read-only SMS status check: three post-call recaps delivered; the evening
caller message has status sent with no error code, not a delivered receipt at
the time of review. The ledger contains one caller-message notification and no
additional recap for that call. Message accepted/sent should not be described
as independently verified handset delivery.

## VERIFIED: misleading operational labels; no demonstrated outage

All four warning-ring entries are OpenAI socket close code 1005. Each follows
the corresponding Twilio stream stop (about 39 ms for three calls; 1.54s for
the morning call). `openaiSession.ts` logs every close as error even when
`closing` indicates intentional cleanup. Treating these four lines as crashes
is a FALSE POSITIVE. Proposed fix: downgrade expected closure to informational
logging while preserving real unexpected-close/auth failures.

Both the booking and bank call log an explicit "Ending call" request with
reason "caller confirmed done", followed by stream stop, then successful end_call
telemetry. The persisted end record nevertheless says "caller hung up". The
deployed endCallNow stamps its reason only after awaiting Twilio REST completion;
the stop callback can win that race and persist the generic reason first.

The inconsistent telemetry and race are VERIFIED. Physical initiator remains
unproven by the generic label. Proposed fix: preserve pending application hangup
intent separately from observed stream stop, reconcile successful/failed REST
completion, and test early-stop, API failure, caller barge-in and caller-first
disconnect. Avoid claiming "caller hung up" from an unqualified stream stop.

## Latest automated QA report: independent disposition

Reviewed Gmail "Erica QA — clean — Sep 09 AM", sent 8:39 AM ET, message
`1a0862df347def78`. Coverage: September 8 5:38 PM through September 9 8:38 AM.

| QA claim | Disposition |
|---|---|
| Two unique calls in window, one September 8 overlap | VERIFIED against metadata and both full transcripts. The afternoon/evening September 9 calls are outside this window. |
| Zero bookings, zero blocked calls, approximately $0.07 cost | VERIFIED for that window: $0.0681 estimated Realtime cost. Not today's totals. |
| Morning existing-client recognition | VERIFIED as a phone-directory match; no spoken identity confirmation occurred. |
| Both calls classified CLIENT by default | FALSE POSITIVE as an established identity/purpose claim: overlap caller was unrecognized and neither supplied a completed request. Categorize as one existing-client number and one unknown greeting-only call. |
| Correct full greeting delivered verbatim; callers silent; caller hung up | Greeting TEXT verified; physical delivery, silence and hangup initiator NEEDS LISTEN. Morning logs contain a speech-start event immediately before disconnect, so no completed caller transcript does not establish silence. |
| WS-close error represents normal teardown rather than outage | VERIFIED temporal correlation and close-logging behavior; outage inference FALSE POSITIVE. |
| Slightly high per-second short-call cost due to fixed greeting overhead, not retry loops | One model response per call and no tool/retry loop VERIFIED; proportional-cost explanation LIKELY. |
| Clean/no customer-impacting finding | No defect established in the narrow morning window. Treat overall health verdict as LIKELY with unreviewed audio, not proof that the whole day was clean. |

## Next action

Discuss approval-gap priority with Aryan and listen to the booking's date-question
exchange. Prepare any agreed fix from the exact production lineage, with the
recognized-caller replay above. Keep held service knowledge, silent-wait work and
unreleased main drafts separate. No new automation was created.

## Owner listening feedback and live matcher check (~8:01 PM ET)

Aryan identified two additional points after listening: the initial clarification
of brow tattoo/shading was reasonable, but Erica should proactively offer nearby
appointment options after September 10 had no availability, instead of asking
the customer to keep suggesting dates. These observations do not resolve the
separate questionable Goodbye transcription or final booking-approval gap.

Read-only probes used the deployed compiled resolveService and live catalog:

| Caller phrase | Actual production result |
|---|---|
| shading | Micro Blading/ Shading, 240 minutes |
| micro shading | Micro Blading/ Shading, 240 minutes |
| microshading | notOffered, no closest candidates |
| eyebrow shading / brow shading | notOffered, with threading/tinting/lamination as closest candidates |
| microblading | Microblading Touch-Up (6 Months), 180 minutes |
| eyebrow tattoo | notOffered, with threading/tinting/lamination as closest candidates |

Private results: `outputs/call-review-2026-09-09/shading-match-probe.json`.
This is a current production matcher probe, not evidence that those failures
occurred in today's call: Erica's clarification led to the correct combined
catalog service in the actual booking.

Proposed matcher work: add narrow phrase aliases for microshading/micro shading
and eyebrow/brow shading to the salon's existing combined service. Bare shading
already works. Keep an appropriate clarification for broad eyebrow tattoo
requests. Prevent generic microblading from silently choosing the six-month
touch-up; distinguish a new treatment from a touch-up. These are salon catalog
mappings, not a claim that different cosmetic techniques are interchangeable.

Proposed availability behavior:

- When a resolved service has no bookable starts on the requested date, check
  nearby later dates automatically and return two or three concrete choices.
  Do not first spend a caller turn asking permission to search another date.
- Respect any explicit constraints (e.g. only that date, afternoons, a particular
  weekday). Start with a bounded lookahead, proposed seven calendar days, and a
  small bounded number of simultaneous Phorest reads. Stop once enough choices
  are found; ask a useful preference if none are found in that window.
- Implement in the existing availability handler/helper so the model receives
  verified alternatives in one tool result. Normal successful date searches
  incur no extra lookahead reads. Additional empty-date lookup latency must be
  measured before release, not assumed negligible.
- Reuse the existing service-duration, salon hours/closure, salon timezone and
  clean-grid filtering for every candidate date; preserve offered-slot tracking
  per date and the existing pre-write fresh check. Do not confuse an API error
  with a searched date having no availability.
- Speak a short selection of actual appointment START times across dates. A
  broad noon-to-four range can misrepresent starts for this four-hour service.
  Example dates offered by Aryan were illustrative, not verified availability.
- Tests/replay: first day full with later options, intervening closed day,
  four-hour appointment fit, preferred-time ranking, no options, partial API
  failure, and booking an offered alternative after required final approval.

No synonym, availability, session, or production change implemented yet; this
addendum records the assessed behavior and concrete proposed scope.
