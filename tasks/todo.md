# TODO — Non-client calls + privacy hardening (2026-08-25)

Approved by Aryan (call-review follow-up): general handling for non-client
calls + a blanket never-disclose rule.

- [ ] 1. Prompt: new `NON-CLIENT CALLS` section (after SPAM) — one triage
      principle (brief, warm, one pointer, no tools, no transfer, wrap up)
      + pointer list: job seekers → website ("openings get posted on our
      website when we have them" — safely true), genuine vendors/press/
      partnerships → message path, charity → polite decline, wrong number →
      identify + end, premises emergency (alarm/leak/break-in) → escalate to
      Richa immediately (the exception).
- [ ] 2. Prompt: new `PRIVACY` section — NEVER give out Richa's/staff phone
      numbers, schedules, or whereabouts to anyone; never confirm whether
      anyone is at the salon; transfers connect without revealing numbers;
      appointment details only with the caller they belong to — for anyone
      else, don't confirm/deny, offer the message path; never read phone
      numbers aloud.
- [ ] 3. Tests in twilioStream.prompt.test.ts for both sections.
- [ ] 4. Full `npm test` + `npm run build` green.
- [ ] 5. Commit, update state.md.
- [ ] NOT in scope: Wix careers blurb (separate repo, publish needs
      approval), multilingual policy (flagged, no decision).
- [ ] Deploy: needs `railway up` — Aryan's call.
