import type { Service } from '../services/phorest.types.js';
import {
  BACKEND_TOOL_USE,
  CANONICAL_SERVICE_CATALOG_HEADER,
  LANGUAGE,
  NON_CLIENT_CALLS,
  OPERATING_RULES,
  PERSONALITY_AND_TONE,
  PRIORITY,
  PRIVACY,
  REASONING_AND_UNCLEAR_AUDIO,
  REFERENCE_PRONUNCIATIONS,
  RESPONSE_SHAPE_AND_TURN_TAKING,
  SAFETY_AND_ESCALATION,
  SERVE_AND_IDENTITY,
  SPAM_AND_TELEMARKETING,
  TEMPORARY_CLOSURE_POLICY_RULES,
  TRANSFER_FAILBACK_CALL_CONTEXT,
} from './backendRules.js';

/** Public facts that are safe to put in the speech model's prompt. */
export type LivePublicFacts = {
  salonName?: string;
  address?: string;
  dateTime?: string;
  timezone?: string;
  today?: string;
  tomorrow?: string;
  weeklyHours?: string;
  currentStatus?: string;
  tomorrowHours?: string;
  richaStatus?: string;
  temporaryClosure?: string;
};

export type LivePromptContext = {
  /** Only public salon facts belong here; account/caller details stay backend-side. */
  publicFacts?: Partial<LivePublicFacts>;
  greetingContext?: 'new_call' | 'transfer_failback' | 'continuation';
};

export type BackendPromptContext = {
  /** Approved aliases attached to canonical IDs by the caller. */
  serviceAliases?: ReadonlyArray<{
    serviceId: string;
    aliases: readonly string[];
  }>;
  /** Optional server-built recognition note. Never include this in Live context. */
  callerContext?: string;
};

type PromptSection = { name: string; body: string };
type ServiceWithAliases = Service & { aliases?: readonly string[] };

function parseSections(prompt: string): {
  lead: string;
  sections: PromptSection[];
} {
  const re = /^═══ (.+?) ═══\s*$/gm;
  const matches = [...prompt.matchAll(re)];
  const [first] = matches;
  if (!first) return { lead: prompt.trim(), sections: [] };

  const sections: PromptSection[] = [];
  for (const [i, match] of matches.entries()) {
    const name = match[1];
    const matchIndex = match.index;
    if (name === undefined || matchIndex === undefined) {
      // matchAll always sets `.index`, and this regex's capture group is
      // mandatory (not `?` or in an alternation) — unreachable in practice.
      throw new Error(
        'parseSections: matchAll result missing index or capture group'
      );
    }
    const start = matchIndex + match[0].length;
    const end = matches[i + 1]?.index ?? prompt.length;
    sections.push({
      name: name.trim(),
      body: prompt.slice(start, end).trim(),
    });
  }
  const firstIndex = first.index;
  if (firstIndex === undefined) {
    throw new Error('parseSections: matchAll result missing index');
  }
  return { lead: prompt.slice(0, firstIndex).trim(), sections };
}

function section(sections: PromptSection[], name: string): string {
  return sections.find((item) => item.name === name)?.body ?? '';
}

function productionFacts(instructions: string): LivePublicFacts {
  const { lead, sections } = parseSections(instructions);
  const facts: LivePublicFacts = {};
  const identity = lead.match(
    /^You are Erica, the AI receptionist for (.+?) in (.+?), (.+?)\./
  );
  const salonName = identity?.[1];
  if (salonName) facts.salonName = salonName;

  const context = section(sections, 'CONTEXT');
  const location = context.match(
    /^LOCATION:\s*(.+?)(?:\. For directions|\n|$)/m
  );
  const hours = context.match(/^HOURS:\s*(.+)$/m);
  const address = location?.[1];
  if (address) facts.address = address.trim();
  const weeklyHours = hours?.[1];
  if (weeklyHours) facts.weeklyHours = weeklyHours.trim();

  const current =
    section(
      sections,
      'CURRENT STATUS (precomputed server-side — trust it verbatim, never re-derive it)'
    ) ||
    sections.find((item) => item.name.startsWith('CURRENT STATUS'))?.body ||
    '';
  const dateLine = current.match(/^CURRENT DATE & TIME:\s*(.+)$/m)?.[1];
  if (dateLine) {
    const when = dateLine.match(/Right now it is (.+?) at the salon/);
    const zone = dateLine.match(/timezone ([^)]+)\)/);
    const today = dateLine.match(/use the date ([^;]+);/);
    const tomorrow = dateLine.match(/tomorrow is ([^.]+)\./);
    const dateTimeValue = when?.[1];
    if (dateTimeValue) facts.dateTime = dateTimeValue.trim();
    const timezoneValue = zone?.[1];
    if (timezoneValue) facts.timezone = timezoneValue.trim();
    const todayValue = today?.[1];
    if (todayValue) facts.today = todayValue.trim();
    const tomorrowValue = tomorrow?.[1];
    if (tomorrowValue) facts.tomorrow = tomorrowValue.trim();
  }

  const currentLines = current.split('\n');
  const statusLine = currentLines.find((line) =>
    /today is .* salon is .* At this moment we are /i.test(line)
  );
  if (statusLine) {
    const clean = statusLine
      .replace(/^\s*/, '')
      .replace(/^TODAY'S STATUS \([^)]*\):\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const tomorrowHours = clean.match(/Tomorrow \([^)]+\): (.+)\.$/);
    const tomorrowHoursValue = tomorrowHours?.[1];
    if (tomorrowHoursValue) facts.tomorrowHours = tomorrowHoursValue.trim();
    facts.currentStatus = clean;
  }

  const richaLine = current.match(
    /RICHA'S LINE \(do NOT re-derive it\): Richa is (.*?)(?:\. Connecting rings|\n|$)/i
  );
  const richaStatusRaw = richaLine?.[1];
  if (richaStatusRaw) {
    facts.richaStatus = richaStatusRaw
      .replace(/; follow TEMPORARY CLOSURE POLICY$/i, '')
      .trim();
  }

  const closureLine = currentLines.find((line) =>
    /^- (?:ACTIVE NOW|UPCOMING) salon-wide:/i.test(line)
  );
  if (closureLine) {
    const closure = closureLine.match(
      /^- (ACTIVE NOW|UPCOMING) salon-wide:\s*([^;]+);\s*reopens\s*([^.]+)\.\s*Public reason[^:]*:\s*"?([^."]+)\.?"?/i
    );
    if (closure) {
      const phase =
        closure[1] === 'ACTIVE NOW'
          ? 'The salon is temporarily closed'
          : 'A temporary salon closure is upcoming';
      facts.temporaryClosure = `${phase} from ${closure[2]}, reopening ${closure[3]}. The approved public explanation is ${closure[4]}. Do not guess another reason.`;
    }
  }
  return facts;
}

function cleanValue(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

/**
 * Raw Phorest names carry menu ordinals ("3) Chin Threading "). Strip them
 * before any model reads them; `livePriceLines` and `serviceCatalog` share
 * this single copy.
 */
function stripServiceCode(name: string): string {
  return name.replace(/^\s*\d+[a-z]?\)\s*/i, '').trim();
}

/** Whole dollars render bare ($15), fractional with exactly two places ($61.50). */
function fmtLivePrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

/**
 * Fix 2 (2026-09-17): the TALKING model's own price list, so a plain
 * "how much is brow threading" is answered instantly instead of costing a
 * backend round trip the caller hears as dead air. Production call
 * CA2e23da275cdde534bc4f3d6b93f65426 spent three consecutive round trips on
 * three one-service price questions, each papered over with narration.
 *
 * Name and price ONLY, and deliberately neither of the two existing
 * formatters:
 *  - `serviceCatalog()` below is backend-shaped — service IDs and aliases. An
 *    ID must never reach the model that speaks aloud.
 *  - `buildPriceLines()` (twilioStream.ts:507) is the right SHAPE but emits
 *    durations, which are backend-only for this model, and importing it would
 *    pull the controller into this module — the exact import cycle this file's
 *    doc comments exist to prevent (twilioStream.ts already imports this
 *    file). Its two one-line helpers are reproduced above instead; the
 *    ordinal strip was ALREADY duplicated inside `serviceCatalog()`, so
 *    sharing `stripServiceCode` nets one FEWER copy in this file, not one more.
 *
 * $0 rows are dropped. The live catalog carries admin entries — "Account
 * Deposit", "Complimentary", and the two "Consultation - Required Before
 * Booking" rows — and "Account Deposit is free" is a wrong answer, not a cheap
 * one. A dropped row is simply not on the list, so the prompt rule routes it
 * to `get_prices` like any other unlisted service. (`get_prices`' own filter
 * is `price > 0 || durationMin > 0`, which keeps $0 rows; that is fine for a
 * tool result the backend reads, not for a list the voice quotes from.)
 */
function livePriceLines(services: readonly Service[]): string {
  return services
    .filter((service) => service.price > 0)
    .map((service) => ({
      name: stripServiceCode(service.name),
      price: service.price,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((service) => `- ${service.name} ${fmtLivePrice(service.price)}`)
    .join('\n');
}

/**
 * W5 (2026-09-17): a listed service's price becomes instant-quotable the
 * moment the talking model decides "exactly one line ... is clearly that
 * service" — a judgement call resting entirely on its own prose reading of
 * SERVICE PRICES. The real catalog is full of collisions where one caller
 * word maps to two-plus lines at DIFFERENT prices ("chin" -> Chin Threading
 * $15 vs Chin Waxing $11), which a confident wrong quote is worse than the
 * round trip Fix 2 removed. This turns that ambiguity into DATA, computed
 * from the same catalog every render, instead of leaving it to judgement.
 *
 * Method (deliberately structural, not a hand-written word list — a list
 * rots the moment Richa edits her menu):
 *  1. Strip generic service-METHOD words (threading/waxing/tinting/bundle
 *     and their bare forms) and stopwords from each display name.
 *  2. Skip any name that visibly names MULTIPLE components joined by
 *     "and"/"+"/"&" ("Brow Thread + Lip Thread") — that is already a bundle,
 *     already routed to delegation by the existing price-policy rule, and a
 *     bare caller word was never going to single it out as a clear match, so
 *     it should not poison the key it happens to contain (e.g. "lip") for
 *     the plain services that DO answer to that bare word alone.
 *  3. Every remaining word (>= 3 chars, crudely singularized) and every
 *     adjacent word-pair — both space-joined ("side face") and concatenated
 *     ("microblading", to bridge the catalog's own "Micro Blading" vs
 *     "Microblading" spacing inconsistency) — becomes a candidate key.
 *  4. A key is ambiguous when 2+ services share it at DIFFERENT prices.
 *     Equal-price collisions (Lip Threading / Lip Waxing, both $8) are left
 *     alone: the answer is the same either way, so there is nothing to ask.
 */
const PRICE_LIST_TYPE_WORDS = new Set([
  'threading',
  'thread',
  'waxing',
  'wax',
  'tinting',
  'tint',
  'bundle',
]);

const PRICE_LIST_STOPWORDS = new Set([
  'of',
  'the',
  'and',
  'to',
  'for',
  'with',
  'any',
  'on',
  'add',
  'ons',
  'from',
  'or',
]);

/** A visible multi-component join names a bundle, not a single concept. */
function isComboServiceName(name: string): boolean {
  return /[+&]/.test(name) || /\band\b/i.test(name);
}

/** Crude plural strip so "Underarms"/"Underarm" and "Eyebrows"/"Eyebrow" key the same. */
function singularize(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
    ? word.slice(0, -1)
    : word;
}

/** The bare-word/bare-pair keys one service's display name contributes. */
function bareServiceKeys(displayName: string): Set<string> {
  if (isComboServiceName(displayName)) return new Set();

  const words = displayName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .filter((word) => !/^\d+$/.test(word))
    .filter((word) => !PRICE_LIST_TYPE_WORDS.has(word))
    .filter((word) => !PRICE_LIST_STOPWORDS.has(word))
    .map(singularize);

  const keys = new Set<string>();
  for (const word of words) {
    if (word.length >= 3) keys.add(word);
  }
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    keys.add(`${a} ${b}`);
    keys.add(`${a}${b}`);
  }
  return keys;
}

/**
 * Pure and exported for unit testing in isolation (see `isFarewellText` in
 * twilioStream.ts for the same pattern). Returns the sorted list of bare
 * words/phrases that name two or more differently-priced listed services —
 * i.e. the terms a caller could say that do NOT resolve to a single clear
 * line, computed fresh from whatever catalog is passed in.
 */
export function ambiguousPriceKeys(services: readonly Service[]): string[] {
  const priceByKey = new Map<string, Set<number>>();
  for (const service of services) {
    if (service.price <= 0) continue;
    const displayName = stripServiceCode(service.name);
    for (const key of bareServiceKeys(displayName)) {
      const prices = priceByKey.get(key) ?? new Set<number>();
      prices.add(service.price);
      priceByKey.set(key, prices);
    }
  }
  const ambiguous: string[] = [];
  for (const [key, prices] of priceByKey) {
    if (prices.size > 1) ambiguous.push(key);
  }
  return ambiguous.sort();
}

/**
 * Build the small speech-facing prompt. It has no controller/config imports
 * and only receives public facts plus the service NAME + PRICE list; service
 * IDs, durations, aliases and every account fact stay backend-side.
 */
export function buildLivePrompt(
  productionInstructions: string,
  services: readonly Service[],
  context: LivePromptContext = {}
): string {
  const facts = {
    ...productionFacts(productionInstructions),
    ...context.publicFacts,
  };
  const name = cleanValue(facts.salonName) ?? 'the salon';
  const factLines = [
    facts.address && `Address: ${cleanValue(facts.address)}`,
    (facts.today || facts.dateTime) &&
      `Salon date and time: ${[facts.today, facts.dateTime, facts.timezone && `(${facts.timezone})`].filter(Boolean).join(' ')}`,
    facts.weeklyHours && `Weekly hours: ${cleanValue(facts.weeklyHours)}`,
    facts.currentStatus &&
      `Today and right now: ${cleanValue(facts.currentStatus)}`,
    facts.tomorrow && `Tomorrow's date: ${cleanValue(facts.tomorrow)}`,
    facts.tomorrowHours &&
      `Tomorrow's hours: ${cleanValue(facts.tomorrowHours)}`,
    facts.temporaryClosure &&
      `Public closure facts: ${cleanValue(facts.temporaryClosure)}`,
  ].filter(Boolean);

  const greeting = context.greetingContext ?? 'new_call';
  const greetingRule =
    greeting === 'new_call'
      ? 'For a new call, greet promptly and warmly, identify Erica and the salon, clearly disclose that the line is recorded, and ask how you can help. Say this naturally; do not recite a sample line.'
      : greeting === 'transfer_failback'
        ? 'This is a continuation after Richa did not answer. Apologize briefly, offer to help or take a message, and do not repeat the greeting or recording disclosure. Her phone already rang out on this call, so never offer or promise to connect them again; a request to reach her can only become a message. This segment has no greeting and no recording notice to give — both were already given before her phone rang — so an instruction to greet the caller or to disclose the recording is satisfied by that apologetic opening and nothing else.'
        : 'This is an ongoing call. Do not greet again or restart the conversation.';

  // Fix 2: the price rule and the price list are rendered ONLY when a priced
  // catalog actually arrived. On the cold-cache/fetch-failure path (the 250ms
  // race cap in twilioStream.ts) the prompt keeps today's tool-first
  // behaviour verbatim — no list, and nothing that invites a guess.
  const priceLines = livePriceLines(services);
  const delegatedPricing = priceLines
    ? 'service selection, bundled and multi-service pricing'
    : 'service selection and prices';
  const ambiguousKeys = priceLines ? ambiguousPriceKeys(services) : [];
  const pricePolicy = priceLines
    ? `\nPrice policy: One listed service's price is yours to answer. When the caller names a service and exactly one line in SERVICE PRICES is clearly that service, give that price straight away, with no preamble and no delegation. Delegate the price to the backend instead — exactly as you would have before this list existed — whenever what they named is not on the list, more than one line could be what they mean, they asked for a total or for two or more services, they asked about a bundle, package or deal, or you are not certain which line matches. Never add prices together yourself, never answer with the nearest-sounding line, and never invent, round, or adjust a price. The list is prices only: it says nothing about what is bookable, how long anything takes, or who performs it. Say a service name the way a person would, ignoring stray punctuation, slashes, and capitalisation in how it is written. Never recite this list in full; a broad "what do you offer" question still gets a few relevant names or a delegation.`
    : '';
  const priceSection = priceLines ? `\n\nSERVICE PRICES\n${priceLines}` : '';
  const ambiguousSection = ambiguousKeys.length
    ? `\n\nAMBIGUOUS PRICE TERMS\nEach word or phrase below alone names two or more lines above at different prices, so on its own it is not a single clear match: ask one short question naming the real alternatives, or delegate — never pick a line for the caller.\n${ambiguousKeys.join(', ')}`
    : '';

  return `You are Erica, the warm, concise English-speaking receptionist for ${name}. Speak naturally and calmly in Marin's feminine voice.

${greetingRule}
Backchannel policy: Use sparse listening acknowledgments only when they help; avoid habitual fillers, repeated names, praise, or echoing the request.
Interruption policy: Yield to a clearly addressed interruption, retain its details and corrections, and keep listening through short pauses. Do not treat coughs, music, or nearby conversation as a request.
Delegation policy: The backend handles account records, ${delegatedPricing}, availability, booking changes, running-late notes, owner messages, requests to reach Richa, and call closing. Delegate before any answer that depends on those tools or account facts. Delegate the done-close before replying whenever the caller signals they are finished — “that is all”, “goodbye”, asking to hang up, or a bare acknowledgement after something you completed; the backend decides if a farewell is needed. For clear spam, delegate the spam-close. Never leave the phone connection open after merely saying goodbye. If the backend returns ending:true, emit no further speech unless its note explicitly requests the single farewell. Do not delegate a greeting, a needed brief clarification, or a public fact supplied below.${pricePolicy}
Account lookup: Delegate requests to find a profile or use caller ID before asking for contact details. The application can use the calling number; never claim you cannot see it. Pass along any supplied name. A lookup miss is not proof of a new client.
Richa schedule: Treat public questions about when Richa works or is available as questions about the salon's public hours. Answer only from the public facts below; do not invent or confirm a personal schedule or personal availability. For a bare question like “Is Richa available?”, ask whether the caller means availability for an appointment or wants to speak with her. If the caller has already given a clear service and date, continue the appointment flow without asking this clarification.
Reaching Richa: when the caller has asked to speak with her and you are handing that over, use your one short line to prepare them for a brief wait and for possibly hearing her phone ring, so that ringing is expected rather than unexplained — without promising that she is there, that she will pick up, or that they will be connected. That is the only thing you may say about what is about to happen on the line; the rule against narrating your process covers every other case.

Carry-over: keep every detail the caller has already given anywhere in this call — service, day, time, or name — and never ask for it again. A day they named while asking about hours or about Richa is still the day they want.
Ask one question at a time, then stop for the caller. Keep replies to one or two short sentences. Offer at most three appointment times per reply, then wait. Do not narrate your reasoning, tools, checking, waiting, or other process. Do not start a booking, ask for details, or propose a specific task unless the caller asks for it.

Answer straightforward hours, date, open/closed, and address questions directly from the public facts below; do not delegate those questions or calculate today's status again. Never guess a backend result. Do not expose caller or account details before identity is confirmed.

PUBLIC SALON FACTS
${factLines.length ? factLines.map((line) => `- ${line}`).join('\n') : '- No current public facts were supplied. Do not guess hours, dates, address, closures, or availability.'}${priceSection}${ambiguousSection}`;
}

function serviceCatalog(
  services: readonly Service[],
  aliases: BackendPromptContext['serviceAliases']
): string {
  const byId = new Map(
    (aliases ?? []).map((entry) => [entry.serviceId, entry.aliases])
  );
  const lines = services.map((raw) => {
    const service = raw as ServiceWithAliases;
    const displayName = stripServiceCode(service.name);
    const aliasList = service.aliases ?? byId.get(service.id) ?? [];
    const aliasText = aliasList.length
      ? `; aliases: ${aliasList.join(', ')}`
      : '';
    return `- ${service.id} | ${displayName} | $${service.price} | ${service.durationMin} min${aliasText}`;
  });
  return lines.length
    ? lines.join('\n')
    : '- Catalog unavailable; do not invent a service, service ID, price, duration, or alias.';
}

/**
 * Compute the authored TEMPORARY CLOSURE POLICY section from the production
 * prompt's CURRENT STATUS facts. Only the summary line (dates + public
 * reason) is COMPUTED, extracted via `productionFacts`; the two rule lines
 * that follow it are AUTHORED (`TEMPORARY_CLOSURE_POLICY_RULES` in
 * backendRules.ts). Returns '' when the section body carries no active or
 * upcoming closure (nothing to render).
 */
function rewriteClosure(body: string): string {
  const firstLine = body
    .split('\n')
    .find((line) => /^- (?:ACTIVE NOW|UPCOMING) salon-wide:/i.test(line));
  if (!firstLine) return '';
  const summary = productionFacts(
    `═══ CURRENT STATUS (precomputed server-side — trust it verbatim, never re-derive it) ═══\n${firstLine}`
  ).temporaryClosure;
  if (!summary) return firstLine.replace(/"/g, '');
  return `TEMPORARY CLOSURE POLICY\n- ${summary}\n${TEMPORARY_CLOSURE_POLICY_RULES}`;
}

/**
 * Assemble the backend prompt's sections in production order. Every section
 * below is either:
 *   - AUTHORED: a plain-text constant from backendRules.ts (see the block
 *     comment at the top of that file for the full computed/authored list), or
 *   - COMPUTED: extracted from `productionInstructions` because it is a
 *     server-computed FACT (address, hours, current date/status, closure
 *     dates), not a rule — duplicating that computation would be the actual
 *     "two sources of truth" bug, not a reason to keep it out of this file.
 */
function backendSections(instructions: string): string {
  const { lead, sections } = parseSections(instructions);
  const context = section(sections, 'CONTEXT');
  const currentStatusBody =
    section(
      sections,
      'CURRENT STATUS (precomputed server-side — trust it verbatim, never re-derive it)'
    ) ||
    sections.find((item) => item.name.startsWith('CURRENT STATUS'))?.body ||
    '';
  const closureBody = section(sections, 'TEMPORARY CLOSURE POLICY');
  const conversationFlowBody = section(sections, 'CONVERSATION FLOW');
  // Whether this is a transfer-failback continuation is COMPUTED (read off
  // the production GREETING line); the CALL CONTEXT text itself is AUTHORED.
  const transferFailback =
    /GREETING \(transfer failback[^\n]*caller is back after Richa did not pick up/i.test(
      conversationFlowBody
    );

  const out: string[] = [lead];
  const push = (name: string, body: string) => {
    if (body.trim()) out.push(`═══ ${name} ═══\n${body.trim()}`);
  };

  push('PRIORITY', PRIORITY);
  push('PERSONALITY & TONE', PERSONALITY_AND_TONE);
  push('LANGUAGE', LANGUAGE);
  push('RESPONSE SHAPE & TURN-TAKING', RESPONSE_SHAPE_AND_TURN_TAKING);
  push('REFERENCE PRONUNCIATIONS', REFERENCE_PRONUNCIATIONS);
  push('CONTEXT', context); // COMPUTED
  push('REASONING & UNCLEAR AUDIO', REASONING_AND_UNCLEAR_AUDIO);
  push('OPERATING RULES', OPERATING_RULES);
  push('PRIVACY — NEVER GIVE OUT DETAILS', PRIVACY);
  push(
    'CONVERSATION FLOW',
    `${SERVE_AND_IDENTITY}${transferFailback ? `\n\n${TRANSFER_FAILBACK_CALL_CONTEXT}` : ''}`
  );
  push('SAFETY & ESCALATION', SAFETY_AND_ESCALATION);
  push('SPAM & TELEMARKETING', SPAM_AND_TELEMARKETING);
  push('NON-CLIENT CALLS', NON_CLIENT_CALLS);
  // COMPUTED — the ACTIVE NOW/UPCOMING closure line, when present, always
  // lands in its own trailing TEMPORARY CLOSURE POLICY section (the nested
  // ═══ header inside buildInstructions' template splits it there), never
  // inside CURRENT STATUS's own body — so no closure rewrite applies here.
  push(
    'CURRENT STATUS (precomputed server-side — trust it verbatim, never re-derive it)',
    currentStatusBody
  );
  if (closureBody)
    push('TEMPORARY CLOSURE POLICY', rewriteClosure(closureBody));

  return out.filter(Boolean).join('\n\n');
}

/**
 * Build the backend model's rule + fact prompt. STATIC rule sections come
 * from src/voice/backendRules.ts (authored, reviewable prose); COMPUTED
 * facts (address, hours, current status, closure dates) are still read from
 * the released production prompt via `backendSections` above. The input
 * string is only read; it is never altered or imported from the controller,
 * keeping this module pure and free of controller import cycles.
 */
export function buildBackendPrompt(
  productionInstructions: string,
  services: readonly Service[],
  context: BackendPromptContext = {}
): string {
  const filtered = backendSections(productionInstructions);
  const catalog = serviceCatalog(services, context.serviceAliases);
  const callerContext = cleanValue(context.callerContext);
  return `${filtered}

═══ BACKEND TOOL USE ═══
${BACKEND_TOOL_USE}

═══ CANONICAL SERVICE CATALOG ═══
${CANONICAL_SERVICE_CATALOG_HEADER}
${catalog}${callerContext ? `\n\n═══ SERVER-BUILT CALLER CONTEXT ═══\n${callerContext}` : ''}`;
}
