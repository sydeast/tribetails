import { describe, it, expect, vi } from 'vitest';

const setMock = vi.fn().mockResolvedValue(undefined);
const docMock = vi.fn(() => ({ id: 'slot-1', set: setMock }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ collection: () => ({ doc: docMock }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a') }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { BlockTimeArgs, createBlockedTimeSlotHandler } from '../src/admin/createBlockedTimeSlot';

describe('BlockTimeArgs validation', () => {
  it('accepts a valid same-day window', () => {
    expect(
      BlockTimeArgs.safeParse({ date: '2026-06-25', startTime: '09:00', endTime: '12:00' }).success,
    ).toBe(true);
  });

  it('rejects a non-ISO date', () => {
    expect(
      BlockTimeArgs.safeParse({ date: '06/25/2026', startTime: '09:00', endTime: '12:00' }).success,
    ).toBe(false);
  });

  it('rejects a malformed time', () => {
    expect(
      BlockTimeArgs.safeParse({ date: '2026-06-25', startTime: '9am', endTime: '12:00' }).success,
    ).toBe(false);
  });

  it('rejects end not after start', () => {
    expect(
      BlockTimeArgs.safeParse({ date: '2026-06-25', startTime: '12:00', endTime: '09:00' }).success,
    ).toBe(false);
  });
});

describe('createBlockedTimeSlotHandler', () => {
  it('writes a BLOCKED, unavailable, INTERNAL_MANUAL slot and returns ok', async () => {
    const res = await createBlockedTimeSlotHandler({
      auth: { uid: 'auntie-1' },
      data: { date: '2026-06-25', startTime: '09:00', endTime: '12:00', notes: 'PTO' },
    } as never);

    expect(res).toEqual({ ok: true, docId: 'slot-1' });
    expect(setMock).toHaveBeenCalledOnce();
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.isAvailable).toBe(false);
    expect(written.slotType).toBe('BLOCKED');
    expect(written.source).toBe('INTERNAL_MANUAL');
    expect(written.date).toBe('2026-06-25');
    expect(written.notes).toBe('PTO');
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(
      createBlockedTimeSlotHandler({ auth: undefined, data: {} } as never),
    ).rejects.toThrow();
  });

  it('rejects invalid args with invalid-argument', async () => {
    await expect(
      createBlockedTimeSlotHandler({
        auth: { uid: 'auntie-1' },
        data: { date: 'nope', startTime: '09:00', endTime: '12:00' },
      } as never),
    ).rejects.toThrow(/validation failed/);
  });
});
