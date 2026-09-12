import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { env } from '../config/env.js';
import { voiceTestRouter } from '../routes/voiceTest.js';
import {
  selectVoiceTestVariant,
  trackVoiceCall,
} from '../voice/testControl.js';
describe('test variant control', () => {
  it('requires explicit bearer, simulation mode and zero active calls', async () => {
    const old = {
      token: env.ADMIN_TOKEN,
      mode: env.PHOREST_WRITE_MODE,
      engine: env.VOICE_ENGINE,
      model: env.OPENAI_LIVE_BACKEND_MODEL,
    };
    let release: (() => void) | undefined;
    try {
      env.ADMIN_TOKEN = 'test-only-token';
      env.PHOREST_WRITE_MODE = 'simulate';
      const app = express();
      app.use(express.json());
      app.use('/test', voiceTestRouter);
      expect(
        (await request(app).post('/test/variant').send({ variant: 'luna' }))
          .status
      ).toBe(401);
      expect(
        (
          await request(app)
            .post('/test/variant?token=test-only-token')
            .send({ variant: 'luna' })
        ).status
      ).toBe(401);
      const changed = await request(app)
        .post('/test/variant')
        .set('Authorization', 'Bearer test-only-token')
        .send({ variant: 'luna' });
      expect(changed.status).toBe(200);
      expect(changed.body.backendModel).toBe('gpt-5.6-luna');
      expect(changed.body.overlayReset).toBe(true);
      release = trackVoiceCall();
      expect(() => selectVoiceTestVariant('terra')).toThrow(/active calls/);
      release();
      release();
      expect(selectVoiceTestVariant('realtime').engine).toBe('realtime');
      env.PHOREST_WRITE_MODE = 'real';
      expect(() => selectVoiceTestVariant('terra')).toThrow(/simulated/);
    } finally {
      release?.();
      env.ADMIN_TOKEN = old.token;
      env.PHOREST_WRITE_MODE = old.mode;
      env.VOICE_ENGINE = old.engine;
      env.OPENAI_LIVE_BACKEND_MODEL = old.model;
    }
  });
});
