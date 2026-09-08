import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DateTime } from 'luxon';
import {
  buildInstructions,
  TOOL_DEFINITIONS,
  TwilioRealtimeCall,
} from '../realtime/twilioStream.js';
import { parseToolArgs } from '../realtime/toolSchemas.js';

describe('Realtime service-information contract', () => {
  it('keeps the OpenAI definition and Zod validator in sync', () => {
    const definition = TOOL_DEFINITIONS.find(
      (tool) => tool.name === 'get_service_information'
    );
    expect(definition).toBeDefined();
    expect(definition?.description).toMatch(/function-call-only/i);
    expect(
      parseToolArgs('get_service_information', {
        serviceName: 'brow lamination',
        topics: ['longevity', 'suitability'],
      }).success
    ).toBe(true);
    expect(
      parseToolArgs('get_service_information', {
        serviceName: 'brow lamination',
        topics: ['price'],
      }).success
    ).toBe(false);
  });

  it('requires grounded, preamble-free service answers', () => {
    const prompt = buildInstructions(
      DateTime.fromISO('2026-09-04T18:45', {
        zone: 'America/New_York',
      })
    );
    expect(prompt).toContain('═══ SERVICE KNOWLEDGE ═══');
    expect(prompt).toMatch(/MUST be ONLY the function call/i);
    expect(prompt).toMatch(/Use returned facts and qualifiers only/i);
    expect(prompt).toMatch(/at most ONE relevant, low-pressure next step/i);
    expect(prompt).toMatch(/never list alternatives, repeat, or push booking/i);
    expect(prompt).toMatch(/For highRisk, say safeResponse verbatim/i);
  });

  it('treats provider availability as public while protecting private calendars', () => {
    const prompt = buildInstructions(
      DateTime.fromISO('2026-09-04T18:45', {
        zone: 'America/New_York',
      })
    );
    expect(prompt).toMatch(
      /Provider working hours and bookable availability are public/i
    );
    expect(prompt).toMatch(
      /Never reveal personal whereabouts, private calendars/i
    );
    expect(prompt).toMatch(/reopens Thursday, September 10/i);
    expect(prompt).not.toMatch(/NEVER share anyone's schedule/i);
  });

  it('executes the real call handler without a network request', async () => {
    const socket: any = {
      readyState: WebSocket.OPEN,
      send: () => {},
      close: () => {},
      on: () => {},
    };
    const call: any = new TwilioRealtimeCall(socket);
    call.callSid = 'CA_service_knowledge_test';

    const result = await call.handleGetServiceInformation({
      serviceName: 'eyebrow tint',
      topics: ['longevity'],
    });

    expect(result.status).toBe('ok');
    expect(result.service).toBe('Eyebrow Tinting');
    expect(result.topics[0].facts[0].text).toMatch(/three to four weeks/i);
  });
});
