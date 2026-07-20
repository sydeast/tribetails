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

// The ADMIN's OWN notification receive-prefs, stored on staff/{uid}.notificationPrefs
// (same shape as the kinfolk portal prefs on clients/{uid}). resolveChannels already
// reads staff prefs via loadUserPrefs(uid, 'staff'); these callables let the admin SET
// them from their own notification settings screen in AuntieOS.
describe('getMyAdminNotificationPrefsHandler', () => {
  it('rejects unauth', async () => {
    const { getMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    await expect(
      getMyAdminNotificationPrefsHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('reads prefs from the staff/{uid} doc (NOT clients)', async () => {
    const ctx = buildDbMock({
      docs: {
        'staff/admin1': {
          notificationPrefs: {
            byKey: { 'invoice.new': { sms: true } },
            byCategory: { invoice: { email: false } },
          },
          notificationPrefsUpdatedAt: { toMillis: () => 9999 },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    const res = await getMyAdminNotificationPrefsHandler({ data: {}, auth: { uid: 'admin1' } } as any);
    expect(res.prefs.byKey?.['invoice.new']?.sms).toBe(true);
    expect(res.prefs.byCategory?.invoice?.email).toBe(false);
    expect(res.updatedAtMs).toBe(9999);
  });

  it('returns empty prefs when the staff doc has none', async () => {
    const ctx = buildDbMock({ docs: { 'staff/admin1': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    const res = await getMyAdminNotificationPrefsHandler({ data: {}, auth: { uid: 'admin1' } } as any);
    expect(res.prefs).toEqual({});
    expect(res.updatedAtMs).toBeNull();
  });
});

describe('saveMyAdminNotificationPrefsHandler', () => {
  it('rejects unauth', async () => {
    const { saveMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    await expect(
      saveMyAdminNotificationPrefsHandler({ data: { prefs: {} }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('writes prefs to staff/{uid} (merge)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    const res = await saveMyAdminNotificationPrefsHandler({
      data: { prefs: { byKey: { 'invoice.new': { sms: true } } } },
      auth: { uid: 'admin1' },
    } as any);
    expect(res).toEqual({ ok: true });
    const write = ctx.writes.find((w) => w.path === 'staff/admin1');
    expect(write, 'must write to staff/admin1').toBeTruthy();
    expect(write?.data?.notificationPrefs?.byKey?.['invoice.new']?.sms).toBe(true);
  });

  it('rejects unknown channel keys', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    await expect(
      saveMyAdminNotificationPrefsHandler({
        data: { prefs: { byKey: { 'invoice.new': { fax: true } } } },
        auth: { uid: 'admin1' },
      } as any),
    ).rejects.toThrow();
  });

  it('rejects unknown category keys', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    await expect(
      saveMyAdminNotificationPrefsHandler({
        data: { prefs: { byCategory: { madeUp: { email: true } } } },
        auth: { uid: 'admin1' },
      } as any),
    ).rejects.toThrow();
  });
});
