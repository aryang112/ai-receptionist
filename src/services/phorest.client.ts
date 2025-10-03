// src/services/phorest.client.ts
import type { PhorestPort, Service, SlotISO } from './phorest.types.js';
import { env } from '../config/env.js';

/**
 * REAL PHOREST CLIENT (placeholder)
 * When keys arrive, implement these with HTTP calls using fetch (undici).
 *
 * Env expected:
 *   PHOREST_BASE_URL
 *   PHOREST_API_USERNAME
 *   PHOREST_API_SECRET
 *   PHOREST_BUSINESS_ID
 *   PHOREST_BRANCH_ID
 */
export const realPhorest: PhorestPort = {
  async listServices(): Promise<Service[]> {
    throw new Error('Phorest client not implemented yet. (listServices)');
  },

  async getAvailability(_serviceId: string, _date: string): Promise<SlotISO[]> {
    throw new Error('Phorest client not implemented yet. (getAvailability)');
  },

  async createAppointment(
    _serviceId: string,
    _startIso: string,
    _customer: { name: string; phone?: string; email?: string }
  ): Promise<{ appointmentId: string }> {
    throw new Error('Phorest client not implemented yet. (createAppointment)');
  },

  async updateAppointment(
    _appointmentId: string,
    _newStartIso: string
  ): Promise<{ appointmentId: string }> {
    throw new Error('Phorest client not implemented yet. (updateAppointment)');
  },

  async cancelAppointment(
    _appointmentId: string
  ): Promise<{ appointmentId: string; cancelled: true }> {
    throw new Error('Phorest client not implemented yet. (cancelAppointment)');
  }
};
