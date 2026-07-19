import type { Request, Response, NextFunction, RequestHandler } from 'express';
import twilio from 'twilio';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

let warnedMissingToken = false;

/**
 * Express middleware that validates Twilio's X-Twilio-Signature header so only
 * genuine Twilio requests reach our webhook routes.
 *
 * The app runs behind a proxy (`trust proxy` is set), so we reconstruct the
 * public-facing URL from the forwarded proto/host headers — that's the URL
 * Twilio signed. In tests (or with no auth token) we can't validate, so we
 * pass through rather than block legitimate local traffic.
 */
export function twilioSignature(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Cannot validate without a token — pass through (dev/test only).
    if (process.env.NODE_ENV === 'test') return next();
    if (!env.TWILIO_AUTH_TOKEN) {
      if (!warnedMissingToken) {
        warnedMissingToken = true;
        logger.warn(
          'TWILIO_AUTH_TOKEN is empty — skipping Twilio signature validation'
        );
      }
      return next();
    }

    const signature = req.header('X-Twilio-Signature') || '';
    const proto =
      req.header('x-forwarded-proto') || req.protocol || 'https';
    const host = req.header('x-forwarded-host') || req.headers.host || '';
    const fullUrl = `${proto}://${host}${req.originalUrl}`;

    const valid = twilio.validateRequest(
      env.TWILIO_AUTH_TOKEN,
      signature,
      fullUrl,
      (req.body ?? {}) as Record<string, unknown>
    );

    if (!valid) {
      logger.warn({ url: fullUrl }, 'Rejected request: invalid Twilio signature');
      res.status(403).send('Invalid Twilio signature');
      return;
    }

    next();
  };
}
