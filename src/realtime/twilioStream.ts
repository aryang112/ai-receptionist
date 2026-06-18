import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { OpenAIRealtimeSession, type ToolDefinition } from './openaiSession.js';
import { logger } from '../core/logger.js';
import { env } from '../config/env.js';
import { suggestSlots, bookAppointment } from '../services/booking.js';
import { phorest } from '../services/phorest.js';
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

const INSTRUCTIONS = `You are Erica, the warm and friendly AI receptionist for Richa's Threading Salon in Parkville, Maryland. You answer calls, book appointments, reschedule, cancel, and help with any questions about the salon.

PERSONALITY: Conversational, warm, efficient. Speak like a real person — not a robot. Keep responses to 1–2 short sentences. Use natural phrasing like "Of course!", "No problem!", "Let me check that for you."

BUSINESS HOURS: Always use the get_business_hours tool when asked about hours. Never guess.

PRICING (memorised — do not call API):
- Brow Threading: $12, ~15 min
- Eyebrow Tinting: $20, ~20 min
- Full Face Threading: $35, ~30 min
- Brazilian Wax: $50, ~30 min
- Bikini Wax: $30, ~20 min
- Facials: $60–90, ~60 min

When calling suggest_availability or book_appointment, use service names EXACTLY as listed above (e.g. "Brow Threading" not "Eyebrow Threading").

═══ CUSTOMER IDENTIFICATION (always do this first) ═══
1. Ask: "What's your phone number?"
2. Call lookup_customer with the phone number
3. If found: "Got it! Hi [First Name], how can I help you today?"
4. If not found by phone: "I don't have that number on file — what's your first and last name?"
5. Call lookup_customer with firstName and lastName
6. If 1 match: "Found you! How can I help?"
7. If multiple matches: "I found a few people with that name — when is your appointment?"
   → Match on the appointment date/time they give you
8. If no match at all: "No worries, I'll get you set up! What's your first and last name?"
   → Proceed to booking and the system will create their profile

═══ BOOKING ═══
1. Identify customer (see above)
2. "What service were you thinking today?"
3. "And what day works for you?"
4. Call suggest_availability with serviceName and date
5. Offer the first 3 slots: "I have [time], [time], and [time] — which works best?"
6. Confirm: "Perfect — so [service] on [day] at [time] for [First Name]. Shall I go ahead and book that?"
7. Call book_appointment ONLY after they say yes
8. "You're all set! See you [day] at [time]. Anything else I can help with?"

Same-day bookings: No minimum notice. If there's availability, book it.

After-hours bookings: Always take the booking for a future date. Only say "we're currently closed" if they're asking to come in RIGHT NOW. Otherwise proceed normally and book the future slot.

═══ RESCHEDULING ═══
1. Identify customer (phone first, name fallback)
2. Call list_appointments to get their upcoming appointments
3. "I see you have [service] on [day] at [time] — is that the one you'd like to move?"
4. "What day and time works better for you?"
5. Call suggest_availability for the new slot
6. "I have [time] open — does that work?"
7. Call reschedule_appointment once confirmed
8. "Done! You're all set for [new day] at [new time]."

═══ CANCELLATION ═══
1. Identify customer
2. Call list_appointments
3. "I see [service] on [day] at [time] — would you like to cancel that one?"
4. "Just to confirm — cancelling [service] on [day] at [time]?"
5. Call cancel_appointment
6. "Done! Your appointment's cancelled. Hope to see you again soon!"

═══ RUNNING LATE ═══
1. "No problem! What's your phone number?"
2. Call lookup_customer → then list_appointments (filter to today)
3. Identify which appointment they mean
4. Call log_running_late with clientId and appointmentId
5. If response has squeezed: false → "No worries at all — take your time, we'll see you soon!"
6. If response has squeezed: true → "Thanks for letting us know! We've made a note and we'll do our best to squeeze you in. See you soon!"

═══ TRANSFER TO RICHA ═══
ALWAYS call transfer_to_owner when:
- Caller asks to speak to Richa or asks for a human
- Request involves multiple services or a group booking
- You cannot help after one clarifying attempt
- Caller sounds frustrated or confused
- Any booking system error occurs

Say first: "Of course, let me get Richa for you — one moment!" then call transfer_to_owner.

═══ GENERAL RULES ═══
- Never read appointment IDs aloud — use human-readable descriptions
- Never guess at hours — use get_business_hours
- If you mishear something, just say "Sorry, could you say that again?"
- Always confirm name spelling if you're uncertain
- Respond in English only, regardless of what language the caller uses
`;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'suggest_availability',
    description: 'Find available appointments for a given service on a specific date.',
    parameters: {
      type: 'object',
      properties: {
        serviceName: { type: 'string' },
        date: { type: 'string', description: 'ISO date YYYY-MM-DD' }
      },
      required: ['serviceName', 'date']
    }
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Book an appointment once all details are confirmed with the caller.',
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
            email: { type: 'string' }
          },
          required: ['name', 'phone']
        }
      },
      required: ['serviceName', 'date', 'time', 'customer']
    }
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
        time: { type: 'string' }
      },
      required: ['appointmentId', 'date', 'time']
    }
  },
  {
    type: 'function',
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment.',
    parameters: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string' }
      },
      required: ['appointmentId']
    }
  },
  {
    type: 'function',
    name: 'get_business_hours',
    description: 'Get the salon operating hours for each day of the week and any special closed dates. Use this when the caller asks about hours, what time you open/close, or when the salon is available.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    type: 'function',
    name: 'lookup_customer',
    description: 'Look up a caller in the salon system. Always try phone first. If not found or no phone given, try by name. Use this before booking, rescheduling, cancelling, or logging running late.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Caller phone number (try this first)' },
        firstName: { type: 'string', description: 'First name (fallback if no phone match)' },
        lastName: { type: 'string', description: 'Last name (fallback if no phone match)' }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'list_appointments',
    description: 'List a customer\'s upcoming appointments. Use before rescheduling, cancelling, or when caller says they\'re running late. Requires clientId from lookup_customer.',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string' }
      },
      required: ['clientId']
    }
  },
  {
    type: 'function',
    name: 'log_running_late',
    description: 'Call this when a caller says they are running late for their appointment. Logs a note on their appointment and checks if there is a tight back-to-back booking.',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        appointmentId: { type: 'string', description: 'The appointment they are running late for' }
      },
      required: ['clientId', 'appointmentId']
    }
  },
  {
    type: 'function',
    name: 'transfer_to_owner',
    description: 'Transfer the call to Richa (the salon owner). Use when: caller asks to speak to Richa or a person, request involves multiple services or group booking, you are unable to help after one clarifying attempt, caller sounds frustrated.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief reason for the transfer' }
      },
      required: ['reason']
    }
  }
];

interface TwilioEventBase {
  event: string;
  streamSid?: string;
}

interface TwilioMediaEvent extends TwilioEventBase {
  event: 'media';
  media: { payload: string };
}

interface TwilioStartEvent extends TwilioEventBase {
  event: 'start';
  start: { streamSid: string; callSid: string };
}

interface TwilioStopEvent extends TwilioEventBase {
  event: 'stop';
}

type TwilioEvent = TwilioMediaEvent | TwilioStartEvent | TwilioStopEvent | TwilioEventBase;

class TwilioRealtimeCall {
  private readonly socket: WebSocket;
  private readonly session: OpenAIRealtimeSession;
  private streamSid = '';
  private callSid = '';
  private closed = false;
  private hasReceivedFirstAudioChunk = false;
  private sessionReady = false;

  constructor(socket: WebSocket) {
    this.socket = socket;
    logger.info('New Twilio WebSocket connection');

    this.session = new OpenAIRealtimeSession({
      onAudioChunk: chunk => this.sendAudioToTwilio(chunk),
      onTextDelta: delta => this.handleAssistantText(delta),
      onError: error => this.handleError(error)
    });

    this.session.registerTool('suggest_availability', args => this.handleSuggestAvailability(args));
    this.session.registerTool('book_appointment', args => this.handleBookAppointment(args));
    this.session.registerTool('reschedule_appointment', args => this.handleReschedule(args));
    this.session.registerTool('cancel_appointment', args => this.handleCancel(args));
    this.session.registerTool('get_business_hours', args => this.handleGetBusinessHours(args));
    this.session.registerTool('lookup_customer', args => this.handleLookupCustomer(args));
    this.session.registerTool('list_appointments', args => this.handleListAppointments(args));
    this.session.registerTool('log_running_late', args => this.handleLogRunningLate(args));
    this.session.registerTool('transfer_to_owner', args => this.handleTransferToOwner(args));
    logger.debug('OpenAI tools registered: suggest_availability, book_appointment, reschedule_appointment, cancel_appointment, get_business_hours, lookup_customer, list_appointments, log_running_late, transfer_to_owner');

    socket.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    socket.on('close', () => this.cleanup());
    socket.on('error', err => this.handleError(err instanceof Error ? err : new Error('Twilio socket error')));
  }

  private async handleMessage(data: WebSocket.RawData) {
    try {
      const event = JSON.parse(data.toString()) as TwilioEvent;
      switch (event.event) {
        case 'start':
          this.streamSid = (event as TwilioStartEvent).start.streamSid;
          this.callSid = (event as TwilioStartEvent).start.callSid;
          logger.info({ streamSid: this.streamSid }, '📞 ========== NEW CALL STARTED ==========');
          logger.info({ streamSid: this.streamSid }, '📞 Twilio stream started');
          await this.session.connect();
          await this.session.configureSession({ instructions: INSTRUCTIONS, tools: TOOL_DEFINITIONS });
          this.sessionReady = true;
          // Preload client phone index in background so lookup_customer is instant
          phorest.preloadClients?.().catch(() => {});
          logger.info({ streamSid: this.streamSid }, '🎙️ Waiting for caller audio...');
          break;
        case 'media':
          await this.handleMedia(event as TwilioMediaEvent);
          break;
        case 'stop':
          logger.info({ streamSid: this.streamSid }, '☎️ ========== CALL ENDED ==========');
          this.cleanup();
          break;
        default:
          break;
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error('Failed to parse Twilio message'));
    }
  }

  private async handleMedia(event: TwilioMediaEvent) {
    if (!event.media?.payload || this.closed || !this.sessionReady) return;

    // With server_vad enabled, just forward audio — OpenAI handles turn detection
    try {
      await this.session.appendTwilioAudio(event.media.payload);
    } catch {
      // Connection lost — stop processing, cleanup will handle the rest
      if (!this.closed) this.cleanup();
    }
  }


  private sendAudioToTwilio(base64Mulaw: string) {
    if (!this.streamSid || this.closed) {
      logger.error({ streamSid: this.streamSid, closed: this.closed }, '❌ Cannot send audio - stream not ready');
      return;
    }

    // Log only the first audio chunk
    if (!this.hasReceivedFirstAudioChunk) {
      logger.info({ streamSid: this.streamSid, audioLength: base64Mulaw.length }, '🔊 AI speaking - first audio chunk sent to Twilio');
      this.hasReceivedFirstAudioChunk = true;
    }

    const payload = {
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: base64Mulaw, track: 'outbound' }
    };

    try {
      this.socket.send(JSON.stringify(payload));
      logger.debug({ audioLength: base64Mulaw.length }, '📤 Audio chunk sent to Twilio');
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error('Failed to send media to Twilio'));
    }
  }

  private handleAssistantText(_delta: string) {
    // Placeholder for future analytics or action parsing.
  }

  private async handleSuggestAvailability(args: unknown) {
    try {
      const payload = args as { serviceName: string; date: string };
      logger.info({ tool: 'suggest_availability', args: payload }, 'Tool called: suggest_availability');
      const result = await suggestSlots(payload);
      logger.info({ tool: 'suggest_availability', slotsCount: result.slots.length }, 'Availability slots found');
      return {
        service: result.service.name,
        date: result.date,
        slots: result.slots.slice(0, 6)
      };
    } catch (error) {
      logger.error({ tool: 'suggest_availability', error: this.formatError(error) }, 'Tool error: suggest_availability');
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
      logger.info({ tool: 'book_appointment', args: payload }, 'Tool called: book_appointment');
      const result = await bookAppointment(payload as any);
      logger.info({ tool: 'book_appointment', appointmentId: result.appointment.appointmentId }, 'Appointment booked successfully');
      return {
        appointmentId: result.appointment.appointmentId,
        service: result.service.name,
        price: result.service.price,
        date: payload.date,
        time: payload.time
      };
    } catch (error) {
      logger.error({ tool: 'book_appointment', error: this.formatError(error) }, 'Tool error: book_appointment');
      return { error: this.formatError(error) };
    }
  }

  private async handleReschedule(args: unknown) {
    try {
      const payload = args as { appointmentId: string; date: string; time: string };
      logger.info({ tool: 'reschedule_appointment', args: payload }, 'Tool called: reschedule_appointment');
      const iso = `${payload.date}T${payload.time}`;
      await phorest.updateAppointment(payload.appointmentId, iso);
      logger.info({ tool: 'reschedule_appointment', appointmentId: payload.appointmentId }, 'Appointment rescheduled successfully');
      return {
        appointmentId: payload.appointmentId,
        date: payload.date,
        time: payload.time
      };
    } catch (error) {
      logger.error({ tool: 'reschedule_appointment', error: this.formatError(error) }, 'Tool error: reschedule_appointment');
      return { error: this.formatError(error) };
    }
  }

  private async handleCancel(args: unknown) {
    try {
      const payload = args as { appointmentId: string };
      logger.info({ tool: 'cancel_appointment', args: payload }, 'Tool called: cancel_appointment');
      await phorest.cancelAppointment(payload.appointmentId);
      logger.info({ tool: 'cancel_appointment', appointmentId: payload.appointmentId }, 'Appointment cancelled successfully');
      return { appointmentId: payload.appointmentId, cancelled: true };
    } catch (error) {
      logger.error({ tool: 'cancel_appointment', error: this.formatError(error) }, 'Tool error: cancel_appointment');
      return { error: this.formatError(error) };
    }
  }

  private async handleGetBusinessHours(_args: unknown) {
    try {
      logger.info({ tool: 'get_business_hours' }, 'Tool called: get_business_hours');

      const formattedHours = {
        monday: businessHours.hours.mon.join(', ') || 'Closed',
        tuesday: businessHours.hours.tue.join(', ') || 'Closed',
        wednesday: businessHours.hours.wed.join(', ') || 'Closed',
        thursday: businessHours.hours.thu.join(', ') || 'Closed',
        friday: businessHours.hours.fri.join(', ') || 'Closed',
        saturday: businessHours.hours.sat.join(', ') || 'Closed',
        sunday: businessHours.hours.sun.join(', ') || 'Closed',
        closedDates: businessHours.closedDates
      };

      logger.info({ tool: 'get_business_hours', hours: formattedHours }, 'Business hours retrieved');
      return formattedHours;
    } catch (error) {
      logger.error({ tool: 'get_business_hours', error: this.formatError(error) }, 'Tool error: get_business_hours');
      return { error: this.formatError(error) };
    }
  }

  private async handleLookupCustomer(args: unknown) {
    try {
      const payload = args as { phone?: string; firstName?: string; lastName?: string };
      logger.info({ tool: 'lookup_customer' }, 'Tool called: lookup_customer');

      if (payload.phone) {
        const result = await phorest.lookupCustomerByPhone(payload.phone);
        if (result) {
          logger.info({ tool: 'lookup_customer', clientId: result.clientId }, 'Customer found by phone');
          return { found: true, clientId: result.clientId, name: `${result.firstName} ${result.lastName}`.trim(), matchedBy: 'phone' };
        }
      }

      if (payload.firstName && payload.lastName) {
        const results = await phorest.lookupCustomerByName(payload.firstName, payload.lastName);
        if (results.length === 1) {
          logger.info({ tool: 'lookup_customer', clientId: results[0]!.clientId }, 'Customer found by name');
          return { found: true, clientId: results[0]!.clientId, name: `${results[0]!.firstName} ${results[0]!.lastName}`.trim(), matchedBy: 'name' };
        }
        if (results.length > 1) {
          return { found: true, multiple: true, count: results.length, message: 'Multiple matches — ask for appointment date/time to disambiguate' };
        }
      }

      logger.info({ tool: 'lookup_customer' }, 'Customer not found');
      return { found: false };
    } catch (error) {
      logger.error({ tool: 'lookup_customer', error: this.formatError(error) }, 'Tool error: lookup_customer');
      return { error: this.formatError(error) };
    }
  }

  private async handleListAppointments(args: unknown) {
    try {
      const payload = args as { clientId: string };
      logger.info({ tool: 'list_appointments', clientId: payload.clientId }, 'Tool called: list_appointments');
      const appointments = await phorest.listAppointments(payload.clientId);
      logger.info({ tool: 'list_appointments', count: appointments.length }, 'Appointments retrieved');
      return { appointments };
    } catch (error) {
      logger.error({ tool: 'list_appointments', error: this.formatError(error) }, 'Tool error: list_appointments');
      return { error: this.formatError(error) };
    }
  }

  private async handleLogRunningLate(args: unknown) {
    try {
      const payload = args as { clientId: string; appointmentId: string };
      logger.info({ tool: 'log_running_late', ...payload }, 'Tool called: log_running_late');

      await phorest.addAppointmentNote(payload.appointmentId, 'Customer called ahead — running late');

      const todayAppts = await phorest.getTodayAppointments();
      const callerAppt = todayAppts.find(a => a.appointmentId === payload.appointmentId);

      let squeezed = false;
      if (callerAppt) {
        const [endH, endM] = callerAppt.endTimeRaw.split(':').map(Number);
        const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);

        squeezed = todayAppts.some(a => {
          if (a.appointmentId === payload.appointmentId) return false;
          const [startH, startM] = a.startTimeRaw.split(':').map(Number);
          const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
          return startMinutes >= endMinutes && startMinutes - endMinutes <= 15;
        });
      }

      logger.info({ tool: 'log_running_late', squeezed }, 'Running late logged');
      return { noted: true, squeezed };
    } catch (error) {
      logger.error({ tool: 'log_running_late', error: this.formatError(error) }, 'Tool error: log_running_late');
      return { error: this.formatError(error) };
    }
  }

  private async handleTransferToOwner(args: unknown) {
    try {
      const payload = args as { reason: string };
      logger.info({ tool: 'transfer_to_owner', reason: payload.reason, callSid: this.callSid }, 'Transferring call to owner');

      const client = getTwilioClient();
      if (!client || !this.callSid) {
        logger.error({ tool: 'transfer_to_owner' }, 'Cannot transfer — missing Twilio client or callSid');
        return { error: 'Transfer unavailable' };
      }

      await client.calls(this.callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna-Neural">One moment while I transfer you to Richa.</Say><Dial>${env.OWNER_PHONE}</Dial></Response>`
      });

      logger.info({ tool: 'transfer_to_owner', callSid: this.callSid }, 'Call transferred successfully');
      this.cleanup();
      return { transferred: true };
    } catch (error) {
      logger.error({ tool: 'transfer_to_owner', error: this.formatError(error) }, 'Transfer failed');
      return { error: this.formatError(error) };
    }
  }

  private formatError(error: unknown) {
    if (error instanceof Error) return error.message;
    return 'Unexpected error occurred';
  }

  private handleError(error: Error) {
    logger.error({ err: error, streamSid: this.streamSid }, 'Twilio realtime call error');
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
