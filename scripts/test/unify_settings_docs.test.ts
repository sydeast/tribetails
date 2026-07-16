import { describe, it, expect } from 'vitest';
import {
  mergeSettings,
  isAlreadyMerged,
  changedKeys,
  ADMIN_AUTHORITATIVE_KEYS,
  PROFILE_PREFER_BUSINESS_KEYS,
} from '../unify_settings_docs';

// Representative prod-shaped fixtures (no Firestore deps).
function businessFixture(): Record<string, unknown> {
  return {
    businessName: 'Tribe Tails Pet Care',
    businessEmail: 'hello@tribetails.com',
    businessPhone: '',
    enableGPSTrackingForAllVisits: true,
    saveRoutesForDays: 90,
    draftRetentionDays: 30,
    companyHolidays: ['2026-12-25|Christmas'],
    calendarSyncId: 'cal-abc',
    timeZone: 'America/Chicago', // business has a stale tz; admin is authoritative
  };
}

function adminFixture(): Record<string, unknown> {
  return {
    // booking-config (admin-authoritative)
    defaultBookingMode: 'TIME_BLOCK',
    defaultCalendarView: 'WEEK',
    allowTimeBlockBooking: true,
    allowSpecificTimeBooking: false,
    enableConflictDetection: true,
    enableAutoReminder24h: true,
    defaultTimeBlockDurationHours: 6,
    travelBufferMinutes: 45,
    observeUsHolidays: true,
    timeBlocks: [
      { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
    ],
    timeZone: 'America/New_York', // authoritative tz
    // profile (admin copy)
    businessName: 'OLD Admin Name',
    businessEmail: 'old-admin@example.com',
    businessPhone: '+15551234567',
  };
}

describe('mergeSettings field precedence', () => {
  it('takes booking-config + timeBlocks + timeZone from admin_settings', () => {
    const merged = mergeSettings(businessFixture(), adminFixture());
    expect(merged.defaultBookingMode).toBe('TIME_BLOCK');
    expect(merged.defaultCalendarView).toBe('WEEK');
    expect(merged.allowTimeBlockBooking).toBe(true);
    expect(merged.allowSpecificTimeBooking).toBe(false);
    expect(merged.enableConflictDetection).toBe(true);
    expect(merged.enableAutoReminder24h).toBe(true);
    expect(merged.defaultTimeBlockDurationHours).toBe(6);
    expect(merged.travelBufferMinutes).toBe(45);
    expect(merged.observeUsHolidays).toBe(true);
    // admin tz wins over the stale business tz
    expect(merged.timeZone).toBe('America/New_York');
  });

  it('carries timeBlocks with the `active` element key preserved from admin', () => {
    const merged = mergeSettings(businessFixture(), adminFixture());
    expect(Array.isArray(merged.timeBlocks)).toBe(true);
    const blocks = merged.timeBlocks as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveProperty('active', true);
    expect(blocks[0]).not.toHaveProperty('isActive');
    expect(blocks[0].label).toBe('Midday');
  });

  it('business profile wins when non-empty', () => {
    const merged = mergeSettings(businessFixture(), adminFixture());
    expect(merged.businessName).toBe('Tribe Tails Pet Care');
    expect(merged.businessEmail).toBe('hello@tribetails.com');
  });

  it('uses admin profile value when the business value is blank', () => {
    const merged = mergeSettings(businessFixture(), adminFixture());
    // business phone was '' so admin phone is used
    expect(merged.businessPhone).toBe('+15551234567');
  });

  it('treats whitespace-only business profile as blank and falls back to admin', () => {
    const business = { ...businessFixture(), businessName: '   ' };
    const merged = mergeSettings(business, adminFixture());
    expect(merged.businessName).toBe('OLD Admin Name');
  });

  it('keeps all other business keys untouched', () => {
    const merged = mergeSettings(businessFixture(), adminFixture());
    expect(merged.enableGPSTrackingForAllVisits).toBe(true);
    expect(merged.saveRoutesForDays).toBe(90);
    expect(merged.draftRetentionDays).toBe(30);
    expect(merged.companyHolidays).toEqual(['2026-12-25|Christmas']);
    expect(merged.calendarSyncId).toBe('cal-abc');
  });
});

describe('mergeSettings union of keys', () => {
  it('is the union of both docs, never deleting a business-owned key', () => {
    const business = { onlyOnBusiness: 'keep-me', businessName: 'B' };
    const admin = { onlyOnAdmin: 'bring-me', defaultBookingMode: 'TIME_BLOCK' };
    const merged = mergeSettings(business, admin);
    expect(merged.onlyOnBusiness).toBe('keep-me');
    expect(merged.onlyOnAdmin).toBe('bring-me');
    expect(merged.defaultBookingMode).toBe('TIME_BLOCK');
    expect(merged.businessName).toBe('B');
  });

  it('lets business win on a plain (non-special) key overlap', () => {
    const business = { someSharedFlag: 'business-value' };
    const admin = { someSharedFlag: 'admin-value' };
    const merged = mergeSettings(business, admin);
    expect(merged.someSharedFlag).toBe('business-value');
  });

  it('takes admin value for admin-authoritative key even when business also has it', () => {
    const business = { travelBufferMinutes: 999 };
    const admin = { travelBufferMinutes: 30 };
    const merged = mergeSettings(business, admin);
    expect(merged.travelBufferMinutes).toBe(30);
  });

  it('does not mutate the input documents', () => {
    const business = businessFixture();
    const admin = adminFixture();
    const businessCopy = JSON.parse(JSON.stringify(business));
    const adminCopy = JSON.parse(JSON.stringify(admin));
    mergeSettings(business, admin);
    expect(business).toEqual(businessCopy);
    expect(admin).toEqual(adminCopy);
  });
});

describe('mergeSettings idempotency', () => {
  it('merge(merge(b,a),a) deep-equals merge(b,a)', () => {
    const business = businessFixture();
    const admin = adminFixture();
    const once = mergeSettings(business, admin);
    const twice = mergeSettings(once, admin);
    expect(twice).toEqual(once);
  });

  it('isAlreadyMerged is false before merge and true after merge', () => {
    const business = businessFixture();
    const admin = adminFixture();
    expect(isAlreadyMerged(business, admin)).toBe(false);
    const merged = mergeSettings(business, admin);
    expect(isAlreadyMerged(merged, admin)).toBe(true);
  });

  it('a missing admin doc is a no-op (already merged)', () => {
    const business = businessFixture();
    expect(isAlreadyMerged(business, {})).toBe(true);
    expect(mergeSettings(business, {})).toEqual(business);
  });

  it('changedKeys is empty once already merged', () => {
    const business = businessFixture();
    const admin = adminFixture();
    const merged = mergeSettings(business, admin);
    expect(changedKeys(merged, admin)).toEqual([]);
  });

  it('changedKeys reports exactly the keys the merge alters on first run', () => {
    const business = businessFixture();
    const admin = adminFixture();
    const changed = changedKeys(business, admin);
    // booking-config + timeBlocks + timeZone + the blank businessPhone fill
    expect(changed).toContain('defaultBookingMode');
    expect(changed).toContain('timeBlocks');
    expect(changed).toContain('timeZone');
    expect(changed).toContain('businessPhone');
    // non-blank business profile values are NOT changed
    expect(changed).not.toContain('businessName');
    expect(changed).not.toContain('businessEmail');
    // untouched business-owned keys are not in the change set
    expect(changed).not.toContain('calendarSyncId');
    expect(changed).not.toContain('saveRoutesForDays');
  });
});

describe('rule constants stay aligned with the design doc', () => {
  it('admin-authoritative keys include the booking-config + timeBlocks + timeZone set', () => {
    for (const k of [
      'defaultBookingMode',
      'defaultCalendarView',
      'allowTimeBlockBooking',
      'allowSpecificTimeBooking',
      'enableConflictDetection',
      'enableAutoReminder24h',
      'defaultTimeBlockDurationHours',
      'travelBufferMinutes',
      'observeUsHolidays',
      'timeBlocks',
      'timeZone',
    ]) {
      expect(ADMIN_AUTHORITATIVE_KEYS).toContain(k);
    }
  });

  it('profile-prefer-business keys cover businessName/email/phone', () => {
    expect(PROFILE_PREFER_BUSINESS_KEYS).toContain('businessName');
    expect(PROFILE_PREFER_BUSINESS_KEYS).toContain('businessEmail');
    expect(PROFILE_PREFER_BUSINESS_KEYS).toContain('businessPhone');
  });
});
