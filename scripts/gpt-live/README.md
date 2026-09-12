# GPT-Live-1 probes (read-only diagnostics, 2026-09-10)

Live validation of the `v1/live/sessions` API with Erica's exact telephony
shape (audio/pcmu 8 kHz, voice marin, Responses delegation). Each run opens a
short billed session ($0.05/min, billed per second — a few cents total).
Never point these at a real call. Run from the repo root:

    node --env-file=.env scripts/gpt-live/live-probe.mjs            # access + shape + greeting
    node --env-file=.env scripts/gpt-live/live-fields.mjs           # which session.start fields are accepted
    node --env-file=.env scripts/gpt-live/live-update-probe.mjs     # what session.update may change mid-call
    node --env-file=.env scripts/gpt-live/live-greeting-ab.mjs      # greeting-first reliability A/B (4 patterns x 4)
    PROBE_BACKEND=gpt-5.6-terra node --env-file=.env scripts/gpt-live/live-tool-probe.mjs
                                                                     # greeting → synthesized caller question →
                                                                     # delegation → tool → spoken answer, with
                                                                     # energy-based speech timing

Findings and the integration proposal: `docs/GPT_LIVE_1_EVALUATION_2026-09-10.md`.
