# Booking hotfix — September 8, 2026

Ready source: `1425f8c89924c547e8a2ca1f130a940276bfed5f`, pushed as
`codex/booking-hotfix-2026-09-08`. Dedicated checkout:
`/Users/aryangupta/Documents/Dev/ai-receptionist-hotfix-2026-09-08`.

Aryan accepted the staged release plan and asked to get the fixes deployed.
Implementation and verification are complete. The saved after-hours rule is the
remaining timing question; an explicit deploy-now exception was requested at
approximately 5:11 PM ET. Do not infer an answer from elapsed time.

## Scope and preservation

The branch starts with September 3 production `117ada0`, followed by the existing
email-only port `acbed9c`. New commits are `5c8534e` (explicit threading aliases),
`1eab9fe` (shared payload builder and exact live diagnostic), and `1425f8c`
(Phorest client version supplied for diagnostic archival).

Only two application files differ from production: `booking.ts` and
`phorest.client.ts`. The release restores placeholder emails with email marketing
and reminder consent disabled, preserving real supplied emails. Six explicit
eyebrow-threading phrases map to Brow Threading. It does not discard arbitrary
unknown words, so henna/tattoo requests do not become threading.

The production prompt, Realtime session, tool schema, model/voice configuration,
business hours, owner recaps, message handling, and booking/identity safeguards
are preserved. The broad matcher filter, lean prompt/`wait_for_user`, combined
identity question, transfer-ordering fix, and service knowledge remain separate.
Do not merge this production-based branch into main by replacing main's whole
tree: main intentionally contains unreleased work.

## Evidence

- 47 test files / 543 tests passed in local time and with `TZ=UTC`. This includes
  adapter create-body regressions and handler-level service/availability tests.
  The count differs from main because this branch excludes its unreleased prompt work.
- TypeScript build, changed-file Prettier, and `git diff --check` passed.
- Live read-only catalog: 63 services, seven intended-service-ID assertions passed;
  henna brows, brow henna, eyebrow tattoo, and eyeball threading remain notOffered.
- The shared application client-create payload was accepted by the live tenant.
  GET confirmed exact name/email and both email consent flags false. No live
  appointment or phone call was created by the validation.
- Diagnostic test client `EricaDiag DeleteMe-1788901717698` was archived and read
  back as archived. The first archive attempt returned HTTP 400 because it omitted
  version; cleanup then succeeded on that same client with its current version.
  The script was corrected; no second client was created.
- Phorest references checked: [create client](https://developer.phorest.com/reference/createclient),
  [retrieve client](https://developer.phorest.com/reference/getclient), and
  [update client](https://developer.phorest.com/reference/updateclient).
- Clean `git archive` created from `1425f8c`; no `.env`, `outputs`, `data`, or
  `node_modules` paths. Local archive location/commit are in `/tmp/erica-hotfix-release.json`.
- Last pre-release check at 5:11 PM ET: production health HTTP 200 and zero queued,
  ringing, or in-progress Twilio calls. Recheck immediately before deployment.

## Deployment and rollback

Production was still deployment `981138c1-6e73-4952-9daa-1087109f1647` / source
`117ada0` when this candidate was prepared. Deploy only the tracked archive,
with explicit Railway project/service/environment targeting and commit in its
release message. Preserve all runtime environment values and forwarding.

After release, verify health, the 63-service cache, complete client-index warmup,
and logs. Record deployment ID and image digest. Roll back to an archive of
`117ada0` for startup failures or new customer-impacting regressions, recognizing
that rollback restores the known missing-email bug. The first real new-caller
booking remains the production end-to-end confirmation.

## Today's calls and QA

As of approximately 5:03 PM ET, the production admin API reported two calls:

| Time ET | Last four | Duration | Observed evidence |
| --- | --- | --- | --- |
| 9:41 AM | 1584 | 45 seconds | Erica greeting, check-in, goodbye; no caller transcript. One successful end_call; no booking tools. |
| 1:42 PM | 7568 | 7 seconds | Erica greeting only; no caller transcript or tools. |

Both have recordings, saved locally under `outputs/call-recordings-2026-09-08/`
and displayed to Aryan. Zero bookings; estimated combined API cost $0.0804.
No transcribed request supports a lost-booking finding. Treat no-outcome flags
as FALSE POSITIVES for booking failure on the available evidence; caller intent
is unclassified. Who ended the call, audio quality, and why no caller text appears
remain NEEDS LISTEN. No claim of listening was made.

Latest available erica-call-qa email remains September 8 AM, sent 8:39 AM. Its
September 7 5:38 PM–September 8 8:38 AM zero-call window is VERIFIED against call
metadata and excludes both of today's later calls; it does not assess them.
