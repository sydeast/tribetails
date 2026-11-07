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
   * INVERTED AGAIN (#1580). From 2026-07-25 this asserted the 3-hour freeze on
   * the internal thread, copied from the kinfolk-facing one. #1580 makes this
   * the visit's one internal-notes store, which Auntie Time writes during and
   * after a visit, so the freeze would refuse the notes it now has to take. The
   * household thread keeps its cutoff (`bookingNoteCutoff.test.ts`).
   */
  it('#1580: takes a note inside 3 hours of the start, and once the visit is under way', async () => {
    for (const offset of [60_000, -30 * 60_000]) {
      const ctx = buildDbMock({
        docs: { [VISIT_PATH]: { startTime: new Date(Date.now() + offset) } },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      await expect(
        addInternalBookingNoteHandler(
          req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'gate latch is loose' }),
        ),
      ).resolves.toMatchObject({ storedOn: 'thread', visibility: 'shared' });
    }
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
// ── #1580: two kinds of internal note, marked by the writer ──────────────────
describe('addInternalBookingNote visibility (#1580)', () => {
  const SESSION = 'kin_care_sessions/vis_v1';
  const later = () => new Date(Date.now() + 4 * 3600 * 1000);
  function asAuntie(data: unknown): CallableRequest<unknown> {
    return {
      data,
      auth: { uid: 'auntie1', token: { staffRole: 'auntie' } as any },
      rawRequest: {} as any,
      instanceIdToken: undefined,
      acceptsStreaming: false,
    } as unknown as CallableRequest<unknown>;
  }
  it('an admin-only note goes to adminNotes, never to the shared thread', async () => {
    const ctx = buildDbMock({ docs: { [VISIT_PATH]: { startTime: later() } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addInternalBookingNoteHandler(
      req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'raise her rate next month', visibility: 'adminOnly' }),
    );
    expect(res).toMatchObject({ visibility: 'adminOnly', storedOn: 'thread' });
    expect(ctx.adds.map((a) => a.collection)).toEqual([`${VISIT_PATH}/adminNotes`]);
    expect(ctx.adds[0]?.data).toMatchObject({ authorRole: 'admin', visibility: 'adminOnly', body: 'raise her rate next month' });
  });
  it('a note with no mark is shared, as every older client meant', async () => {
    const ctx = buildDbMock({ docs: { [VISIT_PATH]: { startTime: later() } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addInternalBookingNoteHandler(req({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'shared' }));
    expect(ctx.adds.map((a) => a.collection)).toEqual([`${VISIT_PATH}/internalNotes`]);
    expect(ctx.adds[0]?.data.visibility).toBe('shared');
  });
  it('refuses an Auntie an admin-only note, and writes nothing', async () => {
    const ctx = buildDbMock({ docs: { [VISIT_PATH]: { startTime: later() } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addInternalBookingNoteHandler(
        asAuntie({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'x', visibility: 'adminOnly' }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.adds).toHaveLength(0);
  });
  it('an Auntie\'s shared note is stamped as hers', async () => {
    const ctx = buildDbMock({ docs: { [VISIT_PATH]: { startTime: later() } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addInternalBookingNoteHandler(asAuntie({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'fed at 5' }));
    expect(ctx.adds[0]?.data).toMatchObject({ authorUid: 'auntie1', authorRole: 'auntie', visibility: 'shared' });
  });
  it('by session id, lands in the same thread Bookings reads', async () => {
    const ctx = buildDbMock({
      docs: {
        [SESSION]: { kinfolkId: 'f1', kinCareBatchId: 'batch1', kinCareVisitId: 'v1', notes: '' },
        [VISIT_PATH]: { startTime: later() },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addInternalBookingNoteHandler(req({ sessionId: 'vis_v1', body: 'from Auntie Time', visibility: 'adminOnly' }));
    expect(ctx.adds.map((a) => a.collection)).toEqual([`${VISIT_PATH}/adminNotes`]);
    // The session's own notes text is not where it went.
    expect(ctx.writes.find((w) => w.path === SESSION)).toBeUndefined();
  });
  it('an older visit with no booking record keeps a shared note on its session text', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s9': { kinfolkId: 'f1', notes: '[2026-11-01T10:00:00Z] (office) old' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addInternalBookingNoteHandler(req({ sessionId: 's9', body: 'new one' }));
    expect(res).toMatchObject({ storedOn: 'visitRecord', visibility: 'shared' });
    const w = ctx.writes.find((x) => x.path === 'kin_care_sessions/s9');
    expect(String(w?.data.notes)).toMatch(/^\[[0-9T:-]+Z\] \(office\) new one\n\[2026-11-01T10:00:00Z\] \(office\) old$/);
    expect(ctx.adds).toHaveLength(0);
  });
  it('refuses an admin-only note on a visit with no booking record, rather than put it where Aunties read', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s9': { kinfolkId: 'f1', notes: '' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addInternalBookingNoteHandler(req({ sessionId: 's9', body: 'secret', visibility: 'adminOnly' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'visit_has_no_booking_record' } });
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/s9')).toBeUndefined();
  });
  it('a missing session is not-found', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(addInternalBookingNoteHandler(req({ sessionId: 'nope', body: 'x' }))).rejects.toMatchObject({ code: 'not-found' });
  });
});
