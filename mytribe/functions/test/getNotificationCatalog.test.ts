import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getNotificationCatalogHandler, lockedChannelsFor } from '../src/notifications/getNotificationCatalog';
import { HttpsError } from 'firebase-functions/v2/https';

// #6: the handler now reads the admin's businessSettings/notifications overrides to gate
// the kinfolk catalog. Mock the Firestore read; tests set `h.overrideData` per case.
const h = vi.hoisted(() => ({ overrideData: undefined as { byKey?: Record<string, unknown> } | undefined }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    collection: () => ({
      doc: () => ({ get: async () => ({ data: () => h.overrideData }) }),
    }),
  }),
}));

const SIGNED_IN = { uid: 'kinfolk-test-uid' };

describe('getNotificationCatalogHandler', () => {
  beforeEach(() => {
    h.overrideData = undefined; // no admin overrides -> catalog defaults
  });

  it('rejects unauthenticated callers', async () => {
    await expect(
      getNotificationCatalogHandler({ data: {} } as never),
    ).rejects.toBeInstanceOf(HttpsError);
  });

  it('returns categorised kinfolk-facing keys for signed-in users', async () => {
    const result = await getNotificationCatalogHandler({
      data: {},
      auth: SIGNED_IN,
    } as never);

    expect(result.schemaVersion).toBe(1);
    expect(Array.isArray(result.categories)).toBe(true);
    expect(result.categories.length).toBeGreaterThan(0);

    // Spot-check: visit category contains kincare.auntie.* keys.
    const visit = result.categories.find((c) => c.id === 'visit');
    expect(visit).toBeDefined();
    const visitKeys = visit!.keys.map((k) => k.key);
    expect(visitKeys).toContain('kincare.auntie.on_my_way');
    expect(visitKeys).toContain('kincare.auntie.arrived');
    expect(visitKeys).toContain('kincare.auntie.departed');
  });

  // Audience revamp 2026-07: alwaysEnabled keys are no longer hidden from the
  // kinfolk portal. They are surfaced with their REQUIRED channels locked and
  // the rest free.
  //
  // This assertion used to read `lockedChannels === allowedChannels`, i.e. the
  // flag locked everything. #491 removed that: `resolveChannels` has no
  // alwaysEnabled check (ruling #7), so the household's own preference is what
  // decides those channels, and a screen rendering them read-only was telling
  // a household it could not change something it can.
  it('surfaces alwaysEnabled keys with only their required channels locked', async () => {
    const result = await getNotificationCatalogHandler({
      data: {},
      auth: SIGNED_IN,
    } as never);
    const allKeys = result.categories.flatMap((c) => c.keys);
    for (const key of ['kincare.booking.confirm', 'kincare.booking.cancel']) {
      const dto = allKeys.find((k) => k.key === key);
      expect(dto, `${key} must now be surfaced`).toBeDefined();
      expect(dto!.lockedChannels, `${key} locks exactly its required channels`).toEqual(
        dto!.required,
      );
      expect(dto!.allowedChannels.length).toBeGreaterThan(0);
      // Every lock ships the value the dispatcher will use for it.
      for (const ch of dto!.lockedChannels) {
        expect(dto!.lockedChannelValues[ch], `${key}/${ch} must carry its resolved value`).toBe(
          true,
        );
      }
    }
  });

  // Audience revamp 2026-07: the filter is now audiences.kinfolk (was kinfolkFacing),
  // so business-only and staff-only keys stay hidden from the kinfolk portal.
  it('excludes keys without the kinfolk audience (business/staff-only)', async () => {
    const result = await getNotificationCatalogHandler({
      data: {},
      auth: SIGNED_IN,
    } as never);
    const allKeys = result.categories.flatMap((c) => c.keys.map((k) => k.key));
    expect(allKeys).toContain('kincare.auntie.on_my_way'); // kinfolk
    expect(allKeys).toContain('kintale.comment.added'); // kinfolk + staff
    for (const hidden of [
      'kincare.requested', // business
      'kincare.note.kinfolk', // staff
      'quote.denied', // business
      'schedule.upcoming.digest', // staff
      // `account.welcome.business` was in this list. It is retired now, so
      // asserting the kinfolk catalog omits it would assert nothing: no catalog
      // read can return a key that has no row. notificationCatalog.test.ts pins
      // its absence from the catalog itself.
      'invite.expired', // business
      'security.breach_attempt.kinfolk', // business
      'security.breach_attempt.staff', // business (#892)
      'security.account.locked.operator', // business (#869)
      'security.failedLogin.attempts.operator', // business (#877)
      'rating.submitted.bad', // business
      'rating.submitted.good', // business
      'pet.marked.inactive', // business
    ]) {
      expect(allKeys, `${hidden} must stay hidden`).not.toContain(hidden);
    }
    // Marketing category still only carries opt-in keys.
    const marketing = result.categories.find((c) => c.id === 'marketing');
    if (marketing) {
      for (const k of marketing.keys) {
        expect(k.marketingCategory).not.toBeNull();
      }
    }
    expect(allKeys.length).toBeGreaterThan(0);
  });

  it('projects required channels as an array (not the source partial map)', async () => {
    const result = await getNotificationCatalogHandler({
      data: {},
      auth: SIGNED_IN,
    } as never);
    for (const cat of result.categories) {
      for (const key of cat.keys) {
        expect(Array.isArray(key.required)).toBe(true);
        // Required channels MUST be a subset of allowedChannels.
        for (const req of key.required) {
          expect(key.allowedChannels).toContain(req);
        }
      }
    }
  });

  it('marketingCategory is null for non-marketing keys, set for marketing keys', async () => {
    const result = await getNotificationCatalogHandler({
      data: {},
      auth: SIGNED_IN,
    } as never);
    const allKeys = result.categories.flatMap((c) => c.keys);
    const marketingKeys = allKeys.filter((k) => k.marketingCategory !== null);
    const nonMarketingKeys = allKeys.filter((k) => k.marketingCategory === null);
    expect(marketingKeys.length).toBeGreaterThan(0);
    expect(nonMarketingKeys.length).toBeGreaterThan(0);
  });

  it('#6: hides admin-disabled types and drops admin-disabled channels (gating)', async () => {
    h.overrideData = {
      byKey: {
        // Admin turned this type off business-wide -> kinfolk should not see it at all.
        'kincare.auntie.on_my_way': { enabled: false, channels: {} },
        // Admin kept the type but disabled the SMS channel -> only SMS drops out.
        'kincare.auntie.arrived': { enabled: true, channels: { sms: false } },
      },
    };
    const result = await getNotificationCatalogHandler({ data: {}, auth: SIGNED_IN } as never);
    const allKeys = result.categories.flatMap((c) => c.keys);

    expect(allKeys.find((k) => k.key === 'kincare.auntie.on_my_way')).toBeUndefined();

    const arrived = allKeys.find((k) => k.key === 'kincare.auntie.arrived');
    expect(arrived).toBeDefined();
    expect(arrived!.allowedChannels).not.toContain('sms');
    expect(arrived!.allowedChannels).toContain('email');
  });

  it('Run-4 #13: surfaces admin-locked channels so the kinfolk renders them read-only', async () => {
    h.overrideData = {
      byKey: {
        'kincare.auntie.arrived': { enabled: true, channels: {}, locked: { email: true } },
        'kincare.auntie.departed': { enabled: true, channels: {}, lockedEnabled: true },
      },
    };
    const result = await getNotificationCatalogHandler({ data: {}, auth: SIGNED_IN } as never);
    const allKeys = result.categories.flatMap((c) => c.keys);

    const arrived = allKeys.find((k) => k.key === 'kincare.auntie.arrived');
    expect(arrived!.lockedChannels).toEqual(['email']);

    // lockedEnabled pins every allowed channel.
    const departed = allKeys.find((k) => k.key === 'kincare.auntie.departed');
    expect(departed!.lockedChannels).toEqual(departed!.allowedChannels);

    // A non-alwaysEnabled notification with no admin lock surfaces an empty
    // lockedChannels array. (Audience revamp 2026-07: catalog order now starts
    // with alwaysEnabled keys, which are locked by design, so pick explicitly.)
    h.overrideData = undefined;
    const r2 = await getNotificationCatalogHandler({ data: {}, auth: SIGNED_IN } as never);
    const onMyWay = r2.categories.flatMap((c) => c.keys).find((k) => k.key === 'kincare.auntie.on_my_way');
    expect(onMyWay!.lockedChannels).toEqual([]);
  });

  // Audience revamp 2026-07: the operator's gate reads come from the KINFOLK
  // stream-effective override view, so a per-stream overlay only bites when it
  // targets the kinfolk stream.
  it('applies kinfolk stream-effective gating (streams overlays)', async () => {
    h.overrideData = {
      byKey: {
        // kinfolk overlay drops sms from the kinfolk catalog...
        'kincare.auntie.arrived': {
          enabled: true,
          channels: {},
          streams: { kinfolk: { channels: { sms: false } } },
        },
        // ...a business overlay must NOT leak into the kinfolk view...
        'kincare.auntie.departed': {
          enabled: true,
          channels: {},
          streams: { business: { enabled: false, channels: { sms: false } } },
        },
        // ...and a kinfolk-stream kill hides the key entirely.
        'kincare.auntie.on_my_way': {
          enabled: true,
          channels: {},
          streams: { kinfolk: { enabled: false } },
        },
      },
    };
    const result = await getNotificationCatalogHandler({ data: {}, auth: SIGNED_IN } as never);
    const allKeys = result.categories.flatMap((c) => c.keys);

    const arrived = allKeys.find((k) => k.key === 'kincare.auntie.arrived');
    expect(arrived!.allowedChannels).not.toContain('sms');
    expect(arrived!.allowedChannels).toContain('email');

    const departed = allKeys.find((k) => k.key === 'kincare.auntie.departed');
    expect(departed).toBeDefined();
    expect(departed!.allowedChannels).toContain('sms');

    expect(allKeys.find((k) => k.key === 'kincare.auntie.on_my_way')).toBeUndefined();
  });

  it('passes the operator lockReason through trimmed, null when absent', async () => {
    h.overrideData = {
      byKey: {
        'kincare.auntie.arrived': {
          enabled: true,
          channels: {},
          locked: { email: true },
          lockReason: '  Required for service quality  ',
        },
      },
    };
    const result = await getNotificationCatalogHandler({ data: {}, auth: SIGNED_IN } as never);
    const allKeys = result.categories.flatMap((c) => c.keys);

    const arrived = allKeys.find((k) => k.key === 'kincare.auntie.arrived');
    expect(arrived!.lockReason).toBe('Required for service quality');

    const departed = allKeys.find((k) => k.key === 'kincare.auntie.departed');
    expect(departed!.lockReason).toBeNull();
  });

  // Audience revamp 2026-07: catalog-required channels are user-immutable in
  // resolveChannels, so the portal surfaces them as locked. The union branch has
  // no live non-alwaysEnabled catalog key yet, so pin it on the pure helper.
  it('lockedChannelsFor unions per-channel operator locks with catalog-required channels', () => {
    const syntheticDef = {
      key: 'synthetic.key',
      audience: 'kinfolk',
      audiences: { kinfolk: true },
      category: 'visit',
      allowedChannels: ['email', 'sms', 'push'],
      required: { email: true },
      alwaysEnabled: false,
      kinfolkFacing: true,
      deliveryMode: 'trigger',
      recipientResolver: 'kinfolkAcct',
      templates: { email: 't', sms: 't', push: 't' },
      description: 'synthetic',
    } as const;
    const surviving: Array<'email' | 'sms' | 'push'> = ['email', 'sms', 'push'];

    // required-only: locked even with no override at all.
    expect(lockedChannelsFor(syntheticDef as never, null, surviving)).toEqual(['email']);
    // union with an operator per-channel lock.
    expect(
      lockedChannelsFor(syntheticDef as never, { enabled: true, channels: {}, locked: { sms: true } }, surviving),
    ).toEqual(['email', 'sms']);
    // lockedEnabled pins everything that survived the gate.
    expect(
      lockedChannelsFor(syntheticDef as never, { enabled: true, channels: {}, lockedEnabled: true }, surviving),
    ).toEqual(surviving);
    // alwaysEnabled pins NOTHING on its own (#491). The flag is advisory —
    // nothing in resolveChannels reads it — so locking on it made every client
    // draw a read-only control over a channel the household still governs.
    expect(
      lockedChannelsFor({ ...syntheticDef, alwaysEnabled: true } as never, null, surviving),
    ).toEqual(['email']);
  });
});
