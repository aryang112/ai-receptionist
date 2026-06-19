import 'dotenv/config';
import { realPhorest } from '../src/services/phorest.client.js';
(async () => {
  const services = await realPhorest.listServices();
  const brow = services.find((s) => /^brow threading$/i.test(s.name)) || services.find((s) => /brow threading/i.test(s.name));
  console.log('service:', brow?.name, brow?.id, 'duration', brow?.durationMin);
  const slots = await realPhorest.getAvailability(brow!.id, '2026-06-19');
  console.log(`\nRAW slots returned (${slots.length}) — note format + whether any are past 7 PM:`);
  slots.forEach((s) => console.log('  ', s));
})();
