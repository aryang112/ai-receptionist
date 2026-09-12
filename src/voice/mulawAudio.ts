export type SpeechTransition = 'started' | 'stopped' | undefined;

/** Decode one G.711 mu-law byte to signed 16-bit PCM. */
function decodeMuLawSample(value: number): number {
  const decoded = ~value & 0xff;
  const sign = decoded & 0x80;
  const exponent = (decoded >> 4) & 0x07;
  const mantissa = decoded & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** Root-mean-square energy of a base64 G.711 mu-law audio payload. */
export function muLawRms(base64MuLaw: string): number {
  const audio = Buffer.from(base64MuLaw, 'base64');
  if (audio.length === 0) return 0;

  let sumSquares = 0;
  for (const byte of audio) {
    const sample = decodeMuLawSample(byte);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / audio.length);
}

export type MuLawSpeechGateOptions = {
  threshold?: number;
  speechFramesToStart?: number;
  quietFramesToStop?: number;
};

/**
 * A small hysteresis gate for activity signals only. A `stopped` transition is
 * not a turn boundary and does not mean remote playback has completed.
 */
export class MuLawSpeechGate {
  private readonly threshold: number;
  private readonly speechFramesToStart: number;
  private readonly quietFramesToStop: number;
  private speechFrames = 0;
  private quietFrames = 0;
  private speaking = false;

  constructor(options: MuLawSpeechGateOptions = {}) {
    this.threshold = options.threshold ?? 200;
    this.speechFramesToStart = Math.max(
      1,
      Math.floor(options.speechFramesToStart ?? 1)
    );
    this.quietFramesToStop = Math.max(
      1,
      Math.floor(options.quietFramesToStop ?? 3)
    );
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  process(base64MuLaw: string): SpeechTransition {
    const active = muLawRms(base64MuLaw) > this.threshold;
    if (active) {
      this.quietFrames = 0;
      if (this.speaking) return undefined;
      this.speechFrames += 1;
      if (this.speechFrames < this.speechFramesToStart) return undefined;
      this.speechFrames = 0;
      this.speaking = true;
      return 'started';
    }

    this.speechFrames = 0;
    if (!this.speaking) return undefined;
    this.quietFrames += 1;
    if (this.quietFrames < this.quietFramesToStop) return undefined;
    this.quietFrames = 0;
    this.speaking = false;
    return 'stopped';
  }

  reset(): void {
    this.speechFrames = 0;
    this.quietFrames = 0;
    this.speaking = false;
  }
}
