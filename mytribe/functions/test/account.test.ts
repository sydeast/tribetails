import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  authFn: vi.fn(() => ({
    getUser: vi.fn(async (uid: string) => ({
      uid,
      email: 'n@x.com',
      displayName: 'Auth Name',
      phoneNumber: '+15555550101',
    })),
    updateUser: vi.fn(async () => undefined),
  })),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: mocks.authFn,
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('getMyAccountHandler', () => {
  it('rejects unauth', async () => {
    const { getMyAccountHandler } = await import('../src/portal/account');
    await expect(getMyAccountHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('merges Firebase Auth + Firestore client doc', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': {
          backupEmail: 'b@x.com',
          kinfolkIds: ['3'],
          stripePaymentMethodId: 'pm_123',
          updatedAt: Timestamp.fromMillis(99),
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccountHandler } = await import('../src/portal/account');
    const res = await getMyAccountHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.email).toBe('n@x.com');
    expect(res.displayName).toBe('Auth Name');
    expect(res.phone).toBe('+15555550101');
    expect(res.backupEmail).toBe('b@x.com');
    expect(res.hasPaymentMethod).toBe(true);
    expect(res.updatedAtMs).toBe(99);
    expect(res.kinfolkIds).toEqual(['3']);
    expect(res.impersonated).toBe(false);
  });

  it('operator impersonating a foreign household returns THAT household account, read-only', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/op1': { kinfolkIds: ['op-own'] } },
      queryDocs: {
        clients: [{ id: 'ownerUid', data: { kinfolkIds: ['demo-family-001'], backupEmail: 's@x.com', stripePaymentMethodId: 'pm_x' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccountHandler } = await import('../src/portal/account');
    const res = await getMyAccountHandler({ data: { kinfolkId: 'demo-family-001' }, auth: { uid: 'op1', token: { admin: true } } } as any);
    expect(res.impersonated).toBe(true);
    expect(res.uid).toBe('ownerUid');
    expect(res.kinfolkIds).toEqual(['demo-family-001']);
    expect(res.hasPaymentMethod).toBe(true);
  });

  it('non-operator passing a foreign kinfolkId gets their OWN account (no cross-household leak)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/k1': { kinfolkIds: ['own-1'], backupEmail: 'me@x.com' } },
      queryDocs: { clients: [{ id: 'someoneElse', data: { kinfolkIds: ['demo-family-001'] } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccountHandler } = await import('../src/portal/account');
    const res = await getMyAccountHandler({ data: { kinfolkId: 'demo-family-001' }, auth: { uid: 'k1', token: {} } } as any);
    expect(res.impersonated).toBe(false);
    expect(res.uid).toBe('k1');
    expect(res.kinfolkIds).toEqual(['own-1']);
  });

  it('operator viewing their OWN household is not impersonation', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op1': { kinfolkIds: ['mine'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccountHandler } = await import('../src/portal/account');
    const res = await getMyAccountHandler({ data: { kinfolkId: 'mine' }, auth: { uid: 'op1', token: { admin: true } } } as any);
    expect(res.impersonated).toBe(false);
    expect(res.uid).toBe('op1');
  });
});

describe('saveMyAccountHandler', () => {
  it('rejects invalid backup email', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyAccountHandler } = await import('../src/portal/account');
    await expect(
      saveMyAccountHandler({ data: { backupEmail: 'not-email' }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
  });

  it('persists changes to Firestore + mirrors displayName to Auth', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyAccountHandler } = await import('../src/portal/account');
    await saveMyAccountHandler({ data: { displayName: 'New Name', phone: '+18005551234' }, auth: { uid: 'u1' } } as any);
    const w = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(w!.data.displayName).toBe('New Name');
    expect(w!.data.phone).toBe('+18005551234');
  });
});
