import { describe, it, expect, vi } from 'vitest';

// Important: set env before importing the selector (it reads env at import time)
describe('phorest selector', () => {
  it('returns mockPhorest when USE_MOCK_PHOREST=true', async () => {
    process.env.USE_MOCK_PHOREST = 'true';

    // dynamic import AFTER setting env
    const { phorest } = await import('../services/phorest.js');
    const services = await phorest.listServices();

    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThan(0);
  });
});
