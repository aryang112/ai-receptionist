import { DateTime } from 'luxon';
import { buildInstructions } from '../src/realtime/twilioStream.js';
const tz = 'America/New_York';
const when = process.argv[2] ?? DateTime.now().setZone(tz).toISO();
const now = DateTime.fromISO(when, { zone: tz });
const services = [
  { id: 's1', name: 'Eyebrow Threading', price: 15, durationMin: 15 },
  { id: 's2', name: 'Lash Lift', price: 150, durationMin: 60 },
  { id: 's3', name: 'Brow Lamination', price: 70, durationMin: 45 },
] as any;
console.log(
  buildInstructions(now, services, {
    transferFailback: process.argv[3] === 'fb',
  })
);
