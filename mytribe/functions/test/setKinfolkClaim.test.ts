import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  authFn: vi.fn(),
  setCustomUserClaims: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ setCustomUserClaims: mocks.setCustomUserClaims, getUser: mocks.getUser }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/operatorAllowlist', () => ({
  isAuntieOperator: () => true,
  requireAuntieOperator: vi.fn(),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: {
      serverTimestamp: () => '__TS__',
      delete: () => '__DEL__',
      arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
    } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.setCustomUserClaims.mockReset();
  mocks.getUser.mockReset();
  // Default: user holds no prior custom claims.
  mocks.getUser.mockResolvedValue({ customClaims: {} });
});

import { setKinfolkClaimHandler } from '../src/admin/setKinfolkClaim';
import { revokeKinfolkClaimHandler } from '../src/admin/revokeKinfolkClaim';

describe('setKinfolkClaimHandler', () => {
  it('links kinfolk: writes claims + updates kinfolk doc', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/k1': { name: 'Pet Mom' }, 'families/k1': { displayName: 'Household' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);

    const res = await setKinfolkClaimHandler({
      data: { uid: 'u1', kinfolkId: 'k1' },
      auth: { uid: 'admin1', token: {} },
    } as any);

    expect(res).toEqual({ ok: true, uid: 'u1', kinfolkId: 'k1' });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { role: 'kinfolk', kinfolkId: 'k1' });
    const w = ctx.writes.find((w) => w.path === 'kinfolk/k1');
    expect(w).toBeDefined();
    expect(w!.merge).toBe(true);
    expect(w!.data.uid).toBe('u1');
  });

  // An admin claim is no longer kept through a link: since #1840/#2096 a staff
  // login is refused outright (see the staff cases below). Any other claim the
  // login holds still survives.
  it('WARNING-22: MERGES onto existing claims so another claim survives the link', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/k1': { name: 'Pet Mom' }, 'families/k1': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({ customClaims: { testTribeId: 't1' } });

    await setKinfolkClaimHandler({
      data: { uid: 'u1', kinfolkId: 'k1' },
      auth: { uid: 'admin1', token: {} },
    } as any);

    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', {
      testTribeId: 't1',
      role: 'kinfolk',
      kinfolkId: 'k1',
    });
  });

  it('WARNING-22: rejects re-linking a uid already bound to a DIFFERENT kinfolk', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/k1': { name: 'Pet Mom' } },
      // db().collection('kinfolk').where('uid','==','u1').get() returns a row for k-other.
      queryDocs: { kinfolk: [{ id: 'k-other', data: { uid: 'u1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);

    await expect(
      setKinfolkClaimHandler({
        data: { uid: 'u1', kinfolkId: 'k1' },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    // Did NOT touch claims or repoint the doc.
    expect(mocks.setCustomUserClaims).not.toHaveBeenCalled();
    expect(ctx.writes.find((w) => w.path === 'kinfolk/k1')).toBeUndefined();
  });

  it('WARNING-22: allows re-linking the SAME kinfolk (idempotent, no self-conflict)', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/k1': { name: 'Pet Mom', uid: 'u1' }, 'families/k1': {} },
      queryDocs: { kinfolk: [{ id: 'k1', data: { uid: 'u1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);

    const res = await setKinfolkClaimHandler({
      data: { uid: 'u1', kinfolkId: 'k1' },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.ok).toBe(true);
  });

  describe('the member record (#2096)', () => {
    function call() {
      return setKinfolkClaimHandler({
        data: { uid: 'u1', kinfolkId: 'k1' },
        auth: { uid: 'admin1', token: {} },
      } as any);
    }
    function seed(docs: Record<string, Record<string, unknown>> = {}, queryDocs = {}) {
      const ctx = buildDbMock({
        writeThrough: true,
        docs: { 'kinfolk/k1': { name: 'Pet Mom' }, 'families/k1': {}, ...docs },
        queryDocs,
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.setCustomUserClaims.mockResolvedValue(undefined);
      return ctx;
    }

    it('HAPPY: writes the ACTIVE PRIMARY record acceptInvite writes, and lists the household on the client', async () => {
      const ctx = seed();
      mocks.getUser.mockResolvedValue({ email: 'catch@hanasamku.com', customClaims: {} });

      await call();

      const member = ctx.writes.find((w) => w.path === 'families/k1/members/u1');
      expect(member?.data).toEqual({
        uid: 'u1',
        displayName: 'catch@hanasamku.com',
        role: 'PRIMARY',
        secondaryLabel: null,
        permissions: {
          billing_full: true,
          messaging_direct: true,
          messaging_group: true,
          kin_edit: true,
          kintales_only: true,
          home_access: true,
        },
        status: 'ACTIVE',
        invitedAt: null,
        joinedAt: '__TS__',
        updatedAt: '__TS__',
      });
      const client = ctx.writes.find((w) => w.path === 'clients/u1');
      expect(client?.merge).toBe(true);
      expect(client?.data.kinfolkIds).toEqual({ __arrayUnion: ['k1'] });
    });

    it('HAPPY: re-linking a login that is already an ACTIVE member writes no second record', async () => {
      const ctx = seed({ 'families/k1/members/u1': { role: 'PRIMARY', status: 'ACTIVE' } });
      await call();
      expect(ctx.writes.find((w) => w.path === 'families/k1/members/u1')).toBeUndefined();
      expect(mocks.setCustomUserClaims).toHaveBeenCalled();
    });

    it.each([
      ['an admin claim', { customClaims: { admin: true } }, {}],
      ['an Auntie claim', { customClaims: { staffRole: 'auntie' } }, {}],
      ['a staff record', { customClaims: {} }, { 'staff/u1': { displayName: 'x' } }],
    ])('NEGATIVE (#1840): a login with %s is refused and nothing is written', async (_label, user, docs) => {
      const ctx = seed(docs as Record<string, Record<string, unknown>>);
      mocks.getUser.mockResolvedValue(user);
      await expect(call()).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('staff login') });
      expect(mocks.setCustomUserClaims).not.toHaveBeenCalled();
      expect(ctx.writes).toEqual([]);
    });

    it('NEGATIVE: a removed member is not added back', async () => {
      const ctx = seed({ 'families/k1/members/u1': { role: 'PRIMARY', status: 'SUSPENDED' } });
      await expect(call()).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(ctx.writes).toEqual([]);
    });

    it('NEGATIVE: a household with a different ACTIVE PRIMARY keeps it', async () => {
      const ctx = seed({ 'families/k1/members/u-pk': { role: 'PRIMARY', status: 'ACTIVE' } });
      await expect(call()).rejects.toMatchObject({ message: expect.stringContaining('already has a primary') });
      expect(ctx.writes).toEqual([]);
    });

    it('NEGATIVE: a login listed on another household is refused', async () => {
      const ctx = seed({ 'clients/u1': { kinfolkIds: ['k2'] } });
      await expect(call()).rejects.toMatchObject({ message: expect.stringContaining('another household') });
      expect(ctx.writes).toEqual([]);
    });

    it('SAD: a household with no portal record is refused', async () => {
      const ctx = buildDbMock({ docs: { 'kinfolk/k1': { name: 'Pet Mom' } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      await expect(call()).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(ctx.writes).toEqual([]);
    });

    it('SAD: a login with no account is refused', async () => {
      seed();
      mocks.getUser.mockRejectedValue(Object.assign(new Error('nope'), { code: 'auth/user-not-found' }));
      await expect(call()).rejects.toMatchObject({ message: expect.stringContaining('no sign-in account') });
      expect(mocks.setCustomUserClaims).not.toHaveBeenCalled();
    });

    it('ERROR: an auth failure propagates and nothing is written', async () => {
      const ctx = seed();
      mocks.getUser.mockRejectedValue(Object.assign(new Error('auth down'), { code: 'auth/internal-error' }));
      await expect(call()).rejects.toThrow('auth down');
      expect(ctx.writes).toEqual([]);
    });
  });

  it('throws not-found when kinfolk doc missing', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setKinfolkClaimHandler({
        data: { uid: 'u1', kinfolkId: 'missing' },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects invalid args', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      setKinfolkClaimHandler({ data: { uid: '', kinfolkId: 'k1' }, auth: { uid: 'admin1' } } as any),
    ).rejects.toThrow();
  });
});

describe('revokeKinfolkClaimHandler', () => {
  it('clears claims + blanks kinfolk uid', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/k1': { uid: 'u1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);

    const res = await revokeKinfolkClaimHandler({
      data: { uid: 'u1', kinfolkId: 'k1' },
      auth: { uid: 'admin1', token: {} },
    } as any);

    expect(res).toEqual({ ok: true, uid: 'u1', kinfolkId: 'k1' });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', {});
    const w = ctx.writes.find((w) => w.path === 'kinfolk/k1');
    expect(w).toBeDefined();
    expect(w!.data.uid).toBe('');
  });

  it('WARNING-22: strips only role+kinfolkId, preserving an admin claim', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/k1': { uid: 'u1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({
      customClaims: { admin: true, role: 'kinfolk', kinfolkId: 'k1' },
    });

    await revokeKinfolkClaimHandler({
      data: { uid: 'u1', kinfolkId: 'k1' },
      auth: { uid: 'admin1', token: {} },
    } as any);

    // admin survives; role + kinfolkId removed.
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', { admin: true });
  });
});
