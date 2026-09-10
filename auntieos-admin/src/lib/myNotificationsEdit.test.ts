import { describe, it, expect } from 'vitest';
import {
  applyBulkToggle,
  applyChannelToggle,
  channelMasterCount,
  channelMasterOn,
  setUserChannelChoice,
  prefsEqual,
  type BulkToggleScope,
} from './myNotificationsEdit';
import {
  STREAM_BUSINESS,
  type AdminNotificationPrefs,
  type NotificationCatalogEntry,
  type NotificationMatrix,
} from '../api/myNotifications';

const EMPTY: AdminNotificationPrefs = { byKey: {}, byCategory: {}, marketingOptIn: {} };

function entry(over: Partial<NotificationCatalogEntry> = {}): NotificationCatalogEntry {
  return {
    key: 'kincare.booking.confirm',
    label: 'Booking confirmed',
    category: 'visit',
    audience: 'business',
    audiences: new Set([STREAM_BUSINESS]),
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    alwaysEnabledStreams: new Set(),
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    whoReceives: [],
    recipientResolver: '',
    emitters: [],
    neverFires: false,
    templates: {},
    mergeFields: [],
    external: false,
    description: '',
    ...over,
  };
}

function matrix(over: Partial<NotificationMatrix> = {}): NotificationMatrix {
  return {
    catalog: [],
    overrides: {},
    ungated: [],
    businessAdminCount: null,
    businessAdminRosterPath: 'businessSettings/admins.uids',
    updatedAtMs: null,
    ...over,
  };
}

describe('setUserChannelChoice', () => {
  it('sets a fresh key with no prior byKey entry', () => {
    const next = setUserChannelChoice(EMPTY, 'kincare.booking.confirm', 'sms', true);
    expect(next.byKey).toEqual({ 'kincare.booking.confirm': { sms: true } });
  });

  it('merges into an existing byKey entry without dropping its other channels', () => {
    const start: AdminNotificationPrefs = {
      ...EMPTY,
      byKey: { 'kincare.booking.confirm': { email: true, push: false } },
    };
    const next = setUserChannelChoice(start, 'kincare.booking.confirm', 'sms', true);
    expect(next.byKey['kincare.booking.confirm']).toEqual({ email: true, push: false, sms: true });
  });

  it('never touches byCategory or another key', () => {
    const start: AdminNotificationPrefs = {
      byKey: { other: { email: true } },
      byCategory: { visit: { push: false } },
      marketingOptIn: { newsletter: true },
    };
    const next = setUserChannelChoice(start, 'kincare.booking.confirm', 'sms', true);
    expect(next.byCategory).toBe(start.byCategory);
    expect(next.byKey['other']).toEqual({ email: true });
    expect(next.marketingOptIn).toBe(start.marketingOptIn);
  });

  it('does not mutate the input object (immutability)', () => {
    const start: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { email: true } } };
    const snapshot = JSON.parse(JSON.stringify(start)) as AdminNotificationPrefs;
    setUserChannelChoice(start, 'k', 'sms', true);
    expect(start).toEqual(snapshot);
  });

  it('flips an existing boolean to its opposite', () => {
    const start: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { sms: true } } };
    const next = setUserChannelChoice(start, 'k', 'sms', false);
    expect(next.byKey['k']?.sms).toBe(false);
  });
});

describe('applyBulkToggle', () => {
  it('turns every editable channel of every entry in the section on', () => {
    const entries = [entry({ key: 'a' }), entry({ key: 'b' })];
    const next = applyBulkToggle(EMPTY, matrix(), entries, STREAM_BUSINESS, true);
    expect(next.byKey).toEqual({
      a: { email: true, sms: true, push: true },
      b: { email: true, sms: true, push: true },
    });
  });

  it('turns every editable channel off with on=false', () => {
    const start: AdminNotificationPrefs = {
      ...EMPTY,
      byKey: { a: { email: true, sms: true, push: true } },
    };
    const next = applyBulkToggle(start, matrix(), [entry({ key: 'a' })], STREAM_BUSINESS, false);
    expect(next.byKey['a']).toEqual({ email: false, sms: false, push: false });
  });

  it('never writes a catalog-required (forced) channel', () => {
    const next = applyBulkToggle(
      EMPTY,
      matrix(),
      [entry({ key: 'a', required: { email: true } })],
      STREAM_BUSINESS,
      false,
    );
    // email is pinned on by the gate, so bulk-off must not fake it off.
    expect(next.byKey['a']).toEqual({ sms: false, push: false });
    expect(next.byKey['a']).not.toHaveProperty('email');
  });

  it('never writes a business-locked (forced) channel', () => {
    const m = matrix({
      overrides: {
        a: { enabled: true, channels: {}, lockedEnabled: false, locked: { sms: true }, streams: {} },
      },
    });
    const next = applyBulkToggle(EMPTY, m, [entry({ key: 'a' })], STREAM_BUSINESS, true);
    expect(next.byKey['a']).toEqual({ email: true, push: true });
    expect(next.byKey['a']).not.toHaveProperty('sms');
  });

  it('skips a channel the business gate does not offer on this stream', () => {
    const m = matrix({
      overrides: {
        a: {
          enabled: true,
          channels: {},
          lockedEnabled: false,
          locked: {},
          streams: { [STREAM_BUSINESS]: { channels: { push: false }, locked: {} } },
        },
      },
    });
    const next = applyBulkToggle(EMPTY, m, [entry({ key: 'a' })], STREAM_BUSINESS, true);
    // push is gate-disabled for this stream, so it is not an editable channel.
    expect(next.byKey['a']).toEqual({ email: true, sms: true });
  });

  it('only writes catalog-allowed channels (never a channel outside allowedChannels)', () => {
    const next = applyBulkToggle(
      EMPTY,
      matrix(),
      [entry({ key: 'a', allowedChannels: ['email'] })],
      STREAM_BUSINESS,
      true,
    );
    expect(next.byKey['a']).toEqual({ email: true });
  });

  it('leaves byCategory and marketingOptIn untouched', () => {
    const start: AdminNotificationPrefs = {
      byKey: {},
      byCategory: { visit: { push: false } },
      marketingOptIn: { newsletter: true },
    };
    const next = applyBulkToggle(start, matrix(), [entry({ key: 'a' })], STREAM_BUSINESS, true);
    expect(next.byCategory).toBe(start.byCategory);
    expect(next.marketingOptIn).toBe(start.marketingOptIn);
  });

  it('does not mutate the input prefs (immutability)', () => {
    const start: AdminNotificationPrefs = { ...EMPTY, byKey: { a: { email: true } } };
    const snapshot = JSON.parse(JSON.stringify(start)) as AdminNotificationPrefs;
    applyBulkToggle(start, matrix(), [entry({ key: 'a' })], STREAM_BUSINESS, false);
    expect(start).toEqual(snapshot);
  });

  it('is a no-op producing an equal object when the section is empty', () => {
    const next = applyBulkToggle(EMPTY, matrix(), [], STREAM_BUSINESS, true);
    expect(next.byKey).toEqual({});
  });
});

describe('prefsEqual', () => {
  it('is true for two structurally identical objects built independently', () => {
    const a: AdminNotificationPrefs = { byKey: { k: { sms: true } }, byCategory: {}, marketingOptIn: {} };
    const b: AdminNotificationPrefs = { byCategory: {}, marketingOptIn: {}, byKey: { k: { sms: true } } };
    expect(prefsEqual(a, b)).toBe(true);
  });

  it('is true regardless of key insertion order at every depth', () => {
    const a: AdminNotificationPrefs = {
      byKey: { a: { email: true, sms: false } },
      byCategory: {},
      marketingOptIn: {},
    };
    const b: AdminNotificationPrefs = {
      byKey: { a: { sms: false, email: true } },
      byCategory: {},
      marketingOptIn: {},
    };
    expect(prefsEqual(a, b)).toBe(true);
  });

  it('is false when a leaf boolean differs', () => {
    const a: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { sms: true } } };
    const b: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { sms: false } } };
    expect(prefsEqual(a, b)).toBe(false);
  });

  it('is false when one side has an extra key the other lacks', () => {
    const a: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { sms: true, push: true } } };
    const b: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { sms: true } } };
    expect(prefsEqual(a, b)).toBe(false);
  });

  it('is true for a value compared against itself after a same-value round trip', () => {
    const a: AdminNotificationPrefs = { ...EMPTY, byKey: { k: { sms: true } } };
    const roundTripped = setUserChannelChoice(a, 'k', 'sms', true);
    expect(prefsEqual(a, roundTripped)).toBe(true);
  });
});

// ── the Account screen's per-channel master switches (#719) ─────────────────
/** One business-stream scope over `entries`, the shape the Account screen builds. */
function scopeOf(...entries: NotificationCatalogEntry[]): BulkToggleScope[] {
  return [{ entries, stream: STREAM_BUSINESS }];
}
describe('channelMasterCount', () => {
  it('counts one editable pair per notification that offers the channel', () => {
    const scopes = scopeOf(entry({ key: 'a' }), entry({ key: 'b' }));
    expect(channelMasterCount(matrix(), scopes, 'sms')).toBe(2);
  });
  it('does not count a channel the notification never offers', () => {
    const scopes = scopeOf(entry({ key: 'a', allowedChannels: ['email'] }));
    expect(channelMasterCount(matrix(), scopes, 'sms')).toBe(0);
  });
  it('does not count a forced channel: the operator does not decide it', () => {
    const scopes = scopeOf(entry({ key: 'a', required: { sms: true } }));
    expect(channelMasterCount(matrix(), scopes, 'sms')).toBe(0);
  });
  it('does not count a channel the business gate has switched off', () => {
    const m = matrix({
      overrides: {
        a: { enabled: true, channels: { sms: false }, lockedEnabled: false, locked: {}, streams: {} },
      },
    });
    expect(channelMasterCount(m, scopeOf(entry({ key: 'a' })), 'sms')).toBe(0);
  });
});
describe('channelMasterOn', () => {
  it('is on when ONE notification would reach the operator on that channel', () => {
    const prefs: AdminNotificationPrefs = { ...EMPTY, byKey: { b: { sms: true } } };
    const scopes = scopeOf(entry({ key: 'a' }), entry({ key: 'b' }));
    expect(channelMasterOn(prefs, matrix(), scopes, 'sms')).toBe(true);
  });
  it('is off only when every editable row is off', () => {
    const prefs: AdminNotificationPrefs = {
      ...EMPTY,
      byKey: { a: { sms: false }, b: { sms: false } },
    };
    const scopes = scopeOf(entry({ key: 'a' }), entry({ key: 'b' }));
    expect(channelMasterOn(prefs, matrix(), scopes, 'sms')).toBe(false);
  });
  it('reads the catalog default when the operator never chose: email on, sms off', () => {
    const scopes = scopeOf(entry({ key: 'a' }));
    expect(channelMasterOn(EMPTY, matrix(), scopes, 'email')).toBe(true);
    expect(channelMasterOn(EMPTY, matrix(), scopes, 'sms')).toBe(false);
  });
  it('is off when the channel has no editable row at all', () => {
    const scopes = scopeOf(entry({ key: 'a', allowedChannels: ['email'] }));
    expect(channelMasterOn(EMPTY, matrix(), scopes, 'push')).toBe(false);
  });
});
describe('applyChannelToggle', () => {
  it('writes the flipped channel on every editable notification', () => {
    const scopes = scopeOf(entry({ key: 'a' }), entry({ key: 'b' }));
    const next = applyChannelToggle(EMPTY, matrix(), scopes, 'sms', true);
    expect(next.byKey).toEqual({ a: { sms: true }, b: { sms: true } });
  });
  it('leaves the other two channels exactly where the operator left them', () => {
    const prefs: AdminNotificationPrefs = { ...EMPTY, byKey: { a: { email: true, push: false } } };
    const next = applyChannelToggle(prefs, matrix(), scopeOf(entry({ key: 'a' })), 'sms', true);
    expect(next.byKey['a']).toEqual({ email: true, push: false, sms: true });
  });
  it('skips a forced channel rather than writing a value the gate would override', () => {
    const scopes = scopeOf(entry({ key: 'a', required: { sms: true } }), entry({ key: 'b' }));
    const next = applyChannelToggle(EMPTY, matrix(), scopes, 'sms', false);
    expect(next.byKey).toEqual({ b: { sms: false } });
  });
  it('round-trips: on then off leaves every editable row explicitly off', () => {
    const scopes = scopeOf(entry({ key: 'a' }), entry({ key: 'b' }));
    const on = applyChannelToggle(EMPTY, matrix(), scopes, 'push', true);
    const off = applyChannelToggle(on, matrix(), scopes, 'push', false);
    expect(channelMasterOn(off, matrix(), scopes, 'push')).toBe(false);
    expect(off.byKey).toEqual({ a: { push: false }, b: { push: false } });
  });
  it('does not mutate the input prefs', () => {
    const start: AdminNotificationPrefs = { ...EMPTY, byKey: { a: { email: true } } };
    const snapshot = JSON.parse(JSON.stringify(start)) as AdminNotificationPrefs;
    applyChannelToggle(start, matrix(), scopeOf(entry({ key: 'a' })), 'sms', true);
    expect(start).toEqual(snapshot);
  });
});
