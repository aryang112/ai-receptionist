# Owner transfers only on working days

Owner correction: 9 AM–8 PM applies only on Richa's working days. The previous helper ignored the salon calendar and would permit Sunday and holiday transfers.

Added one working-day guard to the shared isWithinTransferWindow helper, reusing the existing calendar resolution. For this single-provider salon, business.json identifies Monday–Saturday as working days and excludes Sunday, closedDates and vacation ranges. The clock window remains 9 AM inclusive–8 PM exclusive in salon time, including before public opening or after public closing on eligible dates. The calendar itself was not edited. No roster request or new subsystem was added; time off must be recorded in the existing calendar to affect this policy.

The prompt's computed line status, normal transfer handler and technical-error fallback already use this helper. Normal denied transfers offer the existing caller-authored message path. Technical failures on ineligible dates use the existing apology/hangup path. The earlier vacation-specific public explanation remains intact.

Validation: 682 tests across 61 files and TypeScript build pass. Cases cover Sunday and Christmas transfer refusal, away-day rejection including fatal failover, reopening, before-opening eligibility, and the exact 8 PM boundary. Sunday prompt status is unavailable. No actual phone call or SMS was sent. Real appointment changes and owner notifications remain simulated in the test deployment.

Runtime source `8607ef1`; Railway release `4d6dc922-bc44-4bf1-8699-b31c7f51db1f` SUCCESS, created September 12 at 7:47 PM Eastern. Four deployed source/build hashes match the tested worktree. No active application or Twilio calls before upload. After deployment: health 200, zero active calls, Live + Terra, two approved callers, writes/owner notifications simulated. Tests use injected dates; no real Sunday phone transfer was attempted.
