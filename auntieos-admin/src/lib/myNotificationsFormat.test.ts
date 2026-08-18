import { describe, it, expect } from 'vitest';
import {
  adminChannelForced,
  adminChannelReason,
  adminGateEnabledChannels,
  adminVisibleNotifications,
  channelLabel,
  displayTitle,
  sectionedNotifications,
  userChannelChoice,
} from './myNotificationsFormat';
import {
  STREAM_BUSINESS,
  STREAM_STAFF,
  STREAM_KINFOLK,
  type AdminNotificationPrefs,
  type NotificationCatalogEntry,
  type NotificationMatrix,
} from '../api/myNotifications';

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

function prefs(over: Partial<AdminNotificationPrefs> = {}): AdminNotificationPrefs {
  return { byKey: {}, byCategory: {}, marketingOptIn: {}, ...over };
}

describe('myNotificationsFormat', () => {
  describe('displayTitle', () => {
    it('prefers label', () => {
      expect(displayTitle(entry({ label: 'Booking confirmed', description: 'x', key: 'k' }))).toBe(
        'Booking confirmed',
      );
    });
    it('falls back to description when label is blank', () => {
      expect(displayTitle(entry({ label: '  ', description: 'A booking was confirmed', key: 'k' }))).toBe(
        'A booking was confirmed',
      );
    });
    it('falls back to the raw key when both label and description are blank', () => {
      expect(displayTitle(entry({ label: '', description: '', key: 'kincare.booking.confirm' }))).toBe(
        'kincare.booking.confirm',
      );
    });
  });

  describe('channelLabel', () => {
    it('maps every channel to its human label', () => {
      expect(channelLabel('email')).toBe('Email');
      expect(channelLabel('sms')).toBe('Text (SMS)');
      expect(channelLabel('push')).toBe('Push');
    });
  });

  describe('adminGateEnabledChannels', () => {
    it('offers only channels both catalog-allowed AND stream-gate-enabled', () => {
      const m = matrix({
        overrides: {
          k: { enabled: true, channels: { sms: false }, lockedEnabled: false, locked: {}, streams: {} },
        },
      });
      const e = entry({ key: 'k', allowedChannels: ['email', 'sms', 'push'] });
      expect(adminGateEnabledChannels(m, e, STREAM_BUSINESS)).toEqual(['email', 'push']);
    });

    it('never offers a channel the catalog does not allow, even if the gate has it on', () => {
      const e = entry({ allowedChannels: ['email'] });
      expect(adminGateEnabledChannels(matrix(), e, STREAM_BUSINESS)).toEqual(['email']);
    });

    it('a per-stream channel overlay wins over the flat gate value', () => {
      const m = matrix({
        overrides: {
          k: {
            enabled: true,
            channels: { sms: true },
            lockedEnabled: false,
            locked: {},
            streams: { staff: { channels: { sms: false }, locked: {} } },
          },
        },
      });
      const e = entry({ key: 'k', allowedChannels: ['email', 'sms'], audiences: new Set([STREAM_BUSINESS, STREAM_STAFF]) });
      expect(adminGateEnabledChannels(m, e, STREAM_BUSINESS)).toEqual(['email', 'sms']);
      expect(adminGateEnabledChannels(m, e, STREAM_STAFF)).toEqual(['email']);
    });
  });

  describe('adminVisibleNotifications', () => {
    it('includes only entries serving the stream, gate-enabled, with >=1 offered channel', () => {
      const visible = entry({ key: 'visible', audiences: new Set([STREAM_BUSINESS]) });
      const wrongStream = entry({ key: 'wrong-stream', audiences: new Set([STREAM_STAFF]) });
      const gateOff = entry({ key: 'gate-off', audiences: new Set([STREAM_BUSINESS]) });
      const noChannels = entry({
        key: 'no-channels',
        audiences: new Set([STREAM_BUSINESS]),
        allowedChannels: [],
      });
      const m = matrix({
        overrides: {
          'gate-off': { enabled: true, channels: {}, lockedEnabled: false, locked: {}, streams: {} },
        },
      });
      // Flip gate-off's business stream enabled to false via a stream overlay.
      m.overrides['gate-off']!.streams.business = { channels: {}, locked: {}, enabled: false };
      m.catalog = [visible, wrongStream, gateOff, noChannels];

      const rows = adminVisibleNotifications(m, STREAM_BUSINESS);
      expect(rows.map((r) => r.key)).toEqual(['visible']);
    });

    it('excludes a kinfolk-only entry from both business and staff sections', () => {
      const kinfolkOnly = entry({ key: 'kinfolk-only', audiences: new Set([STREAM_KINFOLK]) });
      const m = matrix({ catalog: [kinfolkOnly] });
      expect(adminVisibleNotifications(m, STREAM_BUSINESS)).toEqual([]);
      expect(adminVisibleNotifications(m, STREAM_STAFF)).toEqual([]);
    });
  });

  describe('adminChannelForced', () => {
    it('is forced when the catalog marks the channel required', () => {
      const e = entry({ required: { email: true } });
      expect(adminChannelForced(matrix(), e, STREAM_BUSINESS, 'email')).toBe(true);
      expect(adminChannelForced(matrix(), e, STREAM_BUSINESS, 'sms')).toBe(false);
    });

    it('is forced when the business flat-locked the whole notification', () => {
      const m = matrix({
        overrides: { k: { enabled: true, channels: {}, lockedEnabled: true, locked: {}, streams: {} } },
      });
      expect(adminChannelForced(m, entry({ key: 'k' }), STREAM_BUSINESS, 'sms')).toBe(true);
    });

    it('is forced when the business locked just this channel for this stream', () => {
      const m = matrix({
        overrides: {
          k: {
            enabled: true,
            channels: {},
            lockedEnabled: false,
            locked: {},
            streams: { business: { channels: {}, locked: { sms: true } } },
          },
        },
      });
      expect(adminChannelForced(m, entry({ key: 'k' }), STREAM_BUSINESS, 'sms')).toBe(true);
      expect(adminChannelForced(m, entry({ key: 'k' }), STREAM_STAFF, 'sms')).toBe(false);
    });
  });

  describe('adminChannelReason', () => {
    it('prefers the operator-written lock reason when one exists', () => {
      const m = matrix({
        overrides: {
          k: { enabled: true, channels: {}, lockedEnabled: false, locked: {}, lockReason: 'Legal hold.', streams: {} },
        },
      });
      expect(adminChannelReason(m, entry({ key: 'k' }), 'email')).toBe('Legal hold.');
    });

    it('falls back to the catalog-required stock line', () => {
      const e = entry({ key: 'k', required: { email: true } });
      expect(adminChannelReason(matrix(), e, 'email')).toBe('Always on for this notification.');
    });

    it('falls back to the business-locked stock line when not catalog-required', () => {
      const e = entry({ key: 'k', required: {} });
      expect(adminChannelReason(matrix(), e, 'email')).toBe('Locked on by your business settings.');
    });

    it('ignores a blank (whitespace-only) lock reason', () => {
      const m = matrix({
        overrides: {
          k: { enabled: true, channels: {}, lockedEnabled: false, locked: {}, lockReason: '   ', streams: {} },
        },
      });
      expect(adminChannelReason(m, entry({ key: 'k', required: { email: true } }), 'email')).toBe(
        'Always on for this notification.',
      );
    });
  });

  describe('userChannelChoice', () => {
    it('byKey wins over byCategory and the default', () => {
      const p = prefs({ byKey: { k: { email: false } }, byCategory: { visit: { email: true } } });
      expect(userChannelChoice(p, 'k', 'visit', 'email')).toBe(false);
    });

    it('falls back to byCategory when byKey is unset for that channel', () => {
      const p = prefs({ byCategory: { visit: { sms: true } } });
      expect(userChannelChoice(p, 'k', 'visit', 'sms')).toBe(true);
    });

    it('defaults to email-on, everything-else-off when nothing is set', () => {
      expect(userChannelChoice(prefs(), 'k', 'visit', 'email')).toBe(true);
      expect(userChannelChoice(prefs(), 'k', 'visit', 'sms')).toBe(false);
      expect(userChannelChoice(prefs(), 'k', 'visit', 'push')).toBe(false);
    });
  });

  describe('sectionedNotifications', () => {
    it('buckets entries into their workflow section, preserving catalog order', () => {
      const booking = entry({ key: 'booking', category: 'visit' });
      const invoice = entry({ key: 'invoice', category: 'invoice' });
      const rows = sectionedNotifications([booking, invoice], STREAM_BUSINESS);
      expect(rows.map(([section]) => section.title)).toEqual(['Bookings and visits', 'Billing and payments']);
      expect(rows[0]![1].map((e) => e.key)).toEqual(['booking']);
    });

    it('drops empty sections entirely', () => {
      const rows = sectionedNotifications([], STREAM_BUSINESS);
      expect(rows).toEqual([]);
    });

    it('collects an unmatched category under a trailing Other section, never dropping the row', () => {
      const mystery = entry({ key: 'mystery', category: 'unmapped-category' });
      const rows = sectionedNotifications([mystery], STREAM_BUSINESS);
      expect(rows).toHaveLength(1);
      expect(rows[0]![0].title).toBe('Other');
      expect(rows[0]![1].map((e) => e.key)).toEqual(['mystery']);
    });

    /**
     * #386: the office's broadcast to a whole audience segment is the only
     * `messages` row the kinfolk stream carries. Before the section existed it
     * fell into the trailing "Other" catch-all, a poor home for a gate row the
     * operator is meant to find and switch off. Kept in lockstep with the
     * Kotlin taxonomy in NotificationMatrix.kt.
     */
    it('files the broadcast row under Messages on the kinfolk stream', () => {
      const broadcast = entry({ key: 'broadcast.message', category: 'messages' });
      const rows = sectionedNotifications([broadcast], STREAM_KINFOLK);
      expect(rows.map(([section]) => section.title)).toEqual(['Messages']);
      expect(rows[0]![1].map((e) => e.key)).toEqual(['broadcast.message']);
    });
    it('uses the staff-specific section set for the staff stream', () => {
      const kintale = entry({ key: 'kintale-comment', category: 'kintale' });
      const rows = sectionedNotifications([kintale], STREAM_STAFF);
      expect(rows.map(([section]) => section.title)).toEqual(['KinTales and comments']);
    });
  });
});
