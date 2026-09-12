# Live caller lookup: September 12 owner test

The owner reported that their approved calling number ending 5169 did not identify Aryan Gupta. Two separate causes were verified.

## Evidence and diagnosis

- Actual owner call at 3:24 PM Eastern (`CAb7f3eb4a6e8a16ae4737f3cd661f14c2`): approximate transcript contains a request to look up the calling number, followed by Erica claiming she could not see caller ID. No customer lookup tool ran. Hosted background lookup logged a clean miss, not a timeout.
- Later hours-only call at 6:08 PM was also unrecognized, but did not request a customer lookup. This is not a separate lookup-tool failure.
- Fresh real Phorest phone-index lookup returned no match for the supplied number. Full-name lookup returned one Aryan Gupta record. A direct GET of that client confirmed its mobile ends in 7474, not 5169; no other phone field appeared in that response. No profile data was changed.
- A synthetic call against the deployed build reproduced the conversation defect even with the full name supplied: Erica asked for a phone number and ran no lookup. This is VERIFIED by model text and tool evidence; no acoustic claim is made.
- The latest available QA report was September 12 AM, before these owner calls. Its earlier clean window does not assess this incident.

## Narrow correction

Runtime source: `9851e8a`.

The speech prompt now routes explicit profile/caller-ID requests to the backend before collecting contact details. The backend uses information already supplied and searches a supplied full name after a phone miss. A name match locates a candidate; it does not by itself verify identity or authorize appointment disclosure or changes.

For Live only, a no-argument `lookup_customer` now uses the actual calling number when there is no prefetched match. Explicit names or different numbers take priority. The real number stays in application/backend handling; it is not placed in the frontend prompt. A miss asks for missing identifying information instead of assuming a new client. Realtime behavior and all simulation/allowlist boundaries remain unchanged.

The local probe utility now admits its configured caller number, so a real caller-ID scenario can be tested locally without changing application access controls.

## Validation

- 666 tests / 61 files passed; TypeScript build and whitespace checks passed.
- Added behavioral tests for caller-ID fallback, explicit-name priority over another prefetched person, explicit different-number priority, and unchanged Realtime behavior.
- Corrected local actual-Live/Terra simulation: calling-number lookup missed; full-name lookup found Aryan Gupta; Erica asked for account phone or appointment detail before proceeding. Read-only Phorest was used throughout.
- Private evidence: `/tmp/erica-aryan-lookup-probe/hosted-evidence.json` (before) and `/tmp/erica-aryan-lookup-fixed/calls.jsonl` (local after). No phone call was placed to the owner.

## Next-call expectation

Automatic recognition from 5169 will still miss while Phorest stores 7474. The corrected fallback should find the profile when the caller supplies “Aryan Gupta,” then ask for identity confirmation. Updating the Phorest mobile to the caller's current number is a separate data change, not something this patch silently does.

Appointment changes remain simulated. This correction does not enable real booking, cancellation or rescheduling.

## Deployment and additional checks

- Railway release `6f211b18-0e1a-4281-ae75-0c8e737f63e1` SUCCESS, created September 12 at 22:20:14 UTC / 6:20 PM Eastern. Four running source/build hashes match the local correction.
- Post-deployment status retains Live+Terra, simulated writes/notifications, and two approved callers.
- A second corrected local simulation supplied only the caller-ID lookup request: the tool used the actual calling number, returned no match, and Erica asked for first and last name. She did not claim caller ID was unavailable.
- Hosted post-deployment replay `CA_probe_1789251733479` ran two successful lookup tools and replied: “I found an account for Aryan Gupta. To confirm it's yours, what phone number is on the account?” This supports the lookup fallback; it is not a handset audio acceptance test. Private evidence: `/tmp/erica-aryan-lookup-hosted-fixed/hosted-evidence.json`.
- Final hosted status: zero active calls, Live+Terra, simulation retained. No Phorest profile or appointment was changed.
