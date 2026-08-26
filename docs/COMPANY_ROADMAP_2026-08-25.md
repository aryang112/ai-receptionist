# AI Salon Company — Plan & Roadmap (v1, 2026-08-25)

> Synthesis of docs/AI_SALON_COMPANY_RESEARCH_2026-08-25.md +
> docs/MARKET_RESEARCH_2026-07-18.md into a sequenced plan. Owner: Aryan.
> Assets in play today: Erica (voice, prod), review automation (prod, real
> reviews), SMS bot (WIP), agentic email marketing (WIP).

## Positioning (the one-liner)

**"The AI front desk for salons — answers every call and text, books into
whatever software you already run, and shows you the revenue it recovered."**
No migration, no switching, no new POS. Priced against a receptionist's wage,
not a software budget.

Strategic frame from research: own the client-communication layer (voice, SMS,
email, reviews) across ANY booking substrate → expand along the client
journey → optionally become the system of record later. Do NOT rebuild
booking/POS/payments. Clock: ~12–18 months before incumbent native AI v2s
get serious. Biggest risk: single-platform single-workflow absorption
(TrueLark→Weave $35M). Antidote: breadth + depth + owning the phone number.

## The four products are one product

Voice (Erica) + SMS bot + email marketing + review automation = **one AI
front desk with one owner dashboard and one client timeline per salon.**
The unifying asset is the per-salon client-communication history — that's the
data moat. Unify early (shared client/event store), even if crudely.

---

## Phase 0 — Prove it at one salon (now → end of Sept)
*Goal: Richa's salon runs the FULL stack, with numbers good enough to sell with.*

- [ ] Erica hardening: deploy pending commits (tonight ~7 PM); prompt-hardening
      pass (unclear-audio block, escalation thresholds, booking invariants,
      rule-conflict audit); keep /call-review as the twice-daily QA gate.
- [ ] SMS bot shipped for Richa's (booking confirmations + missed-call
      text-back first — the two highest-ROI jobs per market research).
- [ ] Email marketing agent live for Richa's; review automation continues.
- [ ] **Instrumentation (the sales deck):** per-call outcome ledger →
      answer rate, after-hours capture, bookings created, est. revenue
      recovered, reviews generated. One weekly number: "$X recovered."
- [ ] Simulated-caller regression harness (fixa-style or DIY vs mock Phorest);
      measure pass^k on core scenarios, not one green demo.
- [ ] Exit criteria: 30 days of clean call reviews, documented $ recovered,
      Richa testimonial + permission to reference.

## Phase 1 — Productize the bundle (Oct → Dec 2026)
*Goal: one sellable product, 5–10 paying salons, ~$2–4k MRR.*

- [ ] **Owner dashboard**: recordings, transcripts, summaries, bookings,
      revenue-recovered counter, review feed. (Owners won't trust an AI they
      can't audit; the $ counter is the retention engine.)
- [ ] **Multi-tenant**: TenantConfig, templated prompts, per-tenant caches
      keyed by called number (July audit already mapped this). Stop adding
      hardcoded salon facts to prompts now.
- [ ] Pricing v1: flat **$297–497/mo** per location, month-to-month, free
      2-week trial on after-hours only (lowest-risk entry). No per-minute
      gouging, no contracts — position directly against incumbents' add-on
      nickel-and-diming.
- [ ] First customers: (a) other Phorest salons (integration already built —
      Phorest's own Front Desk AI is text-first, we do voice), (b) local
      MD/Baltimore salons via Richa's network, (c) content into legacy-owner
      channels (Modern Salon reads, Summit Salon network).
- [ ] Company name/brand/site (Aryan decision).
- [ ] Exit criteria: 5 paying salons outside Richa's, churn = 0, dashboard live.

## Phase 2 — Integration breadth + workflow depth (Q1–Q2 2027)
*Goal: the Numa moat — can't be killed by any one platform. 25–50 locations,
~$10–20k MRR.*

- [ ] **Integration #2: Mindbody/Booker public API** — the one legacy player
      with a real public API and a huge, unhappy, text-bot-only base.
- [ ] **Integration #3: Boulevard GraphQL partner API** — ride their
      ecosystem into their voice gap (the Avoca-on-ServiceTitan play). Beau
      can't book by voice; we can.
- [ ] **Greenfield mode**: built-in lightweight calendar for the ~28%
      pen-and-paper / booth-renter segment (nothing to integrate with —
      Erica IS the booking book). Solo pricing tier (~$99/mo).
- [ ] **Workflow expansion past answering** (the Slang lesson — answering
      alone commoditizes): outbound confirmations for no-show-risky slots,
      cancellation waitlist-fill, lapsed-client win-back (Phorest Reconnect
      data), review-request automation tied to completed visits.
- [ ] Square Appointments / Vagaro integrations as follow-ons.
- [ ] Exit criteria: 3+ platform integrations live, outbound shipped,
      first multi-location group signed.

## Phase 3 — Scale the relationship (H2 2027+)
*Goal: 100+ locations; the must-buy in the category.*

- [ ] Multi-location groups as primary sales motion (Arini lesson: groups =
      one buyer, many locations, and they talk to each other).
- [ ] Marketplace listings (Boulevard, Mindbody partner marketplaces).
- [ ] Outcome-pricing experiments (per-booked-appointment fee option).
- [ ] Raise-vs-bootstrap decision point (category is proven fundable:
      Avoca $1B, GlossGenius $1.15B, Fresha unicorn) — decide from a
      position of traction, not need.
- [ ] Optional: system-of-record expansion for greenfield cohort
      (the Owner.com path) — only if the layer is winning.

---

## This week (Aryan's stated focus: SMS bot + email marketing)

1. Build SMS + email **multi-tenant-shaped from day one** (config per salon,
   no hardcoded Richa facts) — cheap now, painful later.
2. Log every SMS/email event into the same per-salon ledger Erica writes to —
   the unified client timeline starts here.
3. Erica deploy at ~7 PM + test call against the acceptance list.
4. Jarvis queue (parallel, no approval needed): revenue-attribution ledger
   design; dashboard spec; prompt-hardening pass ready-to-apply.

## Standing decision points (Aryan)

- Company name/brand (blocks site + outreach, Phase 1).
- Pricing final ($297 vs $397 vs $497 anchor).
- Trial design (after-hours-only free trial vs full).
- When to approach Phorest/Boulevard for official partnership vs stay quiet.

## Metrics dictionary (define once, use everywhere)

- **Answer rate**: calls answered by AI / total inbound.
- **Containment**: handled fully, no transfer, no callback (industry avg
  40–55%, best-in-class 70–80%).
- **Booking conversion**: bookings / calls with booking intent (leaders claim
  75–90%).
- **Revenue recovered**: after-hours + missed-call-rescue bookings × service
  value (the headline number).
- **pass^k**: same test scenario passed k consecutive runs (consistency).
