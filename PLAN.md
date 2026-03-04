# AI Receptionist — Build Plan (v2 — FINAL)
**Project:** Richa's Threading Salon — Voice AI Receptionist "Erica"
**Codebase:** `/Users/aryangupta/Documents/Dev/ai-receptionist`
**Stack:** Node.js + TypeScript (ESM), Express, OpenAI Realtime API (GPT-4o Realtime), Twilio, Phorest
**Owner cell (transfers):** +14433706471
**Erica's voice:** shimmer
**Running late threshold:** 15 minutes

---

## CURRENT STATUS
> Update this section after every commit.

| Task | Status | Last Commit |
|---|---|---|
| TASK 1 — Customer Lookup Tool | ✅ Done | feat/erica-v2 |
| TASK 2 — List Appointments Tool | ✅ Done | feat/erica-v2 |
| TASK 3 — Running Late Tool | ✅ Done | feat/erica-v2 |
| TASK 4 — Transfer to Human | ✅ Done | feat/erica-v2 |
| TASK 5 — System Prompt Rewrite | ✅ Done | d73b02c |
| TASK 6 — Tests + Build | ✅ Done | feat/erica-v2 |

**Legend:** ⬜ Not started · 🔄 In progress · ✅ Done

---

## MID-TASK RECOVERY PROTOCOL
If this session was interrupted:
1. `git status` — see modified but uncommitted files
2. `npm test` — see what's currently passing/failing
3. `npm run build` — see TypeScript errors
4. Read modified file(s) to understand partial state
5. Resume from first unchecked `- [ ]` below

**Commit rule:** Commit after EVERY checkbox — not just major tasks.
One checkbox = one commit = one surgical restore point.

---

## Architecture

```
Customer calls (410) 942-9100
        ↓
    Twilio (receives call, streams audio bidirectionally)
        ↓ TwiML → opens WebSocket /twilio/stream
    Backend (Express, port 5050)
        ↓ WebSocket connection
    OpenAI Realtime API (GPT-4o Realtime)
     ├─ STT (speech-to-text) — built in
     ├─ LLM (conversation + function calls) — built in
     └─ TTS (text-to-speech, voice: shimmer) — built in
        ~300–500ms total latency, no inter-service hops
        ↓ function calls → backend handlers
    Phorest API (customers, appointments, notes)
```

**Why OpenAI Realtime:** End-to-end audio model. No STT→LLM→TTS hops.
Purpose-built for real-time phone conversations. Already integrated.
To change voice later: update `OPENAI_REALTIME_VOICE` env var.

---

## Key Files
- `src/realtime/twilioStream.ts` — AI brain: persona, tools, OpenAI session, Twilio WS handler
- `src/realtime/openaiSession.ts` — OpenAI Realtime session wrapper
- `src/services/phorest.client.ts` — Real Phorest HTTP client
- `src/services/phorest.mock.ts` — Mock for tests
- `src/services/phorest.types.ts` — PhorestPort interface (the contract)
- `src/services/booking.ts` — Booking helpers (Zod-validated)
- `src/routes/twilio.ts` — TwiML voice/gather routes
- `src/config/business.json` — Business hours (source of truth — DO NOT change)
- `src/config/env.ts` — Environment variables

---

## Phorest API Reference
- **Base URL (US):** `http://api-gateway-us.phorest.com/third-party-api-server/`
- **Auth:** Basic `global/richa@richasthreading.com:D9x$zcbh0h1t`
- **Business ID:** `JGTSCf8nrWhIoBauSzm5wQ`
- **Branch ID:** `BhmcJWTC1BWLuHLwzzZR6w`
- **Timezone:** `America/New_York` (Phorest stores UTC internally; always convert)

### Confirmed Endpoints
| Purpose | Method | Path |
|---|---|---|
| Search client by phone | GET | `/business/{bId}/client?mobile={phone}&size=1` |
| Search client by name | GET | `/business/{bId}/client?firstName={f}&lastName={l}&size=10` |
| Get client by ID | GET | `/business/{bId}/client/{clientId}` |
| Create client | POST | `/business/{bId}/client` |
| List appointments (by date) | GET | `/business/{bId}/branch/{brId}/appointment?from_date={YYYY-MM-DD}&to_date={YYYY-MM-DD}&size=200` |
| List appointments (by client) | GET | `/business/{bId}/branch/{brId}/appointment?clientId={id}&from_date={today}` |
| Create appointment | POST | `/business/{bId}/branch/{brId}/booking?force_selected_time=true` |
| Update appointment | PUT | `/business/{bId}/branch/{brId}/appointment/{id}?force_selected_time=true` |
| Cancel appointment | POST | `/business/{bId}/branch/{brId}/appointment/cancel?appointment_id={id}` |
| Add note to appointment | POST | `/business/{bId}/branch/{brId}/appointment/{id}/note` |
| Get availability | POST | `/business/{bId}/branch/{brId}/appointments/availability` |

### Appointment data shape (confirmed from review-automation project)
```typescript
{
  appointmentId: string,
  clientId: string,
  serviceName: string,      // already on the object — no secondary lookup needed
  appointmentDate: string,  // "YYYY-MM-DD"
  startTime: string,        // "HH:mm:ss" in UTC
  endTime: string,          // "HH:mm:ss" in UTC
  state: string,            // "BOOKED" | "PAID"
  activationState: string,  // "ACTIVE" | "CANCELLED"
  price: number,
  version: number,
  staffId: string
}
```

### Phone normalization
```typescript
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}
```

---

## What's Already Built ✅
- Express + TypeScript backend (ESM, port 5050)
- Phorest real client: `listServices`, `getAvailability`, `createAppointment`, `updateAppointment`, `cancelAppointment`
- `getOrCreateClient` — finds by email/phone, creates if not found
- Phorest mock for tests
- Twilio WebSocket media streaming (bidirectional audio)
- OpenAI Realtime session (GPT-4o Realtime)
- AI persona "Erica" with 5 tools: `suggest_availability`, `book_appointment`, `reschedule_appointment`, `cancel_appointment`, `get_business_hours`
- Luxon timezone/UTC handling
- Service catalog with preferred services filter
- Business hours config (`business.json` — do not touch)
- Vitest + supertest tests

---

## TASKS

---

### TASK 1 — Smart Customer Lookup Tool
**Files to edit:**
1. `src/services/phorest.types.ts` — add types + interface methods
2. `src/services/phorest.mock.ts` — add mock implementations
3. `src/services/phorest.client.ts` — add real implementations
4. `src/realtime/twilioStream.ts` — add tool definition + handler

**Why:** AI must explicitly look up customer before booking. Current `getOrCreateClient` silently creates — we need the AI to surface "I found your account" or "I don't see you in our system."

**Lookup strategy:**
1. Phone first (fastest): `GET /client?mobile={10-digit-phone}`
2. Name fallback: `GET /client?firstName={f}&lastName={l}`
   - 1 result → done
   - Multiple → ask "When is your appointment?" to disambiguate
   - 0 results → create new customer

**Add to `phorest.types.ts`:**
```typescript
export type CustomerResult = {
  clientId: string;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
};
```

**Add to PhorestPort interface in `phorest.types.ts`:**
```typescript
lookupCustomerByPhone(phone: string): Promise<CustomerResult | null>;
lookupCustomerByName(firstName: string, lastName: string): Promise<CustomerResult[]>;
```

**Implement in `phorest.client.ts`:**
```typescript
async lookupCustomerByPhone(phone: string): Promise<CustomerResult | null> {
  const normalized = normalizePhone(phone);
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?mobile=${encodeURIComponent(normalized)}&size=1`
  );
  const client = response._embedded?.clients?.[0];
  if (!client) return null;
  // fetch full client to get name
  const full = await phorestFetch<{ clientId: string; firstName?: string; lastName?: string; mobile?: string; email?: string }>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client/${client.clientId}`
  );
  return {
    clientId: full.clientId,
    firstName: full.firstName || '',
    lastName: full.lastName || '',
    phone: full.mobile,
    email: full.email
  };
}

async lookupCustomerByName(firstName: string, lastName: string): Promise<CustomerResult[]> {
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&size=10`
  );
  const clients = response._embedded?.clients ?? [];
  return clients.map(c => ({
    clientId: c.clientId,
    firstName: (c as any).firstName || firstName,
    lastName: (c as any).lastName || lastName,
  }));
}
```

**Note:** The existing `ClientRecord` type in `phorest.client.ts` only has `clientId`. Expand it:
```typescript
type ClientRecord = {
  clientId: string;
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
};
```

**Implement in `phorest.mock.ts`:**
```typescript
async lookupCustomerByPhone(phone: string): Promise<CustomerResult | null> {
  if (normalizePhone(phone) === '4432535169') {
    return { clientId: 'client_test', firstName: 'Jane', lastName: 'Smith', phone: '4432535169' };
  }
  return null;
},

async lookupCustomerByName(firstName: string, lastName: string): Promise<CustomerResult[]> {
  if (firstName.toLowerCase() === 'jane') {
    return [{ clientId: 'client_test', firstName: 'Jane', lastName: 'Smith' }];
  }
  return [];
},
```

**Add to `twilioStream.ts` TOOL_DEFINITIONS:**
```typescript
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
}
```

**Add handler in `TwilioRealtimeCall` class:**
```typescript
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
```

**Register in constructor:**
```typescript
this.session.registerTool('lookup_customer', args => this.handleLookupCustomer(args));
```

**Checkboxes:**
- [ ] Add `CustomerResult` type to `phorest.types.ts`
- [ ] Add `lookupCustomerByPhone` + `lookupCustomerByName` to PhorestPort interface
- [ ] Implement both in `phorest.mock.ts`
- [ ] Expand `ClientRecord` type in `phorest.client.ts`
- [ ] Implement both in `phorest.client.ts`
- [ ] Add tool definition to `twilioStream.ts` TOOL_DEFINITIONS
- [ ] Add handler + register in `twilioStream.ts`
- [ ] Commit: `feat: add lookup_customer tool with phone and name search`

---

### TASK 2 — List Appointments Tool
**Files to edit:**
1. `src/services/phorest.types.ts`
2. `src/services/phorest.mock.ts`
3. `src/services/phorest.client.ts`
4. `src/realtime/twilioStream.ts`

**Why:** Reschedule/cancel/running-late all need to find the caller's appointment. Callers don't know their `appointmentId`.

**Add to `phorest.types.ts`:**
```typescript
export type AppointmentSummary = {
  appointmentId: string;
  serviceName: string;
  date: string;         // "YYYY-MM-DD" in salon timezone
  timeDisplay: string;  // "2:00 PM" human-readable
  startTimeRaw: string; // "HH:mm:ss" UTC — for internal logic
  endTimeRaw: string;   // "HH:mm:ss" UTC — for internal logic
};
```

**Add to PhorestPort interface:**
```typescript
listAppointments(clientId: string, fromDate?: string): Promise<AppointmentSummary[]>;
```

**Implement in `phorest.client.ts`:**
```typescript
async listAppointments(clientId: string, fromDate?: string): Promise<AppointmentSummary[]> {
  const today = fromDate ?? DateTime.now().setZone(SALON_TIMEZONE).toISODate()!;
  const response = await phorestFetch<AppointmentListResponse>(
    businessBranchPath(`/appointment?clientId=${encodeURIComponent(clientId)}&from_date=${today}&size=20`)
  );

  const appointments = response._embedded?.appointments ?? [];
  return appointments
    .filter(a => a.activationState === 'ACTIVE' && (a.state === 'BOOKED' || a.state === 'PAID'))
    .map(a => {
      // startTime is UTC "HH:mm:ss" — combine with appointmentDate and convert
      const startUtc = DateTime.fromISO(`${a.appointmentDate}T${a.startTime}`, { zone: 'utc' });
      const startLocal = startUtc.setZone(SALON_TIMEZONE);
      return {
        appointmentId: a.appointmentId,
        serviceName: a.serviceName ?? 'Appointment',
        date: startLocal.toISODate()!,
        timeDisplay: startLocal.toFormat('h:mm a'),
        startTimeRaw: a.startTime,
        endTimeRaw: a.endTime ?? a.startTime,
      };
    })
    .sort((a, b) => `${a.date}${a.startTimeRaw}`.localeCompare(`${b.date}${b.startTimeRaw}`));
}
```

**Note:** `AppointmentResponse` in `phorest.client.ts` is missing `serviceName`. Add it:
```typescript
type AppointmentResponse = {
  appointmentId: string;
  version: number;
  appointmentDate: string;
  startTime: string;
  endTime?: string;
  serviceName?: string;   // ADD THIS
  price?: number;
  staffId: string;
  roomId?: string;
  machineId?: string;
  confirmed?: boolean;
  serviceId: string;
  state?: string;          // ADD THIS
  activationState?: string; // ADD THIS
};
```

**Implement in `phorest.mock.ts`:**
```typescript
async listAppointments(_clientId: string): Promise<AppointmentSummary[]> {
  const today = DateTime.now().setZone('America/New_York').toISODate()!;
  return [
    {
      appointmentId: 'appt_mock_001',
      serviceName: 'Eyebrow Threading',
      date: today,
      timeDisplay: '2:00 PM',
      startTimeRaw: '19:00:00',
      endTimeRaw: '19:15:00',
    }
  ];
},
```

**Note:** mock needs `import { DateTime } from 'luxon'` if not already there.

**Add to `twilioStream.ts` TOOL_DEFINITIONS:**
```typescript
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
}
```

**Add handler in `TwilioRealtimeCall` class:**
```typescript
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
```

**Register in constructor:**
```typescript
this.session.registerTool('list_appointments', args => this.handleListAppointments(args));
```

**Checkboxes:**
- [ ] Add `AppointmentSummary` type to `phorest.types.ts`
- [ ] Add `listAppointments` to PhorestPort interface
- [ ] Expand `AppointmentResponse` type in `phorest.client.ts` (add serviceName, state, activationState)
- [ ] Implement `listAppointments` in `phorest.client.ts`
- [ ] Implement `listAppointments` in `phorest.mock.ts`
- [ ] Add tool definition to `twilioStream.ts`
- [ ] Add handler + register in `twilioStream.ts`
- [ ] Commit: `feat: add list_appointments tool`

---

### TASK 3 — Running Late Tool
**Files to edit:**
1. `src/services/phorest.types.ts`
2. `src/services/phorest.mock.ts`
3. `src/services/phorest.client.ts`
4. `src/realtime/twilioStream.ts`

**Why:** Common call scenario — "I'm running about 10 minutes late." Erica logs a note and checks whether the next appointment is within 15 minutes of the caller's end time to determine response.

**Phorest notes endpoint:** `POST /business/{bId}/branch/{brId}/appointment/{id}/note`
Request body (best guess — adjust if API rejects): `{ "text": "Customer called ahead — running late" }`
If `text` fails, try `{ "note": "..." }` or `{ "content": "..." }`. Log the error and move on gracefully.

**Add to PhorestPort interface in `phorest.types.ts`:**
```typescript
addAppointmentNote(appointmentId: string, note: string): Promise<void>;
getTodayAppointments(): Promise<AppointmentSummary[]>;
```

**Implement in `phorest.client.ts`:**
```typescript
async addAppointmentNote(appointmentId: string, note: string): Promise<void> {
  try {
    await phorestFetch(
      businessBranchPath(`/appointment/${appointmentId}/note`),
      {
        method: 'POST',
        body: JSON.stringify({ text: note }),
        expectEmpty: true
      }
    );
  } catch (error) {
    // Note logging is best-effort — don't fail the whole call if this fails
    logger.warn({ appointmentId, error: String(error) }, 'Failed to add appointment note — continuing');
  }
}

async getTodayAppointments(): Promise<AppointmentSummary[]> {
  const today = DateTime.now().setZone(SALON_TIMEZONE).toISODate()!;
  const response = await phorestFetch<AppointmentListResponse>(
    businessBranchPath(`/appointment?from_date=${today}&to_date=${today}&size=200`)
  );

  const appointments = response._embedded?.appointments ?? [];
  return appointments
    .filter(a => a.activationState === 'ACTIVE' && (a.state === 'BOOKED' || a.state === 'PAID'))
    .map(a => {
      const startUtc = DateTime.fromISO(`${a.appointmentDate}T${a.startTime}`, { zone: 'utc' });
      const startLocal = startUtc.setZone(SALON_TIMEZONE);
      return {
        appointmentId: a.appointmentId,
        serviceName: a.serviceName ?? 'Appointment',
        date: startLocal.toISODate()!,
        timeDisplay: startLocal.toFormat('h:mm a'),
        startTimeRaw: a.startTime,
        endTimeRaw: a.endTime ?? a.startTime,
      };
    })
    .sort((a, b) => a.startTimeRaw.localeCompare(b.startTimeRaw));
}
```

**Implement in `phorest.mock.ts`:**
```typescript
async addAppointmentNote(_appointmentId: string, _note: string): Promise<void> {
  // no-op in mock
},

async getTodayAppointments(): Promise<AppointmentSummary[]> {
  const today = DateTime.now().setZone('America/New_York').toISODate()!;
  return [
    {
      appointmentId: 'appt_mock_001',
      serviceName: 'Eyebrow Threading',
      date: today,
      timeDisplay: '2:00 PM',
      startTimeRaw: '19:00:00',
      endTimeRaw: '19:15:00',
    },
    {
      appointmentId: 'appt_mock_002',
      serviceName: 'Eyebrow Tinting',
      date: today,
      timeDisplay: '2:15 PM',
      startTimeRaw: '19:15:00',
      endTimeRaw: '19:35:00',
    }
  ];
},
```

**Add to `twilioStream.ts` TOOL_DEFINITIONS:**
```typescript
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
}
```

**Add handler — squeeze-in check logic (15-min threshold):**
```typescript
private async handleLogRunningLate(args: unknown) {
  try {
    const payload = args as { clientId: string; appointmentId: string };
    logger.info({ tool: 'log_running_late', ...payload }, 'Tool called: log_running_late');

    // Add note (best-effort)
    await phorest.addAppointmentNote(payload.appointmentId, 'Customer called ahead — running late');

    // Get all today's appointments to check for back-to-back
    const todayAppts = await phorest.getTodayAppointments();
    const callerAppt = todayAppts.find(a => a.appointmentId === payload.appointmentId);

    let squeezed = false;
    if (callerAppt) {
      // Find any appointment that starts within 15 minutes of caller's end time
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
```

**Register in constructor:**
```typescript
this.session.registerTool('log_running_late', args => this.handleLogRunningLate(args));
```

**Checkboxes:**
- [ ] Add `addAppointmentNote` + `getTodayAppointments` to PhorestPort interface
- [ ] Implement both in `phorest.mock.ts`
- [ ] Implement both in `phorest.client.ts`
- [ ] Add tool definition to `twilioStream.ts`
- [ ] Add handler + register in `twilioStream.ts`
- [ ] Commit: `feat: add log_running_late tool with 15-min squeeze check`

---

### TASK 4 — Transfer to Human
**Files to edit:**
1. `src/config/env.ts`
2. `src/realtime/twilioStream.ts`

**Why:** Erica must be able to transfer calls to Richa's cell when needed.

**Add to `env.ts`:**
```typescript
OWNER_PHONE: process.env.OWNER_PHONE || '+14433706471',
```

**In `TwilioRealtimeCall` class — add `callSid` field:**
The `start` event already has `start.callSid`. It's captured in `streamSid` assignment. Add:
```typescript
private callSid = '';
```

In the `start` case of `handleMessage`:
```typescript
case 'start':
  this.streamSid = (event as TwilioStartEvent).start.streamSid;
  this.callSid = (event as TwilioStartEvent).start.callSid;  // ADD THIS LINE
  // ... rest stays the same
```

**Add Twilio REST client at top of file (after imports):**
```typescript
import twilio from 'twilio';
// Lazy-initialised so tests don't fail without creds
let _twilioClient: ReturnType<typeof twilio> | null = null;
function getTwilioClient() {
  if (!_twilioClient && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    _twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
}
```

**Add handler:**
```typescript
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
    this.cleanup(); // Close OpenAI session — call is now on Twilio's hands
    return { transferred: true };
  } catch (error) {
    logger.error({ tool: 'transfer_to_owner', error: this.formatError(error) }, 'Transfer failed');
    return { error: this.formatError(error) };
  }
}
```

**Add tool definition to TOOL_DEFINITIONS:**
```typescript
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
```

**Register in constructor:**
```typescript
this.session.registerTool('transfer_to_owner', args => this.handleTransferToOwner(args));
```

**Also update voice in `env.ts`:**
Change default voice from `'alloy'` to `'shimmer'`:
```typescript
OPENAI_REALTIME_VOICE: process.env.OPENAI_REALTIME_VOICE || 'shimmer',
```

**Checkboxes:**
- [ ] Add `OWNER_PHONE` to `env.ts`
- [ ] Change default `OPENAI_REALTIME_VOICE` to `'shimmer'` in `env.ts`
- [ ] Add `callSid` field + capture from start event in `twilioStream.ts`
- [ ] Add lazy Twilio REST client initializer in `twilioStream.ts`
- [ ] Add tool definition to TOOL_DEFINITIONS
- [ ] Add handler + register in `twilioStream.ts`
- [ ] Commit: `feat: add transfer_to_owner tool and shimmer voice`

---

### TASK 5 — Rewrite System Prompt (INSTRUCTIONS)
**File:** `src/realtime/twilioStream.ts` — the `INSTRUCTIONS` constant only

**Replace entire INSTRUCTIONS constant with:**

```typescript
const INSTRUCTIONS = `You are Erica, the warm and friendly AI receptionist for Richa's Threading Salon in Parkville, Maryland. You answer calls, book appointments, reschedule, cancel, and help with any questions about the salon.

PERSONALITY: Conversational, warm, efficient. Speak like a real person — not a robot. Keep responses to 1–2 short sentences. Use natural phrasing like "Of course!", "No problem!", "Let me check that for you."

BUSINESS HOURS: Always use the get_business_hours tool when asked about hours. Never guess.

PRICING (memorised — do not call API):
- Eyebrow Threading: $12, ~15 min
- Eyebrow Waxing: $15, ~15 min
- Eyebrow Tinting: $20, ~20 min
- Facials: $60–90, ~60 min
- Brazilian Waxing: $50, ~30 min
- Eyelash Extensions: $80–120, ~90 min
- Microblading: $400, ~2 hours

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
```

**Checkboxes:**
- [ ] Replace INSTRUCTIONS constant in `twilioStream.ts`
- [ ] Commit: `feat: rewrite Erica system prompt with full conversation flows`

---

### TASK 6 — Tests + Build Validation
**Files:** `src/tests/phorest.mock.test.ts`, `src/tests/appointment.test.ts`, plus build

**Run first:** `npm test && npm run build` — see what's currently passing.

**Add tests for:**

`lookupCustomerByPhone`:
```typescript
it('returns customer when found by phone', async () => {
  const result = await mockPhorest.lookupCustomerByPhone('4432535169');
  expect(result).not.toBeNull();
  expect(result?.firstName).toBe('Jane');
});

it('returns null for unknown phone', async () => {
  const result = await mockPhorest.lookupCustomerByPhone('0000000000');
  expect(result).toBeNull();
});
```

`lookupCustomerByName`:
```typescript
it('returns array of matches by name', async () => {
  const results = await mockPhorest.lookupCustomerByName('Jane', 'Smith');
  expect(results.length).toBeGreaterThan(0);
});

it('returns empty array for unknown name', async () => {
  const results = await mockPhorest.lookupCustomerByName('Nobody', 'Here');
  expect(results).toHaveLength(0);
});
```

`listAppointments`:
```typescript
it('returns upcoming appointments for a client', async () => {
  const appts = await mockPhorest.listAppointments('client_test');
  expect(appts.length).toBeGreaterThan(0);
  expect(appts[0]).toHaveProperty('appointmentId');
  expect(appts[0]).toHaveProperty('serviceName');
  expect(appts[0]).toHaveProperty('timeDisplay');
});
```

`addAppointmentNote`:
```typescript
it('adds a note without throwing', async () => {
  await expect(mockPhorest.addAppointmentNote('appt_001', 'running late')).resolves.toBeUndefined();
});
```

`getTodayAppointments`:
```typescript
it('returns today\'s appointments', async () => {
  const appts = await mockPhorest.getTodayAppointments();
  expect(Array.isArray(appts)).toBe(true);
});
```

**After adding tests:** `npm test` must pass. Then `npm run build` must be clean.

**Checkboxes:**
- [ ] Add tests for `lookupCustomerByPhone` (found + not found)
- [ ] Add tests for `lookupCustomerByName` (found + not found)
- [ ] Add tests for `listAppointments`
- [ ] Add tests for `addAppointmentNote`
- [ ] Add tests for `getTodayAppointments`
- [ ] `npm test` — all green
- [ ] `npm run build` — clean compile
- [ ] Commit: `test: add tests for new PhorestPort methods`

---

## Execution Order

```
Agent A  →  TASK 5 (system prompt only — independent)
              ↓ complete
Agent B  →  TASK 1 + TASK 2 + TASK 3 (all PhorestPort changes — one agent to avoid conflicts)
              ↓ complete
Agent C  →  TASK 4 (transfer + voice — needs stable twilioStream.ts)
              ↓ complete
Agent D  →  TASK 6 (tests + build validation)
```

---

## Environment Variables
```env
PORT=5050
OPENAI_API_KEY=...
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
OPENAI_REALTIME_VOICE=shimmer
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_NUMBER=+14109429100
PHOREST_BASE_URL=http://api-gateway-us.phorest.com/third-party-api-server
PHOREST_API_USERNAME=global/richa@richasthreading.com
PHOREST_API_SECRET=D9x$zcbh0h1t
PHOREST_BUSINESS_ID=JGTSCf8nrWhIoBauSzm5wQ
PHOREST_BRANCH_ID=BhmcJWTC1BWLuHLwzzZR6w
PHOREST_PRIMARY_STAFF_ID=...
USE_MOCK_PHOREST=false
OWNER_PHONE=+14433706471
```

---

## Agent Rules
1. `.js` extension on ALL local imports (ESM)
2. Never log secrets or full phone numbers
3. PhorestPort is the contract — mock and real must implement every method
4. `business.json` is source of truth for hours — do not change it
5. All Phorest times are UTC; display in `America/New_York`
6. Phone: 10 digits, strip leading 1
7. Voice responses: 1–2 sentences, conversational, no IDs read aloud
8. Run `npm test` after every sub-task before committing
9. TypeScript strict — minimise `any`
10. Commit after EVERY checkbox with a clear message
11. Update CURRENT STATUS table at top of this file after each task completes
