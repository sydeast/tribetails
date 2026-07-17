import { describe, it, expect } from 'vitest';
import { setUserChannelChoice, prefsEqual } from './myNotificationsEdit';
import type { AdminNotificationPrefs } from '../api/myNotifications';

const EMPTY: AdminNotificationPrefs = { byKey: {}, byCategory: {}, marketingOptIn: {} };

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
