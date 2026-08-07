import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import type { UserNotificationPrefs } from '../src/notifications/types';

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

  it('writes prefs to staff/{uid}', async () => {
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
    expect(
      (write?.data?.notificationPrefs as UserNotificationPrefs | undefined)?.byKey?.['invoice.new']?.sms,
    ).toBe(true);
  });

  // I2. The staff write is the portal write against a different collection, and
  // prefsSchema.ts's PrefsShape exists so the two cannot drift. Both admin
  // clients read the whole prefs object and save it back whole
  // (auntieos-admin/src/screens/MyNotificationsEdit.tsx seeds `draft` from the
  // load; the two Compose screens bail on `prefs ?: return` when the load
  // failed), so the same mergeFields write is safe here. Nothing in the admin UI
  // deletes a byKey entry today, so this is the latent half of C1 — fixing only
  // the portal side would recreate the divergence PrefsShape prevents.
  it('replaces the whole notificationPrefs subtree on staff/{uid} too (same write as the portal)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyAdminNotificationPrefsHandler } = await import('../src/admin/myAdminNotificationPrefs');
    await saveMyAdminNotificationPrefsHandler({
      data: { prefs: { byKey: {}, byCategory: {}, marketingOptIn: {} } },
      auth: { uid: 'admin1' },
    } as any);
    const write = ctx.writes.find((w) => w.path === 'staff/admin1');
    expect(write).toBeDefined();
    expect(write!.options).toEqual({
      mergeFields: ['notificationPrefs', 'notificationPrefsUpdatedAt'],
    });
    expect(write!.merge).toBe(false);
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
