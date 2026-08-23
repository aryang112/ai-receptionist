// src/routes/metadata.ts
import express from 'express';
import { phorest } from '../services/phorest.js';
import { businessHours as hours } from '../config/businessConfig.js';

export const metadata = express.Router();

metadata.get('/services', async (_req, res) => {
  const services = await phorest.listServices();
  res.json({ services });
});

metadata.get('/hours', (_req, res) => {
  res.json(hours);
});
