import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: mocks.getAdmin }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
  };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getAdmin.mockReset();
});

/** The sign-in accounts `getUsers` answers with, by uid. */
function signInAccounts(users: Array<{ uid: string; displayName?: string; email?: string }>) {
  const getUsers = vi.fn(async (ids: Array<{ uid: string }>) => ({
    users: users.filter((u) => ids.some((i) => i.uid === u.uid)),
  }));
  mocks.getAdmin.mockReturnValue({ auth: () => ({ getUsers }) });
  return getUsers;
}

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

// #1857 / #1870: the owner's staff record had no name, so every visit given to
// her stored `auntieDisplayName: null`: "Assigned" in the office's drawer and
// "Not yet assigned" in MyTribe. The name now falls back to the sign-in
// account's display name, and an email is never stored as the name.
describe('assignAuntieHandler: the name stored with the assignment (#1857)', () => {
  const ASSIGN = { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', auntieUid: 'owner1' };
  it('takes the sign-in display name when the staff record has none', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' }, 'staff/owner1': { email: 'e2e-admin@tribetails.com' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    signInAccounts([{ uid: 'owner1', displayName: 'Dee Rivera', email: 'e2e-admin@tribetails.com' }]);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await assignAuntieHandler({ data: ASSIGN, auth: { uid: 'a' } } as any);
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.auntieDisplayName).toBe('Dee Rivera');
  });

  it('never stores the sign-in email as the name', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' }, 'staff/owner1': { email: 'e2e-admin@tribetails.com' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    signInAccounts([{ uid: 'owner1', email: 'e2e-admin@tribetails.com' }]);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await assignAuntieHandler({ data: ASSIGN, auth: { uid: 'a' } } as any);
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.assignedAuntieUid).toBe('owner1');
    expect(write?.data?.auntieDisplayName).toBeNull();
  });

  it('treats a staff "name" that is an email as no name', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT]: { status: 'confirmed' }, 'staff/owner1': { displayName: 'e2e-admin@tribetails.com' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    signInAccounts([{ uid: 'owner1', displayName: 'Dee Rivera' }]);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await assignAuntieHandler({ data: ASSIGN, auth: { uid: 'a' } } as any);
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.auntieDisplayName).toBe('Dee Rivera');
  });

  it('still assigns, nameless, when the sign-in lookup fails', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' }, 'staff/owner1': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getAdmin.mockReturnValue({ auth: () => ({ getUsers: vi.fn().mockRejectedValue(new Error('auth down')) }) });
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    const res = await assignAuntieHandler({ data: ASSIGN, auth: { uid: 'a' } } as any);
    expect(res.auntieUid).toBe('owner1');
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.assignedAuntieUid).toBe('owner1');
    expect(write?.data?.auntieDisplayName).toBeNull();
  });

  it('does not read the sign-in account when the staff record has a name', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' }, 'staff/owner1': { displayName: 'Auntie Dee' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const getUsers = signInAccounts([{ uid: 'owner1', displayName: 'Other' }]);
    const { assignAuntieHandler } = await import('../src/admin/assignAuntie');
    await assignAuntieHandler({ data: ASSIGN, auth: { uid: 'a' } } as any);
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.auntieDisplayName).toBe('Auntie Dee');
    expect(getUsers).not.toHaveBeenCalled();
  });
});

describe('resolveDefaultAssignee: the name a new request stores (#1870)', () => {
  it('falls back to the sign-in display name, never the email', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['owner1'] }, 'staff/owner1': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    signInAccounts([{ uid: 'owner1', displayName: 'Dee Rivera', email: 'e2e-admin@tribetails.com' }]);
    const { resolveDefaultAssignee } = await import('../src/lib/defaultAssignee');
    expect(await resolveDefaultAssignee()).toEqual({ uid: 'owner1', displayName: 'Dee Rivera' });
  });

  it('stores no name rather than an email', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['owner1'] }, 'staff/owner1': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    signInAccounts([{ uid: 'owner1', email: 'e2e-admin@tribetails.com' }]);
    const { resolveDefaultAssignee } = await import('../src/lib/defaultAssignee');
    expect(await resolveDefaultAssignee()).toEqual({ uid: 'owner1', displayName: null });
  });
});
