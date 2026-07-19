import { describe, it, expect } from 'vitest';
import { applyBulkToggle, setUserChannelChoice, prefsEqual } from './myNotificationsEdit';
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
    description: '',
    ...over,
  };
}

function matrix(over: Partial<NotificationMatrix> = {}): NotificationMatrix {
  return { catalog: [], overrides: {}, updatedAtMs: null, ...over };
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
