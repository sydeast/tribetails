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
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' } };
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
      docs: { 'kinfolk/k1': { name: 'Pet Mom' } },
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

  it('WARNING-22: MERGES onto existing claims so an admin claim survives the link', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/k1': { name: 'Pet Mom' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.setCustomUserClaims.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({ customClaims: { admin: true } });

    await setKinfolkClaimHandler({
      data: { uid: 'u1', kinfolkId: 'k1' },
      auth: { uid: 'admin1', token: {} },
    } as any);

    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('u1', {
      admin: true,
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
      docs: { 'kinfolk/k1': { name: 'Pet Mom', uid: 'u1' } },
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
