import express from 'express';
import { appointment } from './routes/appointment.js';
import { metadata } from './routes/metadata.js';
import cors from 'cors';
import helmet from 'helmet';
import { twilioVoice } from './routes/twilio.js';


const app = express();
app.use(express.json());
app.use(helmet());
app.use(cors());
app.use('/api', appointment);
app.use('/api', metadata);
app.use(express.urlencoded({ extended: false }));
app.use('/twilio', twilioVoice);
// log incoming requests so we see traffic
app.use((req, _res, next) => { console.log('REQ', req.method, req.url); next(); });

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
app.listen(PORT, () => console.log('Server up on', PORT));
