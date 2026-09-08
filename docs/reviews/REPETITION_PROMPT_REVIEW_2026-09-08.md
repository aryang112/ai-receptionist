# Repetition and prompt conflicts — September 8, 2026

Investigation only. No application, prompt, session, or production changes made.
Reviewed the production source `fcee0d8`, not the unreleased prompt on main.
Its call/prompt file is unchanged from September 3 production `117ada0`.
The September 3 daytime examples below ran the older `eca23f1`; they establish
historical symptoms, not proof that today's build still reproduces every symptom.

## Origin and scope

The two proposed work items originated in the September 3 audit
(`docs/PROMPT_AUDIT_2026-09-03.md`, documentation commit `b80241c`, local cleanup
`37d1d93`). That audit combined external conversations, internal tests, and
static instruction review. It was not a measured claim that every client call
has repeated closings. The September 7 client call adds strong service-repetition
evidence; its matching cause is already covered by today's focused release.

Fresh metadata and full transcripts were fetched for 30 calls from September 2
through September 8. This focused review read all 16 transcripts excluding known
owner/test numbers. Those 16 include salon inquiries, vendors, a job seeker,
spam, and three September 8 calls with no transcribed caller speech. They are
not 16 confirmed clients. The September 3 12:10 PM and September 4 6:53 PM caller
was recognized by production; the September 7 booking caller was unrecognized
but clearly seeking salon service. No recordings were listened to in this pass.

Private raw evidence remains untracked in `outputs/repetition-review-2026-09-08/`.
Transcript timestamps describe persisted transcript events, not exact audible
speech boundaries. No call-review cursor was advanced by this focused review.

## Production evidence

### September 7, 1:03 PM ET — repeated service clarification: VERIFIED

Call `CAd163ac9ef7fdac009382931f110add23`, 114 seconds, new booking inquiry.
The transcript sequence is:

1. Caller: “Eyebrow threading.”
2. Erica: “Do you mean Brow Threading, or something else for your brows?”
3. Caller transcription: “Eyeball threading.”
4. Erica: “Are you looking for Brow Threading specifically, or a different brow service like tinting?”
5. Caller: “Eyebrow threading.”
6. Erica: “Do you want the service called Brow Threading?”
7. Caller: “Yes.”

Historical Railway logs independently show `suggest_availability` receiving a
service that the matcher reports as `eyebrow threading`, returning “service not
offered” with Brow Threading, Eyebrow Tinting, and Chin Threading as closest
alternatives at 17:04:08 UTC. The existing tool-result instruction then asks the
model to clarify the treatment or offer nearby services. This is a verified
matching failure that sent the conversation into unnecessary clarification;
the precise reason for each subsequent model question cannot be proven.

Today's small brow/lash normalization fixes this mismatch. Do not stack a new
“never ask twice” instruction on top of the code fix. “Eyeball” could be a
transcription error: NEEDS LISTEN, not a new synonym to add automatically.

Later, the caller says “One” after several offered times. “Do you mean 1:00 PM
for Brow Threading?” is useful disambiguation, not the same defect. Phone-number
confirmation and first/last name are each requested once, in the desired order.
Retain those turns and the separate exact service/date/time approval requirement.

There are also unnecessary procedural lines, notably “Alright, I just need one
quick detail before we can lock that in” immediately before the phone question.
The existing no-preamble-for-confirmations rule already covers this; a global
new anti-preamble paragraph is not warranted. Include it in future replay checks.

### September 3, 12:10 PM ET — repeated return date: VERIFIED text; NEEDS LISTEN cause

Recognized caller, call `CA26e654bf3aaf4ac0b8488b88a73eefa7`. Erica repeats
“Richa is unavailable until Thursday, September 10” in consecutive replies.
The first reply is partial, and an unclear caller fragment occurs between them.
This might be interruption repair or a turn-detection issue. The older audit's
definitive “VAD pounce / caller cut mid-sentence” attribution exceeds transcript
evidence. Do not change VAD, interruption handling, or forbid repeating unheard
information on this evidence alone.

### Closings — narrower evidence than the original wording implied

- September 3, 1:14 PM, vendor message, call `CA6e213e2e10c019418cdb34654d0383e5`:
  caller finishes with “Goodbye.” After successful message capture Erica asks
  “Do you need help with anything else today?” VERIFIED reopening in transcript;
  this is a vendor example, not a client booking or repeated farewell loop.
- September 3, 2:35 PM, job inquiry, call `CAb721a5580ab3b361894416f1c4401917`:
  website pointer followed by “Is there anything else I can help with?” VERIFIED
  transcript behavior, contrary to the specific non-client ending instruction.
- September 5, 1:22 PM vendor message: one offer of further help, caller declines,
  then one farewell. No repeated closer established.
- September 4, 6:53 PM recognized client's tinting inquiry: reopening date repeated
  because the caller explicitly asks when the shop reopens. FALSE POSITIVE as
  unnecessary repetition; answering the question is correct.

This sample does not establish a widespread repeated-closing loop in client calls.
It does justify reconciling unconditional closing instructions that remain live.

## Exact live instruction conflicts and proposed direction

All line numbers refer to `src/realtime/twilioStream.ts` at `fcee0d8`; a matching
local copy is in the focused-synonyms worktree, not main.

| Area | Instructions that compete | Smallest proposed correction |
| --- | --- | --- |
| Closing: confirmed conflict | CLOSE (733) says ask for more help and “then ask again”; NON-CLIENT (754) says end once the caller has the answer. MESSAGE MODE (746) and message success note (4330) always require another question, even after goodbye. | Make the message result and closing flow agree: acknowledge success once; if the caller clearly finished, close; otherwise offer further help and wait. Explicitly retain the non-client ending policy. A genuinely new task can lead to a new closing offer. |
| Failure recovery: confirmed inconsistent thresholds | TOOLS (702) and OTHER TRANSFERS (742) say “MORE THAN 2 tool failures”; availability/list notes (3036, 4050) say retry once, then stop if it fails again. | Remove the competing global counter wording. Follow the specific recovery note, with at most one permitted retry of the same operation; after its second failure use the available human/message route. Preserve no-retry and uncertain-write exceptions. |
| Name collection: conflicting scope | General rule (670) says retain supplied details and ask only for missing values; recognized flow (721) resumes after identity confirmation; booking name description (903) says “Ask everyone for both names.” | In the tool description, require a complete name without instructing redundant collection: reuse a clearly supplied name or the correctly identified account name; ask only for missing parts. Do not weaken identity verification or change new-caller phone/name order. |

The name wording is a verified contract inconsistency; this sample does not prove
it caused a new repeated-name incident. It is a small preventive alignment, not
a reason to redesign identity. Likewise the retry conflict is static evidence:
the September 7 call actually stopped after two failed attempts.

Proposed closing wording, for discussion rather than application:

> After completing the request, if the caller has clearly said they are done,
> end the call using the existing closing procedure. Otherwise offer further
> help and wait. Continue if they raise another request; do not reopen a settled
> ending merely to ask again.

The success note must use that same decision, not independently command another
question. Preserve the existing tool-only `end_call` and result-owned farewell,
pending-action guards, and message-success truthfulness. No extra state machine,
model call, synonym dictionary, or response deduplication filter is proposed.

Not actual contradictions: “identity never from a name alone” versus a successful
account lookup; the temporary closure's explicit exception to ordinary hours
wording; variation in natural phrasing; repeated instructions that agree. Noise
and silence behavior is a separate runtime investigation, not proven defective
merely because a prompt requests silence.

## QA reconciliation

Latest available report: **Erica QA — clean — Sep 08 AM**, sent 8:39 AM.
Its window is September 7 5:38 PM–September 8 8:38 AM ET. Fresh call metadata
independently returns zero calls in that window: VERIFIED coverage count. No
reported customer issue exists to reproduce. This does not clear daytime calls.

Also reviewed **Erica QA — 1 verified finding(s) — Sep 07 PM**:

- VERIFIED: two failed booking attempts, no recorded booking, and an honest
  failure response. Historical logs independently show two Phorest HTTP 400
  `EMAIL_REQUIRED` responses during client creation for September 10, 13:00,
  Brow Threading. Today's separate email integration hotfix addresses this.
- LIKELY: other new-client requests on the same email-less creation path were
  exposed; the report's claim that every new client must fail is too broad.
- NEEDS LISTEN / additional termination evidence: the report says the caller
  hung up before responding. Transcript absence and WebSocket code 1005 do not
  establish who ended the call or whether speech was clipped.
- VERIFIED: no message tool or booking success in the call. “No callback
  captured” should not imply no contact existed: caller-ID was confirmed, and
  logs show a post-call owner summary was accepted.

## Engineering procedure and validation before a future fix

Apply the project's existing fix ladder (`tasks/lessons.md`, August 26): change
the instruction at the decision point first, align tool contracts next, use code
for deterministic invariants, and change general prose only where needed.
OpenAI's current Realtime guide likewise recommends beginning with minimal
instructions, evaluating failures, and keeping tool descriptions consistent:
https://developers.openai.com/api/docs/guides/realtime-models-prompting

Use the production branch as the baseline; selectively edit the closing note and
flow, retry wording, and name description. Do not merge the old broad rewrite.
Replay the September 7 service exchange against the already fixed matcher; add
focused conversation probes for supplied names, unclear service/time, alternate
phone, explicit goodbye after message success, another genuine request, two
read failures, and uncertain write/message outcomes. Verify one-question/WAIT
beats and explicit appointment approval. Then run regression tests/build and a
listening test before deployment. No new network/model request is proposed;
actual end-to-end latency effects still need measurement.

Baseline for this investigation: `npm test` passed 554 tests in 46 files on main.
That is not validation of a proposed prompt change. Production release previously
passed 568 tests in 48 files; this turn made no executable change.
