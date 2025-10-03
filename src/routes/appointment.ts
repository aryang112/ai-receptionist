// src/routes/appointment.ts
import express from 'express';
import { phorest } from '../services/phorest.js';
import { suggestSlots, bookAppointment } from '../services/booking.js';


export const appointment = express.Router();

// POST /api/suggest  { serviceName, date }
appointment.post('/suggest', async (req, res) => {
  try {
    const result = await suggestSlots(req.body);
    res.json(result);
  } catch (e: any) {
    if (e?.issues) return res.status(400).json({ error: 'Invalid input', details: e.issues });
    if (e.message === 'Service not found') return res.status(404).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Internal error' });
  }
});

appointment.post('/book', async (req, res) => {
  try {
    const result = await bookAppointment(req.body);
    res.json(result);
  } catch (e: any) {
    if (e?.issues) return res.status(400).json({ error: 'Invalid input', details: e.issues });
    if (e.message === 'Service not found') return res.status(404).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Internal error' });
  }
});