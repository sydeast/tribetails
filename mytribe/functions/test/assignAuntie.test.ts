import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
  };
});
beforeEach(() => mocks.dbFn.mockReset());

const VISIT = 'families/f1/bookings/b1/kinCares/v1';

// Default-assignee feature (2026-07-02): assignAuntie sets assignedAuntieUid +
// auntieDisplayName on a visit; onBookingsWrite owns the notification fallout.
describe('assignAuntieHandler', () => {
  it('rejects invalid args', async () => {
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await expect(
      assignAuntieHandler({ data: { kinfolkId: 'f1' }, auth: { uid: 'a' } } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('404s on a missing visit', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await expect(
      assignAuntieHandler({
        data: { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', auntieUid: 'staff1' },
        auth: { uid: 'a' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a uid with no staff record', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await expect(
      assignAuntieHandler({
        data: { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', auntieUid: 'ghost' },
        auth: { uid: 'a' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('assigns: writes assignedAuntieUid + displayName from the staff doc', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT]: { status: 'confirmed' },
        'staff/staff1': { displayName: 'Auntie Dee' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    const res = await assignAuntieHandler({
      data: { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', auntieUid: 'staff1' },
      auth: { uid: 'a' },
    } as any);
    expect(res).toEqual({ ok: true, visitId: 'v1', auntieUid: 'staff1' });
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.assignedAuntieUid).toBe('staff1');
    expect(write?.data?.auntieDisplayName).toBe('Auntie Dee');
  });

  it('unassigns: null auntieUid deletes the field and clears the name', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { assignedAuntieUid: 'staff1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    const res = await assignAuntieHandler({
      data: { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', auntieUid: null },
      auth: { uid: 'a' },
    } as any);
    expect(res.auntieUid).toBeNull();
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.assignedAuntieUid).toBe('__DELETE__');
    expect(write?.data?.auntieDisplayName).toBeNull();
  });
});

describe('resolveDefaultAssignee', () => {
  it('prefers defaultAssigneeUid, falls back to uids[0], resolves displayName', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { defaultAssigneeUid: 'boss', uids: ['other'] },
        'staff/boss': { displayName: 'The Boss' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveDefaultAssignee } = await import('../src/lib/defaultAssignee');
    expect(await resolveDefaultAssignee()).toEqual({ uid: 'boss', displayName: 'The Boss' });
  });

  it('uses uids[0] when no explicit default is set', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveDefaultAssignee } = await import('../src/lib/defaultAssignee');
    expect(await resolveDefaultAssignee()).toEqual({ uid: 'admin1', displayName: null });
  });

  it('returns null when the admins doc is missing or empty', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveDefaultAssignee } = await import('../src/lib/defaultAssignee');
    expect(await resolveDefaultAssignee()).toBeNull();
  });
});
