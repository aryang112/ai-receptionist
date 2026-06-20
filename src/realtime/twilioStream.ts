import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { OpenAIRealtimeSession, type ToolDefinition } from './openaiSession.js';
import { logger } from '../core/logger.js';
import { env } from '../config/env.js';
import {
  suggestSlots,
  bookAppointment,
  findServiceByName,
} from '../services/booking.js';
import { phorest } from '../services/phorest.js';
import type {
  CustomerResult,
  AppointmentSummary,
} from '../services/phorest.types.js';
import { getHoursStatus, getOpenClose } from '../core/hours.js';
import { DateTime } from 'luxon';
// decodeMuLaw no longer needed here — audio decoding happens in openaiSession
import businessHours from '../config/business.json';

// Lazy-initialised so tests don't fail without creds
let _twilioClient: ReturnType<typeof twilio> | null = null;
function getTwilioClient() {
  if (!_twilioClient && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    _twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
}

const CORE_SERVICES = env.PHOREST_PREFERRED_SERVICE_IDS.length
  ? env.PHOREST_PREFERRED_SERVICE_IDS.join(', ')
  : 'Brow Threading, Eyebrow Tinting';

function buildInstructions(): string {
  // Inject the authoritative current salon date/time so "today"/"tomorrow" and
  // any relative dates are computed correctly — never left to the model's own
  // (UTC-ish, undocumented) clock, which would book the wrong day near midnight.
  const now = DateTime.now().setZone(env.TIMEZONE);
  const todayISO = now.toISODate();
  const tomorrowISO = now.plus({ days: 1 }).toISODate();
  return `You are Erica, the warm and friendly AI receptionist for Richa's Threading Salon in Parkville, Maryland. You answer calls, book appointments, reschedule, cancel, and help with any questions about the salon.

CURRENT DATE & TIME: Right now it is ${now.toFormat("cccc, MMMM d, yyyy 'at' h:mm a")} at the salon (timezone ${env.TIMEZONE}). When a caller says "today" use the date ${todayISO}; "tomorrow" is ${tomorrowISO}. ALWAYS compute appointment dates from this — never guess today's date, month, or year. Pass every date to tools as YYYY-MM-DD.

PERSONALITY: Conversational, warm, efficient. Speak like a real person — not a robot. Keep responses to 1–2 short sentences. Use natural phrasing like "Of course!", "No problem!", "Let me check that for you."

VOICE & DELIVERY: Sound like a real, warm front-desk receptionist — relaxed, natural pacing (never rushed or robotic), genuine warmth, and natural intonation that rises and falls like real speech. Use light human touches where they fit: a soft "mm-hm", a small friendly laugh, a reassuring "no worries at all". React naturally — if a caller sounds unsure, slow down and reassure; if they're in a hurry, be brisk and efficient. Vary your rhythm like a person would. Never sound like you're reading a script.

GREETING: Open the call yourself, immediately and warmly: "Hi, this is Erica from Richa's Threading Salon — how can I help you today?" Then wait for the caller.

NEVER LEAVE SILENCE: Before you call ANY tool (looking something up, booking, checking availability, etc.), FIRST say a short, natural filler out loud — like "Let me check that for you…", "One sec…", or "Let me pull that up…" — and THEN call the tool. The caller must never hear dead air while you work.

BUSINESS HOURS: Always use the get_business_hours tool when asked about hours. Never guess.

═══ SERVICES & PRICES ═══
Callers often ask for prices. When they ask the price of a service, say a quick filler ("Let me check that for you…") and call get_prices WITH the serviceName they asked about — it returns that service's exact price and duration. Only omit serviceName if they ask broadly "what services do you offer." Quote ONLY what get_prices returns; NEVER guess or make up a price. Read service names naturally (ignore any leading numbers/codes like "3)").

Some callers use different names for the same service — treat these as the same:
- "lash lamination" = our "Lash Lift"
- "brow lamination" / "eyebrow lamination" = "Brow Lamination"
- "eyebrows" / "brows" (threading) = "Brow Threading"
For ANY service a caller names, just try to book it (suggest_availability matches it against the live catalog). NEVER tell a caller "we don't offer that," and never transfer just because a service wasn't in a memorised list.

═══ CUSTOMER IDENTIFICATION (always do this first) ═══
1. Ask: "What's your phone number?"
2. Call lookup_customer with the phone number
3. If found: greet them by name — "Got it, hi [First Name]!" Then:
   - If they have NOT yet said why they're calling → "How can I help you today?"
   - If they ALREADY told you why they called (book / reschedule / cancel / running late) → do NOT ask "how can I help" again. Acknowledge and go straight into it, e.g. "Let me pull up your appointments." You already know what they want — don't make them repeat it.
4. If not found by phone: "I don't have that number on file — what's your first and last name?"
5. Call lookup_customer with firstName and lastName
6. If 1 match: "Found you!" — then continue with their already-stated request (don't re-ask if you know it).
7. If multiple matches: "I found a few people with that name — when is your appointment?"
   → Match on the appointment date/time they give you
8. If no match at all: "No worries, I'll get you set up! What's your first and last name?"
   → Proceed to booking and the system will create their profile

═══ BOOKING ═══
1. Identify customer (see above)
2. "What service were you thinking?"
3. Proactively offer times for BOTH today and tomorrow — don't make the caller guess a day:
   - Call suggest_availability for today, and again for tomorrow (two calls).
   - Offer a couple of options from each: "I have [time] or [time] today, and [time] or [time] tomorrow — what works best?"
   - If the caller names a desired time (e.g. "4 PM", "evening", "morning"), ALWAYS pass it to suggest_availability as preferredTime (24h HH:MM, e.g. "16:00" for 4 PM, "18:00" for evening) so the returned slots are centered on what they asked for — then offer the closest ones.
4. Confirm: "Perfect — so [service] on [day] at [time] for [First Name]. Shall I go ahead and book that?"
5. Call book_appointment ONLY after they say yes.
6. "You're all set! See you [day] at [time]. Anything else I can help with?"

Booking MORE THAN ONE service is completely normal and expected. If, after "Anything else?", the caller wants another service, just run the booking flow again for it (another suggest_availability + book_appointment). Keep going for as many services as they want. NEVER transfer to Richa just because they're booking a second or third service.

Same-day bookings: No minimum notice. If there's availability, book it.

READING suggest_availability RESULTS (important):
- 'slots' is a list of objects with a 'time' and a 'value'. SAY the time (e.g. "1:10 PM"). When you then call book_appointment or reschedule_appointment, pass that slot's value (24-hour, e.g. "13:10") as the time. Only ever offer times that appear in slots — these are already filtered to business hours, so never offer a time that isn't in the list.
- If the caller wants a time that isn't in slots (e.g. they ask for 6 PM but it's not listed), say it's not open and offer the nearest available times instead — do not invent it.
- If salonOpenThatDay is false → we don't open that day at all. Say "We're closed [that day]" and offer the next opening (nextOpen). NEVER say "fully booked" for a day we're closed.
- If closedRightNow is true → we're already closed for today. Say "We're actually closed right now — our hours today are [hoursThatDay], and we open again [nextOpen]." Do NOT say "fully booked."
- If salonOpenThatDay is true and slots is empty → THEN we're genuinely fully booked that day; say so and offer another day (nextOpen).

═══ RESCHEDULING ═══
1. Identify customer (phone first, name fallback)
2. Call list_appointments to get their upcoming appointments.
   - If it returns appointments → continue below.
   - If it returns an error → say "one sec, let me try that again" and retry list_appointments once before doing anything else.
   - If it returns NO appointments → "Hmm, I'm not seeing any upcoming appointments under your account — would you like me to book a new one?" Do NOT transfer for this.
   - The list is already sorted soonest-first. Lead with just the SOONEST one — don't read out a long list.
3. "I see your next appointment is [service] on [day] at [time] — is that the one you'd like to move?" (If they say that's not it and there are others, mention the next one.)
4. "What day and time works better for you?"
5. Call suggest_availability for that day. Offer the nearest available times to what they asked for: "I have [time] or [time] — does either work?" (only times from slots).
6. Call reschedule_appointment once they pick — pass the chosen slot's value (24-hour) as the time.
7. "Done! You're all set for [new day] at [new time]."

═══ CANCELLATION ═══
1. Identify customer.
2. Call list_appointments.
   - Error → "one sec, let me try that again" and retry once.
   - NO appointments → "I'm not seeing any upcoming appointments under your account to cancel — is it possibly under a different name or number?" Do NOT invent an appointment, and do NOT transfer for this.
3. The list is sorted soonest-first. Lead with the SOONEST one only: "I see your next appointment is [service] on [day] at [time] — would you like to cancel that one?" If they say no and there are others, mention the next. NEVER guess or make up an appointment, service, day, or time that wasn't in the list_appointments result, and don't read out a long list.
4. Get an explicit yes: "Just to confirm — cancelling [service] on [day] at [time]?"
5. Only after they confirm, call cancel_appointment with that appointment's id.
6. ONLY say it's cancelled if cancel_appointment came back successfully (no error). If it returns an error → "Hmm, that didn't go through — let me try once more" and retry; if it still fails, offer Richa. Never tell a caller it's cancelled unless the tool confirmed it.
7. On success: "Done! Your appointment's cancelled. Hope to see you again soon!"

═══ RUNNING LATE ═══
1. "No problem! What's your phone number?"
2. Call lookup_customer → then list_appointments (filter to today)
3. Identify which appointment they mean
4. Call log_running_late with clientId and appointmentId
5. If response has squeezed: false → "No worries at all — take your time, we'll see you soon!"
6. If response has squeezed: true → "Thanks for letting us know! We've made a note and we'll do our best to squeeze you in. See you soon!"

═══ TRANSFER TO RICHA ═══
Transferring is a LAST RESORT. You — Erica — handle booking, rescheduling, cancelling, multiple services, hours, and running-late yourself. Only call transfer_to_owner when:
- The caller explicitly asks to speak to Richa or a real person
- It's a group booking for several DIFFERENT PEOPLE at once, or a request genuinely outside booking / reschedule / cancel / hours / running-late
- The caller is clearly upset and wants a human
- A tool keeps failing even AFTER you retried it — and only then, after saying "I'm having a little trouble with our system — let me get Richa to help you."

Do NOT transfer just because: a service isn't in the memorised price list (try to book it — the catalog is bigger than that list); the caller wants a second or third service (book each one); or a tool errors a single time (say "one sec, let me try that again" and retry first). One hiccup is never a reason to transfer.

When you do transfer, say first: "Of course, let me get Richa for you — one moment!" then call transfer_to_owner.

═══ GENERAL RULES ═══
- LET THE CALLER LEAD. After greeting, wait for them to say what they need. Never assume why they're calling, and never pull up appointments, prices, or availability until they've actually asked. If you didn't clearly hear a request, ask "Sorry, what can I help you with today?" and WAIT — do not guess and proceed.
- Let the caller FINISH. Don't jump in during a short pause; only respond once they've clearly finished their thought.
- Never read appointment IDs aloud — use human-readable descriptions
- Never guess at hours — use get_business_hours
- Never guess prices — call get_prices
- Never invent appointments, services, times, or prices — only state what a tool actually returned
- When telling a caller about an appointment, read the 'service', 'date', and 'time' fields from list_appointments EXACTLY as given — never round, shift, guess, or approximate the time
- If you mishear something, just say "Sorry, could you say that again?"
- Always confirm name spelling if you're uncertain
- Respond in English only, regardless of what language the caller uses
`;
}

/** Live Phorest catalog as clean { service, price, durationMin } rows for the get_prices tool. */
async function getServiceCatalog() {
  const services = await phorest.listServices();
  return services
    .filter((s) => s.price > 0 || s.durationMin > 0) // skip $0/0min admin entries
    .map((s) => ({
      service: s.name.replace(/^\s*\d+[a-z]?\)\s*/i, '').trim(), // drop "3) " prefixes
      price: s.price,
      durationMin: s.durationMin,
    }));
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'suggest_availability',
    description:
      'Find available appointments for a given service on a specific date.',
    parameters: {
      type: 'object',
      properties: {
        serviceName: { type: 'string' },
        date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        preferredTime: {
          type: 'string',
          description:
            "If the caller mentioned a desired time (e.g. '4 PM', 'evening', 'morning'), pass it as 24h HH:MM (e.g. '16:00') so the returned slots are centered on it. Omit if they have no preference.",
        },
      },
      required: ['serviceName', 'date'],
    },
  },
  {
    type: 'function',
    name: 'book_appointment',
    description:
      'Book an appointment once all details are confirmed with the caller.',
    parameters: {
      type: 'object',
      properties: {
        serviceName: { type: 'string' },
        date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        time: { type: 'string', description: '24h time HH:MM' },
        customer: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['name', 'phone'],
        },
      },
      required: ['serviceName', 'date', 'time', 'customer'],
    },
  },
  {
    type: 'function',
    name: 'reschedule_appointment',
    description: 'Reschedule an existing appointment to a new date and time.',
    parameters: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string' },
        date: { type: 'string' },
        time: { type: 'string' },
      },
      required: ['appointmentId', 'date', 'time'],
    },
  },
  {
    type: 'function',
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment.',
    parameters: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string' },
      },
      required: ['appointmentId'],
    },
  },
  {
    type: 'function',
    name: 'get_business_hours',
    description:
      'Get the salon operating hours for each day of the week and any special closed dates. Use this when the caller asks about hours, what time you open/close, or when the salon is available.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_prices',
    description:
      'Get the price and duration of salon services. PREFERRED: pass the serviceName the caller asked about to get just that one (fast, accurate). Omit serviceName only when the caller asks broadly what services we offer, to get the full menu.',
    parameters: {
      type: 'object',
      properties: {
        serviceName: {
          type: 'string',
          description:
            'The service the caller asked the price of (e.g. "Brow Threading"). Optional.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'lookup_customer',
    description:
      'Look up a caller in the salon system. Always try phone first. If not found or no phone given, try by name. Use this before booking, rescheduling, cancelling, or logging running late.',
    parameters: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Caller phone number (try this first)',
        },
        firstName: {
          type: 'string',
          description: 'First name (fallback if no phone match)',
        },
        lastName: {
          type: 'string',
          description: 'Last name (fallback if no phone match)',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'list_appointments',
    description:
      "List a customer's upcoming appointments. Use before rescheduling, cancelling, or when caller says they're running late. Requires clientId from lookup_customer.",
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
      },
      required: ['clientId'],
    },
  },
  {
    type: 'function',
    name: 'log_running_late',
    description:
      'Call this when a caller says they are running late for their appointment. Logs a note on their appointment and checks if there is a tight back-to-back booking.',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        appointmentId: {
          type: 'string',
          description: 'The appointment they are running late for',
        },
      },
      required: ['clientId', 'appointmentId'],
    },
  },
  {
    type: 'function',
    name: 'transfer_to_owner',
    description:
      'Transfer the call to Richa (the salon owner). Use when: caller asks to speak to Richa or a person, request involves multiple services or group booking, you are unable to help after one clarifying attempt, caller sounds frustrated.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason for the transfer',
        },
      },
      required: ['reason'],
    },
  },
];

interface TwilioEventBase {
  event: string;
  streamSid?: string;
}

interface TwilioMediaEvent extends TwilioEventBase {
  event: 'media';
  media: { payload: string; timestamp?: string };
}

interface TwilioStartEvent extends TwilioEventBase {
  event: 'start';
  start: {
    streamSid: string;
    callSid: string;
    customParameters?: Record<string, string>;
  };
}

interface TwilioStopEvent extends TwilioEventBase {
  event: 'stop';
}

interface TwilioMarkEvent extends TwilioEventBase {
  event: 'mark';
  mark?: { name: string };
}

type TwilioEvent =
  | TwilioMediaEvent
  | TwilioStartEvent
  | TwilioStopEvent
  | TwilioMarkEvent
  | TwilioEventBase;

class TwilioRealtimeCall {
  private readonly socket: WebSocket;
  private readonly session: OpenAIRealtimeSession;
  private streamSid = '';
  private callSid = '';
  private closed = false;
  private hasReceivedFirstAudioChunk = false;
  private sessionReady = false;
  // Barge-in bookkeeping (mirrors OpenAI's Twilio sample): track the caller's
  // media clock and when the current Erica response began playing, so we can
  // truncate to exactly what was heard when the caller interrupts.
  private latestMediaTimestamp = 0;
  private responseStartTimestamp: number | null = null;
  private markQueue: string[] = [];
  // Caller looked up by their phone number (caller ID) at call start, so tools
  // answer instantly and Erica can greet them by name. null = not recognized.
  private prefetch: {
    clientId: string;
    firstName: string;
    lastName: string;
    appointments: AppointmentSummary[] | null;
  } | null = null;

  constructor(socket: WebSocket) {
    this.socket = socket;
    logger.info('New Twilio WebSocket connection');

    this.session = new OpenAIRealtimeSession({
      onAudioChunk: (chunk) => this.sendAudioToTwilio(chunk),
      onTextDelta: (delta) => this.handleAssistantText(delta),
      onSpeechStarted: () => this.handleBargeIn(),
      onResponseComplete: () => this.handleResponseComplete(),
      onError: (error) => this.handleError(error),
    });

    this.session.registerTool('suggest_availability', (args) =>
      this.handleSuggestAvailability(args)
    );
    this.session.registerTool('book_appointment', (args) =>
      this.handleBookAppointment(args)
    );
    this.session.registerTool('reschedule_appointment', (args) =>
      this.handleReschedule(args)
    );
    this.session.registerTool('cancel_appointment', (args) =>
      this.handleCancel(args)
    );
    this.session.registerTool('get_business_hours', (args) =>
      this.handleGetBusinessHours(args)
    );
    this.session.registerTool('get_prices', (args) =>
      this.handleGetPrices(args)
    );
    this.session.registerTool('lookup_customer', (args) =>
      this.handleLookupCustomer(args)
    );
    this.session.registerTool('list_appointments', (args) =>
      this.handleListAppointments(args)
    );
    this.session.registerTool('log_running_late', (args) =>
      this.handleLogRunningLate(args)
    );
    this.session.registerTool('transfer_to_owner', (args) =>
      this.handleTransferToOwner(args)
    );
    logger.debug(
      'OpenAI tools registered: suggest_availability, book_appointment, reschedule_appointment, cancel_appointment, get_business_hours, lookup_customer, list_appointments, log_running_late, transfer_to_owner'
    );

    socket.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    socket.on('close', () => this.cleanup());
    socket.on('error', (err) =>
      this.handleError(
        err instanceof Error ? err : new Error('Twilio socket error')
      )
    );
  }

  /**
   * Look the caller up by their phone number (from caller ID). If found, cache
   * their record + warm their appointments in the background, and inject a note
   * so Erica greets them by name. Fully dynamic — nothing is hardcoded; the name
   * is whatever Phorest returns for that number. Any failure → no prefetch, and
   * Erica falls back to the normal "what's your phone number?" flow.
   */
  private async warmCallerContext(callerPhone?: string) {
    if (!callerPhone) return;
    try {
      // Don't let a cold lookup delay the greeting (normally instant — the phone
      // index is warmed at boot — but cap it just in case).
      const customer = await Promise.race<CustomerResult | null>([
        phorest.lookupCustomerByPhone(callerPhone).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 700)),
      ]);
      if (!customer) {
        logger.info(
          { tool: 'prefetch' },
          'Caller ID not recognized — normal flow'
        );
        return;
      }
      this.prefetch = {
        clientId: customer.clientId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        appointments: null,
      };
      logger.info(
        { tool: 'prefetch', clientId: customer.clientId },
        'Caller recognized by phone — warming context'
      );
      // Warm their upcoming appointments so reschedule/cancel is instant later.
      phorest
        .listAppointments(customer.clientId)
        .then((appts) => {
          if (this.prefetch) this.prefetch.appointments = appts;
        })
        .catch(() => {});
      // Tell Erica who's calling (the looked-up name, not a hardcoded one).
      const fullName = `${customer.firstName} ${customer.lastName}`.trim();
      this.session.injectContext(
        `The caller is phoning from a number we recognize. Their name is ${fullName}, an existing client — you already have their account on file. For your VERY FIRST line, introduce yourself AND greet them by first name, exactly like: "Hi, this is Erica from Richa's Threading Salon — hi ${customer.firstName}! How can I help you today?" Then STOP and WAIT for them to actually tell you what they need. Do NOT pull up their appointments, do NOT call any tools, and do NOT assume why they're calling until they clearly say so. Do NOT ask for their phone number — you already have their account; when you later need their details, call lookup_customer with no arguments.`
      );
    } catch {
      this.prefetch = null; // graceful: behave exactly as today (ask for phone)
    }
  }

  private async handleMessage(data: WebSocket.RawData) {
    try {
      const event = JSON.parse(data.toString()) as TwilioEvent;
      switch (event.event) {
        case 'start':
          this.streamSid = (event as TwilioStartEvent).start.streamSid;
          this.callSid = (event as TwilioStartEvent).start.callSid;
          logger.info(
            { streamSid: this.streamSid },
            '📞 ========== NEW CALL STARTED =========='
          );
          logger.info(
            { streamSid: this.streamSid },
            '📞 Twilio stream started'
          );
          await this.session.connect();
          // Prices come from the get_prices tool on demand (NOT baked into the
          // prompt) — keeps the per-turn token footprint small so long calls
          // don't exhaust the Realtime token-per-minute rate limit.
          await this.session.configureSession({
            instructions: buildInstructions(),
            tools: TOOL_DEFINITIONS,
          });
          this.sessionReady = true;
          // Look the caller up by THEIR phone number (caller ID) and, if we
          // recognize them, tell Erica so she greets by name + skips asking for
          // the number. If not recognized (or no caller ID), she greets normally.
          await this.warmCallerContext(
            (event as TwilioStartEvent).start.customParameters?.from
          );
          // Erica greets first, in her own voice (no separate Polly handoff).
          this.session.requestGreeting();
          // Preload client phone index in background so lookup_customer is instant
          phorest.preloadClients?.().catch(() => {});
          logger.info(
            { streamSid: this.streamSid },
            '🎙️ Waiting for caller audio...'
          );
          break;
        case 'media': {
          const media = (event as TwilioMediaEvent).media;
          if (media?.timestamp)
            this.latestMediaTimestamp =
              Number(media.timestamp) || this.latestMediaTimestamp;
          this.handleMedia(event as TwilioMediaEvent);
          break;
        }
        case 'mark':
          if (this.markQueue.length > 0) this.markQueue.shift();
          break;
        case 'stop':
          logger.info(
            { streamSid: this.streamSid },
            '☎️ ========== CALL ENDED =========='
          );
          this.cleanup();
          break;
        default:
          break;
      }
    } catch (error) {
      this.handleError(
        error instanceof Error
          ? error
          : new Error('Failed to parse Twilio message')
      );
    }
  }

  private handleMedia(event: TwilioMediaEvent) {
    if (!event.media?.payload || this.closed || !this.sessionReady) return;
    // g711 mu-law passthrough — forward Twilio's frame verbatim, no transcoding.
    // appendTwilioAudio is a safe no-op if the session has closed (never throws).
    this.session.appendTwilioAudio(event.media.payload);
  }

  private sendAudioToTwilio(base64Mulaw: string) {
    if (!this.streamSid || this.closed) return;

    // Mark the start of this response on the caller's media clock — barge-in
    // uses (latestMediaTimestamp - responseStartTimestamp) as the truncation point.
    if (this.responseStartTimestamp === null) {
      this.responseStartTimestamp = this.latestMediaTimestamp;
    }

    if (!this.hasReceivedFirstAudioChunk) {
      logger.info(
        { streamSid: this.streamSid },
        '🔊 AI speaking - first audio chunk sent to Twilio'
      );
      this.hasReceivedFirstAudioChunk = true;
    }

    try {
      this.socket.send(
        JSON.stringify({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: base64Mulaw },
        })
      );
      this.sendMark();
    } catch (error) {
      this.handleError(
        error instanceof Error
          ? error
          : new Error('Failed to send media to Twilio')
      );
    }
  }

  /** Mark each outbound chunk so we can tell when Erica is still mid-utterance. */
  private sendMark() {
    if (!this.streamSid || this.closed) return;
    this.socket.send(
      JSON.stringify({
        event: 'mark',
        streamSid: this.streamSid,
        mark: { name: 'responsePart' },
      })
    );
    this.markQueue.push('responsePart');
  }

  /**
   * Caller started talking while Erica was speaking: truncate her message to
   * what was actually heard and flush Twilio's outbound buffer so she stops now.
   */
  private handleBargeIn() {
    if (this.markQueue.length === 0 || this.responseStartTimestamp === null)
      return;
    const elapsed = Math.max(
      0,
      this.latestMediaTimestamp - this.responseStartTimestamp
    );
    this.session.truncateActiveResponse(elapsed);
    if (this.streamSid && !this.closed) {
      this.socket.send(
        JSON.stringify({ event: 'clear', streamSid: this.streamSid })
      );
    }
    this.markQueue = [];
    this.responseStartTimestamp = null;
  }

  private handleResponseComplete() {
    this.responseStartTimestamp = null;
    this.markQueue = [];
  }

  private handleAssistantText(_delta: string) {
    // Placeholder for future analytics or action parsing.
  }

  private async handleSuggestAvailability(args: unknown) {
    try {
      const payload = args as {
        serviceName: string;
        date: string;
        preferredTime?: string;
      };
      logger.info(
        { tool: 'suggest_availability', args: payload },
        'Tool called: suggest_availability'
      );
      const result = await suggestSlots(payload);
      // Hours context so Erica can tell "we're closed" apart from "fully booked".
      const hours = getHoursStatus(payload.date);

      // Keep only slots that START within open hours AND let the service FINISH
      // before closing — Phorest/staff schedules can run past the salon's stated
      // hours, and we must never offer a time that ends after close.
      const openClose = getOpenClose(payload.date);
      const durationMin = result.service.durationMin || 0;
      const inHours = result.slots
        .map((iso) => DateTime.fromISO(iso))
        .filter(
          (dt) =>
            dt.isValid &&
            (!openClose || dt >= openClose.open) &&
            (!openClose || dt.plus({ minutes: durationMin }) <= openClose.close)
        );

      // CRITICAL: don't just take the earliest N (that hid afternoon/evening
      // slots). If the caller asked for a time, return the slots CLOSEST to it;
      // otherwise return an even spread across the whole day so morning AND
      // evening are represented. Hand the model { time, value } only.
      const MAX = 10;
      const pref = payload.preferredTime
        ? DateTime.fromISO(`${payload.date}T${payload.preferredTime}`, {
            zone: env.TIMEZONE,
          })
        : null;
      let picked: DateTime[];
      if (pref && pref.isValid) {
        picked = [...inHours]
          .sort(
            (a, b) =>
              Math.abs(a.toMillis() - pref.toMillis()) -
              Math.abs(b.toMillis() - pref.toMillis())
          )
          .slice(0, MAX)
          .sort((a, b) => a.toMillis() - b.toMillis());
      } else if (inHours.length <= MAX) {
        picked = inHours;
      } else {
        const step = (inHours.length - 1) / (MAX - 1);
        picked = Array.from(
          { length: MAX },
          (_, i) => inHours[Math.round(i * step)]!
        );
      }
      const slots = picked.map((dt) => ({
        time: dt.toFormat('h:mm a'),
        value: dt.toFormat('HH:mm'),
      }));

      logger.info(
        {
          tool: 'suggest_availability',
          date: payload.date,
          rawCount: result.slots.length,
          offeredCount: slots.length,
          salonOpenThatDay: hours.salonOpenThatDay,
          closedRightNow: hours.closedRightNow,
          slots: slots.map((s) => s.time),
        },
        'Availability slots found'
      );
      return {
        service: result.service.name,
        date: result.date,
        slots, // [{ time: "1:10 PM", value: "13:10" }] — within business hours only
        salonOpenThatDay: hours.salonOpenThatDay,
        hoursThatDay: hours.hoursThatDay,
        closedRightNow: hours.closedRightNow,
        nextOpen: hours.nextOpen,
      };
    } catch (error) {
      logger.error(
        { tool: 'suggest_availability', error: this.formatError(error) },
        'Tool error: suggest_availability'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleBookAppointment(args: unknown) {
    try {
      const payload = args as {
        serviceName: string;
        date: string;
        time: string;
        customer: { name: string; phone: string; email?: string };
      };
      logger.info(
        { tool: 'book_appointment', args: payload },
        'Tool called: book_appointment'
      );
      const result = await bookAppointment(payload as any);
      logger.info(
        {
          tool: 'book_appointment',
          appointmentId: result.appointment.appointmentId,
        },
        'Appointment booked successfully'
      );
      if (this.prefetch) this.prefetch.appointments = null; // warmed list is now stale
      return {
        appointmentId: result.appointment.appointmentId,
        service: result.service.name,
        price: result.service.price,
        date: payload.date,
        time: payload.time,
      };
    } catch (error) {
      logger.error(
        { tool: 'book_appointment', error: this.formatError(error) },
        'Tool error: book_appointment'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleReschedule(args: unknown) {
    try {
      const payload = args as {
        appointmentId: string;
        date: string;
        time: string;
      };
      logger.info(
        { tool: 'reschedule_appointment', args: payload },
        'Tool called: reschedule_appointment'
      );
      const iso = `${payload.date}T${payload.time}`;
      await phorest.updateAppointment(payload.appointmentId, iso);
      logger.info(
        {
          tool: 'reschedule_appointment',
          appointmentId: payload.appointmentId,
        },
        'Appointment rescheduled successfully'
      );
      if (this.prefetch) this.prefetch.appointments = null; // warmed list is now stale
      return {
        appointmentId: payload.appointmentId,
        date: payload.date,
        time: payload.time,
      };
    } catch (error) {
      logger.error(
        { tool: 'reschedule_appointment', error: this.formatError(error) },
        'Tool error: reschedule_appointment'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleCancel(args: unknown) {
    try {
      const payload = args as { appointmentId: string };
      logger.info(
        { tool: 'cancel_appointment', args: payload },
        'Tool called: cancel_appointment'
      );
      await phorest.cancelAppointment(payload.appointmentId);
      logger.info(
        { tool: 'cancel_appointment', appointmentId: payload.appointmentId },
        'Appointment cancelled successfully'
      );
      if (this.prefetch) this.prefetch.appointments = null; // warmed list is now stale
      return { appointmentId: payload.appointmentId, cancelled: true };
    } catch (error) {
      logger.error(
        { tool: 'cancel_appointment', error: this.formatError(error) },
        'Tool error: cancel_appointment'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleGetBusinessHours(_args: unknown) {
    try {
      logger.info(
        { tool: 'get_business_hours' },
        'Tool called: get_business_hours'
      );

      const formattedHours = {
        monday: businessHours.hours.mon.join(', ') || 'Closed',
        tuesday: businessHours.hours.tue.join(', ') || 'Closed',
        wednesday: businessHours.hours.wed.join(', ') || 'Closed',
        thursday: businessHours.hours.thu.join(', ') || 'Closed',
        friday: businessHours.hours.fri.join(', ') || 'Closed',
        saturday: businessHours.hours.sat.join(', ') || 'Closed',
        sunday: businessHours.hours.sun.join(', ') || 'Closed',
        closedDates: businessHours.closedDates,
      };

      logger.info(
        { tool: 'get_business_hours', hours: formattedHours },
        'Business hours retrieved'
      );
      return formattedHours;
    } catch (error) {
      logger.error(
        { tool: 'get_business_hours', error: this.formatError(error) },
        'Tool error: get_business_hours'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleGetPrices(args: unknown) {
    try {
      const payload = (args ?? {}) as { serviceName?: string };
      // Targeted lookup = a few tokens back to the model (vs the whole 63-item
      // catalog). Only return the full menu when no specific service was named.
      if (payload.serviceName) {
        const svc = await findServiceByName(payload.serviceName);
        if (svc) {
          logger.info(
            { tool: 'get_prices', match: svc.name },
            'Price lookup (single)'
          );
          return {
            service: svc.name,
            price: svc.price,
            durationMin: svc.durationMin,
          };
        }
        logger.info(
          { tool: 'get_prices', serviceName: payload.serviceName },
          'No single match — returning full menu'
        );
      }
      const services = await getServiceCatalog();
      logger.info(
        { tool: 'get_prices', count: services.length },
        'Full price menu returned'
      );
      return { services };
    } catch (error) {
      logger.error(
        { tool: 'get_prices', error: this.formatError(error) },
        'Tool error: get_prices'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleLookupCustomer(args: unknown) {
    try {
      const payload = args as {
        phone?: string;
        firstName?: string;
        lastName?: string;
      };
      logger.info({ tool: 'lookup_customer' }, 'Tool called: lookup_customer');

      // If we already recognized the caller from their caller ID and the model
      // didn't supply a different phone/name, answer instantly from the prefetch.
      if (this.prefetch && !payload.phone && !payload.firstName) {
        logger.info(
          { tool: 'lookup_customer', clientId: this.prefetch.clientId },
          'Customer served from caller-ID prefetch'
        );
        return {
          found: true,
          clientId: this.prefetch.clientId,
          name: `${this.prefetch.firstName} ${this.prefetch.lastName}`.trim(),
          matchedBy: 'caller-id',
        };
      }

      if (payload.phone) {
        const result = await phorest.lookupCustomerByPhone(payload.phone);
        if (result) {
          logger.info(
            { tool: 'lookup_customer', clientId: result.clientId },
            'Customer found by phone'
          );
          return {
            found: true,
            clientId: result.clientId,
            name: `${result.firstName} ${result.lastName}`.trim(),
            matchedBy: 'phone',
          };
        }
      }

      if (payload.firstName && payload.lastName) {
        const results = await phorest.lookupCustomerByName(
          payload.firstName,
          payload.lastName
        );
        if (results.length === 1) {
          logger.info(
            { tool: 'lookup_customer', clientId: results[0]!.clientId },
            'Customer found by name'
          );
          return {
            found: true,
            clientId: results[0]!.clientId,
            name: `${results[0]!.firstName} ${results[0]!.lastName}`.trim(),
            matchedBy: 'name',
          };
        }
        if (results.length > 1) {
          return {
            found: true,
            multiple: true,
            count: results.length,
            message:
              'Multiple matches — ask for appointment date/time to disambiguate',
          };
        }
      }

      logger.info({ tool: 'lookup_customer' }, 'Customer not found');
      return { found: false };
    } catch (error) {
      logger.error(
        { tool: 'lookup_customer', error: this.formatError(error) },
        'Tool error: lookup_customer'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleListAppointments(args: unknown) {
    try {
      const payload = args as { clientId: string };
      logger.info(
        { tool: 'list_appointments', clientId: payload.clientId },
        'Tool called: list_appointments'
      );
      // Serve from the caller-ID prefetch if it's the same client and already
      // warmed (zero Phorest round-trip on the critical path).
      const appointments =
        this.prefetch &&
        this.prefetch.appointments &&
        this.prefetch.clientId === payload.clientId
          ? this.prefetch.appointments
          : await phorest.listAppointments(payload.clientId);
      // Hand the model ONLY clean, unambiguous fields — never the raw HH:mm:ss
      // (which it could mis-read as the spoken time). It must quote `date`/`time`
      // verbatim.
      const clean = appointments.map((a) => ({
        appointmentId: a.appointmentId,
        service: a.serviceName,
        date: a.date,
        time: a.timeDisplay,
      }));
      logger.info(
        { tool: 'list_appointments', count: clean.length, appointments: clean },
        'Appointments retrieved'
      );
      return { appointments: clean };
    } catch (error) {
      logger.error(
        { tool: 'list_appointments', error: this.formatError(error) },
        'Tool error: list_appointments'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleLogRunningLate(args: unknown) {
    try {
      const payload = args as { clientId: string; appointmentId: string };
      logger.info(
        { tool: 'log_running_late', ...payload },
        'Tool called: log_running_late'
      );

      await phorest.addAppointmentNote(
        payload.appointmentId,
        'Customer called ahead — running late'
      );

      const todayAppts = await phorest.getTodayAppointments();
      const callerAppt = todayAppts.find(
        (a) => a.appointmentId === payload.appointmentId
      );

      let squeezed = false;
      if (callerAppt) {
        const [endH, endM] = callerAppt.endTimeRaw.split(':').map(Number);
        const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);

        squeezed = todayAppts.some((a) => {
          if (a.appointmentId === payload.appointmentId) return false;
          const [startH, startM] = a.startTimeRaw.split(':').map(Number);
          const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
          return startMinutes >= endMinutes && startMinutes - endMinutes <= 15;
        });
      }

      logger.info(
        { tool: 'log_running_late', squeezed },
        'Running late logged'
      );
      return { noted: true, squeezed };
    } catch (error) {
      logger.error(
        { tool: 'log_running_late', error: this.formatError(error) },
        'Tool error: log_running_late'
      );
      return { error: this.formatError(error) };
    }
  }

  private async handleTransferToOwner(args: unknown) {
    try {
      const payload = args as { reason: string };
      logger.info(
        {
          tool: 'transfer_to_owner',
          reason: payload.reason,
          callSid: this.callSid,
        },
        'Transferring call to owner'
      );

      const client = getTwilioClient();
      if (!client || !this.callSid) {
        logger.error(
          { tool: 'transfer_to_owner' },
          'Cannot transfer — missing Twilio client or callSid'
        );
        return { error: 'Transfer unavailable' };
      }

      await client.calls(this.callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna-Neural">One moment while I transfer you to Richa.</Say><Dial>${env.OWNER_PHONE}</Dial></Response>`,
      });

      logger.info(
        { tool: 'transfer_to_owner', callSid: this.callSid },
        'Call transferred successfully'
      );
      this.cleanup();
      return { transferred: true };
    } catch (error) {
      logger.error(
        { tool: 'transfer_to_owner', error: this.formatError(error) },
        'Transfer failed'
      );
      return { error: this.formatError(error) };
    }
  }

  private formatError(error: unknown) {
    if (error instanceof Error) return error.message;
    return 'Unexpected error occurred';
  }

  private handleError(error: Error) {
    logger.error(
      { err: error, streamSid: this.streamSid },
      'Twilio realtime call error'
    );
    this.cleanup();
  }

  private cleanup() {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
    } catch (error) {
      logger.error({ err: error }, 'Error closing Twilio socket');
    }
  }
}

export function setupTwilioRealtimeStream(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/twilio/stream' });
  wss.on('connection', (socket: WebSocket) => {
    new TwilioRealtimeCall(socket);
  });
  wss.on('error', (error: Error) => {
    logger.error({ err: error }, 'Twilio stream server error');
  });
}
