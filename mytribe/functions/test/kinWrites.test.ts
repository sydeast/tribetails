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

// CRITICAL-4 member-doc fixtures keyed at families/{kinfolkId}/members/{uid}.
const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
  },
};
const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };

describe('kinWrites CRITICAL-4 permission gate (kin_edit)', () => {
  for (const variant of [
    { name: 'addKinHandler', import: 'addKinHandler', data: { kinfolkId: '3', kin: { name: 'Buddy' } } },
    { name: 'updateKinHandler', import: 'updateKinHandler', data: { kinfolkId: '3', kinId: 'k1', kin: { medications: 'x' } } },
    { name: 'archiveKinHandler', import: 'archiveKinHandler', data: { kinfolkId: '3', kinId: 'k1', reason: 'noLongerWithUs' } },
  ]) {
    it(`${variant.name}: DENIES a kintales_only secondary and does not write`, async () => {
      const ctx = buildDbMock({
        docs: {
          'clients/u1': { kinfolkIds: ['3'] },
          'families/3/members/u1': KINTALES_ONLY_MEMBER,
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
        code: 'permission-denied',
      });
      // side effect did NOT run
      expect(ctx.adds.length).toBe(0);
      expect(ctx.writes.find((w) => w.path === 'families/3/kin/k1')).toBeUndefined();
    });

    it(`${variant.name}: ALLOWS a PRIMARY member`, async () => {
      const ctx = buildDbMock({
        docs: {
          'clients/u1': { kinfolkIds: ['3'] },
          'families/3/members/u1': PRIMARY_MEMBER,
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'u1' } } as any)).resolves.toBeTruthy();
    });

    it(`${variant.name}: ALLOWS legacy (no member doc)`, async () => {
      const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'u1' } } as any)).resolves.toBeTruthy();
    });

    it(`${variant.name}: ALLOWS an operator (bypass, no member doc)`, async () => {
      process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
      const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: ['3'] } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'op-uid' } } as any)).resolves.toBeTruthy();
    });
  }
});

describe('addKinHandler', () => {
  it('rejects unauth', async () => {
    const { addKinHandler } = await import('../src/portal/kinWrites');
    await expect(addKinHandler({ data: { kin: { name: 'X' } }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when name missing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addKinHandler } = await import('../src/portal/kinWrites');
    await expect(addKinHandler({ data: { kinfolkId: '3', kin: {} }, auth: { uid: 'u1' } } as any)).rejects.toThrow();
  });

  it('writes status=active and returns kinId', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addKinHandler } = await import('../src/portal/kinWrites');
    const res = await addKinHandler({
      data: { kinfolkId: '3', kin: { name: 'Buddy', breed: 'Aussie', ageYears: 4 } },
      auth: { uid: 'u1' },
    } as any);
    expect(res.kinId).toBeTypeOf('string');
    const wrote = ctx.adds.find((a) => a.collection === 'families/3/kin');
    expect(wrote).toBeDefined();
    expect(wrote!.data.status).toBe('active');
    expect(wrote!.data.name).toBe('Buddy');
  });
});

describe('archiveKinHandler', () => {
  it('flips status to noLongerWithUs', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { archiveKinHandler } = await import('../src/portal/kinWrites');
    await archiveKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', reason: 'noLongerWithUs' },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data.status).toBe('noLongerWithUs');
    expect(w!.merge).toBe(true);
  });

  it('restores when reason=restore', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { archiveKinHandler } = await import('../src/portal/kinWrites');
    await archiveKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', reason: 'restore' },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data.status).toBe('active');
  });
});

describe('updateKinHandler', () => {
  it('merges partial fields', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { updateKinHandler } = await import('../src/portal/kinWrites');
    await updateKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', kin: { medications: 'twice daily' } },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data.medications).toBe('twice daily');
    expect(w!.data.updatedByUid).toBe('u1');
  });
});
