# Market Research — AI Phone Receptionists (2026-07-18)

> Competitive landscape research to inform Erica's feature roadmap and pricing.
> Web-researched 2026-07-18; sources cited per claim. Vendor ROI numbers are
> self-reported marketing claims, not audited. Companion to `tasks/todo.md`
> (plan) and `docs/FABLE_REVIEW_2026-07-06.md` §5–6 (productization).

## Headline conclusions

1. **Erica's live in-call Phorest write-access is the moat.** Across the whole
   market, "books it in the real calendar, doesn't just take a message" is the
   differentiator every vendor charges extra for: Rosie gates in-call booking
   behind its 3× tier ($49→$149), MySalonDesk needs *live humans* to complete
   bookings in most salon systems, Sameday leads marketing with "92% booking
   rate." We already have the hard part.
2. **The universal purchase trigger is "missed calls = lost revenue,"** made
   concrete: "30–35% of calls go unanswered" (Zenoti), "$200+ avg revenue lost
   per missed call" (AgentZap), "46–50% of salon bookings happen outside
   business hours" (Boulevard data, vendor-cited). Sell fear of leakage; prove
   with after-hours capture counts.
3. **Retention is driven by visible ROI accounting** — "revenue booked"
   dashboards (Zenoti), lifetime counters (Rosie), "paid for itself in 10 days"
   (Loman). Products that only answer calls compete on price; products that
   *prove recovered revenue* keep subscribers.
4. **Platform risk is real but not imminent on voice for Phorest salons:**
   Phorest's Front Desk AI is SMS/WhatsApp only today (voice is the obvious
   next step); GlossGenius lists a first-party 24/7 call+text "Reception" as
   *coming soon*; Fresha announced an AI receptionist for 2026; **Zenoti
   already shipped** the full thing (upsell + outbound confirmations + revenue
   dashboard) upmarket. Boulevard and Mangomint have none → friendliest
   integration targets for multi-tenant expansion.
5. **$249–399/mo is squarely in market range.** Salon-native comparables
   cluster $99–$399/mo (BookingBee $99/store, AgentZap $109–$295, MySalonDesk
   $125–$400); Slang.ai charges restaurants $399–$599/location; vertical
   leaders (Avoca ~$1–3K/mo, dental $399–$1,500/mo) prove deep-integration
   pricing power. To defend the price point vs $99 entrants and platform
   bundles: live booking (have) + SMS layer (build) + revenue dashboard (build).
6. **Category prints money:** Avoca $125M Series B at $1B valuation (Apr 2026);
   Slang.ai $36M Series B, 2,000+ restaurants; PolyAI $750M valuation; Numa
   1,200+ dealerships; Podium "9,500 AI Employees deployed."

## Summary table

| Product | Price | Killer features | Integration depth |
|---|---|---|---|
| Slang.ai | $399–$599/mo/location | VIP caller recognition, text confirmations, CSAT, bilingual +$99, multi-location insights | Deep: OpenTable/SevenRooms/Yelp |
| Rosie | $49–$299/mo | Spam blocking, bilingual EN/ES, SMS booking links, recordings/transcripts | Booking links on entry; in-call booking at $149+ |
| Goodcall | $79–$199/mo unlimited mins | SMS follow-up, dashboard, instant setup from Google profile | Shallow: Zapier/links |
| Smith.ai | ~$95+/mo per-call | Hybrid human escalation | Mid: calendars/CRMs |
| Yelp Host/Receptionist | $99–$149/mo | Platform distribution, SMS follow-ups, transcripts in inbox | Deep within Yelp only |
| Podium AI Employee | ~$99–$399 add-on on $399+ platform | Voice+text+chat, review responses, outbound campaigns, "30% more sales" | Deep vertical (ServiceTitan, CDK) |
| **Zenoti AI Receptionist** | not public | End-to-end booking + **upsell every call** + **outbound confirmation calls** + **revenue-booked dashboard** | Native platform |
| GlossGenius "Reception" | coming soon (platform $24–$148/mo) | 24/7 calls+texts into own calendar | Native |
| AgentZap | $109–$899/mo | Real-time booking, instant confirmation texts, reminder SMS | Deep: Vagaro/Boulevard/Fresha/Mangomint |
| BookingBee | $99/mo/store | Beauty-specific, human-in-loop, **Phorest integration** | Deep (claims live Phorest booking) |
| MySalonDesk | $125–$400/mo | Hybrid AI+human; voicemail-to-text | Shallow AI (live booking only in Jane App) |
| Numa | ~$200–400+/mo; pay-per-appointment emerging | Missed-call text rescue, **outbound win-back** ("31% of cold messages convert") | Deep: DMS real-time |
| Avoca | ~$1–3K/mo | AI CSR + AI coaching/QA of human calls | Deep: ServiceTitan/HCP |
| PolyAI | $100K+/yr | Enterprise, 45 languages | Custom |

## Feature gaps vs the market (ordered by universality)

We have: live book/reschedule/cancel, prices, hours, transfer, running-late,
barge-in, caller-ID/VIP recognition (a Slang *Premium* feature — market it).
We lack:

1. **SMS layer** (in ~every product; 3 jobs): (a) instant booking-confirmation
   text; (b) missed-call/voicemail text-back with booking link; (c) reminder
   texts 24–48h out — **check first whether Phorest's own reminders cover (c)**.
2. **Owner dashboard: recordings, transcripts, summaries per call** — table
   stakes everywhere; owners won't trust an AI they can't audit.
3. **Revenue-attribution analytics** ("revenue booked", "after-hours calls
   captured") — the retention feature.
4. **Spam/robocall blocking** (standard even at Rosie's $49 tier; also saves
   OpenAI tokens per junk call).
5. **Bilingual Spanish** (Rosie includes free; Slang charges $99/mo; native to
   gpt-realtime — currently disabled by our English-only prompt rule).
6. **Outbound** (premium tier of the market): confirmation calls to unconfirmed
   guests (Zenoti), waitlist-fill on cancellations (GlossGenius auto-waitlist),
   lapsed-client win-back (Numa; Phorest Client Reconnect already identifies
   lapsed clients — Erica could action them).
7. **Voicemail fallback + summarized handoff** when AI can't finish.
8. **Multi-location/multi-tenant** — basis of per-location pricing upmarket.

Lower priority observed: in-call upsell of add-on services (Zenoti: "25% of
recovered bookings are upsells"), CSAT measurement, custom voice/branding as a
premium tier.

## Key sources
Phorest AI: phorest.com/features/ai-features · BookingBee-on-Phorest:
bookingbee.ai/phorest-integration-made-simple-with-ai-voice-agent ·
GlossGenius: glossgenius.com/pricing (Reception "coming soon") · Fresha:
fresha.com/blog/Up-Next-2026 · Zenoti: zenoti.com/ai-workforce/ai-receptionist
· Slang: slang.ai/pricing + $36M Series B (PRNewswire 2026) · Rosie:
heyrosie.com/pricing · Goodcall: goodcall.com/pricing · Smith.ai:
smith.ai/pricing · Yelp: blog.yelp.com/news/yelp-host-yelp-receptionist-launch
· Podium: podium.com/product/ai-employee · AgentZap: agentzap.ai/industries/salon
· MySalonDesk: mysalondesk.com · Avoca $1B: PRNewswire 2026-04 · Numa: numa.com
· Sameday: gosameday.com · PolyAI: poly.ai/pricing · Boulevard: 
thesalonbusiness.com/boulevard-software-review · Mangomint:
mangomint.com/features/call-text-chat.

## Caveats
- Boulevard's "46–50% after-hours bookings" stat: primary source not located.
- Zenoti/Numa/Avoca/Sameday/Podium/Fresha pricing not public — third-party estimates.
- Vagaro "MySa": no evidence found. Loman.ai now restaurant-focused (not dental).
