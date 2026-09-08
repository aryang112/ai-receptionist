/**
 * probe-service-phrases.ts — run an inventory of REAL caller phrasings through
 * resolveService against the catalog and show which ones dead-end.
 *
 * This is the research tool behind the 2026-09-07 "eyebrow threading -> not
 * offered" fix. The catalog changes without a deploy (Richa edits Phorest), so
 * re-run it whenever services are renamed or added:
 *
 *   npx tsx scripts/probe-service-phrases.ts          # LIVE catalog (needs .env)
 *   USE_MOCK_PHOREST=true npx tsx scripts/probe-service-phrases.ts   # mock catalog
 *
 * Read-only: one listServices() call, no writes. Exit code 1 when any phrase
 * marked `expect: 'match'` fails to resolve, so it can gate a deploy.
 *
 * How to grow it: when a call review shows Erica saying "do you mean…" or
 * "we don't offer…" for something the salon DOES do, add the caller's words
 * here first, then fix the matcher (TOKEN_SYNONYMS for a spoken variant of a
 * catalog word, SERVICE_ALIASES for a phrase that names a different service).
 */
import 'dotenv/config';
import { resolveService } from '../src/services/booking.js';
import { phorest } from '../src/services/phorest.js';

type Expect = 'match' | 'ambiguous' | 'notOffered' | 'any';
type Probe = { phrase: string; expect: Expect; note?: string };

// Phrase families a threading salon actually hears. `expect: 'any'` rows are
// there to SEE the behaviour (they depend on which services the catalog has);
// `match` rows are the contract.
const PROBES: Probe[] = [
  // ── Threading: the core service, said many ways ──────────────────────────
  { phrase: 'brow threading', expect: 'match' },
  { phrase: 'eyebrow threading', expect: 'match' },
  { phrase: 'eyebrows threading', expect: 'match' },
  { phrase: 'eyebrow', expect: 'match' },
  { phrase: 'eyebrows', expect: 'match' },
  { phrase: 'brows', expect: 'match' },
  { phrase: 'my brows', expect: 'match' },
  { phrase: 'do my brows', expect: 'match' },
  { phrase: 'get my brows done', expect: 'match' },
  { phrase: 'get my eyebrows threaded', expect: 'match' },
  { phrase: 'threading for my eyebrows', expect: 'match' },
  {
    phrase: 'eyebrow shaping',
    expect: 'any',
    note: 'shaping = threading in salon slang',
  },
  {
    phrase: 'brow cleanup',
    expect: 'any',
    note: 'cleanup / tidy-up = threading',
  },
  { phrase: 'clean up my brows', expect: 'any' },
  { phrase: 'brow touch up', expect: 'any' },
  {
    phrase: 'threading',
    expect: 'ambiguous',
    note: 'bare verb — Erica should ask which area',
  },
  { phrase: 'lip threading', expect: 'match' },
  {
    phrase: 'upper lip threading',
    expect: 'match',
    note: '"upper" is in no catalog name → dropped',
  },
  { phrase: 'upper lip', expect: 'any' },
  { phrase: 'mustache', expect: 'any', note: 'slang for upper lip' },
  { phrase: 'lip hair', expect: 'any' },
  { phrase: 'chin threading', expect: 'any' },
  { phrase: 'chin hair', expect: 'any' },
  { phrase: 'forehead threading', expect: 'any' },
  { phrase: 'sideburns', expect: 'any' },
  {
    phrase: 'side burns threading',
    expect: 'any',
    note: 'split compound (F4 collapse)',
  },
  { phrase: 'full face threading', expect: 'any' },
  { phrase: 'whole face', expect: 'any' },
  { phrase: 'face threading', expect: 'any' },
  { phrase: 'peach fuzz', expect: 'any', note: 'slang for face/cheek hair' },
  { phrase: 'neck threading', expect: 'any' },
  {
    phrase: 'eyebrows and upper lip',
    expect: 'any',
    note: 'two services in one breath — Erica books one at a time',
  },

  // ── Waxing ───────────────────────────────────────────────────────────────
  { phrase: 'wax', expect: 'ambiguous', note: 'bare → ask which area' },
  { phrase: 'waxing', expect: 'ambiguous' },
  { phrase: 'bikini wax', expect: 'match' },
  { phrase: 'bikini waxing', expect: 'match' },
  { phrase: 'bikini line', expect: 'any' },
  {
    phrase: 'brazilian',
    expect: 'any',
    note: 'a service name on its own if offered',
  },
  { phrase: 'brazilian wax', expect: 'any' },
  { phrase: 'full leg wax', expect: 'match' },
  { phrase: 'legs waxed', expect: 'any' },
  { phrase: 'half leg', expect: 'any' },
  { phrase: 'underarm wax', expect: 'any' },
  { phrase: 'armpits', expect: 'any', note: 'slang for underarm' },
  { phrase: 'arm wax', expect: 'any' },
  { phrase: 'full arms', expect: 'any' },
  { phrase: 'back wax', expect: 'any' },
  { phrase: 'chest wax', expect: 'any' },
  { phrase: 'stomach wax', expect: 'any' },
  { phrase: 'nose wax', expect: 'any' },
  {
    phrase: 'eyebrow wax',
    expect: 'any',
    note: 'if only threading is offered → notOffered is CORRECT; Erica offers threading',
  },

  // ── Tinting / henna ──────────────────────────────────────────────────────
  { phrase: 'brow tint', expect: 'match' },
  { phrase: 'eyebrow tinting', expect: 'match' },
  { phrase: 'tint my brows', expect: 'match' },
  { phrase: 'lash tint', expect: 'any' },
  { phrase: 'eyelash tinting', expect: 'any' },
  {
    phrase: 'henna brows',
    expect: 'any',
    note: 'no henna line → falls to the bare-brow alias (threading); the read-back is the safety net',
  },
  { phrase: 'brow henna', expect: 'any' },

  // ── Lifts / laminations ──────────────────────────────────────────────────
  { phrase: 'lash lift', expect: 'match' },
  { phrase: 'eyelash lift', expect: 'match' },
  {
    phrase: 'lash lamination',
    expect: 'match',
    note: 'SERVICE_ALIASES → Lash Lift',
  },
  {
    phrase: 'lash perm',
    expect: 'match',
    note: 'older name for a lash lift (SERVICE_ALIASES)',
  },
  {
    phrase: 'lash extensions',
    expect: 'any',
    note: 'NOT a lift — must not silently match Lash Lift',
  },
  { phrase: 'brow lamination', expect: 'match' },
  { phrase: 'eyebrow lamination', expect: 'match' },
  {
    phrase: 'brow lami',
    expect: 'match',
    note: 'TikTok shorthand (TOKEN_SYNONYMS)',
  },
  { phrase: 'brow perm', expect: 'match' },

  // ── Other lines / not offered ────────────────────────────────────────────
  { phrase: 'facial', expect: 'any' },
  { phrase: 'microblading', expect: 'any' },
  { phrase: 'micro blading', expect: 'any' },
  { phrase: 'permanent makeup', expect: 'any' },
  { phrase: 'makeup removal', expect: 'any' },
  { phrase: 'haircut', expect: 'notOffered' },
  { phrase: 'hair cut', expect: 'notOffered' },
  { phrase: 'massage', expect: 'notOffered' },
  { phrase: 'manicure', expect: 'notOffered' },
  { phrase: 'nails', expect: 'notOffered' },
  { phrase: 'bundle', expect: 'any', note: 'package / deal / combo' },
  { phrase: 'package', expect: 'any' },
  { phrase: 'combo', expect: 'any' },

  // ── Transcription noise seen on real calls ───────────────────────────────
  {
    phrase: 'eyeball threading',
    expect: 'any',
    note: '"eyebrow" misheard (2026-09-07 call) — notOffered is acceptable; Erica asks once',
  },
  {
    phrase: 'I brow threading',
    expect: 'match',
    note: '"eyebrow" split by the transcriber',
  },
];

(async () => {
  const catalog = await phorest.listServices();
  console.log(`Catalog: ${catalog.length} services\n`);
  const failures: string[] = [];
  for (const { phrase, expect: want, note } of PROBES) {
    const r = await resolveService(phrase);
    const detail =
      r.kind === 'match'
        ? r.service.name
        : (r.kind === 'ambiguous' ? r.candidates : r.closest)
            .map((s) => s.name)
            .join(' | ');
    const ok = want === 'any' || want === r.kind;
    if (!ok) failures.push(phrase);
    console.log(
      `${ok ? '  ' : '✗ '}${JSON.stringify(phrase).padEnd(36)} ${r.kind.padEnd(10)} ${detail}${note ? `   # ${note}` : ''}`
    );
  }
  console.log(
    failures.length
      ? `\n✗ ${failures.length} contract phrase(s) failed: ${failures.join(', ')}`
      : '\n✓ every contract phrase resolved as expected'
  );
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
