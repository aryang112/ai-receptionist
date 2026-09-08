import { afterEach, describe, expect, it, vi } from 'vitest';
import { phorest } from '../services/phorest.js';
import { resolveService } from '../services/booking.js';

const catalog = [
  ['brow', 'Brow Threading'],
  ['lip', 'Lip Threading'],
  ['brow-tint', 'Eyebrow Tinting'],
  ['lash-tint', 'Lash Tinting'],
  ['lift', 'Lash Lift'],
  ['extensions', 'Eyelash Extensions - Regular'],
  // "for" in an unrelated service must not change how filler is treated.
  ['wax', 'Underarm Wax for Beginners'],
].map(([id, name]) => ({ id: id!, name: name!, price: 25, durationMin: 20 }));

afterEach(() => vi.restoreAllMocks());

describe('focused brow and lash vocabulary', () => {
  it.each([
    ['eyebrow threading', 'brow'],
    ['eyebrows threaded', 'brow'],
    ['I want to do my eyebrows', 'brow'],
    ['can I get my brows done please', 'brow'],
    ['threading for my eyebrows', 'brow'],
    ['eyelash tinting', 'lash-tint'],
    ['lash tint', 'lash-tint'],
    ['get my eyelashes tinted', 'lash-tint'],
    ['tint my brows', 'brow-tint'],
    ['eyelash lift', 'lift'],
    ['lash extensions', 'extensions'],
  ])('%s resolves to the correct service identity', async (phrase, id) => {
    const list = vi.spyOn(phorest, 'listServices').mockResolvedValue(catalog);
    expect(await resolveService(phrase)).toMatchObject({
      kind: 'match',
      service: { id },
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each(['threading', 'tinting', 'tint', 'lashes'])(
    '%s retains ambiguity',
    async (phrase) => {
      vi.spyOn(phorest, 'listServices').mockResolvedValue(catalog);
      expect(await resolveService(phrase)).toMatchObject({ kind: 'ambiguous' });
    }
  );

  it.each([
    'henna brows',
    'get my henna brows done',
    'eyebrow tattoo',
    'eyeball threading',
    'not lash tinting',
    'lash tinting removal',
    'brow lami',
    'brow perm',
    'legs waxed',
  ])('%s never becomes an unsupported substitution', async (phrase) => {
    vi.spyOn(phorest, 'listServices').mockResolvedValue(catalog);
    expect(await resolveService(phrase)).toMatchObject({ kind: 'notOffered' });
  });

  it('keeps distinct records ambiguous when synonyms normalize their names equally', async () => {
    vi.spyOn(phorest, 'listServices').mockResolvedValue([
      ...catalog,
      {
        id: 'other-brow',
        name: 'Eyebrow Threading',
        price: 30,
        durationMin: 30,
      },
    ]);
    for (const phrase of [
      'eyebrow threading',
      'brows',
      'get my eyebrows threaded',
    ]) {
      const result = await resolveService(phrase);
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        expect(result.candidates.map((s) => s.id).sort()).toEqual([
          'brow',
          'other-brow',
        ]);
      }
    }
  });
});
