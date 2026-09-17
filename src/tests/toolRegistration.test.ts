import { beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

// 2026-09-16 — Workstream H. reschedule_visit/cancel_visit/book_visit were
// registered ONLY inside the `if (this.voiceEngine === 'realtime')` branch
// of TwilioRealtimeCall's tool setup (twilioStream.ts), mis-indented so the
// gap wasn't visible on read. liveToolDefinitions() still advertised all
// three to the Live backend model, and backendRules.ts's BACKEND_TOOL_USE
// told it to call them directly. On a real VOICE_ENGINE=live call, invoking
// one landed in liveSession.ts's runTool with no handler registered, the
// model swallowed the raw "No handler registered for tool ..." error, and
// Erica told the caller she could not check a combined opening — heard live
// on 2026-09-15 and mis-attributed entirely to a prompt ban (see
// tasks/lessons.md, "a tool the backend may not call does not exist").
//
// This file is the contract test that would have caught it: every tool name
// a session's tool-definition list advertises must have an actual handler
// registered on that same session, for BOTH engines.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let liveToolDefinitions: typeof import('../realtime/twilioStream.js').liveToolDefinitions;
let TOOL_DEFINITIONS: typeof import('../realtime/twilioStream.js').TOOL_DEFINITIONS;

beforeAll(async () => {
  ({ TwilioRealtimeCall, liveToolDefinitions, TOOL_DEFINITIONS } = await import(
    '../realtime/twilioStream.js'
  ));
});

function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.streamSid = 'S';
  call.callSid = 'CA_tool_registration_test';
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

describe('every tool the Live backend is offered has a handler (2026-09-16: visit tools were Realtime-only and Erica said she could not check a combined opening)', () => {
  it('liveToolDefinitions() names are all registered on a Live-engine call session', () => {
    const call = buildCall();
    call.voiceEngine = 'live';
    call.createSession('live-tag');

    const registered = new Set(call.session.registeredToolNames());
    const advertised = liveToolDefinitions().map((tool) => tool.name);
    expect(advertised.length).toBeGreaterThan(0);
    for (const name of advertised) {
      expect(registered.has(name)).toBe(true);
    }
  });

  it('TOOL_DEFINITIONS names are all registered on a Realtime-engine call session', () => {
    const call = buildCall();
    call.voiceEngine = 'realtime';
    call.createSession('realtime-tag');

    const registered = new Set(call.session.registeredToolNames());
    const advertised = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(advertised.length).toBeGreaterThan(0);
    for (const name of advertised) {
      expect(registered.has(name)).toBe(true);
    }
  });
});

// A tool test that only calls the handler method directly (e.g.
// call.handleRescheduleVisit(...)) proves the handler logic works, but not
// that the tool is reachable from a real call — that also requires the
// registration line above to exist. These instead go through
// OpenAILiveSession's own private `runTool`, the SAME dispatch path a real
// Live call uses (toolHandlers lookup by name → JSON-parse args → invoke →
// JSON-stringify result): exactly what would have returned "No handler
// registered for tool ..." before this fix, for a name that IS advertised by
// liveToolDefinitions().
describe('reschedule_visit/cancel_visit/book_visit are dispatchable through a Live-engine session (not just callable directly)', () => {
  async function dispatch(call: any, name: string, args: unknown) {
    const raw = await (call.session as any).runTool({
      callId: 'call-1',
      name,
      arguments: JSON.stringify(args),
    });
    return JSON.parse(raw) as { error?: string };
  }

  it('reschedule_visit reaches the real handler and returns its deterministic ownership error, not "No handler registered"', async () => {
    const call = buildCall();
    call.voiceEngine = 'live';
    call.createSession('live-tag');

    const result = await dispatch(call, 'reschedule_visit', {
      appointmentIds: ['unserved-1', 'unserved-2'],
      date: '2025-10-01',
    });

    expect(result.error).toMatch(/please call list_appointments/i);
    expect(result.error).not.toMatch(/no handler registered/i);
  });

  it('cancel_visit reaches the real handler and returns its deterministic ownership error, not "No handler registered"', async () => {
    const call = buildCall();
    call.voiceEngine = 'live';
    call.createSession('live-tag');

    const result = await dispatch(call, 'cancel_visit', {
      appointmentIds: ['unserved-1', 'unserved-2'],
    });

    expect(result.error).toMatch(/please call list_appointments/i);
    expect(result.error).not.toMatch(/no handler registered/i);
  });

  it('book_visit reaches the real handler and returns its deterministic closed-day error, not "No handler registered"', async () => {
    const call = buildCall();
    call.voiceEngine = 'live';
    call.createSession('live-tag');

    // business.json: Sunday closed. 2025-10-05 is a Sunday (same fixture date
    // used by twilioStream.toolNotes.test.ts).
    const result = await dispatch(call, 'book_visit', {
      services: [{ serviceName: 'Lash Lift' }, { serviceName: 'Brow Wax' }],
      date: '2025-10-05',
    });

    expect(result.error).toMatch(/closed on that date/i);
    expect(result.error).not.toMatch(/no handler registered/i);
  });
});
