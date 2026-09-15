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
    // The operator's OWN kinfolkIds must NOT include the target: this is what
    // makes it a genuine cross-tenant bypass rather than the operator simply
    // being a member of the same household by coincidence. Before the fix
    // this fixture had 'clients/op-uid': { kinfolkIds: ['3'] }, which passed
    // for the wrong reason — the outer clients/{uid}.kinfolkIds check never
    // saw an operator at all, it saw a caller whose own kinfolkIds happened
    // to include '3'.
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: [] },
        'kinfolk/3': { firstName: 'Doe' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(saveHomeAccessHandler({ data: homeData, auth: { uid: 'op-uid' } } as any)).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeDefined();
  });

  it('ALLOWS an operator with the admin claim (no allowlist) on a household that is not their own', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: [] },
        'kinfolk/3': { firstName: 'Doe' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(
      saveHomeAccessHandler({ data: homeData, auth: { uid: 'op-uid', token: { admin: true } } } as any),
    ).resolves.toEqual({ ok: true });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeDefined();
  });

  it('DENIES a stranger (not staff, kinfolkIds does not include the target)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await expect(
      saveHomeAccessHandler({ data: homeData, auth: { uid: 'stranger' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes.find((w) => w.path === HOME_ACCESS_PATH)).toBeUndefined();
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

  // #829 review: the same strip saveTribeProfile does. A home-access save must
  // never become a second, unvalidated Emergency Contact store.
  it('strips every emergencyContact* row from customFields and keeps the rest in order', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    await saveHomeAccessHandler({
      data: {
        kinfolkId: '3',
        customFields: [
          { key: 'alarm', label: 'Alarm Code', value: '5678' },
          { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Mercer' },
          { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '805-555-0199' },
          { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: 'Sister' },
          { key: 'shed', label: 'Shed', value: 'Left of the gate' },
        ],
      },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/homeAccess/current');
    expect(w!.data.customFields).toEqual([
      { key: 'alarm', label: 'Alarm Code', value: '5678' },
      { key: 'shed', label: 'Shed', value: 'Left of the gate' },
    ]);
    expect(JSON.stringify(w!.data)).not.toContain('Rae Mercer');
  });
});

/**
 * #873. The home-access schema path rebuilt `customFields` from schema keys and
 * this callable replaced the stored list whole, deleting every other row. It now
 * merges by key and removes a row only when named in `removeCustomFieldKeys`.
 */
describe('saveHomeAccessHandler: customFields merge by key (#873)', () => {
  const OFFICE = { key: 'shed', label: 'Set by Auntie', value: 'Left of the gate' };
  const ALARM = { key: 'alarm', label: 'Alarm Code', value: '5678' };
  const AFTER = { key: 'afterHoursVetPhone', label: 'After-hours Phone', value: '805-555-0100' };

  function home(stored: Array<Record<string, string>>) {
    const docs: Record<string, any> = {
      'clients/u1': { kinfolkIds: ['3'] },
      [HOME_ACCESS_PATH]: { gateCode: '1234', customFields: stored },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }
  async function save(data: Record<string, unknown>) {
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    return saveHomeAccessHandler({ data: { kinfolkId: '3', ...data }, auth: { uid: 'u1' } } as any);
  }
  const stored = (docs: Record<string, any>) => docs[HOME_ACCESS_PATH].customFields;

  it('an OLD client sending only its schema rows no longer deletes a stored non-schema row', async () => {
    const { docs } = home([OFFICE, ALARM, AFTER]);
    await expect(save({ customFields: [{ ...ALARM, value: '9999' }, AFTER] })).resolves.toEqual({ ok: true });
    expect(stored(docs)).toEqual([OFFICE, { ...ALARM, value: '9999' }, AFTER]);
  });

  it('a NEW client keeps the non-schema row, clears with a sent empty value, and removes a named row', async () => {
    const { docs } = home([OFFICE, ALARM, AFTER]);
    await save({ customFields: [OFFICE, { ...ALARM, value: '' }], removeCustomFieldKeys: ['afterHoursVetPhone'] });
    expect(stored(docs)).toEqual([OFFICE, { ...ALARM, value: '' }]);
  });

  it('a stored emergencyContact* row is still dropped on save (#829), whatever the client sends', async () => {
    const { docs } = home([OFFICE, { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Mercer' }]);
    await save({ customFields: [OFFICE] });
    expect(stored(docs)).toEqual([OFFICE]);
  });

  it('refuses a key that is both sent and named for removal, and writes nothing', async () => {
    const { ctx } = home([ALARM]);
    await expect(save({ customFields: [ALARM], removeCustomFieldKeys: ['alarm'] })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('leaves customFields alone when neither customFields nor removeCustomFieldKeys is sent', async () => {
    const { ctx } = home([OFFICE]);
    await save({ gateCode: '4321' });
    const w = ctx.writes.find((x) => x.path === HOME_ACCESS_PATH);
    expect(w!.data.customFields).toBeUndefined();
  });
});

/**
 * #873 review. The same lockouts and the same race as saveTribeProfile: a 40-row
 * cap and a required label against clients that send every stored row back, and
 * a read-merge-write outside a transaction.
 */
describe('saveHomeAccessHandler: limits and concurrent saves (#873 review)', () => {
  const ALARM = { key: 'alarm', label: 'Alarm Code', value: '5678' };
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `field${i}`, label: `Field ${i}`, value: `v${i}` }));

  function home(stored: unknown[]) {
    const docs: Record<string, any> = {
      'clients/u1': { kinfolkIds: ['3'] },
      [HOME_ACCESS_PATH]: { gateCode: '1234', customFields: stored },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ctx, docs };
  }
  async function save(data: Record<string, unknown>) {
    const { saveHomeAccessHandler } = await import('../src/portal/saveHomeAccess');
    return saveHomeAccessHandler({ data: { kinfolkId: '3', ...data }, auth: { uid: 'u1' } } as any);
  }
  const storedList = (docs: Record<string, any>) => docs[HOME_ACCESS_PATH].customFields as unknown[];

  it('a household with 60 stored rows saves when a current client sends every row back', async () => {
    const sixty = rowsOf(60);
    const { docs } = home(sixty);
    await expect(save({ customFields: sixty.map((r, i) => (i === 0 ? { ...r, value: 'edited' } : r)), removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toHaveLength(60);
    expect(storedList(docs)[0]).toEqual({ ...sixty[0], value: 'edited' });
  });

  it("a stored row with an empty label, echoed back as '', saves and keeps the stored label", async () => {
    const { docs } = home([{ key: 'shed', label: '', value: 'Left' }, ALARM]);
    await expect(
      save({ customFields: [{ key: 'shed', label: '', value: 'Right' }, { key: 'alarm', label: '', value: '9999' }], removeCustomFieldKeys: [] }),
    ).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toEqual([{ key: 'shed', label: '', value: 'Right' }, { ...ALARM, value: '9999' }]);
  });

  it('a NEW key with a blank label and a value is refused, and nothing is written', async () => {
    const { ctx } = home([ALARM]);
    await expect(save({ customFields: [ALARM, { key: 'pool', label: '', value: 'Heated' }] })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('CONCURRENT: a row another device adds between this save reading and writing survives', async () => {
    const { ctx, docs } = home([ALARM]);
    const { installOptimisticTransactions } = await import('./_helpers/optimisticTransaction');
    const ANDROID = { key: 'pool', label: 'Pool', value: 'Heated' };
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        if (path !== HOME_ACCESS_PATH || attempt !== 1) return;
        docs[HOME_ACCESS_PATH] = { ...docs[HOME_ACCESS_PATH], customFields: [...docs[HOME_ACCESS_PATH].customFields, ANDROID] };
      },
    });
    await expect(save({ customFields: [{ ...ALARM, value: '9999' }], removeCustomFieldKeys: [] })).resolves.toEqual({ ok: true });
    expect(storedList(docs)).toEqual([{ ...ALARM, value: '9999' }, ANDROID]);
    expect(tx.attempts()).toBe(2);
  });
});
