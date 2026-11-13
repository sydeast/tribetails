import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FieldPath, FieldValue, Firestore } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1593: the one Settings save. Every field check in
 * `lib/businessSettingsChecks.ts`, the refusal shape the clients read, the
 * write shape (merge, whole-map rate card, server stamp), the #1409 merged-name
 * rule the Firestore rules used to enforce, and the owner-only gate.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn(), writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('../src/lib/sentry', () => ({
  captureFunctionError: vi.fn().mockReturnValue('s1'),
  initSentry: () => {},
}));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import {
  saveBusinessSettingsHandler,
  mergeFieldPaths,
  Args,
} from '../src/admin/saveBusinessSettings';
import {
  BUSINESS_SETTINGS_CHECKS,
  businessSettingsRefusals,
  WHOLE_MAP_SETTINGS_FIELDS,
  cashappHandleProblem,
  closedDayHoursChanges,
  durationProblem,
  hoursRangeProblem,
  isEmailShape,
  isRealDate,
  isUsPhoneShape,
  paypalHandleProblem,
  priceProblem,
  venmoHandleProblem,
  type CheckContext,
} from '../src/lib/businessSettingsChecks';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';

const PATH = 'business_settings/business_settings';
const LOGO =
  'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png';

let ctx: ReturnType<typeof buildDbMock>;
function setup(
  stored: Record<string, unknown> = { businessName: 'Tribe Tails', timeZone: 'America/Chicago' },
) {
  ctx = buildDbMock({ writeThrough: true, docs: { [PATH]: stored } });
  mocks.dbFn.mockReturnValue(ctx.db);
}

const owner = (data: unknown) =>
  ({
    data,
    auth: { uid: 'owner-1', token: { admin: true, email: 'owner@tribetails.com' } },
  }) as never;

async function refusalOf(
  changes: Record<string, unknown>,
): Promise<{ message: string; details: any }> {
  try {
    await saveBusinessSettingsHandler(owner({ changes }));
  } catch (e) {
    const err = e as { code: string; message: string; details: unknown };
    expect(err.code).toBe('invalid-argument');
    return { message: err.message, details: err.details };
  }
  throw new Error('expected a refusal');
}

function settingsWrites() {
  return ctx.writes.filter((w: { path: string }) => w.path === PATH);
}

const CTX: CheckContext = { stored: {}, todayIso: '2026-11-09', cloudName: 'tribetails' };
const one = (field: string, value: unknown, c: CheckContext = CTX) =>
  BUSINESS_SETTINGS_CHECKS[field]!(value, c);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T18:00:00Z'));
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
  vi.stubEnv('AUNTIE_OPERATOR_UIDS', '');
  mocks.writeAuditEntry.mockResolvedValue('audit-1');
  setup();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('primitive shapes', () => {
  it("email: the clients' shape, no doubled dot", () => {
    expect(isEmailShape('owner@tribetails.com')).toBe(true);
    expect(isEmailShape('a.b+c@sub.example.co')).toBe(true);
    for (const bad of [
      '',
      'owner@',
      '@x.com',
      'owner@x',
      'a..b@example.com',
      'a b@x.com',
      'owner@x.c',
    ]) {
      expect(isEmailShape(bad), bad).toBe(false);
    }
  });
  it('phone: 10 digits, or 11 with a leading 1, separators allowed, no letters', () => {
    for (const ok of [
      '5125550123',
      '(512) 555-0123',
      '512.555.0123',
      '+1 512 555 0123',
      '15125550123',
    ]) {
      expect(isUsPhoneShape(ok), ok).toBe(true);
    }
    for (const bad of ['', '555-0123', '25125550123', '512-555-012x', '512 555 01234']) {
      expect(isUsPhoneShape(bad), bad).toBe(false);
    }
  });
  it('dates: real calendar days only', () => {
    expect(isRealDate('2026-12-24')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    for (const bad of [
      '2026-13-45',
      '2026-02-30',
      '2027-02-29',
      '2026-00-10',
      '2026-1-5',
      'zz-99',
      '',
    ]) {
      expect(isRealDate(bad), bad).toBe(false);
    }
  });
  it('hours: HH:MM-HH:MM closing after opening', () => {
    expect(hoursRangeProblem('09:00-17:00')).toBeNull();
    expect(hoursRangeProblem('9:00-12:30')).toBeNull();
    expect(hoursRangeProblem('17:00-09:00')).toBe(
      'The closing time has to be after the opening time.',
    );
    expect(hoursRangeProblem('09:00-09:00')).toBe(
      'The closing time has to be after the opening time.',
    );
    for (const bad of ['zz-99', '-17:00', '09:00-', '25:00-26:00', '9-5', 'by appointment', '']) {
      expect(hoursRangeProblem(bad), bad).toBe('Enter both an opening and a closing time.');
    }
  });
  it('price: blank, or dollars with two decimals at most, never negative', () => {
    for (const ok of ['', '  ', '25', '25.5', '25.50', '0', 0, 25])
      expect(priceProblem('Walk', ok), String(ok)).toBeNull();
    expect(priceProblem('Walk', 'abc')).toBe(
      'Enter the price for "Walk" in dollars, like 25 or 25.50.',
    );
    expect(priceProblem('Walk', '1.234')).toBe(
      'Enter the price for "Walk" in dollars, like 25 or 25.50.',
    );
    expect(priceProblem('Walk', '$25')).toBe(
      'Enter the price for "Walk" in dollars, like 25 or 25.50.',
    );
    expect(priceProblem('Walk', '-5')).toBe('The price for "Walk" cannot be negative.');
    expect(priceProblem('Walk', -5)).toBe(
      'Enter the price for "Walk" in dollars, like 25 or 25.50.',
    );
    expect(priceProblem('Walk', true)).not.toBeNull();
  });
  it('length: blank, or whole minutes from 1 to 1440', () => {
    for (const ok of ['', '30', '1440', 45])
      expect(durationProblem('Walk', ok), String(ok)).toBeNull();
    for (const bad of ['abc', '0', '-30', '30.5', '1441']) {
      expect(durationProblem('Walk', bad), bad).toBe(
        'Enter the length of "Walk" in whole minutes, from 1 to 1440.',
      );
    }
  });
  it('payment handles: the shape each link can use', () => {
    expect(venmoHandleProblem('')).toBeNull();
    expect(venmoHandleProblem('@Tribe-Tails_1')).toBeNull();
    expect(venmoHandleProblem('abc')).not.toBeNull();
    expect(venmoHandleProblem('tribe tails')).not.toBeNull();
    expect(venmoHandleProblem('https://venmo.com/u/x')).not.toBeNull();
    expect(paypalHandleProblem('TribeTails')).toBeNull();
    expect(paypalHandleProblem('paypal.me/TribeTails')).not.toBeNull();
    expect(paypalHandleProblem('a'.repeat(21))).not.toBeNull();
    expect(cashappHandleProblem('$TribeTails')).toBeNull();
    expect(cashappHandleProblem('TribeTails')).toBeNull();
    expect(cashappHandleProblem('$1234')).not.toBeNull();
    expect(cashappHandleProblem('$tribe tails')).not.toBeNull();
  });
});

describe('field checks: the 2026-11-05 QA walk', () => {
  it('KinCare types: letters, negatives and blank names are refused; blank prices pass', () => {
    expect(one('serviceRates', { Walk: 'abc' })).toMatch(/Enter the price for "Walk"/);
    expect(one('serviceRates', { Walk: '-5' })).toBe('The price for "Walk" cannot be negative.');
    expect(one('serviceRates', { '  ': '25' })).toBe('Every KinCare type needs a name.');
    expect(one('serviceRates', { Walk: '25', walk: '30' })).toBe(
      'Two KinCare types are both called "walk".',
    );
    expect(one('serviceRates', { Walk: '', 'Drop-in 30': '25.00' })).toBeNull();
    expect(one('serviceDurations', { Walk: 'abc' })).toMatch(/whole minutes/);
    expect(one('serviceStartTimeBooking', { Walk: true })).toBeNull();
    expect(one('serviceStartTimeBooking', { Walk: 'yes' })).not.toBeNull();
  });
  it('business profile: bad email and phone refused, blanks pass, name required', () => {
    expect(one('businessEmail', 'owner@')).toBe(
      'Enter an email like name@example.com, or leave it blank.',
    );
    expect(one('businessEmail', '')).toBeNull();
    expect(one('businessPhone', '555-01')).toBe(
      'Enter a 10-digit phone number, or leave it blank.',
    );
    expect(one('businessPhone', '')).toBeNull();
    expect(one('businessName', '   ')).toBe('Enter the business name.');
    expect(one('businessName', 42)).toBe('Enter the business name.');
    expect(one('timeZone', 'Mars/Olympus')).toBe('Pick a time zone from the list.');
    expect(one('timeZone', 'America/Chicago')).toBeNull();
    expect(one('privacyPolicyUrl', 'http://example.com')).toBe('Enter a full https:// link.');
    expect(one('privacyPolicyUrl', '')).toBeNull();
  });
  it('business hours: close before open, half-filled and unknown days refused; blank is Closed', () => {
    expect(one('businessHours', { Monday: '17:00-09:00' })).toBe(
      'Monday: The closing time has to be after the opening time.',
    );
    expect(one('businessHours', { Tuesday: '-17:00' })).toBe(
      'Tuesday: Enter both an opening and a closing time.',
    );
    expect(one('businessHours', { Funday: '09:00-17:00' })).toBe(
      '"Funday" is not a day of the week.',
    );
    expect(one('businessHours', { Monday: '09:00-17:00', Sunday: '' })).toBeNull();
  });
  it('time off: impossible and past dates refused for NEW entries; stored ones pass', () => {
    expect(one('companyHolidays', ['2026-13-45|Inventory'])).toBe(
      'Enter a real date as YYYY-MM-DD.',
    );
    expect(one('companyHolidays', ['2026-11-08|Yesterday'])).toBe(
      'That date has passed. Pick today or a later date.',
    );
    expect(one('companyHolidays', ['2026-11-09|Today'])).toBeNull();
    expect(one('companyHolidays', ['2026-12-24|'])).toBe('Give the closure a name.');
    expect(one('companyHolidays', ['2026-12-24|Shut|down'])).toBe('A name cannot contain |.');
    expect(
      one('companyHolidays', ['yearly:12-25|Christmas', 'yearly-nth:11-4-4|Thanksgiving']),
    ).toBeNull();
    expect(one('companyHolidays', ['yearly:13-40|Bad'])).not.toBeNull();
    const kept = { ...CTX, stored: { companyHolidays: ['2024-01-01|Old closure'] } };
    expect(one('companyHolidays', ['2024-01-01|Old closure', '2026-12-31|New'], kept)).toBeNull();

    expect(one('specialHours', ['2026-13-45|09:00-12:00'])).toBe(
      'Enter a real date as YYYY-MM-DD.',
    );
    expect(one('specialHours', ['2026-12-24|zz-99'])).toBe(
      'Enter both an opening and a closing time.',
    );
    expect(one('specialHours', ['2026-12-24|14:00-10:00'])).toBe(
      'The closing time has to be after the opening time.',
    );
    expect(one('specialHours', ['2020-12-24|09:00-12:00'])).toBe(
      'That date has passed. Pick today or a later date.',
    );
    expect(one('specialHours', ['2026-12-24|09:00-12:00'])).toBeNull();
    const keptSpecial = { ...CTX, stored: { specialHours: ['2025-12-24|half day'] } };
    expect(one('specialHours', ['2025-12-24|half day'], keptSpecial)).toBeNull();
  });
  it('visits and tracking and booking rules: the #519 ranges', () => {
    expect(one('arrivalRadiusMeters', 9)).toBe('Enter 10 to 5000 metres.');
    expect(one('arrivalRadiusMeters', 150)).toBeNull();
    expect(one('saveRoutesForDays', 0)).toBe('Enter 1 to 3650 days.');
    expect(one('travelBufferMinutes', 481)).toBe('Enter 0 to 480 minutes.');
    expect(one('defaultTimeBlockDurationHours', 4.5)).toBe('Enter 1 to 24 hours.');
    expect(one('etaMinuteOptions', [5, 5])).toBe('5 is listed twice.');
    expect(one('etaMinuteOptions', [])).toBe('List at least one option, in minutes.');
    expect(one('draftRetentionOptions', [30, 60, 90])).toBeNull();
    expect(one('trackingAccuracy', 'ULTRA')).toBe('Pick a tracking accuracy from the list.');
    expect(one('defaultBookingMode', 'TIME_BLOCK')).toBeNull();
    expect(one('enableAutoReminder24h', 'true')).toBe('The 24-hour reminder has to be on or off.');
  });
  it('time blocks: names, times, order and overlaps', () => {
    const block = (over: Record<string, unknown>) => ({
      id: 'm',
      label: 'Midday',
      startTime: '11:00',
      endTime: '15:00',
      active: true,
      ...over,
    });
    expect(one('timeBlocks', [block({})])).toBeNull();
    expect(one('timeBlocks', [block({ label: ' ' })])).toBe('Every block needs a name.');
    expect(one('timeBlocks', [block({ endTime: '10:00' })])).toMatch(/has to end after it starts/);
    expect(
      one('timeBlocks', [
        block({}),
        block({ id: 'a', label: 'Afternoon', startTime: '14:00', endTime: '17:00' }),
      ]),
    ).toMatch(/overlap/);
    expect(
      one('timeBlocks', [
        block({}),
        block({ id: 'a', label: 'Afternoon', startTime: '14:00', endTime: '17:00', active: false }),
      ]),
    ).toBeNull();
  });
  it('notification hours: 0-23 or null', () => {
    for (const ok of [0, 9, 23, null]) expect(one('householdNotificationHour', ok)).toBeNull();
    for (const bad of [-1, 24, 9.5, '9', true])
      expect(one('scheduleDigestHour', bad), String(bad)).not.toBeNull();
    expect(one('householdNotificationsLive', 'true')).not.toBeNull();
  });
  it('payments: handles and options', () => {
    expect(one('venmoHandle', 'ab')).toMatch(/Venmo username/);
    expect(one('paypalHandle', 'paypal.me/x')).toMatch(/PayPal.Me/);
    expect(one('cashappHandle', '$$$')).toMatch(/Cashtag/);
    expect(one('paymentOptions', { venmo: { enabled: true, instructions: '' } })).toBeNull();
    expect(one('paymentOptions', { bitcoin: { enabled: true } })).toBe(
      '"bitcoin" is not a payment method.',
    );
    expect(
      one('paymentOptions', { zelle: { enabled: true, instructions: 'x'.repeat(501) } }),
    ).toMatch(/under 500/);
  });
  it('MyTribe portal: theme from the list, limit 0 or more, logos from the library', () => {
    expect(one('mytribePortal', { themeId: 'neon' })).toBe('Pick a theme from the list.');
    expect(one('mytribePortal', { themeId: 'midnight' })).toBeNull();
    expect(
      one('mytribePortal', { home: { sections: [{ id: 'visits', enabled: true, limit: -3 }] } }),
    ).toBe('Enter a limit of 0 or more, as a whole number. 0 shows everything.');
    expect(
      one('mytribePortal', { home: { sections: [{ id: 'visits', enabled: true, limit: 0 }] } }),
    ).toBeNull();
    expect(one('mytribePortal', { home: { sections: [{ id: 'visits', enabled: true, limit: 5000 }] } })).toBeNull();
    expect(one('mytribePortal', { logoUrl: 'https://evil.example/x.png' })).toBe(
      'The logo must be an image uploaded to the business library.',
    );
    expect(one('mytribePortal', { logoUrl: LOGO, logoRemovedAt: '' })).toBeNull();
    expect(one('mytribePortal', { flavor: 'x' })).toBe('"flavor" is not a portal setting.');
  });
  it('tags and the calendar id', () => {
    expect(
      one('householdTags', [{ name: 'VIP', color: { token: 'teal', css: '#0aa' }, icon: null }]),
    ).toBeNull();
    expect(one('householdTags', [{ name: ' ' }])).toBe('A tag name is required.');
    expect(one('petTags', [{ name: 'Meds' }, { name: 'meds' }])).toBe(
      'A "meds" tag already exists.',
    );
    expect(one('calendarSyncId', '')).toBeNull();
    expect(one('calendarSyncId', 'primary')).toMatch(/"primary"/);
    expect(one('calendarSyncId', 'ops@group.calendar.google.com')).toBeNull();
  });
  it('the business logo: blank, the stored value, or an image in the library', () => {
    expect(one('logoUrl', '')).toBeNull();
    expect(one('logoUrl', LOGO)).toBeNull();
    expect(one('logoUrl', 'https://res.cloudinary.com/other/image/upload/v1/x.png')).not.toBeNull();
    const stored = { ...CTX, stored: { logoUrl: 'https://legacy.example/logo.png' } };
    expect(one('logoUrl', 'https://legacy.example/logo.png', stored)).toBeNull();
    expect(one('logoRemovedAt', 'not a time')).not.toBeNull();
    expect(one('logoRemovedAt', '2026-11-09T12:00:00.000Z')).toBeNull();
  });
  it('unknown and server-owned fields are refused by name', () => {
    const out = businessSettingsRefusals(
      { updatedBy: 'x', calendarSyncLastStatus: 'ok', colour: 'red' },
      CTX,
    );
    expect(out.map((r) => r.field)).toEqual(['updatedBy', 'calendarSyncLastStatus', 'colour']);
  });
});

describe('saveBusinessSettings', () => {
  it('writes the changed fields with the server stamp and answers with it', async () => {
    const res = await saveBusinessSettingsHandler(
      owner({ changes: { travelBufferMinutes: 45, businessEmail: 'hi@tribetails.com' } }),
    );
    // #1962: the uid, though this caller's token carries a sign-in email.
    expect(res).toEqual({
      updatedAt: '2026-11-09T18:00:00.000Z',
      updatedBy: 'owner-1',
    });
    const [w] = settingsWrites();
    expect(w!.data).toEqual({
      travelBufferMinutes: 45,
      businessEmail: 'hi@tribetails.com',
      updatedAt: '2026-11-09T18:00:00.000Z',
      updatedBy: 'owner-1',
    });
    expect(w!.options?.merge).toBeUndefined();
    expect((w!.options?.mergeFields ?? []).map(String)).toEqual([
      'travelBufferMinutes',
      'businessEmail',
      'updatedAt',
      'updatedBy',
    ]);
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AUDIT_EVENTS.BUSINESS_SETTINGS_UPDATED,
        payload: { fields: ['travelBufferMinutes', 'businessEmail'] },
      }),
    );
  });

  it('stamps the uid when the token has no email, the same as when it has one', async () => {
    const res = await saveBusinessSettingsHandler({
      data: { changes: { enableConflictDetection: false } },
      auth: { uid: 'owner-1', token: { admin: true } },
    } as never);
    expect(res.updatedBy).toBe('owner-1');
  });

  it("refuses with every refusal and the first one's field, and writes nothing", async () => {
    const { message, details } = await refusalOf({
      businessPhone: '555-01',
      serviceRates: { Walk: 'abc' },
      travelBufferMinutes: 30,
    });
    expect(message).toBe('Enter a 10-digit phone number, or leave it blank.');
    expect(details).toEqual({
      code: 'settings_refused',
      field: 'businessPhone',
      refusals: [
        { field: 'businessPhone', message: 'Enter a 10-digit phone number, or leave it blank.' },
        {
          field: 'serviceRates',
          message: 'Enter the price for "Walk" in dollars, like 25 or 25.50.',
        },
      ],
    });
    expect(settingsWrites()).toHaveLength(0);
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses an empty save and a bad envelope', async () => {
    expect((await refusalOf({})).message).toBe('Nothing to save.');
    await expect(saveBusinessSettingsHandler(owner({ patch: {} }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(saveBusinessSettingsHandler(owner(null))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('#1409: a stored blank name refuses every save until a save sets it', async () => {
    setup({ businessName: '  ' });
    const { details } = await refusalOf({ travelBufferMinutes: 30 });
    expect(details.refusals).toEqual([
      { field: 'businessName', message: 'Enter the business name.' },
    ]);
    await saveBusinessSettingsHandler(
      owner({ changes: { businessName: 'Tribe Tails', travelBufferMinutes: 30 } }),
    );
    expect(settingsWrites()).toHaveLength(1);
  });

  it('a document with no name at all still saves (the field was never set)', async () => {
    setup({});
    await saveBusinessSettingsHandler(owner({ changes: { travelBufferMinutes: 30 } }));
    expect(settingsWrites()).toHaveLength(1);
  });

  it('reads "today" in the business zone for past dates', async () => {
    // 2026-11-10 03:00 UTC is still 2026-11-09 in Chicago.
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z'));
    await saveBusinessSettingsHandler(
      owner({ changes: { companyHolidays: ['2026-11-09|Today in Chicago'] } }),
    );
    expect(settingsWrites()).toHaveLength(1);
    setup({ businessName: 'Tribe Tails', timeZone: 'Asia/Tokyo' });
    const { message } = await refusalOf({ companyHolidays: ['2026-11-09|Yesterday in Tokyo'] });
    expect(message).toBe('That date has passed. Pick today or a later date.');
  });

  it('a null send hour is a value, not a dropped key', async () => {
    await saveBusinessSettingsHandler(owner({ changes: { householdNotificationHour: null } }));
    const [w] = settingsWrites();
    expect(w!.data['householdNotificationHour']).toBeNull();
    expect((w!.options?.mergeFields ?? []).map(String)).toContain('householdNotificationHour');
  });
});

/**
 * #1978: a closed day is a present blank key in `businessHours`, which has no
 * room for the hours the day had. The save keeps them beside it, in
 * `closedDayHours`, so reopening the day gives them back after a reload.
 */
describe('#1978: the hours a closed day had', () => {
  const HOURS = { Monday: '09:00-17:00', Sunday: '08:00-16:00' };
  const stored = (extra: Record<string, unknown> = {}) => ({
    businessName: 'Tribe Tails',
    timeZone: 'America/Chicago',
    businessHours: HOURS,
    ...extra,
  });
  const paths = (w: { options?: { mergeFields?: ReadonlyArray<unknown> } }) =>
    (w.options?.mergeFields ?? []).map(String);

  it('closing a day keeps its stored hours, and the day itself is stored blank', async () => {
    setup(stored());
    await saveBusinessSettingsHandler(owner({ changes: { businessHours: { Sunday: '' } } }));
    const [w] = settingsWrites();
    expect(w!.data['businessHours']).toEqual({ Sunday: '' });
    expect(w!.data['closedDayHours']).toEqual({ Sunday: '08:00-16:00' });
    expect(paths(w!)).toEqual([
      'businessHours.Sunday',
      'closedDayHours.Sunday',
      'updatedAt',
      'updatedBy',
    ]);
  });

  it('reopening a day drops what was kept for it', async () => {
    setup(
      stored({
        businessHours: { ...HOURS, Sunday: '' },
        closedDayHours: { Sunday: '08:00-16:00' },
      }),
    );
    await saveBusinessSettingsHandler(
      owner({ changes: { businessHours: { Sunday: '10:00-14:00' } } }),
    );
    const [w] = settingsWrites();
    expect(w!.data['businessHours']).toEqual({ Sunday: '10:00-14:00' });
    expect(w!.data['closedDayHours']).toEqual({ Sunday: FieldValue.delete() });
    expect(paths(w!)).toContain('closedDayHours.Sunday');
  });

  it('a day with no hours to keep writes nothing beside it', async () => {
    // Monday has no key, Sunday is already closed, Saturday holds text nobody can read.
    setup(stored({ businessHours: { Sunday: '', Saturday: 'by appointment' } }));
    await saveBusinessSettingsHandler(
      owner({ changes: { businessHours: { Monday: '', Sunday: '', Saturday: '' } } }),
    );
    const [w] = settingsWrites();
    expect('closedDayHours' in w!.data).toBe(false);
    expect(paths(w!).some((p) => p.startsWith('closedDayHours'))).toBe(false);
  });

  it('closing an already closed day again keeps the hours kept the first time', async () => {
    setup(
      stored({
        businessHours: { ...HOURS, Sunday: '' },
        closedDayHours: { Sunday: '08:00-16:00' },
      }),
    );
    await saveBusinessSettingsHandler(owner({ changes: { businessHours: { Sunday: '' } } }));
    const [w] = settingsWrites();
    expect('closedDayHours' in w!.data).toBe(false);
  });

  it('opening a day that had nothing kept writes only the day', async () => {
    setup(stored());
    await saveBusinessSettingsHandler(
      owner({ changes: { businessHours: { Monday: '10:00-15:00' } } }),
    );
    const [w] = settingsWrites();
    expect('closedDayHours' in w!.data).toBe(false);
    expect(paths(w!)).toEqual(['businessHours.Monday', 'updatedAt', 'updatedBy']);
  });

  it('a save of another field leaves the kept hours alone', async () => {
    setup(stored({ closedDayHours: { Sunday: '08:00-16:00' } }));
    await saveBusinessSettingsHandler(owner({ changes: { travelBufferMinutes: 30 } }));
    const [w] = settingsWrites();
    expect('closedDayHours' in w!.data).toBe(false);
  });

  it("is the server's to write: a client that sends it is refused", async () => {
    setup(stored());
    const { details } = await refusalOf({ closedDayHours: { Sunday: '00:00-23:59' } });
    expect(details.field).toBe('closedDayHours');
    expect(settingsWrites()).toHaveLength(0);
  });

  it('still refuses an open day without hours, and keeps nothing', async () => {
    setup(stored());
    const { message, details } = await refusalOf({ businessHours: { Sunday: '-' } });
    expect(message).toBe('Sunday: Enter both an opening and a closing time.');
    expect(details.field).toBe('businessHours');
    expect(settingsWrites()).toHaveLength(0);
  });

  it('both writes are shapes the real Firestore SDK accepts', async () => {
    // The mock records a write without checking it. A real client checks a
    // `set` with `mergeFields` as the call is made, with no network: every
    // masked path has to be in the data, and a delete has to be masked.
    const real = new Firestore({ projectId: 'demo-tribetails' });
    const ref = real.doc(PATH);
    const check = (w: { data: unknown; options?: unknown }) =>
      real.batch().set(ref, w.data as never, w.options as never);

    setup(stored());
    await saveBusinessSettingsHandler(owner({ changes: { businessHours: { Sunday: '' } } }));
    expect(() => check(settingsWrites()[0]!)).not.toThrow();

    setup(
      stored({
        businessHours: { ...HOURS, Sunday: '' },
        closedDayHours: { Sunday: '08:00-16:00' },
      }),
    );
    await saveBusinessSettingsHandler(
      owner({ changes: { businessHours: { Sunday: '10:00-14:00', Monday: '' } } }),
    );
    const [w] = settingsWrites();
    expect(w!.data['closedDayHours']).toEqual({
      Sunday: FieldValue.delete(),
      Monday: '09:00-17:00',
    });
    expect(() => check(w!)).not.toThrow();
    // The check is live: a masked path with no data behind it is refused.
    expect(() =>
      real.batch().set(ref, { b: 1 } as never, { mergeFields: ['b', 'closedDayHours.Sunday'] }),
    ).toThrow();
  });

  it('closedDayHoursChanges: the rule on its own', () => {
    expect(
      closedDayHoursChanges(
        { Monday: '', Tuesday: '09:00-12:00', Wednesday: '', Thursday: '' },
        {
          businessHours: { Monday: ' 9:00-17:00 ', Tuesday: '', Wednesday: '17:00-09:00' },
          closedDayHours: { Tuesday: '08:00-16:00' },
        },
      ),
    ).toEqual({ Monday: '9:00-17:00', Tuesday: null });
    expect(closedDayHoursChanges('nope', {})).toEqual({});
    expect(closedDayHoursChanges({ Monday: '' }, { businessHours: 'nope' })).toEqual({});
  });
});

describe('mergeFieldPaths', () => {
  it('names every leaf of a nested map, so a slice never clobbers its siblings', () => {
    const paths = mergeFieldPaths(
      {
        mytribePortal: {
          themeId: 'calm',
          banner: { enabled: true, message: 'Hi' },
          home: { sections: [] },
        },
        businessHours: { Monday: '09:00-17:00' },
      },
      WHOLE_MAP_SETTINGS_FIELDS,
    );
    expect(paths.map(String)).toEqual([
      'mytribePortal.themeId',
      'mytribePortal.banner.enabled',
      'mytribePortal.banner.message',
      'mytribePortal.home.sections',
      'businessHours.Monday',
    ]);
  });
  it('replaces the rate card whole, so a removed KinCare type goes', () => {
    const paths = mergeFieldPaths(
      {
        serviceRates: { Walk: '25' },
        serviceDurations: {},
        serviceStartTimeBooking: { Walk: true },
      },
      WHOLE_MAP_SETTINGS_FIELDS,
    );
    expect(paths.map(String)).toEqual([
      'serviceRates',
      'serviceDurations',
      'serviceStartTimeBooking',
    ]);
  });
  it('quotes a key Firestore would read as a path', () => {
    const [p] = mergeFieldPaths(
      { paymentOptions: { 'pay.me': { enabled: true } } },
      WHOLE_MAP_SETTINGS_FIELDS,
    );
    expect(p).toBeInstanceOf(FieldPath);
    expect(String(p)).toBe('paymentOptions.`pay.me`.enabled');
  });
  it('an empty map is a leaf, so clearing to {} still lands', () => {
    expect(mergeFieldPaths({ mytribePortal: {} }, WHOLE_MAP_SETTINGS_FIELDS).map(String)).toEqual([
      'mytribePortal',
    ]);
  });
});

describe('the gate', () => {
  it('is owner-only: an Auntie and a kinfolk are refused, and it is not on the Auntie list', async () => {
    expect(AUNTIE_ALLOWED_CALLABLES.has('saveBusinessSettings')).toBe(false);
    const wrapped = wrapAdminCallable('saveBusinessSettings', saveBusinessSettingsHandler);
    const data = { changes: { travelBufferMinutes: 30 } };
    await expect(
      wrapped({ data, auth: { uid: 'a1', token: { staffRole: 'auntie' } } } as never),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      wrapped({ data, auth: { uid: 'k1', token: { role: 'kinfolk' } } } as never),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(wrapped({ data } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(settingsWrites()).toHaveLength(0);
  });
  it('freezes the envelope at one key', () => {
    expect(Object.keys(Args.shape)).toEqual(['changes']);
  });
});
