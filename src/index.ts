import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { appointment } from './routes/appointment.js';
import { metadata } from './routes/metadata.js';
import { twilioVoice } from './routes/twilio.js';
import { setupTwilioRealtimeStream } from './realtime/twilioStream.js';


const app = express();
app.set('trust proxy', true); // Trust proxy headers for correct protocol detection
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// log incoming requests so we see traffic
app.use((req, _res, next) => { console.log('REQ', req.method, req.url); next(); });
app.use('/api', appointment);
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

server.listen(PORT, () => console.log('Server up on', PORT));
