// src/services/booking.ts
import { z } from 'zod';
import { phorest } from './phorest.js';

export const SuggestSchema = z.object({
  serviceName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const BookSchema = z.object({
  serviceName: z.string().min(1),
  date: z.string().regex(/^\d{2}|\d{4}-\d{2}-\d{2}$/), // keep your pattern; just placeholder here
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
});

export async function findServiceByName(name: string) {
  const services = await phorest.listServices();
  return services.find(s => s.name.toLowerCase().includes(name.toLowerCase()));
}

export async function suggestSlots(input: z.infer<typeof SuggestSchema>) {
  const { serviceName, date } = SuggestSchema.parse(input);
  const svc = await findServiceByName(serviceName);
  if (!svc) throw new Error('Service not found');
  const slots = await phorest.getAvailability(svc.id, date);
  return { service: svc, date, slots };
}

export async function bookAppointment(input: z.infer<typeof BookSchema>) {
  const { serviceName, date, time, customer } = BookSchema.parse(input);
  const svc = await findServiceByName(serviceName);
  if (!svc) throw new Error('Service not found');

  const startIso = `${date}T${time.length === 5 ? time + ':00' : time}`;

  // ✅ remove undefined keys to satisfy exactOptionalPropertyTypes
  const customerClean: { name: string; phone?: string; email?: string } = {
    name: customer.name,
    ...(customer.phone ? { phone: customer.phone } : {}),
    ...(customer.email ? { email: customer.email } : {}),
  };

  const appointment = await phorest.createAppointment(svc.id, startIso, customerClean);
  return { service: svc, appointment };
}
