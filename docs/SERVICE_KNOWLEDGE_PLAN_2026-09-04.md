# ADR-004: Low-latency service knowledge for Erica

**Status:** Proposed; working local prototype, not approved for production
**Date:** 2026-09-04
**Deciders:** Aryan and Richa

## Context

Erica can currently quote live service names, prices, appointment durations,
hours, closures, and availability. Phorest does not expose the salon's
aftercare, preparation, suitability, expected-result, or longevity guidance.
The model can improvise plausible answers, but a live baseline probe showed
that plausible answers do not consistently match the salon's published
material.

The public website was audited from its sitemap on 2026-09-04:

- 57 indexed pages: 39 Wix booking-service pages and 18 ordinary pages.
- The live Phorest catalog has 63 active services.
- The booking pages are mainly old price/duration shells, not a complete
  service knowledge base.
- Useful educational content is concentrated in the brow-lamination,
  lash-lift, microblading, threading, waxing, facial, eyelash-extension, and
  linked consent/aftercare documents.

### Important source conflicts

| Subject                  | Website                                         | Live/current comparison                              | Decision                    |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| Eyebrow tint booking     | $15 / 35 min                                    | Phorest: $25 / 5 min                                 | Phorest only                |
| Brow threading           | $10 / 10 min                                    | Phorest: $15 / 5 min                                 | Phorest only                |
| Brazilian wax            | $45 / 20 min; stale $25 promotion also indexed  | Phorest: $58 / 15 min                                | Phorest only                |
| Lash lift booking        | Website says email because it is not in Phorest | Phorest offers Lash Lift and Lash Tinting            | Phorest only                |
| Lash-lift longevity      | Same salon page says both 4-6 and 6-8 weeks     | Manufacturer says typically 6-8 weeks                | Withhold pending Richa      |
| Lash-lift aftercare      | Salon page says avoid water for 24-48 hours     | Named manufacturer says water does not undo the lift | Withhold pending Richa      |
| Microblading preparation | Page says to stop aspirin/blood thinners        | Medication changes require clinician guidance        | Never automate this wording |

The salon's eye-service consent form supports a three-to-four-week tint
touch-up range and notes faster fading from exfoliation and chlorine. The
microblading aftercare PDF is an older, detailed wound-care handout and should
not be converted directly into conversational medical advice.

## Decision

Use a small, version-controlled, owner-reviewed knowledge file loaded once at
application startup. Expose it to GPT-Realtime through one deterministic,
read-only `get_service_information` function.

Do not browse the website, call an embedding service, or query a vector
database during a phone call. Do not copy the full knowledge corpus into the
global prompt. Do not put prices, durations, bookability, or appointment slots
in the knowledge file.

Source authority is:

1. Explicit Richa-approved wording and rules.
2. Live Phorest for offered services, price, appointment duration, and slots.
3. Reviewed salon-website facts for salon-specific process and care.
4. Clearly labeled general professional guidance for low-risk approximations.
5. Model memory only for conversational phrasing. It is not an authority for a
   number, procedure, policy, expected result, or safety instruction.

Scraping creates editorial candidates. It never publishes a fact directly to
Erica.

## Options considered

### Option A: Let the model answer from training data

| Dimension         | Assessment   |
| ----------------- | ------------ |
| Latency           | Lowest       |
| Accuracy          | Inconsistent |
| Maintenance       | Low          |
| Salon specificity | Poor         |

**Rejected:** the baseline model produced fluent but conflicting tint,
lash-lift, and microblading guidance.

### Option B: Put all service content in the system prompt

| Dimension   | Assessment                            |
| ----------- | ------------------------------------- |
| Latency     | No tool round trip, but larger prompt |
| Accuracy    | Better if perfectly maintained        |
| Maintenance | High                                  |
| Reliability | Facts compete with behavioral rules   |

**Rejected:** 63 services plus care details would enlarge an already carefully
budgeted prompt and make stale facts difficult to isolate.

### Option C: Search the website during each call

| Dimension   | Assessment                         |
| ----------- | ---------------------------------- |
| Latency     | Variable and network-dependent     |
| Accuracy    | Website is stale/conflicting       |
| Maintenance | Low initial, high operational risk |
| Reliability | Exposed to Wix changes and outages |

**Rejected:** a website outage or layout change must not create dead air, and
raw scraped text must not become instructions to the model.

### Option D: Reviewed local facts with an in-memory tool

| Dimension   | Assessment                     |
| ----------- | ------------------------------ |
| Latency     | Sub-millisecond local lookup   |
| Accuracy    | Deterministic and reviewable   |
| Maintenance | Small editorial workflow       |
| Reliability | No mid-call network dependency |

**Selected.**

### Industry cross-check

The selected design is consistent with current voice-agent practice without
copying another platform's architecture:

- Vapi recommends short voice prompts, explicit tool behavior, concise
  structured tool results, and scenario examples rather than a large negative
  rule list.
- Retell separates large knowledge from the main prompt, recommends clean
  structured source text, and explicitly instructs agents to answer only from
  retrieved context when hallucination control matters.
- Bland separates global behavior from knowledge and call-flow branches, then
  validates them with repeatable scenarios before promotion.

Because this salon corpus is small and contains known conflicts, a deterministic
reviewed lookup is simpler and faster than the general-purpose vector retrieval
those platforms also offer.

## Prototype

The prototype contains:

- `src/config/serviceKnowledge.json`: 9 service families and 29 atomic facts.
- `src/config/serviceKnowledgeConfig.ts`: development/compiled-runtime loader.
- `src/services/serviceKnowledge.ts`: startup validation, alias matching,
  reviewed-only filtering, and compact Realtime result construction.
- `get_service_information`: accepts `serviceName` plus one to three topics.
- Website audit, catalog validation, local benchmark, and live Realtime probe
  scripts under `scripts/`.
- Focused unit and prompt-contract tests under `src/tests/`.

Of the 29 extracted/normalized facts, 20 are currently voice-ready in the
prototype and 9 are deliberately withheld as conflicting, safety-sensitive,
unsafe, or awaiting owner review. Forty-five of the 63 current Phorest service
names map deterministically to one knowledge family; the other 18 correctly
return no salon knowledge rather than receiving invented details.

This is a review prototype. `voice_ready` does not replace Richa's final
approval for production release.

## Runtime flow

1. The caller asks a service question.
2. GPT-Realtime selects `get_service_information` with the caller's wording and
   up to three requested topics.
3. The application searches the already-loaded in-memory index.
4. Only reviewed facts are returned; source URLs and editorial notes stay
   server-side.
5. Erica gives a one- or two-sentence answer, followed by at most one relevant
   booking step.

Missing, disputed, or unapproved facts return an explicit status. Erica says
Richa needs to confirm that detail instead of filling it from memory.

Safety-sensitive results can return top-level `highRisk: true` and one curated
`safeResponse`. The prompt tells Erica to repeat that response verbatim and add
no factual advice.

## Tool contract

```json
{
  "name": "get_service_information",
  "arguments": {
    "serviceName": "brow lamination",
    "topics": ["suitability", "longevity"]
  }
}
```

Possible results are:

- `ok`: one matched family and reviewed facts.
- `ambiguous`: at most three service-family names; ask one clarification.
- `not_documented`: no matching family; do not invent a salon fact.
- `needs_provider_confirmation`: the topic is missing, conflicting, unsafe, or
  awaiting approval.

Prices, durations, current offerings, schedules, and appointment slots remain
outside this tool.

## Prompt change

The proposed prompt adds one short behavior section:

```text
SERVICE KNOWLEDGE
- For process, longevity, preparation, aftercare, suitability, results,
  products, patch tests, contraindications, or safety, use
  get_service_information. The invoking response must be only the function
  call—no speech or filler.
- Answer in one or two sentences using only returned facts and qualifiers.
  General facts are typical, not guaranteed. Never mention tools or sources.
- Then offer at most one low-pressure action only if it fits the caller's
  intent; never list alternatives, repeat, or push booking.
- For high-risk results, say the supplied safe response verbatim; do not
  paraphrase, shorten, or add advice. If a topic is undocumented or needs
  provider confirmation, say Richa needs to confirm it; never fill the gap
  from memory.
```

The privacy rule is also corrected:

- Provider working hours and bookable availability are public.
- A provider's personal whereabouts, private calendar contents, client
  appointments, and when someone will be alone remain private.
- During a salon-wide closure, questions about Richa's availability or whether
  anyone can help now use the existing dynamic closure and reopen date.
- Outside a closure, exact availability requires the service and date because
  appointment length affects the slots.

## Test results

### Local retrieval

Twenty thousand mixed lookups:

| Measure |  Result | Acceptance limit |
| ------- | ------: | ---------------: |
| p50     | 0.12 ms |                - |
| p95     | 0.13 ms |            10 ms |
| p99     | 0.22 ms |            25 ms |
| Maximum | 1.18 ms |                - |

There were no network requests on the lookup path.

### Live GPT-Realtime-2.1 probe

Twenty-four independent sessions across the strict prompt iterations used the
proposed tool and array-based input schema:

- Correct knowledge-tool selection: 24/24.
- Spoken filler before the tool: 0/24.
- API errors/timeouts: 0.
- Tool decision p95: 816 ms.
- Tool result to first audio p95: 847 ms.
- Approximate caller-turn-to-grounded-audio p95: 1.77 seconds.
- Eyebrow-tint and brow-lamination numeric ranges were reproduced correctly.
- Conflicting lash aftercare was withheld.
- Unknown oxygen-facial aftercare was not guessed.
- Prescribed-aspirin and pregnancy questions reproduced the curated safety
  response verbatim, including the warning not to stop prescribed medication.

The final exact prompt was then run in six fresh sessions. It repeated all six
behavioral successes with no API error; five grounded answers began within
1.04-1.77 seconds, while one began at 2.09 seconds because tool selection took
1.57 seconds. That single natural API/model outlier is why the plan requires a
larger repeated release evaluation instead of treating a six-call sample as a
latency guarantee.

The focused build and 105 relevant tests pass. The repository's full suite has
540 passing tests and 6 unrelated failures in existing recording/transfer
tests whose assumptions depend on live environment/date state. ESLint is also
currently blocked repository-wide because ESLint 9 is installed while the repo
still uses the legacy `.eslintrc.cjs` format.

## Production acceptance gates

- Local lookup: p95 at or below 10 ms; p99 at or below 25 ms.
- Realtime tool decision: p95 at or below 1.5 seconds.
- Tool result to first audio: p95 at or below 1.2 seconds.
- Caller turn to grounded first audio: p95 at or below 2 seconds.
- Knowledge routing: at least 98% over a minimum 30-question golden set, three
  repetitions each.
- Safety-sensitive routing, numeric fidelity, no-guess missing behavior, and
  preamble-free tool calls: 100%.
- Unsupported salon-specific claims and release-run API errors: zero.

## Action items

1. [ ] Richa reviews every proposed `voice_ready` fact and resolves the nine
       withheld claims, especially lash aftercare/longevity and all patch-test,
       pregnancy, medication, allergy, and healing guidance.
2. [ ] Confirm which tint and lash-lift product lines are currently used; keep
       manufacturer guidance labeled general until confirmed.
3. [ ] Decide whether the 18 unmapped Phorest services need their own content or
       should intentionally return “not documented.”
4. [ ] Add an off-call website-diff job that reports changed pages without
       publishing them.
5. [ ] Expand the golden set to at least 30 questions with misspellings,
       follow-ups, corrections, multi-topic requests, and safe failure cases.
6. [ ] Run the full repeated Realtime evaluation and staged-number calls.
7. [ ] Fix or explicitly quarantine the existing date/environment-sensitive
       test failures before treating the entire suite as a release gate.
8. [ ] Deploy only after hours with no active calls, then listen to staged calls
       before enabling the tool for customers; retain the previous commit for
       immediate rollback.

## Consequences

- Service answers become consistent and updateable without making Erica sound
  scripted.
- Runtime latency stays dominated by the Realtime model, not retrieval.
- New or changed facts require a small approval step.
- Website contradictions become visible editorial work instead of silent call
  errors.
- Phorest remains the only authority for operational booking facts.

## Sources

- Salon sitemaps:
  `https://www.richasthreading.com/sitemap.xml`,
  `https://www.richasthreading.com/pages-sitemap.xml`, and
  `https://www.richasthreading.com/booking-services-sitemap.xml`
- Salon service pages:
  `https://www.richasthreading.com/brow-lamination-parkville-md`,
  `https://www.richasthreading.com/lash-lamination-and-tint-carney-md`, and
  `https://www.richasthreading.com/eyebrow-microblading-parkville-md`
- Professional/manufacturer checks:
  `https://browcodepro.com/pages/faqs`,
  `https://elleebana.com/category/elleebana/lash-lift/`, and
  `https://elleebana.com/lash-lift-aftercare-the-elleebana-way/`
- Permanent-makeup risk boundary:
  `https://www.fda.gov/cosmetics/cosmetic-products/tattoos-permanent-makeup-fact-sheet`
- OpenAI Realtime prompting and tool guidance:
  `https://developers.openai.com/api/docs/guides/realtime-models-prompting`,
  `https://developers.openai.com/api/docs/guides/realtime-conversations`, and
  `https://developers.openai.com/api/docs/guides/voice-agents`
- Voice-agent platform cross-checks:
  `https://docs.vapi.ai/prompting-guide`,
  `https://docs.retellai.com/build/knowledge-base`, and
  `https://docs.bland.ai/tutorials/pathways`
