// Print the CURRENT STATUS tail of the live prompt as rendered right now, plus
// constraint-word counts and any quoted candidate-reply lines (lessons.md).
// Run: node --env-file=.env --import tsx scripts/render-prompt.ts
import { DateTime } from 'luxon';
import { buildInstructions, buildRecognizedCallerContext, buildUnrecognizedCallerContext } from '../src/realtime/twilioStream.js';
import { getHoursStatus } from '../src/core/hours.js';
const now = DateTime.now().setZone('America/New_York');
const p = buildInstructions(now, null);
const i = p.indexOf('═══ CURRENT STATUS');
console.log('=== CURRENT STATUS TAIL (as rendered right now) ===');
console.log(p.slice(i));
console.log('=== est tokens (chars/4):', Math.round(p.length / 4));
const words = ['NEVER', 'Never', 'never', 'ALWAYS', 'Always', 'always', 'ONLY', 'Only', 'only', 'MUST', 'must', 'exactly', 'EXACTLY', 'immediately', 'IMMEDIATELY'];
const counts: Record<string, number> = {};
for (const w of words) counts[w] = (p.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length;
console.log('=== constraint-word counts ===', JSON.stringify(counts));
console.log('=== hours status for 2026-09-02 (Wed, in vacation):', JSON.stringify(getHoursStatus('2026-09-02', now)));
console.log('=== hours status for 2026-09-10 (reopen):', JSON.stringify(getHoursStatus('2026-09-10', now)));
console.log('=== quoted candidate reply lines in prompt ===');
for (const m of p.matchAll(/"([^"\n]{12,})"/g)) console.log('  ', m[1]);
