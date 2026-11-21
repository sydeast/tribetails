import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
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
  NOTIFICATION_CATALOG,
  NOTIFICATION_KEY_ALIASES,
  canonicalNotificationKey,
  getNotificationDef,
  legacyKeysFor,
  listNotificationKeys,
} from '../src/notifications/catalog';
import { resolveChannels } from '../src/notifications/prefs';
import { enqueueNotification } from '../src/notifications/dispatcher';
import { DIRECT_SEND_KEYS } from '../src/notifications/catalogKeys';

const LEGACY = 'kincare.report.sent';
const CANONICAL = 'kintale.published';

/**
 * A KinTale IS the visit report. `kincare.report.sent` (dispatched by the
 * `dispatchVisitNotification` callable on the Auntie's Send tap) and
 * `kintale.published` (dispatched by the `onKinTaleCreate` trigger) describe
 * the same real-world moment, so the operator saw two switches for one thing.
 * They are now ONE catalog row, with the old key kept as an alias so every
 * pref and override already stored under it keeps working.
 */
describe('notification key aliases: catalog shape', () => {
  it('exposes exactly one KinTale-publish key (the canonical one)', () => {
    const keys = listNotificationKeys();
    expect(keys).toContain(CANONICAL);
    expect(keys).not.toContain(LEGACY);
    expect(NOTIFICATION_CATALOG[LEGACY]).toBeUndefined();
  });

  it('declares the legacy key as an alias of the canonical key', () => {
    expect(NOTIFICATION_KEY_ALIASES[LEGACY]?.canonical).toBe(CANONICAL);
    // The legacy row lived under the `visit` category; kept so a household that
    // muted the whole Visit Updates row stays muted after the merge.
    expect(NOTIFICATION_KEY_ALIASES[LEGACY]?.legacyCategory).toBe('visit');
    expect(legacyKeysFor(CANONICAL)).toEqual([LEGACY]);
  });

  it('resolves the legacy key to the canonical def at catalog-read time', () => {
    const def = getNotificationDef(LEGACY);
    expect(def.key).toBe(CANONICAL);
    expect(def.templates.email).toBe(CANONICAL);
  });

  it('NEGATIVE: an unknown key is still a loud failure, not an alias', () => {
    expect(canonicalNotificationKey('nope.not.a.key')).toBe('nope.not.a.key');
    expect(() => getNotificationDef('nope.not.a.key')).toThrow(/unknown key/);
    expect(legacyKeysFor('nope.not.a.key')).toEqual([]);
  });

  it('relabels the three KinTale rows so the comment box and the body read differently', () => {
    expect(NOTIFICATION_CATALOG[CANONICAL]!.label).toBe('KinTale (visit report) published');
    expect(NOTIFICATION_CATALOG['kintale.comment.added']!.label).toBe(
      'New comment on a KinTale (comment box)',
    );
    expect(NOTIFICATION_CATALOG['kintale.note.added']!.label).toBe(
      'Auntie added to a KinTale after sending',
    );
  });
});

describe('notification key aliases: seeded templates', () => {
  const seedsDir = join(__dirname, '..', '..', 'seeds', 'notificationTemplates');

  it('the merged key still has an email template to render', () => {
    const dirs = readdirSync(seedsDir);
    expect(dirs).toContain(CANONICAL);
    expect(readdirSync(join(seedsDir, CANONICAL))).toContain('content.html');
    // The canonical row's template ids are what a send actually resolves, for a
    // legacy-key dispatch too (getNotificationDef returns the canonical def).
    expect(getNotificationDef(LEGACY).templates.email).toBe(CANONICAL);
  });

  it('every seed dir is a catalog key or a declared alias (mirrors the seeder guard)', () => {
    // seedNotificationTemplates.ts throws on a dir that is neither. The retired
    // key keeps its dir and its already-seeded docs; nothing is orphaned.
    // #1586: a direct-send key (DIRECT_SEND_KEYS, e.g. invite.verify-email)
    // may carry a dir too; the seeder accepts it the same way.
    const known = new Set([
      ...listNotificationKeys(),
      ...Object.keys(NOTIFICATION_KEY_ALIASES),
      ...DIRECT_SEND_KEYS.map((d) => d.key),
    ]);
    for (const dir of readdirSync(seedsDir)) {
      expect(known.has(dir), `seed dir ${dir} matches no catalog key, alias or direct-send key`).toBe(true);
    }
    expect(readdirSync(seedsDir)).toContain(LEGACY);
  });
});

describe('notification key aliases: dispatch', () => {
  it('dispatching the legacy key writes the canonical key on the notification doc', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const ids = await enqueueNotification({
      key: LEGACY,
      recipientUid: 'kin1',
      data: { kinfolkId: 'f1', reportId: 'r1' },
    });
    expect(ids.length).toBe(1);
    const written = ctx.writes.find((w) => w.path.startsWith('notifications/'));
    expect(written).toBeTruthy();
    expect(written!.data.key).toBe(CANONICAL);
    // #2093: the household's copy carries the household title (#1372). #1831:
    // the line under it is the tale's own facts, and this fixture holds no
    // tale, so there is none; never the operator's or the settings wording.
    expect(written!.data.title).toBe('Your KinTale is ready');
    expect(written!.data.description).toBe('');
  });

  /**
   * What a legacy pref governs is DELIVERY. It used to be shown on email: the
   * stored legacy pref turned email off and nothing went out. Since #2382
   * (2026-11-20) the KinTale notice's email is locked on for households, so a
   * household can no longer turn it off under either name. The alias walk is
   * shown on push instead, which stays the household's choice: off by default,
   * on because of a pref stored under the retired key. The notifications record
   * is written either way (#1505).
   */
  const channelsOf = (writes: Array<{ path: string; data: Record<string, unknown> }>) =>
    writes.filter((w) => w.path.startsWith('notificationDispatch/')).map((w) => w.data.channels);
  const records = (writes: Array<{ path: string }>) => writes.filter((w) => w.path.startsWith('notifications/'));

  for (const key of [LEGACY, CANONICAL]) {
    it(`a pref stored under the legacy key still governs the ${key} dispatch`, async () => {
      const ctx = buildDbMock({
        docs: {
          'clients/kin1': {
            notificationPrefs: { byKey: { [LEGACY]: { email: false, push: true } } },
          },
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const ids = await enqueueNotification({ key, recipientUid: 'kin1', data: { kinfolkId: 'f1' } });
      expect(ids).toHaveLength(1);
      expect(records(ctx.writes)).toHaveLength(1);
      // Push on from the retired key's pref; email on whatever it says (#2382).
      expect(channelsOf(ctx.writes as never)).toEqual([['email', 'push']]);
    });
  }

  it('a business override stored under the legacy key still governs both keys', async () => {
    for (const key of [LEGACY, CANONICAL]) {
      const ctx = buildDbMock({
        docs: {
          'clients/kin1': { notificationPrefs: { byKey: { [CANONICAL]: { push: true } } } },
          'businessSettings/notifications': {
            byKey: { [LEGACY]: { enabled: true, channels: { push: false } } },
          },
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      await enqueueNotification({ key, recipientUid: 'kin1', data: { kinfolkId: 'f1' } });
      expect(channelsOf(ctx.writes as never), `${key}: push gated off by the legacy override`).toEqual([['email']]);
    }
  });

  it('#2382: a legacy override switching the KinTale notice off no longer holds the household copy', async () => {
    for (const key of [LEGACY, CANONICAL]) {
      const ctx = buildDbMock({
        docs: {
          'businessSettings/notifications': { byKey: { [LEGACY]: { enabled: false, channels: {} } } },
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const ids = await enqueueNotification({ key, recipientUid: 'kin1', data: { kinfolkId: 'f1' } });
      expect(ids, key).toHaveLength(1);
      expect(channelsOf(ctx.writes as never), key).toEqual([['email']]);
    }
  });
});

describe('notification key aliases: pref resolution precedence', () => {
  const def = () => NOTIFICATION_CATALOG[CANONICAL]!;

  // Shown on push: since #2382 the KinTale notice's email is locked on for
  // households, so no pref under either name moves it.
  it('honors an explicit legacy byKey pref when no canonical pref exists', () => {
    const out = resolveChannels(def(), { byKey: { [LEGACY]: { email: false, push: true } } }, null, 'kinfolk');
    expect(out.email).toBe(true);
    expect(out.push).toBe(true);
  });

  it('the canonical byKey pref wins when both are set (no stuck toggle)', () => {
    // The merged toggle writes the canonical key. What the household sees in the
    // UI must be what the dispatcher does, immediately.
    const out = resolveChannels(
      def(),
      { byKey: { [CANONICAL]: { push: false }, [LEGACY]: { push: true } } },
      null,
      'kinfolk',
    );
    expect(out.push).toBe(false);
  });

  it('falls back to the legacy category row when nothing else is set', () => {
    // Someone who turned push on for the whole "Visit Updates" category before
    // the merge keeps getting the merged notification by push.
    const out = resolveChannels(def(), { byCategory: { visit: { push: true } } }, null, 'kinfolk');
    expect(out.push).toBe(true);
  });

  it('the canonical category row wins over the legacy category row', () => {
    const out = resolveChannels(
      def(),
      { byCategory: { kintale: { push: false }, visit: { push: true } } },
      null,
      'kinfolk',
    );
    expect(out.push).toBe(false);
  });

  it('any byKey pref outranks any category pref, canonical or legacy', () => {
    const out = resolveChannels(
      def(),
      { byKey: { [LEGACY]: { push: true } }, byCategory: { kintale: { push: false } } },
      null,
      'kinfolk',
    );
    expect(out.push).toBe(true);
  });

  it('no pref at all still lands on the catalog default (email on, sms/push off)', () => {
    const out = resolveChannels(def(), {}, null, 'kinfolk');
    expect(out).toEqual({ email: true, sms: false, push: false });
  });
});

describe('notification key aliases: business override admin surface', () => {
  it('folds a legacy stored override onto the canonical row and hides the legacy row', async () => {
    const stored = { enabled: true, channels: { sms: false } };
    const ctx = buildDbMock({
      docs: {
        'businessSettings/notifications': { byKey: { [LEGACY]: stored }, updatedAtMs: 7 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getBusinessNotificationOverridesHandler } = await import(
      '../src/admin/notificationOverrides'
    );
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides[CANONICAL]).toEqual(stored);
    expect(res.overrides[LEGACY]).toBeUndefined();
    // One row in the matrix, not two.
    const keys = res.catalog.map((c) => c.key);
    expect(keys).toContain(CANONICAL);
    expect(keys).not.toContain(LEGACY);
  });

  it('a canonical override wins over a stale legacy one', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/notifications': {
          byKey: {
            [LEGACY]: { enabled: false, channels: {} },
            [CANONICAL]: { enabled: true, channels: { push: true } },
          },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getBusinessNotificationOverridesHandler } = await import(
      '../src/admin/notificationOverrides'
    );
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides[CANONICAL]).toEqual({ enabled: true, channels: { push: true } });
  });

  it('saving under the legacy key writes the canonical row and clears the legacy one', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveBusinessNotificationOverrideHandler } = await import(
      '../src/admin/notificationOverrides'
    );
    const res = await saveBusinessNotificationOverrideHandler({
      // Text off, which #2382 leaves the operator's: an off for the row or its
      // email is refused for this key now (notificationOverrides.test.ts).
      data: { key: LEGACY, override: { enabled: true, channels: { sms: false } } },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: CANONICAL });
    const w = ctx.writes.find((x) => x.path === 'businessSettings/notifications');
    expect((w!.data.byKey as any)[CANONICAL]).toEqual({
      enabled: true,
      channels: { sms: false },
    });
    expect((w!.data.byKey as any)[LEGACY]).toBe('__DEL__');
  });

  it('deleting the canonical override also clears the legacy shadow row', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteBusinessNotificationOverrideHandler } = await import(
      '../src/admin/notificationOverrides'
    );
    await deleteBusinessNotificationOverrideHandler({
      data: { key: CANONICAL },
      auth: { uid: 'admin1', token: {} },
    } as any);
    const w = ctx.writes.find((x) => x.path === 'businessSettings/notifications');
    expect((w!.data.byKey as any)[CANONICAL]).toBe('__DEL__');
    expect((w!.data.byKey as any)[LEGACY]).toBe('__DEL__');
  });
});

describe('notification key aliases: kinfolk catalog read', () => {
  it('returns one KinTale-publish row, under KinTales, never the legacy key', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getNotificationCatalogHandler } = await import(
      '../src/notifications/getNotificationCatalog'
    );
    const res = await getNotificationCatalogHandler({ data: {}, auth: { uid: 'kin1' } } as any);
    const allKeys = res.categories.flatMap((c) => c.keys.map((k) => k.key));
    expect(allKeys.filter((k) => k === CANONICAL).length).toBe(1);
    expect(allKeys).not.toContain(LEGACY);
    const row = res.categories
      .flatMap((c) => c.keys)
      .find((k) => k.key === CANONICAL)!;
    expect(row.title).toBe('KinTale (visit report) published');
  });
});
