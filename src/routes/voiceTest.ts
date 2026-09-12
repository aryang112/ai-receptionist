import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import {
  voiceTestStatus,
  selectVoiceTestVariant,
} from '../voice/testControl.js';
export const voiceTestRouter = express.Router();
// Bearer-only and fail-closed in every environment; do not accept ambient cookies
// or URL tokens on the state-changing comparison endpoint.
voiceTestRouter.use((req, res, next) => {
  const actual = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  if (
    !env.ADMIN_TOKEN ||
    !actual ||
    !timingSafeEqual(
      createHash('sha256').update(actual).digest(),
      createHash('sha256').update(env.ADMIN_TOKEN).digest()
    )
  ) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  next();
});
voiceTestRouter.get('/', (_req, res) => res.json(voiceTestStatus()));
voiceTestRouter.post('/variant', (req, res) => {
  const variant = req.body?.variant;
  if (!['terra', 'luna', 'realtime'].includes(variant)) {
    res.status(400).json({ error: 'variant must be terra, luna, or realtime' });
    return;
  }
  try {
    res.json(selectVoiceTestVariant(variant));
  } catch (error) {
    res
      .status(409)
      .json({
        error: error instanceof Error ? error.message : 'Variant unavailable',
      });
  }
});
