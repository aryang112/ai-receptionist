import { env, isVoiceTestMode } from '../config/env.js';
import { resetSimulatedPhorestOverlay } from '../services/phorest.simulated.js';
let activeCalls = 0;
export function trackVoiceCall(): () => void {
  activeCalls += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeCalls -= 1;
    }
  };
}
export function voiceTestStatus() {
  return {
    enabled: isVoiceTestMode(),
    activeCalls,
    engine: env.VOICE_ENGINE,
    backendModel: env.OPENAI_LIVE_BACKEND_MODEL,
    effort: env.OPENAI_LIVE_BACKEND_EFFORT ?? 'default',
    writes: env.PHOREST_WRITE_MODE,
    callerAccess: isVoiceTestMode() ? 'allowlist' : 'all',
    ownerTransfers: isVoiceTestMode() ? 'simulate' : env.OWNER_TRANSFER_MODE,
    ownerNotifications: isVoiceTestMode() ? 'simulate' : env.OWNER_SMS_MODE,
    allowedCallerCount: env.VOICE_TEST_ALLOWED_PHONES.split(',').filter((s) =>
      s.trim()
    ).length,
  };
}
export function selectVoiceTestVariant(variant: 'terra' | 'luna' | 'realtime') {
  if (!isVoiceTestMode())
    throw new Error(
      'Variant switching is available only in simulated test mode.'
    );
  if (activeCalls > 0)
    throw new Error(
      'Wait for active calls to finish before changing the test variant.'
    );
  env.VOICE_ENGINE = variant === 'realtime' ? 'realtime' : 'live';
  if (variant !== 'realtime')
    env.OPENAI_LIVE_BACKEND_MODEL =
      variant === 'terra' ? 'gpt-5.6-terra' : 'gpt-5.6-luna';
  env.OPENAI_LIVE_BACKEND_EFFORT = undefined;
  resetSimulatedPhorestOverlay();
  return { ...voiceTestStatus(), overlayReset: true, persisted: false };
}
