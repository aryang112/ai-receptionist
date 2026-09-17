// src/tests/smsAgent.test.ts
//
// Locks in the request shape of runSmsAgent() after its 2026-09-16 migration
// from OpenAI chat completions (gpt-4.1) to the Responses API
// (openai.responses.create) on gpt-5.6-terra with reasoning: { effort }.
// gpt-5.6 rejects function tools together with reasoning on chat completions
// (400, verified live) — the Responses API is the only surface that accepts
// both, so this file pins: the top-level request fields (model, reasoning,
// store, tool_choice, instructions, tools), the function_call ->
// function_call_output round trip, the MAX_TOOL_ROUNDS forced-text-answer
// behavior, and that a gpt-4.x fallback model does not send `reasoning`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmsThread } from '../services/smsStore.js';

// `vi.hoisted` guarantees these exist by the time the (also hoisted)
// `vi.mock` factories below run, regardless of variable-naming heuristics —
// a plain `const xMock = vi.fn()` next to `vi.mock(...)` proved order-
// dependent in this vitest version (booking.js's factory saw
// `suggestSlotsMock` before initialization even though openai's identically-
// shaped `createMock` didn't), so this is the robust form.
const { createMock, suggestSlotsMock, bookAppointmentMock, sendOwnerSmsMock } =
  vi.hoisted(() => ({
    createMock: vi.fn(),
    suggestSlotsMock: vi.fn(),
    bookAppointmentMock: vi.fn(),
    sendOwnerSmsMock: vi.fn().mockResolvedValue({ queued: true }),
  }));

// Mock the whole 'openai' package with a default-export class, mirroring
// ownerSms.test.ts's `vi.mock('twilio', () => ({ default: factoryMock }))`
// pattern for a default-export SDK. smsAgent.ts's module-scope `getClient()`
// memoizes `new OpenAI(...)` and only calls `.responses.create(...)` on it —
// nothing else on the client is touched.
vi.mock('openai', () => {
  class MockOpenAI {
    responses = { create: createMock };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI };
});

// Same convention as digest.test.ts: mock the collaborator modules entirely
// rather than reaching into what they call (Phorest et al).
vi.mock('../services/booking.js', () => ({
  suggestSlots: suggestSlotsMock,
  bookAppointment: bookAppointmentMock,
}));

vi.mock('../services/ownerSms.js', () => ({
  sendOwnerSms: sendOwnerSmsMock,
}));

import { runSmsAgent, MAX_SMS_CHARS } from '../services/smsAgent.js';
import { env } from '../config/env.js';

function makeThread(overrides: Partial<SmsThread> = {}): SmsThread {
  const now = Date.now();
  return {
    phone: '+14105551234',
    state: 'active',
    ref: 'A7',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A Responses-API turn that produced a final text answer, no tool calls. */
function textResponse(text: string) {
  return {
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    output_text: text,
  };
}

/** A Responses-API turn that asked to call one function tool. */
function functionCallResponse(
  callId: string,
  name: string,
  args: Record<string, unknown>
) {
  return {
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      },
    ],
    output_text: '',
  };
}

const EXPECTED_TOOL_NAMES = [
  'check_availability',
  'book_appointment',
  'list_my_appointments',
  'reschedule_appointment',
  'cancel_appointment',
  'escalate_to_owner',
];

describe('runSmsAgent — Responses API request shape (2026-09-16 gpt-4.1 -> gpt-5.6-terra migration)', () => {
  const originalApiKey = env.OPENAI_API_KEY;
  const originalModel = env.OPENAI_SMS_MODEL;
  const originalEffort = env.OPENAI_SMS_EFFORT;

  beforeEach(() => {
    env.OPENAI_API_KEY = 'test-key';
    createMock.mockReset();
    suggestSlotsMock.mockReset();
    bookAppointmentMock.mockReset();
    sendOwnerSmsMock.mockClear();
  });

  afterEach(() => {
    env.OPENAI_API_KEY = originalApiKey;
    env.OPENAI_SMS_MODEL = originalModel;
    env.OPENAI_SMS_EFFORT = originalEffort;
  });

  it('talks to the Responses API with the configured model and reasoning effort (2026-09-16: gpt-5.6 rejects function tools on chat completions)', async () => {
    createMock.mockResolvedValueOnce(textResponse('Yes, 10:15 AM works.'));

    const thread = makeThread();
    const result = await runSmsAgent(
      thread,
      'anything Thursday for brow threading?',
      false
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0]?.[0] as any;

    expect(call.model).toBe(env.OPENAI_SMS_MODEL);
    expect(call.reasoning).toEqual({ effort: env.OPENAI_SMS_EFFORT });
    expect(call.store).toBe(false);
    expect(call.tool_choice).toBe('auto');
    expect(typeof call.instructions).toBe('string');
    expect(call.instructions.length).toBeGreaterThan(0);
    expect(call.instructions).toContain('Erica');

    expect(Array.isArray(call.tools)).toBe(true);
    for (const tool of call.tools) {
      expect(tool.type).toBe('function');
      expect(typeof tool.name).toBe('string');
      // Wire shape is flat (Responses API) — never nested chat-completions
      // style under a `function` key.
      expect(tool.function).toBeUndefined();
    }
    const names = new Set(call.tools.map((t: any) => t.name));
    expect(names).toEqual(new Set(EXPECTED_TOOL_NAMES));

    expect(result.reply).toBe('Yes, 10:15 AM works.');
  });

  it('completes a tool round-trip: function_call → handler → function_call_output in the next request', async () => {
    createMock
      .mockResolvedValueOnce(
        functionCallResponse('call_1', 'check_availability', {
          serviceName: 'brow threading',
          date: '2026-09-17',
        })
      )
      .mockResolvedValueOnce(
        textResponse(
          'Brow threading is open Thursday at 10:15 AM, 1:30 PM, or 4:45 PM — want one?'
        )
      );
    suggestSlotsMock.mockResolvedValueOnce({
      service: { name: 'Brow Threading', price: 12 },
      date: '2026-09-17',
      slots: ['10:15 AM', '1:30 PM', '4:45 PM'],
    });

    const thread = makeThread();
    const result = await runSmsAgent(
      thread,
      'anything Thursday for brow threading?',
      false
    );

    expect(suggestSlotsMock).toHaveBeenCalledWith({
      serviceName: 'brow threading',
      date: '2026-09-17',
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    const secondCall = createMock.mock.calls[1]?.[0] as any;
    const input: any[] = secondCall.input;
    const fnCallIndex = input.findIndex(
      (item) => item.type === 'function_call' && item.call_id === 'call_1'
    );
    expect(fnCallIndex).toBeGreaterThanOrEqual(0);
    const outputItem = input[fnCallIndex + 1];
    expect(outputItem.type).toBe('function_call_output');
    expect(outputItem.call_id).toBe('call_1');
    expect(outputItem.output).toContain('10:15 AM');

    expect(result.toolsUsed).toEqual(['check_availability']);
    expect(result.reply).toBe(
      'Brow threading is open Thursday at 10:15 AM, 1:30 PM, or 4:45 PM — want one?'
    );
  });

  it('forces a plain text answer once the tool budget is spent (tool_choice none on the last round)', async () => {
    createMock.mockImplementation(async () =>
      functionCallResponse('call_x', 'check_availability', {
        serviceName: 'brow threading',
        date: '2026-09-17',
      })
    );
    suggestSlotsMock.mockResolvedValue({
      service: { name: 'Brow Threading', price: 12 },
      date: '2026-09-17',
      slots: ['10:15 AM'],
    });

    const thread = makeThread();
    const result = await runSmsAgent(
      thread,
      'anything Thursday for brow threading?',
      false
    );

    // MAX_TOOL_ROUNDS (3) + 1 forced-final round = 4 requests.
    expect(createMock).toHaveBeenCalledTimes(4);
    expect((createMock.mock.calls[3]?.[0] as any).tool_choice).toBe('none');
    // The model never produced text (it kept calling the tool even on the
    // forced round), so there is nothing usable to send the client.
    expect(result.reply).toBeNull();
  });

  it('does not send a reasoning field for a gpt-4.x fallback model', async () => {
    env.OPENAI_SMS_MODEL = 'gpt-4.1';
    createMock.mockResolvedValueOnce(textResponse('Sure, see you then!'));

    const thread = makeThread();
    await runSmsAgent(thread, 'can we do 2pm instead?', false);

    const call = createMock.mock.calls[0]?.[0] as any;
    expect(call).not.toHaveProperty('reasoning');
  });

  it('caps the reply at MAX_SMS_CHARS', async () => {
    const longText = 'a'.repeat(500);
    createMock.mockResolvedValueOnce(textResponse(longText));

    const thread = makeThread();
    const result = await runSmsAgent(thread, 'tell me everything', false);

    expect(result.reply?.length).toBe(MAX_SMS_CHARS);
  });
});
