import type { Service } from '../services/phorest.types.js';

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
  if (!matches.length) return { lead: prompt.trim(), sections: [] };

  const first = matches[0]!;
  const sections: PromptSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index! + match[0].length;
    const end = matches[i + 1]?.index ?? prompt.length;
    sections.push({
      name: match[1]!.trim(),
      body: prompt.slice(start, end).trim(),
    });
  }
  return { lead: prompt.slice(0, first.index).trim(), sections };
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
  if (identity) facts.salonName = identity[1]!;

  const context = section(sections, 'CONTEXT');
  const location = context.match(
    /^LOCATION:\s*(.+?)(?:\. For directions|\n|$)/m
  );
  const hours = context.match(/^HOURS:\s*(.+)$/m);
  if (location) facts.address = location[1]!.trim();
  if (hours) facts.weeklyHours = hours[1]!.trim();

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
    if (when) facts.dateTime = when[1]!.trim();
    if (zone) facts.timezone = zone[1]!.trim();
    if (today) facts.today = today[1]!.trim();
    if (tomorrow) facts.tomorrow = tomorrow[1]!.trim();
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
    if (tomorrowHours) facts.tomorrowHours = tomorrowHours[1]!.trim();
    facts.currentStatus = clean;
  }

  const richaLine = current.match(
    /RICHA'S LINE \(do NOT re-derive it\): Richa is (.*?)(?:\. Connecting rings|\n|$)/i
  );
  if (richaLine) {
    facts.richaStatus = richaLine[1]!
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

function rewriteResponseShape(body: string): string {
  return body
    .split('\n')
    .filter(
      (line) => !/LET THE CALLER LEAD:|LET THE CALLER FINISH:/i.test(line)
    )
    .join('\n')
    .trim();
}

function rewriteReasoning(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/UNCLEAR AUDIO:/i.test(line))
    .join('\n')
    .trim();
}

function rewriteConversation(body: string): string {
  const identifyStart = body.indexOf('\nIDENTIFY ');
  const serveStart = body.indexOf('\nSERVE —');
  if (identifyStart < 0 || serveStart < 0 || serveStart <= identifyStart)
    return body;
  const prefix = body
    .slice(0, identifyStart)
    .split('\n')
    .filter((line) => !/^GREETING\b/i.test(line.trim()))
    .join('\n')
    .trim();
  const transferFailback = body.match(
    /GREETING \(transfer failback[^\n]*caller is back after Richa did not pick up/i
  );
  const continuation = transferFailback
    ? '\n\nCALL CONTEXT: This is a continuation after Richa did not answer. Do not restart the call or repeat the greeting.'
    : '';
  const serve = `SERVE — keep the caller's complete request in mind and act only on what they asked for.
- CARRY OVER what the caller already said. A service, day, time, or name given earlier in the call still stands, including one mentioned while asking about hours or about Richa. Never ask again for a detail they have already given; asking the service first does not discard the day.
- Select services only from the catalog below. Use the canonical serviceId for service tools. Treat listed aliases as caller wording for that exact catalog entry; never invent a service or turn a person's name into a service. If the phrase could mean different services, ask one short question.
- For multiple requested services the caller wants in ONE sitting, use the visit tools (book_visit, reschedule_visit, cancel_visit) — they plan every service together and are the evidence that the combination fits. For services the caller wants at genuinely separate times, handle each with the ordinary availability and appointment tools, one action at a time, and do not promise that a combination fits until each part is checked.
- BOOK: first resolve the requested service, date, and public availability; offer returned times and let the caller choose. Take the date from what the caller already said when they have named one; only when no day has been mentioned at all, check today and tomorrow and offer a couple of times from each instead of asking which day. Do not ask for phone or name before offering availability. After the caller selects a time, identify the account and collect only missing contact details immediately before preparing one exact proposal — or, for two or more services in one sitting, before confirming book_visit. Read its returned service, date, time, and person back, ask for explicit approval, and wait. Caller intent, a selected slot, or an identity/contact answer is not approval.
- RESCHEDULE: first confirm the caller's identity, then list appointments. Name every service in the soonest sitting — never just the first — and confirm exactly which appointment or appointments they mean; for two or more they keep together use reschedule_visit. Establish the requested new date and public availability — reuse a new day they already named rather than asking again — let the caller choose a returned time, then prepare one proposal. Read back the exact old appointment and proposed new time; ask for explicit approval and wait.
- CANCEL: identify exactly which appointment or appointments they mean, read back each service, day, and time, ask for explicit approval, and wait. One appointment: prepare one cancellation proposal. Two or more they are dropping together: cancel_visit with a single yes covering all of them.
- After any correction, discard the old proposal and prepare a new one. Confirm only the proposal the caller approved. Claim success only when the confirmation result says it succeeded.
- RUNNING LATE: identify the caller, find today's appointments, and use the existing running-late tool with the caller's own short detail, including how late when stated. If today's visit has more than one service, pass the others as alsoAppointmentIds so the whole sitting is noted. Report only the tool result.
- If the caller changes their mind, abandon the old flow and follow the new request.

IDENTITY & CONTACT — account details require a verified caller identity; public service, price, hours, and availability information does not.
- A name alone is not identity. For a recognized caller, do not ask for a phone number. Before account-specific reads or writes, ask only whether they are the matched person if that is not confirmed; wait and preserve their request. If they mention a changed number, keep the matched account and do not update it unless they are calling for someone else.
- For an existing-account lookup, use supplied contact details instead of asking again. If the caller asks to use the calling number, call lookup_customer with no arguments; the application supplies that number privately. If that number has no match and the caller supplied first and last name, search by that name immediately. Otherwise ask only for the missing full name or a different number. A name-only match locates a candidate, not verified identity: confirm the account phone or appointment detail before revealing appointment records or changing anything. Never change the phone on file from caller ID.
- For an unrecognized new booking, wait until the caller has chosen a returned available time before collecting contact details. First ask whether the calling number is best for their file and wait. If yes, ask for any missing name parts next, one question at a time. If no, ask for their preferred phone number and wait; look up that number, then ask for any missing name parts if there is no match. Do not ask for phone and name together.
- Use a confirmed name sparingly and never make the caller repeat a request. Identity and contact answers never approve an appointment action.`;
  return `${prefix ? `${prefix}\n\n` : ''}${serve}${continuation}`;
}

function rewriteSafety(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      if (
        /ONLY "Is Richa available, free, or there\?".*Ask exactly:/i.test(line)
      ) {
        return "A question only about whether Richa is available is ambiguous while RICHA'S LINE says AVAILABLE. Ask one brief question to distinguish an appointment inquiry from a request to connect, then wait.";
      }
      return line
        .replace(
          /Persistent abuse → use end_call SILENT\/PROACTIVE so its result owns the polite closing, or transfer if safety requires it\./g,
          'For persistent abuse, end the interaction politely; transfer only when safety requires it.'
        )
        .replace(
          /call leave_message_for_owner silently/g,
          'use leave_message_for_owner'
        )
        .replace(
          /no acknowledgement, transition, or dispatch narration before its result/g,
          'do not claim delivery before its result'
        )
        .replace(
          /offer a message; during closure, enter only after need discovery under TEMPORARY CLOSURE POLICY/g,
          'offer a message; during a closure, first find out what the caller needs under TEMPORARY CLOSURE POLICY'
        )
        .replace(
          /After success, follow the result note and CLOSE\./g,
          'After success, finish naturally without another question when the caller is done.'
        )
        .replace(/exhausted recovery per TOOLS/g, 'exhausted safe recovery')
        .replace(
          /Give one short handoff, then call transfer_to_owner; longer speech is cut off\./g,
          'Use a brief handoff, then call transfer_to_owner.'
        )
        .replace(/then WAIT/g, 'then wait');
    })
    .join('\n');
}

function rewriteSpam(body: string): string {
  return body
    .replace(
      /Response: use end_call SILENT\/PROACTIVE with reason 'spam'\. Its result response owns the single polite decline and farewell\./,
      'For clear spam, Live gives one polite decline and farewell; then follow the silent end_call spam-close instructions below without further speech.'
    )
    .replace(
      /Persistent abuse.*$/m,
      'Persistent abuse should end politely; do not engage or transfer spam calls.'
    );
}

function rewriteNonClient(body: string): string {
  return body
    .replace(
      /use NO tools beyond what the pointer needs, don't transfer, then use end_call SILENT\/PROACTIVE once they have their answer; its result owns the farewell\./,
      'use no tools beyond what the pointer needs, do not transfer, and finish once they have their answer.'
    )
    .replace(
      /then call leave_message_for_owner silently\./,
      'then use leave_message_for_owner after the caller finishes the message.'
    )
    .replace(
      /use end_call as the only output item\./,
      'finish politely after one friendly sentence.'
    )
    .replace(
      /EXCEPTION — an urgent problem with the salon premises itself \(([^)]+)\) is NOT off-topic: get it to Richa immediately — connect the caller if RICHA'S LINE says AVAILABLE, otherwise send the details as a message right away\./,
      "EXCEPTION — an urgent problem with the salon premises itself ($1) is on-topic: get it to Richa immediately by connecting if RICHA'S LINE says AVAILABLE, otherwise take a message right away."
    );
}

function rewriteClosure(body: string): string {
  const firstLine = body
    .split('\n')
    .find((line) => /^- (?:ACTIVE NOW|UPCOMING) salon-wide:/i.test(line));
  if (!firstLine) return body;
  const summary = productionFacts(
    `═══ CURRENT STATUS (precomputed server-side — trust it verbatim, never re-derive it) ═══\n${firstLine}`
  ).temporaryClosure;
  if (!summary) return firstLine.replace(/"/g, '');
  return `TEMPORARY CLOSURE POLICY\n- ${summary}\n- If a caller asks for Richa, say the public return date and ask what they need before considering a message. Handle supported salon tasks directly.\n- For salon hours, give the approved closure explanation. For affected bookings, offer to check dates after reopening and never promise an unchecked slot. Do not say another provider is away. Never call a closure date fully booked.`;
}

function backendSections(instructions: string): string {
  const { lead, sections } = parseSections(instructions);
  const out: string[] = [lead];
  for (const item of sections) {
    let body = item.body;
    switch (item.name) {
      case 'RESPONSE SHAPE & TURN-TAKING':
        body = rewriteResponseShape(body);
        break;
      case 'SERVICES & PRICES':
        continue;
      case 'REASONING & UNCLEAR AUDIO':
        body = rewriteReasoning(body);
        break;
      case 'PREAMBLES':
      case 'TOOLS':
        continue;
      case 'CONVERSATION FLOW':
        body = rewriteConversation(body).replace(
          /lookup silently/g,
          'perform the lookup without narrating it'
        );
        break;
      case 'SAFETY & ESCALATION':
        body = rewriteSafety(body).replace(
          'exhausted recovery per TOOLS',
          'exhausted safe recovery'
        );
        break;
      case 'SPAM & TELEMARKETING':
        body = rewriteSpam(body);
        break;
      case 'NON-CLIENT CALLS':
        body = rewriteNonClient(body);
        break;
      case 'OPERATING RULES':
        body = body.replace(
          'If asked to stay quiet, listen until addressed again; do not abandon the call.',
          'If asked to stay quiet, do not abandon the caller or change the salon scope.'
        );
        break;
      case 'CURRENT STATUS (precomputed server-side — trust it verbatim, never re-derive it)':
      case 'CURRENT STATUS':
        body = rewriteClosure(body);
        break;
      case 'TEMPORARY CLOSURE POLICY':
        body = rewriteClosure(body);
        break;
    }
    if (body.trim()) out.push(`═══ ${item.name} ═══\n${body.trim()}`);
  }
  return out.filter(Boolean).join('\n\n');
}

/**
 * Build concise tool-reasoning instructions from the released production prompt.
 * The input string is only read; it is never altered or imported from the
 * controller, keeping this module pure and free of controller import cycles.
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
- The owner transfer window only permits an attempted phone connection; it is not Richa's personal schedule or proof she can answer. For public questions about when she works at the salon, give the published salon hours, without promising her presence. A simulated transfer is not evidence of personal unavailability.
- You support Erica on the current caller request. Use available tools only when needed, follow their schemas and result notes, and return concise caller-ready language for non-closing responses. Never narrate tool names, hidden reasoning, or process steps.
- Answer simple hours, address, and current-status questions from supplied facts; do not call tools for a direct answer. For records or availability, use the existing read tools and trust their returned facts.
- Reuse every detail the caller has already given earlier in the call — service, day, time, or name — including a day they named while asking about hours or about Richa. Never ask for a detail twice. When an availability lookup needs a day the caller has named, use that day; only when no day has been mentioned at all, check today and tomorrow and offer a couple of times from each rather than asking which day.
- For any booking, reschedule, or cancellation, call prepare_appointment_action({action:'book'|'reschedule'|'cancel', arguments:{...existing handler fields}}) to create one exact proposal. It does not write an appointment. Read back the returned summary, including the person when relevant, and ask one clear question for approval. Wait for the caller's answer. A booking request, chosen slot, or identity/contact answer is not approval.
- Only after the caller clearly approves that exact read-back, call confirm_appointment_action({proposalId, confirmed:true}) using the returned proposalId. Never infer approval from the initial request. If the caller corrects any proposal detail, prepare a new proposal; confirm only the current one they approved. Never call a raw booking, reschedule, or cancellation write tool; the visit tools are the exception, below.
- TWO OR MORE services the caller treats as ONE sitting: use the visit tools, not prepare_appointment_action, and never one appointment at a time. book_visit to book them back-to-back, reschedule_visit to move them, cancel_visit to drop them. book_visit and reschedule_visit run in two phases: call WITHOUT startTime to get back-to-back options, read ONE option back naming every service and its exact time, wait for a single yes covering all of them, then call again with that startTime and confirmed:true. Their returned options ARE the evidence of combined feasibility, so never tell the caller you cannot check a combined opening. cancel_visit needs no planning phase — name every service, day and time, take one yes covering all of them, then call it with confirmed:true. Appointments hours apart on the same day are SEPARATE visits: ask which they mean instead of assuming, and only ever pass the ids the caller agreed to.
- A caller running late is late for the WHOLE sitting. Pass every other appointmentId in it as alsoAppointmentIds so the salon sees the note on all of them, not just the first.
- A multi-service request may otherwise require separate appointments. Keep the full request in mind, check each part with existing tools, and prepare at most one appointment action at a time. Do not promise combined feasibility without returned evidence.
- Keep contact collection sequential: for an unrecognized new booking, first ask whether the calling number is best; after that answer, collect missing name parts. For an existing account, use supplied contact details or the requested calling number first; if no match, use the supplied full name or ask only for the missing name parts. Never bundle phone and name. A confirmed name is contact data, not action approval.
- Use leave_message_for_owner only after the caller chooses to leave a message and finishes its content. Do not invent or summarize caller-authored message content.
- Call end_call({reason:'done'}) for a caller who is clearly done, or end_call({reason:'spam'}) for clear spam. Do not generate a pre-tool farewell. Follow the result note: if it explicitly requests the single farewell, relay that closing instruction once; otherwise ending:true means emit no speech or text. Never add a second farewell, decline, or question. Do not call end_call mid-task or for silence alone. A request you have completed and confirmed, followed by an acknowledgement that asks for nothing further, counts as clearly done; when it is genuinely unclear, ask once whether they need anything else instead of ending. When the caller's request is fully handled — the booking, change, cancellation, or message is done, or their question is answered and nothing is pending — take the lead: ask once whether they need anything else, then wait. Never ask this after an intermediate step, while any part of their request is still open, a second time in the same call, or once they have said goodbye, thanks-that-is-all, or anything else meaning they are finished — close instead. A farewell outranks the offer.
- Follow each tool result. Retry an operation at most once only when the result is a known safe failure. Never retry an uncertain write. Hide raw errors and claim only outcomes returned by tools.

═══ CANONICAL SERVICE CATALOG ═══
Use the catalog ID as serviceId whenever a service tool accepts it. Names and approved aliases are evidence for selecting that ID; do not invent IDs, prices, durations, services, or aliases. If a caller's phrase has more than one plausible catalog match, ask one short clarification. A person's name is not a service.
${catalog}${callerContext ? `\n\n═══ SERVER-BUILT CALLER CONTEXT ═══\n${callerContext}` : ''}`;
}
