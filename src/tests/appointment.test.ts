import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { appointment } from '../routes/appointment.js';

const app = express();
app.use(express.json());
app.use('/api', appointment);

describe('appointment routes', () => {
  it('suggest returns slots', async () => {
    const r = await request(app)
      .post('/api/suggest')
      .send({ serviceName: 'Eyebrow', date: '2025-10-01' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.slots)).toBe(true);
  });

  it('book returns appointmentId', async () => {
    const r = await request(app)
      .post('/api/book')
      .send({ serviceName: 'Eyebrow', date: '2025-10-01', time: '13:20', customer: { name: 'Alice' }});
    expect(r.status).toBe(200);
    expect(r.body.appointment?.appointmentId).toBeDefined();
  });
});
