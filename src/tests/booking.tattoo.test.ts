import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listServices } = vi.hoisted(() => ({ listServices: vi.fn() }));
vi.mock('../services/phorest.js', () => ({ phorest: { listServices } }));

import { resolveService } from '../services/booking.js';

const fullTreatment = {
  id: 'full-treatment',
  name: 'Micro Blading/ Shading',
  price: 500,
  durationMin: 240,
};
const touchUp = {
  id: 'touch-up',
  name: 'Microblading Touch-Up (6 Months)',
  price: 250,
  durationMin: 180,
};
const threading = {
  id: 'threading',
  name: 'Brow Threading',
  price: 15,
  durationMin: 5,
};

beforeEach(() => {
  listServices.mockResolvedValue([threading, touchUp, fullTreatment]);
});

describe('owner-approved eyebrow tattoo alias', () => {
  it.each(['eyebrow tattoo', 'brow tattoo', 'eyebrows tattoo'])(
    'resolves %s to the full treatment despite the competing touch-up',
    async (phrase) => {
      expect(await resolveService(phrase)).toEqual({
        kind: 'match',
        service: fullTreatment,
      });
    }
  );

  it('preserves an explicit touch-up selection', async () => {
    expect(await resolveService(touchUp.name)).toEqual({
      kind: 'match',
      service: touchUp,
    });
  });

  it('does not substitute a touch-up or threading when the target is absent', async () => {
    listServices.mockResolvedValue([threading, touchUp]);
    expect(await resolveService('eyebrow tattoo')).toMatchObject({
      kind: 'notOffered',
    });
  });

  it.each(['eyebrow tattoo removal', 'lip tattoo'])(
    'does not broaden the alias to %s',
    async (phrase) => {
      expect(await resolveService(phrase)).toMatchObject({
        kind: 'notOffered',
      });
    }
  );
});
