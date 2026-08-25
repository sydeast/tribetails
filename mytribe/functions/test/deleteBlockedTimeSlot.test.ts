import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #574: unblocking a window used to be a client delete against a collection
 * `firestore.rules` denies every client write to, so it always failed. This is
 * the callable that half was missing.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));

import {
  deleteBlockedTimeSlotHandler,
  IMPORTED_BUSY_SLOT_CODE,
} from '../src/admin/deleteBlockedTimeSlot';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const MANUAL_SLOT = {
  date: '2026-08-24',
  startTime: '09:00',
  endTime: '12:00',
  notes: 'Vet appointment',
  isAvailable: false,
  slotType: 'BLOCKED',
  source: 'INTERNAL_MANUAL',
  createdBy: 'admin1',
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

describe('deleteBlockedTimeSlot', () => {
  it('deletes an operator-authored block and audits what it removed', async () => {
    const ctx = buildDbMock({ docs: { 'booking_time_slots/slot-1': MANUAL_SLOT } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await deleteBlockedTimeSlotHandler(req({ slotId: 'slot-1' }));

    expect(res).toEqual({ ok: true, slotId: 'slot-1' });
    expect(ctx.deletes).toEqual(['booking_time_slots/slot-1']);
    // The document is gone after this, so the audit entry is the only surviving
    // record of what the window was.
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'DELETE_BLOCKED_TIME_SLOT',
        payload: expect.objectContaining({
          docId: 'slot-1',
          date: '2026-08-24',
          startTime: '09:00',
          endTime: '12:00',
        }),
      }),
    );
  });

  it('a slot with no source at all is still deletable (rows predate the field)', async () => {
    const ctx = buildDbMock({
      docs: { 'booking_time_slots/legacy': { date: '2026-08-24', startTime: '09:00', endTime: '10:00' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(deleteBlockedTimeSlotHandler(req({ slotId: 'legacy' }))).resolves.toMatchObject({
      ok: true,
    });
    expect(ctx.deletes).toEqual(['booking_time_slots/legacy']);
  });

  /**
   * The refusal that is the whole reason this is not a two-line delete: the next
   * calendar sync writes an imported row straight back, so deleting it here
   * would be a block that will not stay deleted.
   */
  it('refuses a Google Calendar import, with a code and no delete', async () => {
    const ctx = buildDbMock({
      docs: {
        'booking_time_slots/imported': { ...MANUAL_SLOT, source: 'GOOGLE_BUSY_IMPORT' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(deleteBlockedTimeSlotHandler(req({ slotId: 'imported' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: IMPORTED_BUSY_SLOT_CODE, source: 'GOOGLE_BUSY_IMPORT' },
    });
    expect(ctx.deletes).toEqual([]);
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('refuses any other non-operator source the same way', async () => {
    const ctx = buildDbMock({
      docs: { 'booking_time_slots/rule': { ...MANUAL_SLOT, source: 'SYSTEM_RULE' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(deleteBlockedTimeSlotHandler(req({ slotId: 'rule' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: IMPORTED_BUSY_SLOT_CODE, source: 'SYSTEM_RULE' },
    });
    expect(ctx.deletes).toEqual([]);
  });

  it('404s a slot that is not there, rather than reporting a delete that did nothing', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(deleteBlockedTimeSlotHandler(req({ slotId: 'ghost' }))).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(ctx.deletes).toEqual([]);
  });

  it('refuses a blank slot id before touching Firestore', async () => {
    const ctx = buildDbMock({ docs: { 'booking_time_slots/slot-1': MANUAL_SLOT } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(deleteBlockedTimeSlotHandler(req({ slotId: '' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(ctx.deletes).toEqual([]);
  });

  it('refuses an unauthenticated caller', async () => {
    const ctx = buildDbMock({ docs: { 'booking_time_slots/slot-1': MANUAL_SLOT } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      deleteBlockedTimeSlotHandler(req({ slotId: 'slot-1' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.deletes).toEqual([]);
  });
});
