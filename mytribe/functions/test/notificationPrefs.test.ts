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

  it('writes the hybrid prefs map to clients/{uid}', async () => {
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
    const np = w!.data.notificationPrefs as any;
    expect(np.byCategory.visit.email).toBe(true);
    expect(np.byKey['kintale.published'].push).toBe(true);
    expect(np.marketingOptIn.newsletter).toBe(true);
  });

  // C1. Clearing an override has to REMOVE a byKey entry, and `{ merge: true }`
  // cannot express that. DocumentMask.fromObject (the shipped SDK,
  // @google-cloud/firestore/build/src/document.js:607-643) walks the payload and
  // pushes only LEAF paths into the update mask, so a key the client left out is
  // simply not in the mask and the server keeps whatever it already had. The
  // clients both send the whole prefs object (web seeds `edited` from
  // prefs.data.prefs, Compose seeds all three maps from getMyNotificationPrefs),
  // so naming the parent path in `mergeFields` is what makes the write mean
  // "this subtree is now exactly this" — write-batch.js:271-291 builds the mask
  // from the field list instead of the payload, and `set` still creates the doc
  // when it is missing, which `update()` would not.
  it('replaces the whole notificationPrefs subtree, so a cleared override is really gone', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await saveMyNotificationPrefsHandler({
      data: { prefs: { byCategory: {}, byKey: {}, marketingOptIn: {} } },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(w).toBeDefined();
    expect(w!.options).toEqual({
      mergeFields: ['notificationPrefs', 'notificationPrefsUpdatedAt'],
    });
    expect(w!.merge).toBe(false);
  });
});
describe('saveMyNotificationPrefsHandler, single-preference patch (#1292)', () => {
  const EXISTING = {
    byCategory: { visit: { email: true, sms: false, push: true }, invoice: { email: true } },
    byKey: { 'kintale.published': { email: false, push: true }, 'invoice.posted': { sms: true } },
    marketingOptIn: { newsletter: true },
  };
  async function patchWith(patch: unknown, existing: unknown = EXISTING) {
    const ctx = buildDbMock({ docs: { 'clients/u1': { notificationPrefs: existing } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    const res = await saveMyNotificationPrefsHandler({ data: { patch }, auth: { uid: 'u1' } } as any);
    const w = ctx.writes.find((x) => x.path === 'clients/u1');
    return { res, w, np: w?.data.notificationPrefs as any, ctx };
  }
  it('changes one channel and leaves every other preference exactly as stored', async () => {
    const { res, np, w } = await patchWith({ byCategory: { visit: { sms: true } } });
    expect(res).toEqual({ ok: true });
    expect(np.byCategory.visit).toEqual({ email: true, sms: true, push: true });
    expect(np.byCategory.invoice).toEqual({ email: true });
    expect(np.byKey).toEqual(EXISTING.byKey);
    expect(np.marketingOptIn).toEqual({ newsletter: true });
    expect(w!.options).toEqual({ mergeFields: ['notificationPrefs', 'notificationPrefsUpdatedAt'] });
  });
  it('a patch against a household with no stored prefs creates the subtree from just that choice', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await saveMyNotificationPrefsHandler({
      data: { patch: { byCategory: { visit: { sms: true } } } },
      auth: { uid: 'u1' },
    } as any);
    const np = ctx.writes.find((x) => x.path === 'clients/u1')!.data.notificationPrefs as any;
    expect(np).toEqual({ byCategory: { visit: { sms: true } }, byKey: {}, marketingOptIn: {} });
  });
  it('sets a per-key override without touching the category', async () => {
    const { np } = await patchWith({ byKey: { 'invoice.posted': { email: false } } });
    expect(np.byKey['invoice.posted']).toEqual({ sms: true, email: false });
    expect(np.byCategory).toEqual(EXISTING.byCategory);
  });
  it('null clears one per-key channel, and the last channel removes the entry', async () => {
    const { np } = await patchWith({ byKey: { 'invoice.posted': { sms: null } } });
    expect(np.byKey['invoice.posted']).toBeUndefined();
    expect(np.byKey['kintale.published']).toEqual({ email: false, push: true });
  });
  it('null on a key clears every override on that key', async () => {
    const { np } = await patchWith({ byKey: { 'kintale.published': null } });
    expect(np.byKey['kintale.published']).toBeUndefined();
    expect(np.byKey['invoice.posted']).toEqual({ sms: true });
  });
  it('merges marketingOptIn per category', async () => {
    const { np } = await patchWith({ marketingOptIn: { survey: true } });
    expect(np.marketingOptIn).toEqual({ newsletter: true, survey: true });
  });
  it('applies a whole-category master change (several channels) in one patch', async () => {
    const { np } = await patchWith({ byCategory: { visit: { email: false, sms: false, push: false } } });
    expect(np.byCategory.visit).toEqual({ email: false, sms: false, push: false });
    expect(np.byCategory.invoice).toEqual({ email: true });
  });
  it('rejects sending both prefs and patch', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(
      saveMyNotificationPrefsHandler({ data: { prefs: {}, patch: {} }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
    expect(ctx.writes).toHaveLength(0);
  });
  it('rejects neither prefs nor patch', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(saveMyNotificationPrefsHandler({ data: {}, auth: { uid: 'u1' } } as any)).rejects.toThrow();
  });
  it('rejects an unknown channel or category in a patch and writes nothing', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(
      saveMyNotificationPrefsHandler({ data: { patch: { byCategory: { visit: { fax: true } } } }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
    await expect(
      saveMyNotificationPrefsHandler({ data: { patch: { byCategory: { nope: { email: true } } } }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
    expect(ctx.writes).toHaveLength(0);
  });
  it('rejects unauthenticated patches', async () => {
    const { saveMyNotificationPrefsHandler } = await import('../src/portal/notificationPrefs');
    await expect(
      saveMyNotificationPrefsHandler({ data: { patch: {} }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

