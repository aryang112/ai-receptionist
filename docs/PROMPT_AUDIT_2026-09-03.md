# Erica prompt + architecture audit — 2026-09-03

Audited: the local prompt at `117ada0` (production behavior since 2026-09-03
7:36 PM ET) — core instructions, tool contracts, caller-context notes,
tool-result coaching, session config — against (1) the 35 production calls of
the last 7 days (12 transcripts read in full: 7 real external callers, 5 of
Aryan's test calls on the current and previous build), (2) the OpenAI Realtime
prompting guide, VAD guide, voice-agent guide, model pages and changelog as of
today, (3) the Vapi, Retell and ElevenLabs prompting guides, and (4) a live
probe of which session fields `gpt-realtime-2.1` accepts today.

Everything below is grounded in a transcript, a rendered prompt, a live API
probe, or a cited page. Where something could not be verified it says so.

---

## Bottom line

- **Architecture is correct and current.** Twilio Media Streams (µ-law
  passthrough) ⇄ OpenAI Realtime speech-to-speech ⇄ in-process tools is the
  architecture OpenAI itself recommends for "natural, low-latency
  conversations". `gpt-realtime-2.1` (July 6, 2026) is the newest full
  Realtime model; the September changelog adds nothing newer. Marin is the
  right voice. No model, transport, or voice change is warranted.
- **The prompt was doing its job on the hard gates but had drifted into
  repetition.** Ten rule families were stated in three to six places each,
  one quoted assistant line had crept back in yesterday's closure commit, and
  the failure threshold was stated three different ways. Real calls showed the
  cost: booking writes without the read-back confirmation (2 of 2 test
  bookings), intent menus recited on empty turns, and prompt jargon spoken
  aloud ("salon-wide closure", "live call", "confirm your identity").
- **One rule was unfulfillable by any prompt.** "Empty audio, noise, silence
  get no response" cannot be obeyed when every VAD-created response forces
  speech. The OpenAI-recommended fix is a no-op tool; it is now implemented
  (`wait_for_user`) and verified live.
- **Shipped locally, not deployed:** one-home-per-rule prompt rewrite, tool
  descriptions that own their contracts, `wait_for_user`, a permanent live
  probe script, tests. Deployment waits for the after-hours owner go-ahead per
  the standing release rule.

---

## 1. Architecture and model verdict

| Component | Current | Verdict | Evidence / action |
| --- | --- | --- | --- |
| Model | `gpt-realtime-2.1` | **Keep.** Newest full Realtime model (changelog: 2.1 on Jul 6 2026; nothing newer through Sep 3). Reasoning S2S, 128k context, improved interruption/noise handling. | OpenAI model page + changelog |
| Mini variant | not used | **Not now.** `gpt-realtime-2.1-mini` is ~3× cheaper ($10 vs $32 /1M audio in) but the published guidance is: full model when the hard moments are interruption, ambiguous speech, multi-step tools — which is exactly this receptionist. Revisit as a measured A/B once the prompt is stable. | model pages |
| Architecture | speech-to-speech, no STT/LLM/TTS chain | **Keep.** OpenAI's voice-agent guide: S2S for "barge-in, low first-audio latency, natural turn taking, and realtime tool use"; chained only when each stage must be visible/replaceable. | voice-agents guide |
| Transport | Twilio Media Streams → our WS relay → OpenAI WS | **Keep for now.** OpenAI's SIP connector (Twilio Elastic SIP Trunking → OpenAI) removes our media hop and would cut some tens of ms of latency, but the whole call-control layer (greeting handshake, barge-in truncation, timed `<Dial>` failback, recording, silence watchdog) is built on the media stream. Migration is a project, not a tweak; the latency gain is smaller than the levers below. | Twilio/OpenAI SIP docs |
| Voice | `marin` | **Keep.** Realtime-exclusive natural female voice, owner-chosen. | — |
| Turn detection | `server_vad` 0.6 / 700 ms / 300 ms, greeting handshake | **Keep as default; stage a semantic-VAD ear test.** Accepted live today (`semantic_vad`, `eagerness`). Two real calls this week show the failure mode it targets: the 12:10 PM caller cut mid-sentence and Erica repeating herself; a caller getting three Erica lines before speaking. | live field probe; calls 3eefa7, 3275fa |
| Reasoning effort | omitted (provider default; the echoed session shows `reasoning: undefined`) | **Add an env knob, default `low`, ear-test.** The guide's explicit starting point for production voice agents is `low`; accepted live today. Expect lower first-audio latency and fewer spoken deliberations. | prompting guide; live probe |
| Input transcription | `gpt-4o-mini-transcribe`, no language pin | **Ship `language: 'en'` + salon-vocabulary prompt.** Still visible today: 5 of 12 transcripts carry Korean/Chinese/Urdu/Slovak script for English speech. Zero effect on what callers hear; large effect on the transcript-driven guards and on QA. Accepted live 2026-09-01. | transcripts; validate-transcription-fields |
| Silence / noise | prompt rule only | **Fixed this pass: `wait_for_user` no-op tool.** See §5. | guide "wait_for_user" pattern |
| Context cost | 3.9k-token prompt, retention_ratio 0.8, 96–98 % cache hit | Fine. Cached audio input is $0.40/1M; the prompt's size is a salience problem, not a cost problem. | realtime-costs guide; 08-28 call |
| Agents SDK `RealtimeAgent` + Twilio extension | not used | **No.** It would replace a mature, tested custom layer with a generic one and lose the deterministic guards. | — |
| Post-call recap | `gpt-4.1-mini` structured output | Out of scope; works. | — |

**Levers that actually move latency and naturalness, in order:** reasoning
effort `low` → VAD silence 700 → ~550 ms (each 100 ms is direct latency; watch
the pause-pouncing lesson) → semantic VAD ear test → SIP (last, largest
effort).

---

## 2. What the last week's real calls showed

Builds: calls before 09-02 7:46 PM ran `6f696a4`; 09-02 evening ran `2d24cfe`;
09-03 daytime ran `eca23f1`; nothing external has yet hit `117ada0`.

| Call (ET) | Caller | What happened | Prompt/architecture reading |
| --- | --- | --- | --- |
| 09-03 17:12 | real, walk-in question | One sentence: closed through Sep 9, can check from Sep 10, which service? | Correct. Closure policy works. |
| 09-03 14:35 | real, job seeker | Website pointer, no resumes by phone, "anything else?" | Correct; NON-CLIENT wanted `end_call` after the pointer, CLOSE won. Harmless. |
| 09-03 13:52 | real, "Is Richa open?" | Closure + reopen date, then **"I can help with prices, services, or planning…"** | Intent menu recited (no rule against it outside UNCLEAR AUDIO). Fixed: RESPONSE SHAPE now bans menus. |
| 09-03 13:20 | real, Spectrum sales | One redirect, then decline + goodbye via `end_call('spam')` | Correct. |
| 09-03 13:14 | real, Bank of America rep | "Richa is unavailable **for a live call**…" then clean message capture | "live call" is prompt vocabulary leaking. Prompt wording now avoids it. |
| 09-03 12:10 | real, mis-heard opener | **"Who would you like to speak with?"**, "live transfer isn't available", caller cut mid-sentence, closure recited twice | Three defects: asked whom (rule existed but lost), implementation jargon, VAD pounce. First two are prose salience → rewrite; third is semantic-VAD territory. |
| 09-02 11:42 | real, Bank of America rep | Erica spoke **three times before the caller said a word** ("Hi there—what can I help you with?", then a five-item menu) | Structural: noise turns forced responses. Fixed with `wait_for_user`. |
| 09-03 08:57 | test, hours | "closed **for the salon-wide closure**"; "which are available tomorrow?" → message offer | Jargon leak; availability-with-date mis-routed to message. Both addressed (plain wording; date context → booking flow was already in `117ada0`, now less buried). |
| 09-03 08:45 | test, booking | Slots offered → "1 pm" → "Are you Tony?" | Correct beats. |
| 09-02 21:01 | test, book/resched/cancel | **Booked with no read-back**: caller said "1:45" → number → name → "let me place that booking" → booked. Reschedule and cancel both confirmed properly. | The BOOK flow's confirmation beat was mid-arrow-chain and the tool description let "picked a time" count as confirmation. Fixed in both places; verified live (§6). |
| 09-02 20:24 | test, booking | "12:45 looks good" → **booked 12:15**, no read-back; "I need a clear yes or no to confirm your identity" | Wrong slot booked (transcript-level evidence; needs the recording to be certain). A read-back would have caught it. "confirm your identity" is caller-context vocabulary. |
| 09-02 20:22 | test, booking | "I don't want any time" → "anything else… like prices, hours, or another service?" | Menu again. |

Positive signals worth keeping: no invented slots, no write without at least a
time choice, closure dates and reopen date always right, spam handled in two
turns, messages captured verbatim and acknowledged once.

---

## 3. Prompt audit

### 3a. Conflicts

| # | Conflict | Resolution |
| --- | --- | --- |
| K1 | Tool-failure threshold: TOOLS "MORE THAN 2 failures", OTHER TRANSFERS "MORE THAN 2", every tool-result note "retry once, if it fails again offer Richa" (= 2) | One rule everywhere: retry once at most; a second failure → offer Richa or a message. |
| K2 | "Empty audio … get no response" vs a session where every VAD turn creates a response | `wait_for_user` tool; the rule now names it. |
| K3 | IDENTIFY "never a name alone" vs the name-lookup path two lines later | "never from a name the caller merely states"; a name must resolve through `lookup_customer`. |
| K4 | CLOSE "ask if there's anything else… then ask again" vs NON-CLIENT "end_call once they have their answer" and the repeated-closer complaint | CLOSE asks once. |
| K5 | The closure block's quoted first reply ("…what do you need?") + "varied naturally" — one example plus a vary instruction is the exact anti-pattern the 09-01 audit warned about, and the project's thrice-bitten lesson | Description only: say she is away until the date and you can help meanwhile, ask what they need, WAIT. Test locks that no quoted line remains. |
| K6 | "sole whereabouts exception", "salon-wide", "UPCOMING applies only to that range" — model-facing meta-language that leaked into speech | Plain words; the UPCOMING-only clause renders only in the UPCOMING variant. |

### 3b. Duplication (same rule, N homes → 1)

| Rule | Was stated in | Now |
| --- | --- | --- |
| `end_call` silent/tool-only contract | TOOLS, CLOSE, SPAM, NON-CLIENT ×2, OTHER TRANSFERS, tool description | tool description (owner) + one compact CLOSE sentence |
| `leave_message_for_owner` silent, no content | PREAMBLES, TOOLS, MESSAGE MODE, NON-CLIENT, tool description | tool description + PREAMBLES (test-pinned) + one MESSAGE MODE clause |
| Never narrate tools/mechanics | RESPONSE SHAPE, PREAMBLES, CONNECTING, MESSAGE MODE, OPERATING RULES | RESPONSE SHAPE + PREAMBLES |
| Confirm before write | TOOLS, three flows, three tool descriptions | flows + tool descriptions; TOOLS keeps one line that adds the missing fact ("picking a time is not confirmation") |
| "Don't re-derive" hours/status | header + four status lines | header only |
| suggest_availability day/time rules | TOOLS prose | tool description (decision moment) — including the 09-01 P1 item "both dates in one turn" |
| Public info needs no identity | IDENTIFY + both caller contexts | unchanged (contexts are separate injections) |
| Richa-away first reply | closure policy, ASKED FOR RICHA, SELF-SERVICE FIRST, MESSAGE MODE, RICHA'S LINE, transfer note | the five copies now say the same thing in fewer words; the policy block owns the wording |

### 3c. Additions (each is a guide recommendation with a transcript behind it)

- Variety: "do not repeat the same sentence or closer twice in a call" (guide;
  every call ended on the same closer).
- No menus: "do not list possible tasks or offer a menu" (four calls).
- Unclear audio: "do not repeat the same clarification twice" (guide; 09-01 C13).
- "never invent … reasons for a result" (09-01 C9, three words).
- BOOK: explicit "WAIT for their pick → … read back → WAIT for an explicit yes".

### 3d. Size and constraint density

| Measure | Before (`117ada0`) | After |
| --- | --- | --- |
| Estimated tokens (chars/4, fallback prompt, closure active) | 4,198 | 3,910 |
| Words | 3,252 | 3,104 |
| never/NEVER | 41 | 37 |
| only/ONLY | 36 | 31 |
| Quoted assistant lines | greeting, clarifier, closure reply | greeting, clarifier |

The trim is modest by count because the content that remains is load-bearing
(privacy, flows, closure policy). The point of the pass was one home per rule
and salience, not raw size; ElevenLabs' "<2000 tokens" is a text-pipeline
figure and this prompt carries a legal greeting, a privacy block, four flows,
and a config-driven closure policy.

---

## 4. Alignment with OpenAI and the platforms

| Recommendation | Source | Erica now |
| --- | --- | --- |
| Labeled sections; bullets over paragraphs; minimal prompt then add for failures | OpenAI | Yes. The three remaining paragraphs (SERVE, MESSAGE MODE, NON-CLIENT) are flows. |
| Remove overlapping always/never/only/must | OpenAI, Vapi ("never-say lists prime the banned tokens") | Reduced; the remaining ones guard privacy and writes. |
| One question at a time; collect one entity per turn | OpenAI, Vapi, Retell | Yes, with explicit WAIT beats. |
| Write tools: summarize → confirm → call; completion only on success | OpenAI, Retell ("paraphrase back") | Yes, and now enforced by the tool description too. |
| Preambles: at most one, describe the action, vary, no filler | OpenAI | Yes ("in varied words"). |
| Unclear audio: one clarification, never twice, no tool | OpenAI | Yes. |
| `wait_for_user` no-op for silence/noise | OpenAI | Yes (new). |
| `reasoning.effort: low` to start | OpenAI | **Open** (env knob + ear test). |
| Sample phrases with "vary these" | OpenAI, Vapi (few-shot ×3) | Deliberately no — three production incidents of parroted examples. Descriptions instead. |
| Disfluencies ("um", 2–4 per turn) | Vapi | Deliberately no — owner wants natural, not theatrical; S2S prosody already carries it. |
| Spoken-form numbers/dates | Vapi, Retell, ElevenLabs | Not needed: S2S speaks, there is no TTS normalization step. Phone-number digit read-back is kept. |
| Guardrails in a dedicated section; repeat the top 1–2 rules | ElevenLabs | PRIVACY + PRIORITY; the write gate is the one rule intentionally stated twice. |
| Tools: when / params / errors beside each tool | ElevenLabs, Retell | Yes — descriptions plus tool-result notes. |
| Conversation-flow states with exit criteria | OpenAI (Realtime 1.5 shape) | Flows are arrow chains with WAIT beats; a state table remains the option if flow drift recurs. |

---

## 5. What changed in this pass (local, tested, NOT deployed)

1. **Prompt rewrite** in `buildInstructions()` (`src/realtime/twilioStream.ts`):
   section order unchanged (test-locked), every rule family kept (test-locked),
   duplicates removed, K1–K6 resolved, §3c additions.
2. **Tool descriptions own their contracts**: `suggest_availability` carries
   the day/time rules; `book_appointment` and `reschedule_appointment` require
   a read-back + explicit yes and say that picking a time is not confirmation.
3. **`wait_for_user`** — new argument-free tool, zod mirror, silent result
   path in `OpenAIRealtimeSession` (`registerTool(name, handler, {silent})`
   delivers the `function_call_output` and never sends `response.create`),
   `handleWaitForUser` logs `🤫` and records a tool row. The silence watchdog
   is unchanged: it counts from the caller's last speech, so a wrong pick costs
   one 20 s check-in, never a stuck call.
4. **`scripts/probe-prompt-live.ts`** — permanent read-only live probe: the
   exact local prompt and tools on the production model/session shape, text
   in, audio transcript out, business tools intercepted. Run it before any
   prompt deploy.
5. Tests: 46 files / 532 (was 528). Six pins updated for the deliberate
   wording changes; four new tests (silent tool path ×2, `wait_for_user`
   definition/prompt/schema mirror ×2).

Not changed: model, voice, VAD, noise reduction, transcription, `business.json`,
Phorest writes, any `session.update` field.

---

## 6. Live probe results (new prompt, `gpt-realtime-2.1`, tools intercepted)

| Scenario | Result |
| --- | --- |
| New caller books brow threading Sep 11 ~1 PM | Slots → pick → number → name → **read-back "Brow Threading on September 11 at 1:15 PM—does that look right?" → yes → book** → one confirmation → `end_call` result owns the farewell. The beat that both production test bookings skipped now happens. |
| "Is Richa there?" during closure | Away until Thursday, September 10, can help meanwhile, what do you need. No message offer first. |
| "Can I talk to someone?" → personal → message | Same opener, no "who?", silent `leave_message_for_owner`, one acknowledgement, no mechanics. |
| Hours this week, then "say that again?" | Closed through Sep 9 because Richa is away, reopen Sep 10; the repeat is shorter, not verbatim. No "salon-wide". |
| "Hello?" / "Um." / TV chatter / real request | "Hello?" and "Um." still get a short prompt (text turns read as addressed speech); **the non-addressed turn gets `wait_for_user` and no speech**; the real request is then handled normally. |
| "Check Richa's availability for tomorrow" | Run 1: straight to the booking flow. Run 2: closure answer plus the availability-vs-speak question. Both correct on facts; the clarifier is a residual on a genuinely ambiguous line. |

Residuals seen: the model still emits a short commentary-phase line before the
read-back question ("Let me just confirm the details…") and another before the
write. That is Realtime 2.1 phase behavior, not a prompt conflict; the 09-01
item "log `phase` per output item" is the way to measure it before adding a
code guard. These are text-in probes: pacing, interruption, and pause handling
still need the ear test the release gate requires.

---

## 7. Recommended next, ranked

1. **Deploy this pass** in an owner-confirmed after-hours window (rollback:
   `117ada0`, deployment `981138c1…`). Then ear-test A, B, C, E on the real
   number before the salon reopens Sep 10.
2. **`OPENAI_REASONING_EFFORT` env knob**, default `low`, session field
   `reasoning.effort` (accepted live today). Compare `⏱` first-audio latency
   and listen for fewer spoken deliberations. One commit, one staged call.
3. **Transcription `language: 'en'` + vocabulary prompt** (09-01 P0, still
   open; accepted live). Unblocks trustworthy transcript-based QA.
4. **Log `phase`** (`commentary` | `final_answer`) per output item; decide on a
   commentary-phase guard only from counts.
5. **Semantic-VAD staged ear test** (`eagerness: 'auto'` first; keep the
   greeting handshake). Targets the 12:10 PM cut-off and the pause-pounce.
6. **Caller-context vocabulary**: "identity" → "whether it's them" wording so
   "confirm your identity" stops being spoken; C5 (unrecognized caller told
   the calling number was already checked) from 09-01 is still open.
7. Later, measured: `gpt-realtime-2.1-mini` A/B on cost; SIP connector only
   if latency percentiles justify rebuilding call control.

---

## 8. Release gate

- All 532 tests green locally and under `TZ=UTC`; `tsc` clean; Prettier;
  `git diff --check`; prompt estimate 3,910 < 4,200; live probes above.
- No deploy during business hours; owner go-ahead; zero active calls; the
  exact commit deployed from a clean `git archive` (untracked `AGENTS.md` and
  `outputs/` are still in the working tree).
- Sources: OpenAI [Realtime prompting guide](https://developers.openai.com/api/docs/guides/realtime-models-prompting),
  [VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad),
  [voice agents guide](https://developers.openai.com/api/docs/guides/voice-agents),
  [gpt-realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1),
  [gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini),
  [changelog](https://developers.openai.com/api/docs/changelog),
  [realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs);
  [Vapi prompting guide](https://docs.vapi.ai/prompting-guide);
  [Retell prompt engineering guide](https://docs.retellai.com/build/prompt-engineering-guide);
  [ElevenLabs prompting guide](https://elevenlabs.io/docs/agents-platform/best-practices/prompting-guide);
  [Twilio + OpenAI SIP](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking).
