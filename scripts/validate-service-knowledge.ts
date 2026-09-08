import 'dotenv/config';
import { realPhorest } from '../src/services/phorest.client.js';
import {
  getServiceInformation,
  getServiceKnowledgeAuditSummary,
} from '../src/services/serviceKnowledge.js';

const services = await realPhorest.listServices();
const mapped: string[] = [];
const ambiguous: string[] = [];
const unmapped: string[] = [];

for (const service of services) {
  const result = getServiceInformation({
    serviceName: service.name,
    topics: ['overview'],
  });
  if (result.status === 'ambiguous') ambiguous.push(service.name);
  else if ('service' in result) mapped.push(service.name);
  else unmapped.push(service.name);
}

console.log(
  JSON.stringify(
    {
      catalogServices: services.length,
      mappedToKnowledgeFamily: mapped.length,
      ambiguous,
      unmapped,
      knowledge: getServiceKnowledgeAuditSummary(),
      note: 'Mapping coverage does not mean every topic is documented. Prices, durations, bookability, and availability remain live Phorest data.',
    },
    null,
    2
  )
);
if (ambiguous.length) process.exitCode = 1;
