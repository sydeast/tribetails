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

  /**
   * `syncState` is a five-value vocabulary - LOCAL_ONLY, SYNCED, OVERRIDDEN,
   * DISMISSED, FAILED - declared by the Android model (`ServiceModels.kt`
   * `TimeSlotSyncState`) and defaulted to `LOCAL_ONLY` by the Compose web client
   * (`FirestoreClient.kt`). The sibling server writer,
   * `syncGoogleCalendarBusyEvents`, writes the in-vocabulary `'SYNCED'`. This
   * handler wrote `'LOCAL'`, which is in no vocabulary anywhere, and Android
   * decodes `syncState` into the real enum: the whole document THROWS, taking
   * every other slot in the same snapshot with it.
   */
  it('writes an in-vocabulary syncState the Android enum can decode', async () => {
    await createBlockedTimeSlotHandler({
      auth: { uid: 'auntie-1' },
      data: { date: '2026-06-25', startTime: '09:00', endTime: '12:00' },
    } as never);

    const written = setMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written.syncState).toBe('LOCAL_ONLY');
  });

  /**
   * `createdAt` is a STRING on both client models, and the sibling importer
   * writes it as one (`busyIntervalToSlot`'s `nowIso`). A `serverTimestamp()`
   * here reaches Android as a `com.google.firebase.Timestamp` and fails the same
   * whole-snapshot decode: "Failed to convert value of type
   * com.google.firebase.Timestamp to String (found in field 'createdAt')".
   * `updatedAt` is on neither model and is therefore ignored on decode today,
   * but it is written in the same statement at the same instant, and every other
   * model in this repo declares `updatedAt: String` - so it gets the same shape
   * rather than being left as the next trap.
   */
  it('writes both stamps as ISO strings, not server timestamps', async () => {
    await createBlockedTimeSlotHandler({
      auth: { uid: 'auntie-1' },
      data: { date: '2026-06-25', startTime: '09:00', endTime: '12:00' },
    } as never);

    const written = setMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(typeof written.createdAt).toBe('string');
    expect(typeof written.updatedAt).toBe('string');
    expect(written.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(written.createdAt).toBe(written.updatedAt);
  });

  /** The provenance field the bare-set client write used to erase. Still written. */
  it('records who blocked the window', async () => {
    await createBlockedTimeSlotHandler({
      auth: { uid: 'auntie-1' },
      data: { date: '2026-06-25', startTime: '09:00', endTime: '12:00' },
    } as never);

    const written = setMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written.createdBy).toBe('auntie-1');
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
