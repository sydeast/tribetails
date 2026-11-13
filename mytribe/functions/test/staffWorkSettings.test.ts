import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn().mockReturnValue('s1'), initSentry: () => {} }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { buildStaffWorkSettings, getStaffWorkSettingsHandler } from '../src/admin/staffWorkSettings';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

/**
 * A settings document carrying every kind of field Business Settings holds,
 * with prices and contact details distinctive enough to search the reply for.
 */
const SETTINGS: Record<string, unknown> = {
  businessName: 'Hanasamku Care',
  businessEmail: 'pawsome@hanasamku.com',
  businessPhone: '555-0142',
  businessAddress: '1 Test Way',
  timeZone: 'America/Denver',
  serviceRates: { '30 Minute Visit': '27.50', Overnight: '131.75', '  ': '9.99' },
  serviceDurations: { '30 Minute Visit': ' 30 ', Overnight: '720', Stray: '15' },
  serviceStartTimeBooking: { Overnight: true },
  timeBlocks: [
    { id: 'morning', label: 'Morning', startTime: '07:00', endTime: '11:00', active: true, note: 'x' },
    { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', active: false },
    'not a row',
  ],
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: false,
  defaultBookingMode: 'TIME_BLOCK',
  requireArrivalDepartureVerification: true,
  kinTaleRequired: true,
  snapRescheduleTo15Min: true,
  venmoHandle: '@venmo-handle-xyz',
  paypalHandle: 'paypal-handle-xyz',
  cashappHandle: '$cashapp-xyz',
  paymentOptions: { stripe: true },
  householdNotificationsLive: true,
  calendarSyncId: 'calendar-sync-xyz',
  householdTags: [{ id: 't1', label: 'Gate code' }],
  weatherLocation: 'Denver',
};

const EXPECTED_KEYS = [
  'allowSpecificTimeBooking',
  'allowTimeBlockBooking',
  'defaultBookingMode',
  'kinTaleRequired',
  'requireArrivalDepartureVerification',
  'services',
  'snapRescheduleTo15Min',
  'timeBlocks',
  'timeZone',
];

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.dbFn.mockReset();
});

describe('#2164 buildStaffWorkSettings', () => {
  it('returns exactly the work fields, and nothing else from the document', () => {
    const out = buildStaffWorkSettings(SETTINGS);
    expect(Object.keys(out).sort()).toEqual(EXPECTED_KEYS);
  });

  it('carries the KinCare names and lengths, never a price', () => {
    const out = buildStaffWorkSettings(SETTINGS);
    expect(out.services).toEqual([
      { id: '30 Minute Visit', durationMinutes: '30' },
      { id: 'Overnight', durationMinutes: '720' },
    ]);
    const wire = JSON.stringify(out);
    for (const secret of ['27.50', '131.75', '9.99', 'serviceRates', 'pawsome', '555-0142', 'venmo', 'paypal', 'cashapp', 'calendar-sync', 'Gate code', 'Hanasamku']) {
      expect(wire, `the reply must not carry ${secret}`).not.toContain(secret);
    }
  });

  it('carries the clock, the Time Blocks and their mode, the arrival rule and KinTale required', () => {
    const out = buildStaffWorkSettings(SETTINGS);
    expect(out.timeZone).toBe('America/Denver');
    expect(out.timeBlocks).toEqual([
      { id: 'morning', label: 'Morning', startTime: '07:00', endTime: '11:00', active: true },
      { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', active: false },
    ]);
    expect(out.allowTimeBlockBooking).toBe(true);
    expect(out.allowSpecificTimeBooking).toBe(false);
    expect(out.defaultBookingMode).toBe('TIME_BLOCK');
    expect(out.requireArrivalDepartureVerification).toBe(true);
    expect(out.kinTaleRequired).toBe(true);
    expect(out.snapRescheduleTo15Min).toBe(true);
  });

  it('reads an empty or missing document as the server defaults, never as on', () => {
    for (const doc of [undefined, {}]) {
      const out = buildStaffWorkSettings(doc);
      expect(out.services).toEqual([]);
      expect(out.timeZone).toBe('America/Chicago');
      expect(out.timeBlocks).toBeNull();
      expect(out.requireArrivalDepartureVerification).toBe(false);
      expect(out.kinTaleRequired).toBe(false);
      expect(out.snapRescheduleTo15Min).toBe(false);
      expect(out.allowSpecificTimeBooking).toBe(true);
      expect(out.defaultBookingMode).toBe('SPECIFIC_TIME');
    }
  });

  it('reads a stray non-true switch as off, and an unusable zone as the default', () => {
    const out = buildStaffWorkSettings({
      requireArrivalDepartureVerification: 'true',
      kinTaleRequired: 1,
      snapRescheduleTo15Min: 'yes',
      timeZone: 'Not/AZone',
      serviceRates: ['a', 'b'],
    });
    expect(out.requireArrivalDepartureVerification).toBe(false);
    expect(out.kinTaleRequired).toBe(false);
    expect(out.snapRescheduleTo15Min).toBe(false);
    expect(out.timeZone).toBe('America/Chicago');
    expect(out.services).toEqual([]);
  });
});

describe('#2164 getStaffWorkSettings', () => {
  const handler = wrapAdminCallable('getStaffWorkSettings', getStaffWorkSettingsHandler);

  it('answers an Auntie with the projection of the stored document', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'business_settings/business_settings': SETTINGS } }).db);
    const res = await handler({ auth: { uid: 'auntie-1', token: { staffRole: 'auntie' } }, data: {} } as never);
    expect(Object.keys(res).sort()).toEqual(EXPECTED_KEYS);
    expect(res.services.map((s) => s.id)).toEqual(['30 Minute Visit', 'Overnight']);
    expect(JSON.stringify(res)).not.toContain('131.75');
  });

  it('answers the owner the same projection', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'business_settings/business_settings': SETTINGS } }).db);
    const res = await handler({ auth: { uid: 'owner-1', token: { admin: true } }, data: {} } as never);
    expect(res.timeZone).toBe('America/Denver');
  });

  it('refuses a household account and an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'business_settings/business_settings': SETTINGS } }).db);
    await expect(
      handler({ auth: { uid: 'kf-1', token: { role: 'kinfolk', kinfolkId: 'k1' } }, data: {} } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(handler({ auth: undefined, data: {} } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('a failed read fails the call rather than answering with defaults', async () => {
    mocks.dbFn.mockReturnValue({
      doc: () => ({ get: () => Promise.reject(new Error('unavailable')) }),
    });
    await expect(
      handler({ auth: { uid: 'auntie-1', token: { staffRole: 'auntie' } }, data: {} } as never),
    ).rejects.toBeTruthy();
  });
});
