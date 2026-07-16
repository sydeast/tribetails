import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
    home_access: false,
  },
};
// kin_edit granted but home_access explicitly withheld — must be DENIED
const KIN_EDIT_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: true,
    kintales_only: true,
    home_access: false,
  },
};
// home_access granted, kin_edit withheld — must be ALLOWED
const HOME_ACCESS_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
    home_access: true,
  },
};
const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const HOME_ACCESS_PATH = 'families/3/homeAccess/current';
const homeData = { kinfolkId: '3', gateCode: '1234', wifiPassword: 'TribeNet' };

describe('saveHomeAccess permission gate (home_access)', () => {
  it('DENIES a kintales_only secondary and writes no home-access secrets', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(
      saveHomeAccessHandler({ data: homeData, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeUndefined();
  });

  it('DENIES a secondary with kin_edit=true but home_access=false (granular separation)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': KIN_EDIT_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(
      saveHomeAccessHandler({ data: homeData, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeUndefined();
  });

  it('ALLOWS a secondary with home_access=true even when kin_edit=false', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': HOME_ACCESS_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(saveHomeAccessHandler({ data: homeData, auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeDefined();
  });

  it('ALLOWS a PRIMARY member', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/members/u1': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(saveHomeAccessHandler({ data: homeData, auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeDefined();
  });

  it('ALLOWS legacy (no member doc)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(saveHomeAccessHandler({ data: homeData, auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeDefined();
  });

  it('ALLOWS an operator (bypass, no member doc)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(saveHomeAccessHandler({ data: homeData, auth: { uid: 'op-uid' } } as any)).resolves.toEqual({ ok: true });
  });
});

describe('saveHomeAccessHandler', () => {
  it('rejects unauth', async () => {
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(saveHomeAccessHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('writes the homeAccess/current doc with updatedByUid', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await saveHomeAccessHandler({
      data: { kinfolkId: '3', gateCode: '1234', wifiPassword: 'TribeNet' },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/homeAccess/current');
    expect(w).toBeDefined();
    expect(w!.data.gateCode).toBe('1234');
    expect(w!.data.wifiPassword).toBe('TribeNet');
    expect(w!.data.updatedByUid).toBe('u1');
    expect(w!.merge).toBe(true);
  });
});
