import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getNotificationMatrix, getMyNotificationPrefs, STREAM_BUSINESS, STREAM_STAFF } from './myNotifications';

beforeEach(() => call.mockReset());

describe('myNotifications api', () => {
  describe('getNotificationMatrix', () => {
    it('calls getBusinessNotificationOverrides with no args and decodes the envelope', async () => {
      call.mockResolvedValue({
        catalog: [
          {
            key: 'kincare.booking.confirm',
            label: 'Booking confirmed',
            category: 'visit',
            audience: 'business',
            audiences: { business: true },
            allowedChannels: ['email', 'sms'],
            required: { email: true },
            alwaysEnabled: false,
            kinfolkFacing: false,
            deliveryMode: 'trigger',
            description: '',
          },
        ],
        overrides: {
          'kincare.booking.confirm': {
            enabled: true,
            channels: { sms: false },
            lockedEnabled: false,
            locked: { email: true },
            lockReason: 'Compliance requires it.',
            streams: { business: { channels: { sms: true } } },
          },
        },
        updatedAtMs: 1_700_000_000_000,
      });

      const matrix = await getNotificationMatrix();

      expect(call).toHaveBeenCalledWith('getBusinessNotificationOverrides', {});
      expect(matrix.updatedAtMs).toBe(1_700_000_000_000);
      expect(matrix.catalog).toHaveLength(1);
      const entry = matrix.catalog[0]!;
      expect(entry.key).toBe('kincare.booking.confirm');
      expect(entry.audiences.has(STREAM_BUSINESS)).toBe(true);
      expect(entry.audiences.has(STREAM_STAFF)).toBe(false);
      expect(entry.required.email).toBe(true);

      const override = matrix.overrides['kincare.booking.confirm'];
      expect(override?.lockReason).toBe('Compliance requires it.');
      expect(override?.locked.email).toBe(true);
      expect(override?.streams.business?.channels.sms).toBe(true);
    });

    it('falls back to the legacy audience mapping when the backend sends no audiences object', async () => {
      call.mockResolvedValue({
        catalog: [
          {
            key: 'legacy.key',
            label: 'Legacy',
            category: 'account',
            audience: 'both',
            allowedChannels: ['email'],
            required: {},
            alwaysEnabled: false,
          },
        ],
        overrides: {},
        updatedAtMs: null,
      });

      const matrix = await getNotificationMatrix();
      const entry = matrix.catalog[0]!;
      expect(entry.audiences.has(STREAM_BUSINESS)).toBe(true);
      expect(entry.audiences.has('kinfolk')).toBe(true);
      expect(entry.audiences.has(STREAM_STAFF)).toBe(false);
    });

    it('defaults every field so a sparse catalog entry never throws', async () => {
      call.mockResolvedValue({ catalog: [{}], overrides: {}, updatedAtMs: null });
      const matrix = await getNotificationMatrix();
      const entry = matrix.catalog[0]!;
      expect(entry.key).toBe('');
      expect(entry.label).toBe('');
      expect(entry.allowedChannels).toEqual([]);
      expect(entry.required).toEqual({});
      expect(entry.alwaysEnabled).toBe(false);
      // No audiences and a blank legacy audience falls back to kinfolk (never dropped).
      expect(entry.audiences.has('kinfolk')).toBe(true);
    });

    it('defaults catalog/overrides/updatedAtMs when the envelope is missing them entirely', async () => {
      call.mockResolvedValue({});
      const matrix = await getNotificationMatrix();
      expect(matrix.catalog).toEqual([]);
      expect(matrix.overrides).toEqual({});
      expect(matrix.updatedAtMs).toBeNull();
    });

    it('drops any allowedChannels entry the client does not recognize', async () => {
      call.mockResolvedValue({
        catalog: [
          {
            key: 'k',
            allowedChannels: ['email', 'carrier-pigeon', 'sms'],
            required: {},
          },
        ],
        overrides: {},
        updatedAtMs: null,
      });
      const matrix = await getNotificationMatrix();
      expect(matrix.catalog[0]!.allowedChannels).toEqual(['email', 'sms']);
    });
  });

  describe('getMyNotificationPrefs', () => {
    it('calls getMyAdminNotificationPrefs with no args and unwraps { prefs, updatedAtMs }', async () => {
      call.mockResolvedValue({
        prefs: {
          byKey: { 'kincare.booking.confirm': { sms: false } },
          byCategory: { visit: { push: true } },
          marketingOptIn: { newsletter: true },
        },
        updatedAtMs: 1_700_000_000_000,
      });

      const result = await getMyNotificationPrefs();

      expect(call).toHaveBeenCalledWith('getMyAdminNotificationPrefs', {});
      expect(result.updatedAtMs).toBe(1_700_000_000_000);
      expect(result.prefs.byKey['kincare.booking.confirm']?.sms).toBe(false);
      expect(result.prefs.byCategory.visit?.push).toBe(true);
      expect(result.prefs.marketingOptIn.newsletter).toBe(true);
    });

    it('defaults to empty prefs when the callable returns no prefs object (brand-new operator)', async () => {
      call.mockResolvedValue({ updatedAtMs: null });
      const result = await getMyNotificationPrefs();
      expect(result.prefs).toEqual({ byKey: {}, byCategory: {}, marketingOptIn: {} });
      expect(result.updatedAtMs).toBeNull();
    });

    it('propagates a callable rejection (fail-loud, never a silent empty)', async () => {
      call.mockRejectedValueOnce(new Error('permission-denied'));
      await expect(getMyNotificationPrefs()).rejects.toThrow('permission-denied');
    });
  });
});
