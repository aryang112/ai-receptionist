# Owner taste-test guide handoff

Added `docs/GPT_LIVE_OWNER_TASTE_TEST_GUIDE_2026-09-12.md`, a plain-language run guide and empty Terra/Luna/Realtime scorecard. It documents the bearer-authenticated `GET /admin/voice-test` and `POST /admin/voice-test/variant` endpoints, the `terra` / `luna` / `realtime` values, active-call guard, in-memory selection, and per-selection simulated-overlay reset. It distinguishes the simulation overlay from real Phorest reads and calls out that availability/catalog are not frozen by this endpoint.

The guide includes eight caller scenarios: person vs. service, aliases/bundle, full tattoo vs. touch-up, a known caller asking about another person, current hours, paired reschedule, simulated message plus goodbye interruption, and safe no-match recovery. It states that the current endpoint has no outage injector; a transient tool-failure scenario remains unscored until a controlled read-only failure is available. It also explains why synthetic transport cannot replace actual handset and speakerphone listening.

No source files were changed. No deployment, phone call, model probe, Phorest write/read, owner notification, or listening test was performed. The guide contains no test results or deployment claims.
