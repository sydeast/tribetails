import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAYMENT_TERMS,
  INVOICE_TERMS_CODES,
  PAYMENT_TERMS_SETTING_CODES,
  addDays,
  firstServiceDay,
  invoiceTermsDef,
  invoiceTermsDefs,
  invoiceTermsWords,
  isCalendarDay,
  lastServiceDay,
  parseInvoiceTermsCode,
  paymentTermsSettingOf,
  resolveDueDate,
  serviceDayOf,
  type InvoiceTermsCode,
} from '../src/lib/invoiceTerms';

/**
 * The terms resolver's fixture table. THE SAME CASES AND THE SAME EXPECTED DAYS
 * run in `auntieos-admin/src/lib/invoiceTerms.test.ts` over the mirror, and in
 * the Android and desktop `InvoiceTermsTest`, so a rule changed on one side and
 * not the other turns a suite red. Keep the tables identical; that is the whole
 * point of them. Every case resolves in America/Chicago.
 */
interface Case {
  what: string;
  code: InvoiceTermsCode;
  invoiceDate: string;
  serviceDates: string[];
  now: string;
  dueDate: string | null;
  isPast: boolean;
  appliedCode: InvoiceTermsCode;
}

const CASES: readonly Case[] = [
  {
    what: 'due on receipt is the invoice date itself',
    code: 'due_on_receipt',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-08-19',
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'net 14 counts from the invoice date',
    code: 'net_14',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-09-02',
    isPast: false,
    appliedCode: 'net_14',
  },
  {
    what: 'net 30 crosses a month boundary without arithmetic of its own',
    code: 'net_30',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-09-18',
    isPast: false,
    appliedCode: 'net_30',
  },
  {
    what: 'net 7 crosses a year boundary',
    code: 'net_7',
    invoiceDate: '2026-12-29',
    serviceDates: [],
    now: '2026-12-29',
    dueDate: '2027-01-05',
    isPast: false,
    appliedCode: 'net_7',
  },
  {
    what: 'net 7 crosses a leap day',
    code: 'net_7',
    invoiceDate: '2028-02-26',
    serviceDates: [],
    now: '2028-02-26',
    dueDate: '2028-03-04',
    isPast: false,
    appliedCode: 'net_7',
  },
  {
    what: 'after-last-visit terms count from the LAST visit, not the first',
    code: 'net_14_after_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-02', '2026-08-11', '2026-08-05'],
    now: '2026-08-19',
    dueDate: '2026-08-25',
    isPast: false,
    appliedCode: 'net_14_after_last_visit',
  },
  {
    what: 'due on the last visit is that visit day',
    code: 'due_on_last_visit',
    invoiceDate: '2026-08-01',
    // Already behind today, and reported as such rather than moved.
    serviceDates: ['2026-08-02', '2026-08-11'],
    now: '2026-08-01',
    dueDate: '2026-08-11',
    isPast: false,
    appliedCode: 'due_on_last_visit',
  },
  {
    what: 'due on the first visit is the earliest visit day',
    code: 'due_on_first_visit',
    invoiceDate: '2026-08-01',
    serviceDates: ['2026-08-11', '2026-08-02', '2026-08-05'],
    now: '2026-08-01',
    dueDate: '2026-08-02',
    isPast: false,
    appliedCode: 'due_on_first_visit',
  },
  {
    what: '1 day after the last visit crosses a month end',
    code: 'net_1_after_last_visit',
    invoiceDate: '2026-08-31',
    serviceDates: ['2026-08-24', '2026-08-31'],
    now: '2026-08-31',
    dueDate: '2026-09-01',
    isPast: false,
    appliedCode: 'net_1_after_last_visit',
  },
  {
    what: '30 days after the last visit crosses a month end',
    code: 'net_30_after_last_visit',
    invoiceDate: '2026-11-30',
    serviceDates: ['2026-11-30'],
    now: '2026-11-30',
    dueDate: '2026-12-30',
    isPast: false,
    appliedCode: 'net_30_after_last_visit',
  },
  {
    what: '5 days after the last visit crosses February in a leap year',
    code: 'net_5_after_last_visit',
    invoiceDate: '2028-02-26',
    serviceDates: ['2028-02-26'],
    now: '2028-02-26',
    dueDate: '2028-03-02',
    isPast: false,
    appliedCode: 'net_5_after_last_visit',
  },
  {
    what: '3 days before the first visit counts back across a month start',
    code: 'net_3_before_first_visit',
    invoiceDate: '2026-11-20',
    serviceDates: ['2026-12-09', '2026-12-02'],
    now: '2026-11-20',
    dueDate: '2026-11-29',
    isPast: false,
    appliedCode: 'net_3_before_first_visit',
  },
  {
    what: '1 day before the first visit counts back across a year start',
    code: 'net_1_before_first_visit',
    invoiceDate: '2026-12-15',
    serviceDates: ['2027-01-01', '2027-01-04'],
    now: '2026-12-15',
    dueDate: '2026-12-31',
    isPast: false,
    appliedCode: 'net_1_before_first_visit',
  },
  {
    what: '30 days before the first visit counts back across February',
    code: 'net_30_before_first_visit',
    invoiceDate: '2026-02-01',
    serviceDates: ['2026-03-15'],
    now: '2026-02-01',
    dueDate: '2026-02-13',
    isPast: false,
    appliedCode: 'net_30_before_first_visit',
  },
  {
    what: 'a before-first-visit date before the invoice date is due on receipt',
    code: 'net_7_before_first_visit',
    invoiceDate: '2026-11-13',
    serviceDates: ['2026-11-15'],
    now: '2026-11-13',
    dueDate: '2026-11-13',
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'an evening visit in Chicago is counted on its Chicago day, not the UTC day',
    code: 'due_on_last_visit',
    invoiceDate: '2026-11-30',
    // 7 PM on Nov 30 in Chicago is 01:00 on Dec 1 in UTC.
    serviceDates: ['2026-11-28T15:00:00.000Z', '2026-12-01T01:00:00.000Z'],
    now: '2026-11-30',
    dueDate: '2026-11-30',
    isPast: false,
    appliedCode: 'due_on_last_visit',
  },
  {
    what: 'an evening first visit is counted on its Chicago day before the count runs back',
    code: 'net_2_before_first_visit',
    invoiceDate: '2026-11-20',
    // 8 PM on Dec 1 in Chicago is 02:00 on Dec 2 in UTC.
    serviceDates: ['2026-12-02T02:00:00.000Z', '2026-12-05T15:00:00.000Z'],
    now: '2026-11-20',
    dueDate: '2026-11-29',
    isPast: false,
    appliedCode: 'net_2_before_first_visit',
  },
  {
    what: 'the night the clocks go forward: 05:30Z is still Mar 7 in Chicago',
    code: 'net_7_after_last_visit',
    invoiceDate: '2026-03-08',
    serviceDates: ['2026-03-08T05:30:00.000Z'],
    now: '2026-03-08',
    dueDate: '2026-03-14',
    isPast: false,
    appliedCode: 'net_7_after_last_visit',
  },
  {
    what: 'the day after the clocks go forward: 04:30Z is Mar 8 in Chicago',
    code: 'due_on_last_visit',
    invoiceDate: '2026-03-08',
    serviceDates: ['2026-03-09T04:30:00.000Z'],
    now: '2026-03-08',
    dueDate: '2026-03-08',
    isPast: false,
    appliedCode: 'due_on_last_visit',
  },
  {
    what: 'the night the clocks go back: 05:30Z on Nov 2 is still Nov 1 in Chicago',
    code: 'net_14_before_first_visit',
    invoiceDate: '2026-10-01',
    serviceDates: ['2026-11-02T05:30:00.000Z', '2026-11-03T15:00:00.000Z'],
    now: '2026-10-01',
    dueDate: '2026-10-18',
    isPast: false,
    appliedCode: 'net_14_before_first_visit',
  },
  {
    what: 'a time with an offset is read on the Chicago clock',
    code: 'due_on_last_visit',
    invoiceDate: '2026-11-30',
    serviceDates: ['2026-11-30T23:30:00-06:00'],
    now: '2026-11-30',
    dueDate: '2026-11-30',
    isPast: false,
    appliedCode: 'due_on_last_visit',
  },
  {
    what: 'a time with no zone is already the business clock and keeps its own date',
    code: 'due_on_last_visit',
    invoiceDate: '2026-11-30',
    serviceDates: ['2026-11-30T23:30:00'],
    now: '2026-11-30',
    dueDate: '2026-11-30',
    isPast: false,
    appliedCode: 'due_on_last_visit',
  },
  {
    what: 'after-last-visit terms with no visits are due on receipt',
    code: 'net_14_after_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-08-19',
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'before-first-visit terms with no visits are due on receipt',
    code: 'net_7_before_first_visit',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-08-19',
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'unreadable visit dates count as no visits, so due on receipt',
    code: 'due_on_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['', 'sometime last week', '2026-02-30'],
    now: '2026-08-19',
    dueDate: '2026-08-19',
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'no visits and no invoice date resolve to no date at all',
    code: 'due_on_first_visit',
    invoiceDate: '',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'invoice-relative terms with no invoice date resolve to no date at all',
    code: 'net_14',
    invoiceDate: '',
    serviceDates: ['2026-08-11'],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
    appliedCode: 'net_14',
  },
  {
    what: 'custom terms decide nothing, by design',
    code: 'custom',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-11'],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
    appliedCode: 'custom',
  },
  {
    what: 'due on the last visit, invoiced after it, is due on receipt',
    code: 'due_on_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-02', '2026-08-11'],
    now: '2026-08-19',
    dueDate: '2026-08-19',
    isPast: false,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'after-last-visit terms already behind today are reported, not moved',
    code: 'net_7_after_last_visit',
    invoiceDate: '2026-07-21',
    serviceDates: ['2026-07-20'],
    now: '2026-08-19',
    dueDate: '2026-07-27',
    isPast: true,
    appliedCode: 'net_7_after_last_visit',
  },
  {
    what: 'a backdated invoice held to its own date is still reported as past',
    code: 'net_3_before_first_visit',
    invoiceDate: '2026-11-10',
    serviceDates: ['2026-11-12'],
    now: '2026-11-13',
    dueDate: '2026-11-10',
    isPast: true,
    appliedCode: 'due_on_receipt',
  },
  {
    what: 'before-first-visit terms that land on the invoice date are kept',
    code: 'net_2_before_first_visit',
    invoiceDate: '2026-11-13',
    serviceDates: ['2026-11-15'],
    now: '2026-11-13',
    dueDate: '2026-11-13',
    isPast: false,
    appliedCode: 'net_2_before_first_visit',
  },
  {
    what: 'with no invoice date there is nothing to hold the due date to',
    code: 'net_7_before_first_visit',
    invoiceDate: '',
    serviceDates: ['2026-11-15'],
    now: '2026-11-13',
    dueDate: '2026-11-08',
    isPast: true,
    appliedCode: 'net_7_before_first_visit',
  },
];

describe('resolveDueDate fixture table', () => {
  for (const c of CASES) {
    it(c.what, () => {
      const out = resolveDueDate(
        { code: c.code, invoiceDate: c.invoiceDate },
        c.serviceDates,
        c.now,
        'America/Chicago',
      );
      expect(out.dueDate).toBe(c.dueDate);
      expect(out.isPast).toBe(c.isPast);
      expect(out.appliedCode).toBe(c.appliedCode);
      // A missing date always says why, and a resolved one never carries a
      // leftover complaint: the two fields are exclusive by construction.
      expect(out.problem === null).toBe(out.dueDate !== null);
    });
  }
});

describe('resolveDueDate reads visit days on the business clock', () => {
  it('defaults to America/Chicago when no zone is given', () => {
    const out = resolveDueDate(
      { code: 'due_on_last_visit', invoiceDate: '2026-11-30' },
      ['2026-12-01T01:00:00.000Z'],
      '2026-11-30',
    );
    expect(out.dueDate).toBe('2026-11-30');
  });

  it('uses the zone it is given', () => {
    const out = resolveDueDate(
      { code: 'due_on_last_visit', invoiceDate: '2026-11-30' },
      ['2026-12-01T01:00:00.000Z'],
      '2026-11-30',
      'Asia/Tokyo',
    );
    expect(out.dueDate).toBe('2026-12-01');
  });

  it('falls back to America/Chicago for a zone it cannot read', () => {
    expect(serviceDayOf('2026-12-01T01:00:00.000Z', 'Not/AZone')).toBe('2026-11-30');
  });
});

describe('resolveDueDate never makes a bill due before its own date (#1966 review)', () => {
  it('says why when the floor decided the date', () => {
    const out = resolveDueDate(
      { code: 'net_3_before_first_visit', invoiceDate: '2026-11-13' },
      ['2026-11-14'],
      '2026-11-13',
    );
    expect(out.dueDate).toBe('2026-11-13');
    expect(out.appliedCode).toBe('due_on_receipt');
    expect(out.beforeInvoiceDate).toBe(true);
  });

  it('does not say it for no visits, or for terms that land on or after the invoice date', () => {
    expect(resolveDueDate({ code: 'net_3_before_first_visit', invoiceDate: '2026-11-13' }, [], '2026-11-13').beforeInvoiceDate).toBe(false);
    expect(
      resolveDueDate({ code: 'net_3_before_first_visit', invoiceDate: '2026-11-13' }, ['2026-11-16'], '2026-11-13')
        .beforeInvoiceDate,
    ).toBe(false);
    expect(resolveDueDate({ code: 'net_14', invoiceDate: '2026-11-13' }, [], '2026-11-13').beforeInvoiceDate).toBe(false);
  });
});

describe('resolveDueDate problems name what is missing', () => {
  it('names the invoice date when invoice-relative terms have none', () => {
    const out = resolveDueDate({ code: 'net_30', invoiceDate: '' }, ['2026-08-11'], '2026-08-19');
    expect(out.problem).toContain('no date on it yet');
  });

  it('says custom terms leave the date to the operator', () => {
    const out = resolveDueDate({ code: 'custom', invoiceDate: '2026-08-19' }, [], '2026-08-19');
    expect(out.problem).toContain('pick the due date');
  });

  it('reports the day the count ran from, so a surprising date can be traced', () => {
    const out = resolveDueDate(
      { code: 'net_14_after_last_visit', invoiceDate: '2026-08-19' },
      ['2026-08-02', '2026-08-11'],
      '2026-08-19',
    );
    expect(out.basisDay).toBe('2026-08-11');
    const first = resolveDueDate(
      { code: 'net_3_before_first_visit', invoiceDate: '2026-08-01' },
      ['2026-08-11', '2026-08-05'],
      '2026-08-01',
    );
    expect(first.basisDay).toBe('2026-08-05');
  });
});

describe('terms vocabulary', () => {
  it('gives every code a rule, a label and household-facing words', () => {
    for (const code of INVOICE_TERMS_CODES) {
      const def = invoiceTermsDef(code);
      expect(def.code).toBe(code);
      expect(def.label.trim()).not.toBe('');
      expect(def.words.trim()).not.toBe('');
      expect(invoiceTermsWords(code)).toBe(def.words);
    }
  });

  it('offers the rules in the declared order', () => {
    expect(invoiceTermsDefs().map((d) => d.code)).toEqual([...INVOICE_TERMS_CODES]);
  });

  it('says "1 day", never "1 days"', () => {
    expect(invoiceTermsDef('net_1_after_last_visit').label).toBe('Due 1 day after the last visit');
    expect(invoiceTermsDef('net_1_before_first_visit').label).toBe('Due 1 day before the first visit');
    expect(invoiceTermsDef('net_2_before_first_visit').label).toBe('Due 2 days before the first visit');
    for (const def of invoiceTermsDefs()) expect(def.label).not.toMatch(/\b1 days\b/);
  });

  it('reads a stored code back, and refuses anything that is not one of ours', () => {
    expect(parseInvoiceTermsCode('net_14')).toBe('net_14');
    expect(parseInvoiceTermsCode('  net_14  ')).toBe('net_14');
    expect(parseInvoiceTermsCode('net_3_before_first_visit')).toBe('net_3_before_first_visit');
    // The legacy free-text field. It has no code, and must not acquire one.
    expect(parseInvoiceTermsCode('Net 14')).toBeNull();
    expect(parseInvoiceTermsCode('')).toBeNull();
    expect(parseInvoiceTermsCode(undefined)).toBeNull();
    expect(parseInvoiceTermsCode(14)).toBeNull();
  });
});

describe('the Payment terms setting (#1966)', () => {
  it('offers exactly the ruled options, in the ruled order', () => {
    expect([...PAYMENT_TERMS_SETTING_CODES]).toEqual([
      'due_on_receipt',
      'due_on_first_visit',
      'due_on_last_visit',
      'net_1_after_last_visit',
      'net_2_after_last_visit',
      'net_3_after_last_visit',
      'net_4_after_last_visit',
      'net_5_after_last_visit',
      'net_6_after_last_visit',
      'net_7_after_last_visit',
      'net_14_after_last_visit',
      'net_30_after_last_visit',
      'net_1_before_first_visit',
      'net_2_before_first_visit',
      'net_3_before_first_visit',
      'net_4_before_first_visit',
      'net_5_before_first_visit',
      'net_6_before_first_visit',
      'net_7_before_first_visit',
      'net_14_before_first_visit',
      'net_30_before_first_visit',
    ]);
  });

  it('starts every business on due on receipt', () => {
    expect(DEFAULT_PAYMENT_TERMS).toBe('due_on_receipt');
    expect(paymentTermsSettingOf(undefined)).toBe('due_on_receipt');
    expect(paymentTermsSettingOf('')).toBe('due_on_receipt');
  });

  it('reads a stored option back, and anything else as due on receipt', () => {
    expect(paymentTermsSettingOf('net_14_after_last_visit')).toBe('net_14_after_last_visit');
    expect(paymentTermsSettingOf('net_30_before_first_visit')).toBe('net_30_before_first_visit');
    // In the table, but not a setting option.
    expect(paymentTermsSettingOf('net_14')).toBe('due_on_receipt');
    expect(paymentTermsSettingOf('custom')).toBe('due_on_receipt');
    expect(paymentTermsSettingOf('Net 14')).toBe('due_on_receipt');
    expect(paymentTermsSettingOf(14)).toBe('due_on_receipt');
  });
});

describe('day arithmetic', () => {
  it('accepts real calendar days and refuses impossible ones', () => {
    expect(isCalendarDay('2026-08-19')).toBe(true);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-02-30')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('2026-8-19')).toBe(false);
    expect(isCalendarDay('')).toBe(false);
  });

  it('adds and subtracts days across months, years and leap days', () => {
    expect(addDays('2026-08-19', 14)).toBe('2026-09-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-08-19', 0)).toBe('2026-08-19');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('picks the latest and the earliest readable service day and ignores the rest', () => {
    expect(lastServiceDay(['2026-08-02', '2026-08-11', '2026-08-05'])).toBe('2026-08-11');
    expect(firstServiceDay(['2026-08-11', '2026-08-02', '2026-08-05'])).toBe('2026-08-02');
    expect(lastServiceDay(['2026-08-11T23:30:00.000Z'])).toBe('2026-08-11');
    expect(lastServiceDay(['', 'nope'])).toBeNull();
    expect(firstServiceDay([])).toBeNull();
  });

  it('reads a visit start time as its business day', () => {
    expect(serviceDayOf('2026-11-30')).toBe('2026-11-30');
    expect(serviceDayOf('2026-12-01T01:00:00.000Z')).toBe('2026-11-30');
    expect(serviceDayOf('2026-12-01T06:00:00.000Z')).toBe('2026-12-01');
    expect(serviceDayOf('2026-11-30T19:00')).toBe('2026-11-30');
    expect(serviceDayOf('2026-11-30T19:00:00+00:00')).toBe('2026-11-30');
    expect(serviceDayOf('next Tuesday')).toBeNull();
    expect(serviceDayOf('2026-02-30T10:00:00')).toBeNull();
  });
});
