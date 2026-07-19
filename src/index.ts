import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { metadata } from './routes/metadata.js';
import { twilioVoice } from './routes/twilio.js';
import { setupTwilioRealtimeStream } from './realtime/twilioStream.js';
import { rateLimiter } from './middleware/rateLimit.js';
import { assertWsAuthConfigured } from './security/wsAuth.js';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { phorest } from './services/phorest.js';

// Fail fast in production if the WS auth secret is missing — never boot with an
// unauthenticated /twilio/stream (see wsAuth.assertWsAuthConfigured / F3).
assertWsAuthConfigured();

// A single call's error must NEVER take down the server and drop every other
// live call (this is exactly how a mid-call transfer used to crash the process).
// Log and keep serving; per-call handlers already isolate their own failures.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { reason: String(reason) },
    'Unhandled promise rejection — kept process alive'
  );
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — kept process alive');
});

const app = express();
app.set('trust proxy', true); // Trust proxy headers for correct protocol detection
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// log incoming requests so we see traffic
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'REQ');
  next();
});
// Per-IP rate limiting, mounted before the routers.
app.use(
  '/twilio',
  rateLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX })
);
app.use(
  '/api',
  rateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.API_RATE_LIMIT_MAX,
  })
);
app.use('/api', metadata);
app.use('/twilio', twilioVoice);

app.get('/', (_req, res) => {
  res.status(200).type('html').send(`
    <html><body style="font-family:system-ui;padding:24px">
      <h1>AI Receptionist server is running ✅</h1>
      <p>Try the health check: <a href="/health">/health</a></p>
    </body></html>
  `);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const PORT = Number(process.env.PORT || 5050);
const server = http.createServer(app);
setupTwilioRealtimeStream(server);

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server up');
  // Warm the client phone index now so the first caller's lookup is instant
  // instead of paying a full client-list scan mid-call. No-op in mock mode.
  phorest.preloadClients?.().catch((err) => {
    logger.warn(
      { err: String(err) },
      'Client index warm-up failed (will load lazily)'
    );
  });
  // Warm the service catalog too, so the live price menu is ready before the
  // first call and the first availability check isn't a cold load.
  phorest.listServices().then(
    (s) => logger.info({ serviceCount: s.length }, 'Service catalog warmed'),
    (err) =>
      logger.warn(
        { err: String(err) },
        'Service catalog warm-up failed (will load lazily)'
      )
  );
});
