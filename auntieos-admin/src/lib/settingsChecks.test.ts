import { describe, expect, it } from 'vitest';
import {
  businessEmailError,
  businessPhoneError,
  cashappHandleError,
  CLOSURE_NAME_REQUIRED,
  closureNameError,
  DATE_INVALID,
  DATE_PAST,
  dayHoursError,
  displayablePrice,
  durationError,
  EMAIL_INVALID,
  HOURS_CLOSE_BEFORE_OPEN,
  HOURS_RANGE_INVALID,
  hoursRangeError,
  isRealDate,
  KINCARE_NAME_REQUIRED,
  kinCareNameError,
  NAME_HAS_PIPE,
  parsePortalLimit,
  paypalHandleError,
  PHONE_INVALID,
  PORTAL_LIMIT_INVALID,
  PORTAL_THEMES,
  priceError,
  settingsRefusalsOf,
  splitSettingsRefusal,
  THEME_INVALID,
  themeError,
  todayInZone,
  upcomingDateError,
  venmoHandleError,
} from './settingsChecks';

/**
 * #1593: the Settings field rules the screens show beside each field. The
 * server (`mytribe/functions/src/lib/businessSettingsChecks.ts`) runs the same
 * rules with the same sentences; these pin the client copy.
 */

describe('businessEmailError', () => {
  it('passes blank and whitespace, because the field is optional', () => {
    expect(businessEmailError('')).toBeNull();
    expect(businessEmailError('   ')).toBeNull();
  });
  it('passes an ordinary address, with spaces around it', () => {
    expect(businessEmailError('hello@tribetails.com')).toBeNull();
    expect(businessEmailError('  hello@tribetails.com ')).toBeNull();
  });
  it.each(['hello', 'hello@', '@tribetails.com', 'a@b', 'a@b.c', 'a..b@tribetails.com', 'a b@tribetails.com'])(
    'refuses %j',
    (raw) => {
      expect(businessEmailError(raw)).toBe(EMAIL_INVALID);
    },
  );
});

describe('businessPhoneError', () => {
  it('passes blank', () => {
    expect(businessPhoneError('')).toBeNull();
    expect(businessPhoneError('  ')).toBeNull();
  });
  it.each(['(555) 123-4567', '555.123.4567', '+1 555 123 4567', '15551234567'])('passes %j', (raw) => {
    expect(businessPhoneError(raw)).toBeNull();
  });
  it.each(['555-1234', 'call me', '25551234567', '555 123 4567 x2', '+44 20 7946 0958'])('refuses %j', (raw) => {
    expect(businessPhoneError(raw)).toBe(PHONE_INVALID);
  });
});

describe('isRealDate / upcomingDateError', () => {
  it('knows a real date from a calendar-shaped one', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-13-45')).toBe(false);
    expect(isRealDate('2026-00-10')).toBe(false);
    expect(isRealDate('2026-1-5')).toBe(false);
    expect(isRealDate('next tuesday')).toBe(false);
  });
  it('refuses a date that is not real before asking whether it has passed', () => {
    expect(upcomingDateError('2026-13-45', '2026-11-09')).toBe(DATE_INVALID);
    expect(upcomingDateError('', '2026-11-09')).toBe(DATE_INVALID);
  });
  it('refuses yesterday and passes today and later', () => {
    expect(upcomingDateError('2026-11-08', '2026-11-09')).toBe(DATE_PAST);
    expect(upcomingDateError('2026-11-09', '2026-11-09')).toBeNull();
    expect(upcomingDateError(' 2026-12-25 ', '2026-11-09')).toBeNull();
  });
});

describe('todayInZone', () => {
  it('reads the date in the business zone, not the runtime one', () => {
    // 03:30 UTC on Nov 10 is still the evening of Nov 9 in Chicago.
    const now = new Date('2026-11-10T03:30:00Z');
    expect(todayInZone('America/Chicago', now)).toBe('2026-11-09');
    expect(todayInZone('UTC', now)).toBe('2026-11-10');
  });
  it('falls back to the runtime zone for a zone it cannot read', () => {
    expect(todayInZone('Not/AZone', new Date('2026-06-15T12:00:00Z'))).toMatch(/^2026-06-1[45]$/);
  });
});

describe('hoursRangeError / dayHoursError', () => {
  it('passes a range that closes after it opens, padded or not', () => {
    expect(hoursRangeError('09:00-17:00')).toBeNull();
    expect(hoursRangeError('9:00 - 17:00')).toBeNull();
  });
  it('refuses a close at or before the open', () => {
    expect(hoursRangeError('17:00-09:00')).toBe(HOURS_CLOSE_BEFORE_OPEN);
    expect(hoursRangeError('09:00-09:00')).toBe(HOURS_CLOSE_BEFORE_OPEN);
  });
  it.each(['', 'zz-99', '-17:00', '09:00-', '25:00-26:00', '09:60-10:00', '09:00-12:00-13:00', '0900-1700'])(
    'refuses %j as not a range',
    (raw) => {
      expect(hoursRangeError(raw)).toBe(HOURS_RANGE_INVALID);
    },
  );
  it('reads both time boxes blank as Closed, and one blank as unfinished', () => {
    expect(dayHoursError('', '')).toBeNull();
    expect(dayHoursError('', '17:00')).toBe(HOURS_RANGE_INVALID);
    expect(dayHoursError('09:00', '')).toBe(HOURS_RANGE_INVALID);
    expect(dayHoursError('18:00', '08:00')).toBe(HOURS_CLOSE_BEFORE_OPEN);
    expect(dayHoursError('08:00', '18:00')).toBeNull();
  });
});

describe('priceError / displayablePrice', () => {
  it('passes blank, which is "No price set"', () => {
    expect(priceError('Walk', '')).toBeNull();
    expect(priceError('Walk', '  ')).toBeNull();
    expect(displayablePrice('')).toBeNull();
  });
  it.each(['25', '25.5', '25.50', '0', '1234567.89'])('passes %j', (raw) => {
    expect(priceError('Walk', raw)).toBeNull();
    expect(displayablePrice(raw)).toBe(raw);
  });
  it('refuses a negative price by name', () => {
    expect(priceError('Walk', '-5')).toBe('The price for "Walk" cannot be negative.');
    expect(displayablePrice('-5')).toBeNull();
  });
  it.each(['abc', '1.234', '$25', '25.', '12345678', '1,000'])('refuses %j by name', (raw) => {
    expect(priceError('Walk', raw)).toBe('Enter the price for "Walk" in dollars, like 25 or 25.50.');
    expect(displayablePrice(raw)).toBeNull();
  });
});

describe('durationError', () => {
  it('passes blank and 1 to 1440 whole minutes', () => {
    expect(durationError('Walk', '')).toBeNull();
    expect(durationError('Walk', '1')).toBeNull();
    expect(durationError('Walk', '1440')).toBeNull();
  });
  it.each(['0', '1441', '-30', '30.5', 'half an hour'])('refuses %j by name', (raw) => {
    expect(durationError('Walk', raw)).toBe('Enter the length of "Walk" in whole minutes, from 1 to 1440.');
  });
});

describe('kinCareNameError', () => {
  it('needs a name', () => {
    expect(kinCareNameError('', ['', 'Walk'])).toBe(KINCARE_NAME_REQUIRED);
    expect(kinCareNameError('   ', ['   '])).toBe(KINCARE_NAME_REQUIRED);
  });
  it('refuses a name two rows share, ignoring case and spaces', () => {
    expect(kinCareNameError('Walk', ['Walk', ' walk '])).toBe('Two KinCare types are both called "Walk".');
  });
  it('passes a name only one row has', () => {
    expect(kinCareNameError('Walk', ['Walk', 'Overnight'])).toBeNull();
  });
});

describe('payment handles', () => {
  it('Venmo: blank passes, a leading @ is allowed, 5 to 30 characters', () => {
    expect(venmoHandleError('')).toBeNull();
    expect(venmoHandleError('@tribe-tails')).toBeNull();
    expect(venmoHandleError('abcd')).toBe('Enter the Venmo username: 5 to 30 letters, numbers, - or _.');
    expect(venmoHandleError('venmo.com/u/tribe')).toBe('Enter the Venmo username: 5 to 30 letters, numbers, - or _.');
  });
  it('PayPal: letters and numbers, up to 20', () => {
    expect(paypalHandleError('')).toBeNull();
    expect(paypalHandleError('tribetails')).toBeNull();
    expect(paypalHandleError('paypal.me/tribetails')).toBe('Enter the PayPal.Me name: up to 20 letters and numbers.');
    expect(paypalHandleError('a'.repeat(21))).toBe('Enter the PayPal.Me name: up to 20 letters and numbers.');
  });
  it('Cash App: an optional $, up to 20, at least one letter', () => {
    expect(cashappHandleError('')).toBeNull();
    expect(cashappHandleError('$tribetails')).toBeNull();
    expect(cashappHandleError('tribe_tails')).toBeNull();
    expect(cashappHandleError('$12345')).toBe('Enter the $Cashtag: up to 20 letters, numbers or _, with at least one letter.');
    expect(cashappHandleError('$tribe tails')).toBe(
      'Enter the $Cashtag: up to 20 letters, numbers or _, with at least one letter.',
    );
  });
});

describe('parsePortalLimit', () => {
  it('passes any whole number from 0 up, with no ceiling', () => {
    expect(parsePortalLimit('0')).toEqual({ value: 0 });
    expect(parsePortalLimit(' 12 ')).toEqual({ value: 12 });
    expect(parsePortalLimit('1000')).toEqual({ value: 1000 });
    expect(parsePortalLimit('5000')).toEqual({ value: 5000 });
  });
  it.each(['', '-3', 'abc', '1.5', '1e3'])('refuses %j', (raw) => {
    expect(parsePortalLimit(raw)).toEqual({ error: PORTAL_LIMIT_INVALID });
  });
});

describe('themeError', () => {
  it('passes every listed theme and blank', () => {
    for (const t of PORTAL_THEMES) expect(themeError(t.id)).toBeNull();
    expect(themeError('')).toBeNull();
  });
  it('refuses an id that is not in the list', () => {
    expect(themeError('neon')).toBe(THEME_INVALID);
    expect(themeError('Default')).toBe(THEME_INVALID);
  });
});

describe('closureNameError', () => {
  it('needs a name with no |', () => {
    expect(closureNameError('')).toBe(CLOSURE_NAME_REQUIRED);
    expect(closureNameError('  ')).toBe(CLOSURE_NAME_REQUIRED);
    expect(closureNameError('Closed | back Monday')).toBe(NAME_HAS_PIPE);
    expect(closureNameError('Christmas closure')).toBeNull();
  });
});

describe('server refusals', () => {
  function refused(refusals: unknown): Error {
    return Object.assign(new Error('first sentence'), { details: { code: 'settings_refused', refusals } });
  }

  it('reads the refusal list off the error, dropping malformed entries', () => {
    expect(
      settingsRefusalsOf(refused([{ field: 'businessEmail', message: EMAIL_INVALID }, { field: 3 }, null])),
    ).toEqual([{ field: 'businessEmail', message: EMAIL_INVALID }]);
    expect(settingsRefusalsOf(new Error('no details'))).toEqual([]);
    expect(settingsRefusalsOf(null)).toEqual([]);
  });

  it('puts a refusal for a field the section draws beside it, with no banner', () => {
    expect(splitSettingsRefusal(refused([{ field: 'businessEmail', message: EMAIL_INVALID }]), ['businessEmail'])).toEqual({
      byField: { businessEmail: EMAIL_INVALID },
      banner: null,
    });
  });

  it('sends a refusal for a field the section does not draw to the banner', () => {
    expect(
      splitSettingsRefusal(
        refused([
          { field: 'businessEmail', message: EMAIL_INVALID },
          { field: 'serviceRates', message: KINCARE_NAME_REQUIRED },
        ]),
        ['businessEmail'],
      ),
    ).toEqual({ byField: { businessEmail: EMAIL_INVALID }, banner: KINCARE_NAME_REQUIRED });
  });

  it('shows any other failure in the banner whole', () => {
    expect(splitSettingsRefusal(new Error('permission-denied'), ['businessEmail'])).toEqual({
      byField: {},
      banner: 'permission-denied',
    });
    expect(splitSettingsRefusal('nope', [])).toEqual({ byField: {}, banner: 'Save failed.' });
  });
});
