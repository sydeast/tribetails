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
beforeEach(() => mocks.dbFn.mockReset());

describe('getMyNotificationPrefsHandler', () => {
  it('rejects unauth', async () => {
    const { getMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(getMyNotificationPrefsHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns prefs object (new hybrid shape)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': {
          notificationPrefs: {
            byCategory: { visit: { email: true, sms: false, push: true } },
            byKey: { 'kintale.published': { email: false, push: true } },
            marketingOptIn: { newsletter: true },
          },
          notificationPrefsUpdatedAt: { toMillis: () => 1234 },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    const res = await getMyNotificationPrefsHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.prefs.byCategory?.visit?.email).toBe(true);
    expect(res.prefs.byKey?.['kintale.published']?.push).toBe(true);
    expect(res.prefs.marketingOptIn?.newsletter).toBe(true);
    expect(res.updatedAtMs).toBe(1234);
  });
});

describe('saveMyNotificationPrefsHandler', () => {
  it('rejects unauth', async () => {
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(saveMyNotificationPrefsHandler({ data: { prefs: {} }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects unknown channel keys', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(
      saveMyNotificationPrefsHandler({
        data: { prefs: { byCategory: { visit: { fax: true } } } },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow();
  });

  it('rejects unknown category keys', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(
      saveMyNotificationPrefsHandler({
        data: { prefs: { byCategory: { madeUp: { email: true } } } },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow();
  });

  it('accepts byCategory.security (schema bug fix: Category enum omitted security)', async () => {
    // types.ts Category includes 'security' but the zod enum in prefsSchema.ts
    // dropped it, so a legitimate security-row pref write was rejected.
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await saveMyNotificationPrefsHandler({
      data: { prefs: { byCategory: { security: { email: true, push: false } } } },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(w).toBeDefined();
    expect((w!.data.notificationPrefs as any).byCategory.security.email).toBe(true);
  });

  it('writes hybrid prefs map merged into clients/{uid}', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await saveMyNotificationPrefsHandler({
      data: {
        prefs: {
          byCategory: { visit: { email: true, sms: false, push: true } },
          byKey: { 'kintale.published': { email: false, push: true } },
          marketingOptIn: { newsletter: true, survey: false },
        },
      },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(w).toBeDefined();
    expect(w!.merge).toBe(true);
    const np = w!.data.notificationPrefs as any;
    expect(np.byCategory.visit.email).toBe(true);
    expect(np.byKey['kintale.published'].push).toBe(true);
    expect(np.marketingOptIn.newsletter).toBe(true);
  });
});
