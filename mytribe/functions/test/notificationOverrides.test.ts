import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/operatorAllowlist', () => ({
  isAuntieOperator: () => true,
  requireAuntieOperator: vi.fn(),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' },
  };
});

beforeEach(() => mocks.dbFn.mockReset());

import {
  getBusinessNotificationOverridesHandler,
  saveBusinessNotificationOverrideHandler,
  deleteBusinessNotificationOverrideHandler,
} from '../src/admin/notificationOverrides';

describe('getBusinessNotificationOverridesHandler', () => {
  it('returns empty overrides + full catalog when doc missing', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides).toEqual({});
    expect(res.catalog.length).toBeGreaterThan(20);
    expect(res.updatedAtMs).toBeNull();
  });

  it('returns existing byKey overrides', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/notifications': {
          byKey: {
            'kintale.published': { enabled: true, channels: { sms: false } },
          },
          updatedAtMs: 1234,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides['kintale.published']).toEqual({ enabled: true, channels: { sms: false } });
    expect(res.updatedAtMs).toBe(1234);
  });

  // Audience revamp 2026-07: the admin matrix needs each key's stream taxonomy.
  it('projects the audiences streams for every catalog row', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    const byCatalogKey = Object.fromEntries(res.catalog.map((c: any) => [c.key, c]));
    expect(byCatalogKey['kincare.booking.confirm'].audiences).toEqual({ kinfolk: true, business: true });
    expect(byCatalogKey['kincare.note.kinfolk'].audiences).toEqual({ staff: true });
    expect(byCatalogKey['kintale.published'].audiences).toEqual({ kinfolk: true });
    for (const row of res.catalog) {
      expect(row.audiences, `${row.key} must project audiences`).toBeTruthy();
    }
  });

  // Audience revamp 2026-07: streams + lockReason are stored verbatim and must
  // round-trip through the getter untouched.
  it('returns streams + lockReason verbatim from the stored override', async () => {
    const stored = {
      enabled: true,
      channels: { sms: true },
      lockReason: 'Required for care coordination',
      streams: { kinfolk: { channels: { sms: false } }, business: { enabled: false } },
    };
    const ctx = buildDbMock({
      docs: {
        'businessSettings/notifications': { byKey: { 'kintale.published': stored }, updatedAtMs: 9 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides['kintale.published']).toEqual(stored);
  });
});

describe('saveBusinessNotificationOverrideHandler', () => {
  it('writes override to businessSettings/notifications byKey map', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kintale.published',
        override: { enabled: true, channels: { sms: false, push: true } },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: 'kintale.published' });
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect(w).toBeDefined();
    expect(w!.merge).toBe(true);
    expect((w!.data.byKey as any)['kintale.published']).toEqual({
      enabled: true,
      channels: { sms: false, push: true },
    });
  });

  it('Run-4 #13: persists admin lockedEnabled + per-channel locked', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kintale.published',
        override: {
          enabled: true,
          channels: { email: true, sms: false },
          lockedEnabled: true,
          locked: { email: true },
        },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: 'kintale.published' });
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect((w!.data.byKey as any)['kintale.published']).toEqual({
      enabled: true,
      channels: { email: true, sms: false },
      lockedEnabled: true,
      locked: { email: true },
    });
  });

  // #7 (2026-06-08): warn-but-allow-off. The operator may now disable even an
  // alwaysEnabled notification or a catalog-required channel; the admin UI warns
  // first. The handler no longer rejects these.
  it('allows disabling an alwaysEnabled notification (warn-but-allow-off)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const r = await saveBusinessNotificationOverrideHandler({
      data: { key: 'auth.password.reset', override: { enabled: false } },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(r).toMatchObject({ ok: true, key: 'auth.password.reset' });
    expect(ctx.writes.some((w) => w.path === 'businessSettings/notifications')).toBe(true);
  });

  it('allows disabling a catalog-required channel (warn-but-allow-off)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const r = await saveBusinessNotificationOverrideHandler({
      data: { key: 'invoice.new', override: { enabled: true, channels: { email: false } } },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(r).toMatchObject({ ok: true, key: 'invoice.new' });
  });

  it('rejects unknown catalog keys', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: { key: 'made.up.key', override: { enabled: true } },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow(/unknown key/);
  });

  // Audience revamp 2026-07: per-stream overlays + operator lockReason.
  it('persists streams + trimmed lockReason verbatim (merge)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kincare.booking.confirm',
        override: {
          enabled: true,
          channels: { sms: true },
          lockReason: '  Bookings must reach you  ',
          streams: {
            kinfolk: { channels: { sms: false }, locked: { email: true } },
            business: { enabled: false },
          },
        },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: 'kincare.booking.confirm' });
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect(w!.merge).toBe(true);
    expect((w!.data.byKey as any)['kincare.booking.confirm']).toEqual({
      enabled: true,
      channels: { sms: true },
      lockReason: 'Bookings must reach you',
      streams: {
        kinfolk: { channels: { sms: false }, locked: { email: true } },
        business: { enabled: false },
      },
    });
  });

  it('an empty (or whitespace-only) lockReason deletes the stored field', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kintale.published',
        override: { enabled: true, channels: {}, lockReason: '   ' },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect((w!.data.byKey as any)['kintale.published'].lockReason).toBe('__DEL__');
  });

  it('rejects a lockReason longer than 300 chars after trimming', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, lockReason: 'x'.repeat(301) },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
  });

  it('rejects an unknown stream name', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, streams: { auntie: { enabled: false } } },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
  });

  it('rejects unknown channels and non-true locked values inside a stream overlay', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, streams: { kinfolk: { channels: { fax: true } } } },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, streams: { kinfolk: { locked: { sms: false } } } },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
  });
});

describe('deleteBusinessNotificationOverrideHandler', () => {
  it('clears the byKey entry for a catalog key', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteBusinessNotificationOverrideHandler({
      data: { key: 'kintale.published' },
      auth: { uid: 'admin1', token: {} },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect(w).toBeDefined();
    expect((w!.data.byKey as any)['kintale.published']).toBe('__DEL__');
  });
});
