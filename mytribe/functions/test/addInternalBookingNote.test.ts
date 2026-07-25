import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { addInternalBookingNoteHandler } from '../src/admin/addInternalBookingNote';

function req(data: unknown, uid = 'admin1', admin = true): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const VISIT_PATH = 'families/f1/bookings/batch1/kinCares/v1';

describe('addInternalBookingNote (envelope model)', () => {
  it('HAPPY: writes to internalNotes subcollection on the kinCare with authorRole=admin', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addInternalBookingNoteHandler(
      req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'internal context' }),
    );
    expect(res.noteId).toMatch(/^auto-/);
    const internalAdd = ctx.adds.find((a) =>
      a.collection.endsWith('/internalNotes'),
    );
    expect(internalAdd).toBeDefined();
    expect(internalAdd?.collection).toBe(`${VISIT_PATH}/internalNotes`);
    expect(internalAdd?.data.authorRole).toBe('admin');
    expect(internalAdd?.data.body).toBe('internal context');
  });

  it('SAD: kinCare not found throws not-found', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addInternalBookingNoteHandler(req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'missing', body: 'x' })),
    ).rejects.toThrow();
  });

  it('SAD: whitespace-only body rejected', async () => {
    // Start deliberately OUTSIDE the cutoff window, so this can only fail for
    // the reason it is testing. Seeded at `new Date()` it would now also be
    // inside the 3-hour lock, and would keep passing for the wrong reason.
    const ctx = buildDbMock({
      docs: { [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addInternalBookingNoteHandler(req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: '   ' })),
    ).rejects.toThrow();
  });

  it('strips injected markup from the internal note body', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addInternalBookingNoteHandler(
      req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: '<script>alert(1)</script>internal context' }),
    );
    const internalAdd = ctx.adds.find((a) => a.collection.endsWith('/internalNotes'));
    expect(internalAdd?.data.body).toBe('internal context');
  });

  /**
   * INVERTED on purpose (2026-07-25). This case used to assert the opposite,
   * that internal notes had no cutoff, which pinned the gap rather than the
   * rule: the 3-hour lock existed only in client code, so any other caller
   * wrote straight past it. The cutoff now lives in the callable, shared with
   * addBookingNote. Boundary and error-surface coverage is in
   * `bookingNoteCutoff.test.ts`; this keeps the rejection pinned from the
   * suite that owns this callable.
   */
  it('SAD: rejects within 3hr of start, same cutoff as the kinfolk-facing thread', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT_PATH]: { startTime: new Date(Date.now() + 60_000) } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addInternalBookingNoteHandler(
        req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'last-minute auntie note' }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'booking_note_cutoff' },
    });
  });

  it('BACK-COMPAT: legacy bookingId resolves via collectionGroup lookup', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT_PATH]: { familyId: 'f1', batchId: 'batch1', startTime: new Date(Date.now() + 4 * 3600 * 1000) } },
      collectionGroupDocs: {
        kinCares: [
          { id: 'v1', path: VISIT_PATH, data: { familyId: 'f1', batchId: 'batch1' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addInternalBookingNoteHandler(
      req({ kinfolkId: 'f1', bookingId: 'v1', body: 'resolved by id' }),
    );
    expect(res.noteId).toMatch(/^auto-/);
    const internalAdd = ctx.adds.find((a) => a.collection.endsWith('/internalNotes'));
    expect(internalAdd?.collection).toBe(`${VISIT_PATH}/internalNotes`);
  });
});
