# AI Salon Company — Strategy Research (2026-08-25)

> Three-agent web research run the evening Aryan stated the ambition: build an
> AI Salon company that modernizes legacy salons and beats Boulevard et al.
> Companion to docs/MARKET_RESEARCH_2026-07-18.md (AI-receptionist competitors).
> Vendor numbers are self-reported unless noted. Full agent reports are in the
> session transcript; this doc is the distilled version.

## 1. The modern platforms (the "beat Boulevard" targets)

| Company | Position | Scale / money | AI shipped (2026) | Weakness |
|---|---|---|---|---|
| **Boulevard** | Premium salons + ~15% of US medspas | ~$188M raised, ~$800M val (Series D Jul 2025), 5k+ businesses, ~$5B payments/yr, $176–410/mo/location | **Beau** receptionist beta ($125/mo): CANNOT book by voice — texts a link; no group/memberships/custom knowledge; 1 voice, 1 transfer number | Price, buggy mobile app, 12-mo contracts, support waits |
| **Zenoti** | Enterprise chains/medspa | $1.5B val, profitable, ~30k businesses | Most aggressive: 9-agent "AI Workforce" incl. voice receptionist w/ upsells + outbound | Clunky UI, bad mobile, offshore support, overkill below enterprise |
| **GlossGenius → "Genius AI"** | Solos/micro | $1.15B val (Jul 2026), ~$200M rev run-rate | Full agent team: AI receptionist (calls+texts, ~50% after-hours booked), growth analyst, marketer | Weak team/multi-location; payout freezes; support |
| **Fresha** | Global marketplace, 140k businesses | Unicorn (KKR May 2026) | **AI Concierge** — real voice booking into calendar (~$80/mo credits) | 20% new-client commission resentment; no API |
| **Mangomint** | Best-loved boutique software | $35M Series B | **None** (deliberately) — most exposed "great software, no AI" player | Thin marketing; slow AI roadmap |
| **Phorest** | Premium independents (our integration) | 11k+ businesses, modest capital | Front Desk AI (new, text-first) + Cheat Sheet AI | Quote-only pricing, SMS fees, no EMR |
| **Squire** | Premium barbershops | $750M val | "Operator" 24/7 receptionist, books directly | Nickel-and-diming resentment |
| Vagaro / Booksy / StyleSeat | Budget mass-market / marketplaces | ~$100k+ businesses each | Minimal (Booksy: Google AI Mode distribution) | Dated UX / 1.4★ Trustpilot / fee stacking |

**Business-model key:** these are payments companies wearing SaaS clothes
(GlossGenius: $7B/yr facilitated vs $200M rev; Boulevard $5B processed). They
defend the processing relationship above all. An AI layer that doesn't touch
payments can partner in; one that routes bookings is existential to them.

## 2. The legacy base (the "transform legacy salons" thesis — validated)

- US: 1M+ salon "businesses" (87% of workforce = booth renters/solos, per PBA);
  ~84k employer establishments; avg employer salon revenue ~$245–320k/yr.
- **~28% of US salons still book manually**; solos burn 8–10 h/mo answering DMs.
- Legacy vendors: Meevo (has AI, closed API), DaySmart (PE harvest, no AI),
  Rosy/Envision/Shortcuts (no AI, dated, 3-yr contracts), Booker/Mindbody
  (Vista-owned, aging, text-bot only — but the ONE legacy player with a real
  public API), SalonBiz (Aveda lock-in), Kitomba (ANZ).
- **Phone stats (the wedge):** 53% of bookings by phone; 37% of calls missed;
  69% of consumers have abandoned a booking they couldn't get through on;
  46% of bookings after hours; 55% comfortable with AI receptionists (Zenoti survey).
- **Migration pain is the incumbents' moat** (documented: $2,800 + 60 hrs +
  5 yrs of history lost) → the AI layer wins precisely because it requires NO
  migration. Nobody sells migration standalone; it's vendor CAC.
- **TrueLark — the salon AI-layer category leader — exited to Weave ($35M,
  May 2025) and left beauty.** Remaining rivals (BookingBee, Qlient, Kickcall)
  are thin/demo-gated. The top slot is open.
- Rentable distribution into legacy owners: Summit Salon Business Center
  (consulting network, already educating on AI), Data-Driven Salon Summit,
  Modern Salon / American Salon press.

## 3. The playbook (case-study evidence)

- **Avoca** (home services): AI call layer ON ServiceTitan → marketplace
  partner → expanded Convert/Nurture/Coach → $1B val Apr 2026. Survived
  ServiceTitan shipping its own AI by being 10x better + going deeper.
- **Slang.ai** (restaurants, cautionary): pure phone answering commoditized —
  $199/mo rivals, OpenTable/Toast native AI; "good phone answering is no
  longer scarce." Wedge alone is a melting asset.
- **Numa** (auto): SMS wedge → 90% DMS integration coverage → "AI OS for
  dealerships." Multi-platform breadth = unkillable by any one incumbent.
- **Arini** (dental, YC W24, closest to our stage): ~$500k raised, 18 people,
  15k calls/day — growth unlock was multi-location groups (DSOs), not
  one-location sales.
- **Owner.com**: proof the layer can become the system of record ($499/mo,
  $1B val) — but it takes years; the wedge earns the right.
- **Sierra/Decagon**: outcome pricing works (~$1.50/resolved conversation;
  price against labor, not seats).
- VC consensus (Tavel "sell work not software", Foundation Capital
  service-as-software $4.6T, a16z, Bessemer): wedge into the highest-pain
  revenue-linked workflow, own the revenue moment, price against labor
  replaced, moat = interaction data + integration depth, live alongside the
  incumbent first.

## 4. Strategy synthesis for us

**Do NOT rebuild booking/POS/payments to fight Boulevard head-on** (their kill
zone, $50M+ fight). The winning shape: **the AI front-desk layer that works
across every booking system a salon might already have** — enter with zero
migration, own the phone number + client-communication layer, prove recovered
revenue, expand along the client journey (SMS confirmations → rebooking →
win-back → no-show protection → analytics), then optionally become the system
of record years from now on the salon's timeline.

Ranked principles (agent 3):
1. Price against the receptionist wage / recovered revenue ($300–600/mo flat),
   with a revenue-recovered dashboard as the retention engine.
2. Multi-platform integration breadth fast (Phorest ✓ → Mindbody/Booker
   public API → Boulevard GraphQL partner API → Square/Vagaro) — the Numa moat.
3. Expand past call answering before it commoditizes (the Slang lesson).
4. Target multi-location groups once one location is airtight (the Arini
   lesson); instrument Richa's salon obsessively as the reference case.
5. Exploit the Boulevard voice gap now; assume Zenoti-grade native AI arrives
   everywhere within 12–18 months.

**Biggest risk: incumbent absorption before escape velocity** (Bowtie→Mindbody,
TrueLark→Weave at only $35M). Single-platform single-workflow add-ons become
features. Mitigation = principles 2–4.

**Erica gap list vs this plan (from July doc, still true):** SMS layer, owner
dashboard w/ recordings+transcripts, revenue-attribution analytics,
multi-tenant. Those four ARE the company-building roadmap.
