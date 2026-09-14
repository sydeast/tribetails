import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const HOME_ACCESS_DOC = {
  gateCode: '1234',
  keyLocation: 'Under frog',
  wifiPassword: 'TribeNet_5G',
  customFields: [{ key: 'h1', label: 'Alarm Code', value: '5678' }],
  updatedAt: Timestamp.fromMillis(1_700_000_000_000),
};

const FAMILY_DOC = {
  displayName: 'The Foster',
  customFields: [{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }],
};

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

describe('getMyTribeProfileHandler', () => {
  it('rejects unauth', async () => {
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    await expect(getMyTribeProfileHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns profile + homeAccess + customFields (legacy: no member doc)', async () => {
    // No member doc -> legacy primary -> hasKinfolkPerm returns true -> secrets visible
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.profile.displayName).toBe('The Foster');
    expect(res.profile.customFields).toHaveLength(1);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.updatedAtMs).toBe(1_700_000_000_000);
    expect(res.homeAccess.customFields[0].label).toBe('Alarm Code');
  });

  it('handles missing homeAccess doc (legacy primary)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'X' },
        'families/3/homeAccess/current': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.homeAccess.gateCode).toBeNull();
    expect(res.homeAccess.customFields).toEqual([]);
  });

  // --- home_access read-gating ---

  it('REDACTS homeAccess secrets for a kintales_only secondary (home_access=false)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u2': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u2': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u2' } } as any);
    // Profile still returned normally
    expect(res.profile.displayName).toBe('The Foster');
    // homeAccess secrets are all null/empty — not leaked
    expect(res.homeAccess.gateCode).toBeNull();
    expect(res.homeAccess.keyLocation).toBeNull();
    expect(res.homeAccess.wifiPassword).toBeNull();
    expect(res.homeAccess.customFields).toEqual([]);
    expect(res.homeAccess.updatedAtMs).toBeNull();
  });

  it('EXPOSES homeAccess secrets for a home_access=true secondary', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u3': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u3': HOME_ACCESS_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u3' } } as any);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.keyLocation).toBe('Under frog');
    expect(res.homeAccess.wifiPassword).toBe('TribeNet_5G');
    expect(res.homeAccess.customFields).toHaveLength(1);
    expect(res.homeAccess.updatedAtMs).toBe(1_700_000_000_000);
  });

  it('EXPOSES homeAccess secrets for a PRIMARY member', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u4': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u4': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u4' } } as any);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.wifiPassword).toBe('TribeNet_5G');
  });

  it('EXPOSES homeAccess secrets for an operator (bypass)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        // RULING O-6 hardening 1: staff branch existence-checks kinfolk/{id}.
        'kinfolk/3': { firstName: 'Test' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'op-uid' } } as any);
    expect(res.homeAccess.gateCode).toBe('1234');
    expect(res.homeAccess.wifiPassword).toBe('TribeNet_5G');
    expect(res.homeAccess.keyLocation).toBe('Under frog');
  });

  it('REDACTS homeAccess but returns profile intact (non-home_access secondary, missing homeAccess doc)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u5': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': null,
        'families/3/members/u5': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u5' } } as any);
    expect(res.profile.displayName).toBe('The Foster');
    expect(res.homeAccess.gateCode).toBeNull();
    expect(res.homeAccess.customFields).toEqual([]);
  });

  // #843: the portal disables the Emergency Contact inputs off this flag, the
  // same permission saveTribeProfile now enforces on those keys.
  it('tells a secondary without home_access they cannot edit home details', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u5': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u5': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u5' } } as any);
    expect(res.canEditHomeDetails).toBe(false);
  });

  it('tells a secondary with home_access, and a primary, they can edit home details', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u6': { kinfolkIds: ['3'] },
        'clients/u7': { kinfolkIds: ['3'] },
        'families/3': FAMILY_DOC,
        'families/3/homeAccess/current': HOME_ACCESS_DOC,
        'families/3/members/u6': HOME_ACCESS_MEMBER,
        'families/3/members/u7': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const secondary = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u6' } } as any);
    const primary = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u7' } } as any);
    expect(secondary.canEditHomeDetails).toBe(true);
    expect(primary.canEditHomeDetails).toBe(true);
  });
});
