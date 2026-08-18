import { describe, it, expect } from 'vitest';
import {
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  STREAM_STAFF,
  type NotificationCatalogEntry,
  type NotificationMatrix,
  type NotificationOverride,
} from '../api/myNotifications';
import {
  alwaysEnabledFor,
  catalogForStream,
  currentOverride,
  defaultOverride,
  encodeOverridePayload,
  setLockReason,
  setStreamChannel,
  setStreamEnabled,
  sharedCopyCaption,
  toggledStreamChannelLock,
  toggledStreamEnabledLock,
  withStreamGate,
} from './notificationGateEdit';

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

describe('catalogForStream', () => {
  it('keeps only entries that serve the stream', () => {
    const biz = entry({ key: 'b' });
    const kin = entry({ key: 'k', audiences: new Set([STREAM_KINFOLK]) });
    const both = entry({ key: 'x', audiences: new Set([STREAM_BUSINESS, STREAM_KINFOLK]) });
    const cat = [biz, kin, both];
    expect(catalogForStream(cat, STREAM_BUSINESS).map((e) => e.key)).toEqual(['b', 'x']);
    expect(catalogForStream(cat, STREAM_KINFOLK).map((e) => e.key)).toEqual(['k', 'x']);
    expect(catalogForStream(cat, STREAM_STAFF)).toEqual([]);
  });
});

describe('sharedCopyCaption', () => {
  it('names the OTHER audience for a shared key, null for a single-audience key', () => {
    const shared = entry({ audiences: new Set([STREAM_BUSINESS, STREAM_KINFOLK]) });
    expect(sharedCopyCaption(shared, STREAM_BUSINESS)).toBe('Kinfolk get their own copy of this one');
    expect(sharedCopyCaption(shared, STREAM_KINFOLK)).toBe('The owner gets their own copy of this one');
    expect(sharedCopyCaption(entry({}), STREAM_BUSINESS)).toBeNull();
  });

  it('is null when the entry does not serve the current stream', () => {
    expect(sharedCopyCaption(entry({}), STREAM_KINFOLK)).toBeNull();
  });
});

describe('alwaysEnabledFor', () => {
  it('applies to every served stream when alwaysEnabledStreams is empty', () => {
    const e = entry({ alwaysEnabled: true, audiences: new Set([STREAM_BUSINESS, STREAM_KINFOLK]) });
    expect(alwaysEnabledFor(e, STREAM_BUSINESS)).toBe(true);
    expect(alwaysEnabledFor(e, STREAM_KINFOLK)).toBe(true);
  });

  it('is scoped to the listed streams when alwaysEnabledStreams is non-empty', () => {
    const e = entry({
      alwaysEnabled: true,
      audiences: new Set([STREAM_BUSINESS, STREAM_KINFOLK]),
      alwaysEnabledStreams: new Set([STREAM_KINFOLK]),
    });
    expect(alwaysEnabledFor(e, STREAM_BUSINESS)).toBe(false);
    expect(alwaysEnabledFor(e, STREAM_KINFOLK)).toBe(true);
  });

  it('is false when the entry is not alwaysEnabled at all', () => {
    expect(alwaysEnabledFor(entry({}), STREAM_BUSINESS)).toBe(false);
  });
});

describe('currentOverride', () => {
  it('seeds enabled + per-allowed-channel channels from the effective flat values when none exists', () => {
    const o = currentOverride(matrix({}), entry({}));
    expect(o).toEqual({
      enabled: true,
      channels: { email: true, sms: true, push: true },
      lockedEnabled: false,
      locked: {},
      streams: {},
    });
  });

  it('returns the existing override untouched when one is stored', () => {
    const stored: NotificationOverride = {
      enabled: false,
      channels: { email: false },
      lockedEnabled: true,
      locked: { email: true },
      streams: {},
    };
    const m = matrix({ overrides: { 'kincare.booking.confirm': stored } });
    expect(currentOverride(m, entry({}))).toBe(stored);
  });
});

describe('withStreamGate / setStreamEnabled / setStreamChannel', () => {
  it('creates an empty gate then applies the transform, leaving siblings alone', () => {
    const base = defaultOverride();
    const next = withStreamGate(base, STREAM_BUSINESS, (g) => ({ ...g, enabled: false }));
    expect(next.streams[STREAM_BUSINESS]).toEqual({ channels: {}, locked: {}, enabled: false });
    // Original untouched (immutability).
    expect(base.streams[STREAM_BUSINESS]).toBeUndefined();
  });

  it('setStreamChannel writes only that stream + channel', () => {
    const o = setStreamChannel(defaultOverride(), STREAM_STAFF, 'sms', false);
    expect(o.streams[STREAM_STAFF]).toEqual({ channels: { sms: false }, locked: {} });
  });

  it('setStreamEnabled writes only that stream', () => {
    const o = setStreamEnabled(defaultOverride(), STREAM_KINFOLK, false);
    expect(o.streams[STREAM_KINFOLK]).toEqual({ channels: {}, locked: {}, enabled: false });
  });
});

describe('toggledStreamChannelLock', () => {
  it('locks a channel for a stream when none is set', () => {
    const o = toggledStreamChannelLock(matrix({}), entry({}), STREAM_BUSINESS, 'email');
    expect(o.streams[STREAM_BUSINESS]?.locked).toEqual({ email: true });
  });

  it('removes a stream-only lock when toggled off', () => {
    const stored: NotificationOverride = {
      ...defaultOverride(),
      streams: { [STREAM_BUSINESS]: { channels: {}, locked: { email: true } } },
    };
    const m = matrix({ overrides: { 'kincare.booking.confirm': stored } });
    const o = toggledStreamChannelLock(m, entry({}), STREAM_BUSINESS, 'email');
    expect(o.streams[STREAM_BUSINESS]?.locked.email).toBeUndefined();
  });

  it('unlocking a FLAT lock clears it and materializes it on every OTHER served stream', () => {
    const shared = entry({ audiences: new Set([STREAM_BUSINESS, STREAM_KINFOLK]) });
    const stored: NotificationOverride = { ...defaultOverride(), locked: { email: true } };
    const m = matrix({ overrides: { 'kincare.booking.confirm': stored } });
    const o = toggledStreamChannelLock(m, shared, STREAM_BUSINESS, 'email');
    // Flat lock cleared, so it no longer leaks onto business.
    expect(o.locked.email).toBeUndefined();
    // Kinfolk's effective lock is preserved by an explicit stream lock.
    expect(o.streams[STREAM_KINFOLK]?.locked).toEqual({ email: true });
    // Business is explicitly unlocked.
    expect(o.streams[STREAM_BUSINESS]?.locked.email).toBeUndefined();
  });
});

describe('toggledStreamEnabledLock', () => {
  it('turns the stream whole-notification lock on when off', () => {
    const o = toggledStreamEnabledLock(matrix({}), entry({}), STREAM_BUSINESS);
    expect(o.streams[STREAM_BUSINESS]?.lockedEnabled).toBe(true);
  });

  it('turns it off (explicit false) when a flat lock is on, so one stream unlocks', () => {
    const stored: NotificationOverride = { ...defaultOverride(), lockedEnabled: true };
    const m = matrix({ overrides: { 'kincare.booking.confirm': stored } });
    const o = toggledStreamEnabledLock(m, entry({}), STREAM_BUSINESS);
    expect(o.streams[STREAM_BUSINESS]?.lockedEnabled).toBe(false);
  });
});

describe('encodeOverridePayload (wire shape = saveBusinessNotificationOverride schema)', () => {
  it('always sends enabled; sends channels verbatim (both true and false)', () => {
    const o: NotificationOverride = {
      enabled: true,
      channels: { email: true, sms: false, push: true },
      lockedEnabled: false,
      locked: {},
      streams: {},
    };
    expect(encodeOverridePayload(o)).toEqual({
      enabled: true,
      channels: { email: true, sms: false, push: true },
    });
  });

  it('sends flat lockedEnabled only when true, and lock maps as literal-true only', () => {
    const o: NotificationOverride = {
      enabled: true,
      channels: {},
      lockedEnabled: true,
      locked: { email: true, sms: false },
      streams: {},
    };
    expect(encodeOverridePayload(o)).toEqual({
      enabled: true,
      lockedEnabled: true,
      locked: { email: true },
    });
  });

  it('passes lockReason through, including "" as the explicit clear', () => {
    expect(encodeOverridePayload({ ...defaultOverride(), lockReason: 'Legal requirement' })).toEqual({
      enabled: true,
      lockReason: 'Legal requirement',
    });
    expect(encodeOverridePayload({ ...defaultOverride(), lockReason: '' })).toEqual({
      enabled: true,
      lockReason: '',
    });
  });

  it('drops an empty stream gate but keeps a tri-state lockedEnabled:false overlay', () => {
    const o: NotificationOverride = {
      ...defaultOverride(),
      streams: {
        [STREAM_BUSINESS]: { channels: { sms: false }, locked: {} },
        [STREAM_STAFF]: { channels: {}, locked: {} }, // empty -> dropped
        [STREAM_KINFOLK]: { channels: {}, locked: {}, lockedEnabled: false },
      },
    };
    expect(encodeOverridePayload(o)).toEqual({
      enabled: true,
      streams: {
        [STREAM_BUSINESS]: { channels: { sms: false } },
        [STREAM_KINFOLK]: { lockedEnabled: false },
      },
    });
  });

  it('round-trips the setLockReason gesture into a bare enabled+lockReason payload', () => {
    const o = setLockReason(currentOverride(matrix({}), entry({})), 'Because safety');
    const wire = encodeOverridePayload(o);
    expect(wire.enabled).toBe(true);
    expect(wire.lockReason).toBe('Because safety');
    expect(wire.channels).toEqual({ email: true, sms: true, push: true });
  });
});
