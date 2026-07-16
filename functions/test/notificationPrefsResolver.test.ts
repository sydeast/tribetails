import { describe, it, expect } from 'vitest';
import { overrideForStream, resolveChannels } from '../src/notifications/prefs';
import type {
  BusinessNotificationOverride,
  NotificationDef,
  UserNotificationPrefs,
} from '../src/notifications/types';

function def(overrides: Partial<NotificationDef>): NotificationDef {
  return {
    key: 'test.key',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 't', sms: 't', push: 't' },
    description: 'test',
    ...overrides,
  };
}

describe('resolveChannels', () => {
  it('defaults: only email on, sms/push off without explicit opt-in', () => {
    const r = resolveChannels(def({}), {}, null, 'kinfolk');
    expect(r).toEqual({ email: true, sms: false, push: false });
  });

  it('respects per-category default for sms/push', () => {
    const prefs: UserNotificationPrefs = {
      byCategory: { visit: { sms: true, push: true, email: false } },
    };
    const r = resolveChannels(def({}), prefs, null, 'kinfolk');
    expect(r).toEqual({ email: false, sms: true, push: true });
  });

  it('per-key override beats per-category', () => {
    const prefs: UserNotificationPrefs = {
      byCategory: { visit: { sms: true, push: true, email: true } },
      byKey: { 'test.key': { sms: false } },
    };
    const r = resolveChannels(def({}), prefs, null, 'kinfolk');
    expect(r.sms).toBe(false);
    expect(r.push).toBe(true);
  });

  it('catalog.required forces channel ON regardless of user opt-out', () => {
    const prefs: UserNotificationPrefs = {
      byKey: { 'test.key': { email: false, sms: false, push: false } },
    };
    const r = resolveChannels(def({ required: { email: true } }), prefs, null, 'kinfolk');
    expect(r.email).toBe(true);
    expect(r.sms).toBe(false);
  });

  it('admin enabled=false suppresses everything when !alwaysEnabled', () => {
    const override: BusinessNotificationOverride = { enabled: false, channels: {} };
    const r = resolveChannels(def({}), {}, override, 'kinfolk');
    expect(r).toEqual({ email: false, sms: false, push: false });
  });

  // #7 (2026-06-08): warn-but-allow-off — the operator CAN now suppress even an
  // alwaysEnabled notification (the admin UI warns first). Dispatch honors it so the
  // UI and send layer agree (no silent divergence).
  it('admin enabled=false now suppresses even alwaysEnabled notifications', () => {
    const override: BusinessNotificationOverride = { enabled: false, channels: {} };
    const r = resolveChannels(
      def({ alwaysEnabled: true, required: { email: true } }),
      {},
      override,
      'kinfolk',
    );
    expect(r.email).toBe(false);
    expect(r.sms).toBe(false);
    expect(r.push).toBe(false);
  });

  // #7: an explicit operator channel-off now beats even a catalog-required channel.
  it('admin channel off beats a catalog-required channel (warn-but-allow-off)', () => {
    const override: BusinessNotificationOverride = { enabled: true, channels: { email: false } };
    const r = resolveChannels(
      def({ required: { email: true }, allowedChannels: ['email', 'sms'] }),
      {},
      override,
      'kinfolk',
    );
    expect(r.email).toBe(false);
  });

  it('admin channel off beats user channel on', () => {
    const override: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: false },
    };
    const prefs: UserNotificationPrefs = {
      byKey: { 'test.key': { sms: true } },
    };
    const r = resolveChannels(def({}), prefs, override, 'kinfolk');
    expect(r.sms).toBe(false);
  });

  it('Run-4 #13: a locked channel ignores the kinfolk pref (admin ON wins over user OFF)', () => {
    const prefs: UserNotificationPrefs = { byKey: { 'test.key': { sms: false } } };
    const override: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: true },
      locked: { sms: true },
    };
    const r = resolveChannels(def({}), prefs, override, 'kinfolk');
    expect(r.sms).toBe(true); // locked on; user's off is ignored
  });

  it('Run-4 #13: an explicit admin OFF still wins even when that channel is locked', () => {
    const override: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: false },
      locked: { sms: true },
    };
    const r = resolveChannels(def({}), { byKey: { 'test.key': { sms: true } } }, override, 'kinfolk');
    expect(r.sms).toBe(false); // locked off; user's on is ignored
  });

  it('Run-4 #13: lockedEnabled pins every channel to the business setting, ignoring user prefs', () => {
    const prefs: UserNotificationPrefs = { byKey: { 'test.key': { email: false, sms: true, push: true } } };
    const override: BusinessNotificationOverride = {
      enabled: true,
      channels: {}, // no explicit channel values -> catalog defaults
      lockedEnabled: true,
    };
    const r = resolveChannels(def({}), prefs, override, 'kinfolk');
    // catalog default: email on, sms/push off; user prefs ignored because locked.
    expect(r).toEqual({ email: true, sms: false, push: false });
  });

  it('Run-4 #13: an unlocked channel still honors the kinfolk pref', () => {
    const prefs: UserNotificationPrefs = { byKey: { 'test.key': { sms: true } } };
    const override: BusinessNotificationOverride = { enabled: true, channels: {}, locked: { email: true } };
    const r = resolveChannels(def({}), prefs, override, 'kinfolk');
    expect(r.sms).toBe(true); // sms not locked -> user's opt-in honored
  });

  it('marketing requires explicit opt-in or all channels stay off', () => {
    const marketingDef = def({
      category: 'marketing',
      marketingCategory: 'newsletter',
      allowedChannels: ['email', 'push'],
      templates: { email: 't', push: 't' },
    });
    const r1 = resolveChannels(marketingDef, {}, null, 'kinfolk');
    expect(r1).toEqual({ email: false, sms: false, push: false });

    const r2 = resolveChannels(marketingDef, { marketingOptIn: { newsletter: true } }, null, 'kinfolk');
    expect(r2.email).toBe(true);
  });

  it('channels not in allowedChannels stay off even with opt-in', () => {
    const emailOnly = def({
      allowedChannels: ['email'],
      templates: { email: 't' },
    });
    const r = resolveChannels(
      emailOnly,
      { byKey: { 'test.key': { sms: true, push: true } } },
      null,
      'kinfolk',
    );
    expect(r).toEqual({ email: true, sms: false, push: false });
  });
});

// Audience revamp 2026-07: overrides gain per-stream overlays (streams.{kinfolk|
// business|staff}) with FIELD-level fallback to the flat fields, plus a flat
// operator-authored lockReason.
describe('overrideForStream (audience revamp 2026-07)', () => {
  it('returns null for a null override', () => {
    expect(overrideForStream(null, 'kinfolk')).toBeNull();
  });

  it('zero-migration: no streams block -> flat fields pass through unchanged for all three streams', () => {
    const flat: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: false, push: true },
      lockedEnabled: true,
      locked: { email: true },
      lockReason: 'ops requires email',
    };
    for (const stream of ['kinfolk', 'business', 'staff'] as const) {
      const eff = overrideForStream(flat, stream)!;
      expect(eff.enabled, `${stream} enabled`).toBe(true);
      expect(eff.channels, `${stream} channels`).toEqual({ sms: false, push: true });
      expect(eff.lockedEnabled, `${stream} lockedEnabled`).toBe(true);
      expect(eff.locked, `${stream} locked`).toEqual({ email: true });
      expect(eff.lockReason, `${stream} lockReason`).toBe('ops requires email');
    }
  });

  it('stream enabled overlays the flat enabled at field level', () => {
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: {},
      streams: { business: { enabled: false } },
    };
    expect(overrideForStream(ov, 'business')!.enabled).toBe(false);
    expect(overrideForStream(ov, 'kinfolk')!.enabled).toBe(true);
    expect(overrideForStream(ov, 'staff')!.enabled).toBe(true);
  });

  it('channels merge per channel: overlay value wins, missing overlay channel falls back to flat', () => {
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: true, push: false },
      streams: { kinfolk: { channels: { sms: false } } },
    };
    expect(overrideForStream(ov, 'kinfolk')!.channels).toEqual({ sms: false, push: false });
    expect(overrideForStream(ov, 'business')!.channels).toEqual({ sms: true, push: false });
  });

  it('locked merges per channel and lockedEnabled falls back at field level', () => {
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: {},
      locked: { email: true },
      streams: { staff: { locked: { sms: true }, lockedEnabled: true } },
    };
    const staff = overrideForStream(ov, 'staff')!;
    expect(staff.locked).toEqual({ email: true, sms: true }); // flat email lock survives the overlay
    expect(staff.lockedEnabled).toBe(true);
    const kin = overrideForStream(ov, 'kinfolk')!;
    expect(kin.locked).toEqual({ email: true });
    expect(kin.lockedEnabled).toBeUndefined();
  });

  it('lockReason stays flat (per-notification, not per-stream)', () => {
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: {},
      lockReason: 'legal hold',
      streams: { kinfolk: { enabled: false } },
    };
    expect(overrideForStream(ov, 'kinfolk')!.lockReason).toBe('legal hold');
    expect(overrideForStream(ov, 'business')!.lockReason).toBe('legal hold');
  });
});

describe('resolveChannels stream-awareness (audience revamp 2026-07)', () => {
  it('streams.kinfolk sms gate: kinfolk stream loses sms, business/staff streams keep it', () => {
    // Shared-key scenario from the redesign: flat sms stays available, the
    // operator gates sms off for the kinfolk stream only.
    const prefs: UserNotificationPrefs = { byKey: { 'test.key': { sms: true } } };
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: true },
      streams: { kinfolk: { channels: { sms: false } } },
    };
    expect(resolveChannels(def({}), prefs, ov, 'kinfolk').sms).toBe(false);
    expect(resolveChannels(def({}), prefs, ov, 'business').sms).toBe(true);
    expect(resolveChannels(def({}), prefs, ov, 'staff').sms).toBe(true);
  });

  it('streams.business.enabled=false kills only the business stream', () => {
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: {},
      streams: { business: { enabled: false } },
    };
    expect(resolveChannels(def({}), {}, ov, 'business')).toEqual({
      email: false,
      sms: false,
      push: false,
    });
    expect(resolveChannels(def({}), {}, ov, 'kinfolk').email).toBe(true);
    expect(resolveChannels(def({}), {}, ov, 'staff').email).toBe(true);
  });

  it('a lock in one stream does not lock the other', () => {
    const prefs: UserNotificationPrefs = { byKey: { 'test.key': { sms: false } } };
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: true },
      streams: { kinfolk: { locked: { sms: true } } },
    };
    // kinfolk: sms locked -> pinned to the admin's ON; the user's off is ignored.
    expect(resolveChannels(def({}), prefs, ov, 'kinfolk').sms).toBe(true);
    // business: unlocked -> the same user's off is honored.
    expect(resolveChannels(def({}), prefs, ov, 'business').sms).toBe(false);
  });

  it('zero-migration: an override without streams resolves identically for all three streams', () => {
    const prefs: UserNotificationPrefs = {
      byKey: { 'test.key': { push: true } },
      byCategory: { visit: { sms: true } },
    };
    const ov: BusinessNotificationOverride = {
      enabled: true,
      channels: { sms: false },
      locked: { email: true },
    };
    const kin = resolveChannels(def({}), prefs, ov, 'kinfolk');
    const biz = resolveChannels(def({}), prefs, ov, 'business');
    const stf = resolveChannels(def({}), prefs, ov, 'staff');
    expect(biz).toEqual(kin);
    expect(stf).toEqual(kin);
    expect(kin).toEqual({ email: true, sms: false, push: true });
  });
});
