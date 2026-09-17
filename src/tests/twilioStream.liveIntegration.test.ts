import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let isMoreHelpOfferText: typeof import('../realtime/twilioStream.js').isMoreHelpOfferText;

beforeAll(async () => {
  ({ TwilioRealtimeCall, isMoreHelpOfferText } = await import(
    '../realtime/twilioStream.js'
  ));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function buildCall() {
  const sent: Array<Record<string, any>> = [];
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: vi.fn(),
    on: vi.fn(),
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: vi.fn(),
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    getCurrentResponseId: vi.fn(() => null),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return { call, sent };
}

describe('GPT-Live Twilio control boundaries', () => {
  it('preserves the continuous Live stream on barge-in', () => {
    const { call, sent } = buildCall();
    call.voiceEngine = 'live';
    call.liveOutputActive = true;
    call.markQueue = ['live-1'];
    call.responseStartTimestamp = 1_000;
    call.latestMediaTimestamp = 1_300;

    call.handleBargeIn();

    expect(call.bargeInEpoch).toBe(1);
    expect(call.session.truncateActiveResponse).not.toHaveBeenCalled();
    expect(sent.some((event) => event.event === 'clear')).toBe(false);
    expect(call.markQueue).toEqual(['live-1']);
    expect(call.responseStartTimestamp).toBe(1_000);
  });

  it('keeps Realtime truncation and Twilio clear behavior unchanged', () => {
    const { call, sent } = buildCall();
    call.voiceEngine = 'realtime';
    call.markQueue = ['responsePart'];
    call.responseStartTimestamp = 1_000;
    call.latestMediaTimestamp = 1_300;

    call.handleBargeIn();

    expect(call.bargeInEpoch).toBe(1);
    expect(call.session.truncateActiveResponse).toHaveBeenCalledWith(300);
    expect(sent).toContainEqual({ event: 'clear', streamSid: 'STREAMSID' });
    expect(call.markQueue).toEqual([]);
    expect(call.responseStartTimestamp).toBeNull();
  });

  it('replaces a timed-out LOADING caller lookup with a clean miss', async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: null) => void;
    vi.spyOn(phorest, 'lookupCustomerByPhone').mockReturnValue(
      new Promise((resolve) => (resolveLookup = resolve))
    );
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.sessionReady = false;

    const initialLookup = call.prepareCallerContext('+14435551234');
    await vi.advanceTimersByTimeAsync(700);
    await initialLookup;
    expect(call.pendingCallerContext).toContain('caller_id_match: LOADING');

    resolveLookup(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(call.pendingCallerContext).toContain('caller_id_match: NONE');
    expect(call.pendingCallerContext).not.toContain('LOADING');
  });

  it('does not treat Live silence frames as a post-end_call goodbye segment', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.outboundAudioEpoch = 4;
    call.liveOutputActive = false;

    let resolved: boolean | undefined;
    const waiting = call
      .waitForGoodbyeToStart(1_000, 4, null, 0)
      .then((value: boolean) => {
        resolved = value;
      });

    // Live forwards continuous PCMU, including silence. The controller only
    // advances its epoch from the adapter's acoustic speech-start callback.
    call.sendAudioToTwilio(Buffer.alloc(160, 0xff).toString('base64'));
    await vi.advanceTimersByTimeAsync(100);
    expect(call.outboundAudioEpoch).toBe(4);
    expect(resolved).toBeUndefined();

    call.liveOutputActive = true;
    call.outboundAudioEpoch += 1;
    call.sendAudioToTwilio(Buffer.alloc(160, 0).toString('base64'));
    await vi.advanceTimersByTimeAsync(50);
    await waiting;

    expect(resolved).toBe(true);
  });
});

describe('GPT-Live native end_call', () => {
  function stageCurrentFarewell(call: any, active: boolean) {
    call.voiceEngine = 'live';
    call.lastCallerSpeechStoppedAt = Date.now() - 4_000;
    call.liveLastOutputStartedAt = Date.now();
    call.liveClosingText = [{ ts: Date.now(), text: 'Take care.' }];
    call.liveOutputActive = active;
    call.markQueue = active ? [] : ['live-1'];
  }

  it('waits for a requested farewell and refuses a silent hangup when none arrives', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.lastCallerSpeechStoppedAt = Date.now();
    call.liveLastOutputStartedAt = Date.now() - 1_000;

    const result = await call.handleEndCall({ reason: 'done' });

    expect(result).toMatchObject({ ending: true });
    expect(call.modelEndCallPending).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.session.requestResponse).not.toHaveBeenCalled();
    expect(call.closed).toBe(false);
  });

  it('does not mistake a current okay backchannel for the farewell', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, false);
    call.liveClosingText = [{ ts: Date.now(), text: 'Okay.' }];
    const result = await call.handleEndCall({ reason: 'done' });
    expect(result).toMatchObject({ ending: true });
    await vi.advanceTimersByTimeAsync(15000);
    expect(call.closed).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
  });

  it('drains the current farewell and closes without requesting a second response', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, false);

    const result = await call.handleEndCall({ reason: 'done' });
    expect(result).toMatchObject({ ending: true });
    expect(call.session.requestResponse).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(call.transferring).toBe(true);
    await call.handleMessage(
      Buffer.from(JSON.stringify({ event: 'mark', mark: { name: 'live-1' } }))
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(call.closed).toBe(true);
    expect(call.session.requestResponse).not.toHaveBeenCalled();
    expect(call.session.close).toHaveBeenCalledTimes(1);
  });

  it('aborts when the caller starts a new turn during farewell drain', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, true);

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    call.handleCallerSpeechStarted();
    call.handleCallerSpeechStopped();
    call.liveOutputActive = false;
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(50);

    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.liveOutputCommittedClosed).toBe(false);
  });

  it('leaves the call open when Live playback does not drain by the cap', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, true);

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(6_050);

    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.liveOutputCommittedClosed).toBe(false);
    expect(call.session.close).not.toHaveBeenCalled();
  });
});

describe('Live account lookup uses available contact information', () => {
  it('uses the calling number on an explicit no-argument lookup without a prefetch match', async () => {
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.callerFrom = '+12025550198';
    const lookup = vi
      .spyOn(phorest, 'lookupCustomerByPhone')
      .mockResolvedValue(null);
    const result = await call.handleLookupCustomer({});
    expect(lookup).toHaveBeenCalledWith('2025550198');
    expect(result.found).toBe(false);
    expect(result.note).toContain('Use a supplied full name next');
  });

  it('searches a supplied name instead of substituting the caller number or a prefetched person', async () => {
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.callerFrom = '+12025550198';
    call.prefetch = {
      clientId: 'other-client',
      firstName: 'Other',
      lastName: 'Person',
    };
    const phone = vi.spyOn(phorest, 'lookupCustomerByPhone');
    const name = vi
      .spyOn(phorest, 'lookupCustomerByName')
      .mockResolvedValue([
        { clientId: 'requested-client', firstName: 'Test', lastName: 'Person' },
      ]);
    const result = await call.handleLookupCustomer({
      firstName: 'Test',
      lastName: 'Person',
    });
    expect(phone).not.toHaveBeenCalled();
    expect(name).toHaveBeenCalledWith('Test', 'Person');
    expect(result).toMatchObject({
      found: true,
      clientId: 'requested-client',
      matchedBy: 'name',
    });
  });

  it('keeps an explicitly supplied different number authoritative', async () => {
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.callerFrom = '+12025550198';
    const lookup = vi
      .spyOn(phorest, 'lookupCustomerByPhone')
      .mockResolvedValue(null);
    await call.handleLookupCustomer({ phone: '2025550199' });
    expect(lookup).toHaveBeenCalledWith('2025550199');
    expect(lookup).not.toHaveBeenCalledWith('2025550198');
  });

  it('does not change the Realtime no-argument miss behavior', async () => {
    const { call } = buildCall();
    call.voiceEngine = 'realtime';
    call.callerFrom = '+12025550198';
    const lookup = vi.spyOn(phorest, 'lookupCustomerByPhone');
    const result = await call.handleLookupCustomer({});
    expect(lookup).not.toHaveBeenCalled();
    expect(result.found).toBe(false);
  });
});

// Workstream E (2026-09-16): the mechanics behind "ask once whether they
// need anything else, never twice, and never after a goodbye" move into
// server state. The server never sees caller text on the Live path, but it
// does see Erica's own output text (the same stream liveClosingText uses),
// so it can at least know whether SHE has already made the offer.
describe('isMoreHelpOfferText — "anything else" offer detection', () => {
  it('matches common phrasings of the offer', () => {
    expect(
      isMoreHelpOfferText('Is there anything else I can help you with?')
    ).toBe(true);
    expect(isMoreHelpOfferText('Anything else for you today?')).toBe(true);
    expect(isMoreHelpOfferText('Is there something else you need?')).toBe(true);
  });

  it('does not match ordinary confirmations, results, or farewells', () => {
    expect(isMoreHelpOfferText('Okay.')).toBe(false);
    expect(isMoreHelpOfferText('Your brow threading is booked for 4 PM.')).toBe(
      false
    );
    expect(isMoreHelpOfferText('Goodbye, take care.')).toBe(false);
  });
});

describe('GPT-Live more-help offer — central tool-result annotation', () => {
  function buildTrackedCall() {
    const registered = new Map<string, (args: unknown) => Promise<any>>();
    const socket: any = {
      readyState: WebSocket.OPEN,
      send: () => {},
      close: vi.fn(),
      on: vi.fn(),
    };
    const call: any = new TwilioRealtimeCall(socket);
    call.session = {
      appendTwilioAudio: vi.fn(),
      truncateActiveResponse: vi.fn(),
      registerTool: (name: string, fn: (args: unknown) => Promise<any>) => {
        registered.set(name, fn);
      },
      close: vi.fn(),
    };
    call.streamSid = 'STREAMSID';
    call.callSid = 'CA_offer_test';
    if (call.preAuthTimer) {
      clearTimeout(call.preAuthTimer);
      call.preAuthTimer = undefined;
    }
    return { call, registered };
  }

  function getTool(
    registered: Map<string, (args: unknown) => Promise<any>>,
    name: string
  ) {
    const fn = registered.get(name);
    if (!fn) throw new Error(`tool not registered: ${name}`);
    return fn;
  }

  it('leaves a tool result untouched before the offer, then annotates once Erica has made it', async () => {
    const { call, registered } = buildTrackedCall();
    call.registerTrackedTool('probe_tool', async () => ({
      ok: true,
      note: 'existing note',
    }));
    const probe = getTool(registered, 'probe_tool');

    const before = await probe({});
    expect(before).toEqual({ ok: true, note: 'existing note' });
    expect(before.moreHelpAlreadyOffered).toBeUndefined();

    call.recordLiveFragment('erica', {
      delta: 'Anything else I can help with?',
    });

    const after = await probe({});
    expect(after.moreHelpAlreadyOffered).toBe(true);
    expect(after.note).toBe(
      'existing note You have already asked whether the caller needs anything else on this call. Do not ask again; when they are done, close.'
    );
  });

  it('adds a bare note when the underlying result had none', async () => {
    const { call, registered } = buildTrackedCall();
    call.registerTrackedTool('bare_tool', async () => ({ ok: true }));
    const bare = getTool(registered, 'bare_tool');

    call.recordLiveFragment('erica', {
      delta: 'Is there something else you need?',
    });

    const result = await bare({});
    expect(result.moreHelpAlreadyOffered).toBe(true);
    expect(result.note).toBe(
      'You have already asked whether the caller needs anything else on this call. Do not ask again; when they are done, close.'
    );
  });

  it('leaves an ending:true result alone even after the offer', async () => {
    const { call, registered } = buildTrackedCall();
    call.registerTrackedTool('closing_tool', async () => ({
      ending: true,
      note: 'The farewell has been spoken.',
    }));
    const closingTool = getTool(registered, 'closing_tool');

    call.recordLiveFragment('erica', {
      delta: 'Anything else I can help with?',
    });

    const result = await closingTool({});
    expect(result).toEqual({
      ending: true,
      note: 'The farewell has been spoken.',
    });
    expect(result.moreHelpAlreadyOffered).toBeUndefined();
  });

  it('detects the offer even split across two streamed fragments', async () => {
    const { call, registered } = buildTrackedCall();
    call.registerTrackedTool('probe_tool', async () => ({ ok: true }));
    const probe = getTool(registered, 'probe_tool');

    call.recordLiveFragment('erica', { delta: 'Anything' });
    call.recordLiveFragment('erica', { delta: ' else for you today?' });

    const result = await probe({});
    expect(result.moreHelpAlreadyOffered).toBe(true);
  });
});
