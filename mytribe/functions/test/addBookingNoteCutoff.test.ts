import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { addBookingNoteHandler } from '../src/portal/addBookingNote';

function kinReq(data: unknown, uid = 'k1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: {} as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function adminReq(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** kinCare doc path under the envelope model. */
const VISIT_PATH = 'families/f1/bookings/batch1/kinCares/v1';

describe('addBookingNote — 3hr cutoff + admin/kinfolk role branching (envelope model)', () => {
  it('HAPPY: kinfolk writes when visit >3hr away (batchId+visitId path)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/k1': { kinfolkIds: ['f1'] },
        [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addBookingNoteHandler(
      kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'feed at 5pm please' }),
    );
    expect(res.noteId).toMatch(/^auto-/);
    const noteAdd = ctx.adds.find((a) => a.collection.endsWith('/notes'));
    expect(noteAdd?.collection).toBe(`${VISIT_PATH}/notes`);
    expect(noteAdd?.data.authorRole).toBe('kinfolk');
  });

  it('HAPPY: admin writes kinfolk-facing note (authorRole=admin)', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addBookingNoteHandler(
      adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'backup auntie heads-up' }),
    );
    expect(res.noteId).toMatch(/^auto-/);
    const noteAdd = ctx.adds.find((a) => a.collection.endsWith('/notes'));
    expect(noteAdd?.data.authorRole).toBe('admin');
  });

  it('SAD: cutoff — kinfolk write rejected within 3hr', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/k1': { kinfolkIds: ['f1'] },
        [VISIT_PATH]: { startTime: new Date(Date.now() + 60 * 60 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'too late' })),
    ).rejects.toThrow(/3 hours/);
  });

  it('SAD: cutoff — admin write also rejected within 3hr (audit cleanliness)', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT_PATH]: { startTime: new Date(Date.now() + 60 * 60 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(
        adminReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'too late admin' }),
      ),
    ).rejects.toThrow(/3 hours/);
  });

  it('SAD: admin without kinfolkId rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(adminReq({ batchId: 'batch1', visitId: 'v1', body: 'no kid' })),
    ).rejects.toThrow();
  });

  it('SAD: kinfolk without tribe linkage rejected', async () => {
    // Authorization runs BEFORE the visit is resolved (existence-oracle fix:
    // a non-member can't distinguish "booking exists" from "booking missing"
    // via the error code), so this test doesn't need a visit doc seeded —
    // the membership check throws first regardless.
    const ctx = buildDbMock({
      docs: {
        'clients/k1': { kinfolkIds: [] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'x' })),
    ).rejects.toThrow(/No tribes/);
  });

  it('SAD: kinfolk with OTHER linkage (not this household) rejected', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/k1': { kinfolkIds: ['some-other-household'] },
        [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'x' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('SAD: nonexistent booking rejected as not-found regardless of caller', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/k1': { kinfolkIds: ['f1'] } }, // no VISIT_PATH doc seeded
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'x' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('existence-oracle fix: a non-member gets permission-denied, not not-found, even when the booking does not exist', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/k1': { kinfolkIds: ['some-other-household'] } }, // no VISIT_PATH doc seeded
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      addBookingNoteHandler(kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'x' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('CWE-863 fix: env-allowlist-only operator (no admin claim) can now add a note', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({
      docs: {
        [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addBookingNoteHandler(
      kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: 'env-fallback operator note' }, 'op1'),
    );
    expect(res.noteId).toMatch(/^auto-/);
    const noteAdd = ctx.adds.find((a) => a.collection.endsWith('/notes'));
    expect(noteAdd?.data.authorRole).toBe('admin');
    delete process.env.AUNTIE_OPERATOR_UIDS;
  });

  it('strips injected markup from the note body before writing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/k1': { kinfolkIds: ['f1'] },
        [VISIT_PATH]: { startTime: new Date(Date.now() + 4 * 3600 * 1000) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await addBookingNoteHandler(
      kinReq({ kinfolkId: 'f1', batchId: 'batch1', visitId: 'v1', body: '<script>alert(1)</script>feed at 5pm' }),
    );
    const noteAdd = ctx.adds.find((a) => a.collection.endsWith('/notes'));
    expect(noteAdd?.data.body).toBe('feed at 5pm');
  });

  it('BACK-COMPAT: legacy bookingId resolves via collectionGroup lookup', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/k1': { kinfolkIds: ['f1'] },
        [VISIT_PATH]: { familyId: 'f1', batchId: 'batch1', startTime: new Date(Date.now() + 4 * 3600 * 1000) },
      },
      collectionGroupDocs: {
        kinCares: [
          {
            id: 'v1',
            path: VISIT_PATH,
            data: { familyId: 'f1', batchId: 'batch1', sourceBookingId: 'legacy-99' },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await addBookingNoteHandler(
      kinReq({ kinfolkId: 'f1', bookingId: 'legacy-99', body: 'resolved by back-compat' }),
    );
    expect(res.noteId).toMatch(/^auto-/);
    const noteAdd = ctx.adds.find((a) => a.collection.endsWith('/notes'));
    expect(noteAdd?.collection).toBe(`${VISIT_PATH}/notes`);
  });
});
