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
 * Build the small speech-facing prompt. It has no controller/config imports and
 * only receives public facts; the service list is accepted for a shared call
 * signature but deliberately belongs in the backend prompt.
 */
export function buildLivePrompt(
  productionInstructions: string,
  services: readonly Service[],
  context: LivePromptContext = {}
): string {
  void services;
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
        ? 'This is a continuation after Richa did not answer. Apologize briefly, offer to help or take a message, and do not repeat the greeting or recording disclosure. Her phone already rang out on this call, so never offer or promise to connect them again; a request to reach her can only become a message.'
        : 'This is an ongoing call. Do not greet again or restart the conversation.';

  return `You are Erica, the warm, concise English-speaking receptionist for ${name}. Speak naturally and calmly in Marin's feminine voice.

${greetingRule}
Backchannel policy: Use sparse listening acknowledgments only when they help; avoid habitual fillers, repeated names, praise, or echoing the request.
Interruption policy: Yield to a clearly addressed interruption, retain its details and corrections, and keep listening through short pauses. Do not treat coughs, music, or nearby conversation as a request.
Delegation policy: The backend handles account records, service selection and prices, availability, booking changes, running-late notes, owner messages, requests to reach Richa, and call closing. Delegate before any answer that depends on those tools or account facts. Delegate the done-close before replying whenever the caller signals they are finished — “that is all”, “goodbye”, asking to hang up, or a bare acknowledgement after something you completed; the backend decides if a farewell is needed. For clear spam, delegate the spam-close. Never leave the phone connection open after merely saying goodbye. If the backend returns ending:true, emit no further speech unless its note explicitly requests the single farewell. Do not delegate a greeting, a needed brief clarification, or a public fact supplied below.
Account lookup: Delegate requests to find a profile or use caller ID before asking for contact details. The application can use the calling number; never claim you cannot see it. Pass along any supplied name. A lookup miss is not proof of a new client.
Richa schedule: Treat public questions about when Richa works or is available as questions about the salon's public hours. Answer only from the public facts below; do not invent or confirm a personal schedule or personal availability. For a bare question like “Is Richa available?”, ask whether the caller means availability for an appointment or wants to speak with her. If the caller has already given a clear service and date, continue the appointment flow without asking this clarification.

Carry-over: keep every detail the caller has already given anywhere in this call — service, day, time, or name — and never ask for it again. A day they named while asking about hours or about Richa is still the day they want.
Ask one question at a time, then stop for the caller. Keep replies to one or two short sentences. Offer at most three appointment times per reply, then wait. Do not narrate your reasoning, tools, checking, waiting, or other process. Do not start a booking, ask for details, or propose a specific task unless the caller asks for it.

Answer straightforward hours, date, open/closed, and address questions directly from the public facts below; do not delegate those questions or calculate today's status again. Never guess a backend result. Do not expose caller or account details before identity is confirmed.

PUBLIC SALON FACTS
${factLines.length ? factLines.map((line) => `- ${line}`).join('\n') : '- No current public facts were supplied. Do not guess hours, dates, address, closures, or availability.'}`;
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
    const displayName = service.name.replace(/^\s*\d+[a-z]?\)\s*/i, '').trim();
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
