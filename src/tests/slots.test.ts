import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { isOnGrid, isOnGridValue, partitionByGrid } from '../core/slots.js';

// This module replaced snapSlotsToGrid on 2026-09-14 (the Loretta call).
// The old version ceil-rounded real Phorest starts onto a clean grid and the
// rounded value was then booked — straight into another client's appointment.
// These tests lock the new contract: SELECT, never MOVE.

const at = (hhmm: string) =>
  DateTime.fromISO(`2026-09-15T${hhmm}:00`, { zone: 'America/New_York' });
const hhmm = (list: DateTime[]) => list.map((d) => d.toFormat('HH:mm'));

describe('isOnGrid', () => {
  it('accepts quarter hours and rejects odd minutes', () => {
    expect(isOnGrid(at('17:00'), 15)).toBe(true);
    expect(isOnGrid(at('17:45'), 15)).toBe(true);
    expect(isOnGrid(at('17:05'), 15)).toBe(false);
    expect(isOnGrid(at('17:25'), 15)).toBe(false);
  });

  it('treats a disabled grid as everything being acceptable', () => {
    expect(isOnGrid(at('17:03'), 0)).toBe(true);
    expect(isOnGrid(at('17:03'), 1)).toBe(true);
  });

  it('matches the HH:mm tool-result form', () => {
    expect(isOnGridValue('18:30', 15)).toBe(true);
    expect(isOnGridValue('18:35', 15)).toBe(false);
  });
});

describe('partitionByGrid', () => {
  it('splits real starts without moving, dropping or inventing any', () => {
    // Verbatim Phorest read for 2026-09-15 (5-minute booking interval).
    // 17:30/17:35 are another client's appointment; 18:00 held two bookings.
    const raw = [
      '17:00', '17:10', '17:15', '17:20', '17:25',
      '17:40', '17:45', '17:50', '17:55',
      '18:05', '18:10', '18:15',
    ].map(at);
    const { onGrid, offGrid } = partitionByGrid(raw, 15);

    expect(hhmm(onGrid)).toEqual(['17:00', '17:15', '17:45', '18:15']);
    expect(hhmm(offGrid)).toEqual([
      '17:10', '17:20', '17:25', '17:40', '17:50', '17:55', '18:05', '18:10',
    ]);
    // Nothing gained, nothing lost, nothing altered.
    expect([...onGrid, ...offGrid]).toHaveLength(raw.length);
    // The occupied times are absent because Phorest never offered them.
    expect(hhmm([...onGrid, ...offGrid])).not.toContain('17:30');
    expect(hhmm([...onGrid, ...offGrid])).not.toContain('18:00');
  });

  it('de-duplicates and sorts chronologically', () => {
    const raw = ['18:15', '17:00', '18:15', '17:20'].map(at);
    const { onGrid, offGrid } = partitionByGrid(raw, 15);
    expect(hhmm(onGrid)).toEqual(['17:00', '18:15']);
    expect(hhmm(offGrid)).toEqual(['17:20']);
  });

  it('handles a day with no tidy starts at all', () => {
    const raw = ['17:05', '17:20', '17:35'].map(at);
    const { onGrid, offGrid } = partitionByGrid(raw, 15);
    expect(onGrid).toEqual([]);
    expect(hhmm(offGrid)).toEqual(['17:05', '17:20', '17:35']);
  });
});
