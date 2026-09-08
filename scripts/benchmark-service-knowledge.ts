import { performance } from 'node:perf_hooks';
import { getServiceInformation } from '../src/services/serviceKnowledge.js';

const cases = [
  { serviceName: 'eyebrow tint', topics: ['longevity'] },
  { serviceName: 'brow lamination', topics: ['suitability', 'longevity'] },
  { serviceName: 'lash lift', topics: ['aftercare'] },
  { serviceName: 'micro blading', topics: ['preparation', 'safety'] },
  { serviceName: 'full leg wax', topics: ['overview'] },
  { serviceName: 'oxygen facial', topics: ['aftercare'] },
] as const;

for (let index = 0; index < 500; index++) {
  getServiceInformation(cases[index % cases.length]);
}

const samples: number[] = [];
for (let index = 0; index < 20_000; index++) {
  const started = performance.now();
  getServiceInformation(cases[index % cases.length]);
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);

function percentile(p: number) {
  return samples[Math.ceil((p / 100) * samples.length) - 1] ?? 0;
}

const result = {
  lookups: samples.length,
  p50Ms: Number(percentile(50).toFixed(4)),
  p95Ms: Number(percentile(95).toFixed(4)),
  p99Ms: Number(percentile(99).toFixed(4)),
  maxMs: Number((samples.at(-1) ?? 0).toFixed(4)),
  acceptance: { p95Ms: 10, p99Ms: 25 },
};

console.log(JSON.stringify(result, null, 2));
if (result.p95Ms > 10 || result.p99Ms > 25) process.exitCode = 1;
