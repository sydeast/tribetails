import { describe, it, expect } from 'vitest';
import {
  INVOICE_TERMS_CODES,
  addDays,
  invoiceTermsDef,
  invoiceTermsDefs,
  invoiceTermsWords,
  isCalendarDay,
  lastServiceDay,
  parseInvoiceTermsCode,
  resolveDueDate,
  type InvoiceTermsCode,
} from '../src/lib/invoiceTerms';

/**
 * The terms resolver's fixture table. THE SAME CASES AND THE SAME EXPECTED DAYS
 * run in `auntieos-admin/src/lib/invoiceTerms.test.ts` over the mirror, so a
 * rule changed on one side and not the other turns a suite red. Keep the two
 * tables identical; that is the whole point of them.
 */
interface Case {
  what: string;
  code: InvoiceTermsCode;
  invoiceDate: string;
  serviceDates: string[];
  now: string;
  dueDate: string | null;
  isPast: boolean;
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
  },
  {
    what: 'net 14 counts from the invoice date',
    code: 'net_14',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-09-02',
    isPast: false,
  },
  {
    what: 'net 30 crosses a month boundary without arithmetic of its own',
    code: 'net_30',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: '2026-09-18',
    isPast: false,
  },
  {
    what: 'net 7 crosses a year boundary',
    code: 'net_7',
    invoiceDate: '2026-12-29',
    serviceDates: [],
    now: '2026-12-29',
    dueDate: '2027-01-05',
    isPast: false,
  },
  {
    what: 'net 7 crosses a leap day',
    code: 'net_7',
    invoiceDate: '2028-02-26',
    serviceDates: [],
    now: '2028-02-26',
    dueDate: '2028-03-04',
    isPast: false,
  },
  {
    what: 'service-relative terms count from the LAST visit, not the first',
    code: 'net_14_after_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-02', '2026-08-11', '2026-08-05'],
    now: '2026-08-19',
    dueDate: '2026-08-25',
    isPast: false,
  },
  {
    what: 'due on the last visit is that visit day',
    code: 'due_on_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-02', '2026-08-11'],
    now: '2026-08-19',
    // Already behind today, and reported as such rather than moved.
    dueDate: '2026-08-11',
    isPast: true,
  },
  {
    what: 'a service-relative due date already in the past resolves to the real past day',
    code: 'net_7_after_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-07-20'],
    now: '2026-08-19',
    dueDate: '2026-07-27',
    isPast: true,
  },
  {
    what: 'due today is due, not overdue',
    code: 'net_7_after_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-12'],
    now: '2026-08-19',
    dueDate: '2026-08-19',
    isPast: false,
  },
  {
    what: 'ISO timestamps are read as their calendar day',
    code: 'due_on_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-11T23:30:00.000Z', '2026-08-04T01:00:00.000Z'],
    now: '2026-08-01',
    dueDate: '2026-08-11',
    isPast: false,
  },
  {
    what: 'service-relative terms with no visits resolve to no date at all',
    code: 'net_14_after_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: [],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
  },
  {
    what: 'service-relative terms ignore unreadable visit dates entirely',
    code: 'due_on_last_visit',
    invoiceDate: '2026-08-19',
    serviceDates: ['', 'sometime last week', '2026-02-30'],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
  },
  {
    what: 'invoice-relative terms with no invoice date resolve to no date at all',
    code: 'net_14',
    invoiceDate: '',
    serviceDates: ['2026-08-11'],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
  },
  {
    what: 'custom terms decide nothing, by design',
    code: 'custom',
    invoiceDate: '2026-08-19',
    serviceDates: ['2026-08-11'],
    now: '2026-08-19',
    dueDate: null,
    isPast: false,
  },
];

describe('resolveDueDate fixture table', () => {
  for (const c of CASES) {
    it(c.what, () => {
      const out = resolveDueDate({ code: c.code, invoiceDate: c.invoiceDate }, c.serviceDates, c.now);
      expect(out.dueDate).toBe(c.dueDate);
      expect(out.isPast).toBe(c.isPast);
      // A missing date always says why, and a resolved one never carries a
      // leftover complaint: the two fields are exclusive by construction.
      expect(out.problem === null).toBe(out.dueDate !== null);
    });
  }
});

describe('resolveDueDate problems name what is missing', () => {
  it('names the visits when service-relative terms have none', () => {
    const out = resolveDueDate({ code: 'net_14_after_last_visit', invoiceDate: '2026-08-19' }, [], '2026-08-19');
    expect(out.problem).toContain('no visits on this invoice yet');
    expect(out.basisDay).toBeNull();
  });

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

  it('offers the rules in the declared order, invoice-relative before visit-relative', () => {
    expect(invoiceTermsDefs().map((d) => d.code)).toEqual([...INVOICE_TERMS_CODES]);
  });

  it('reads a stored code back, and refuses anything that is not one of ours', () => {
    expect(parseInvoiceTermsCode('net_14')).toBe('net_14');
    expect(parseInvoiceTermsCode('  net_14  ')).toBe('net_14');
    // The legacy free-text field. It has no code, and must not acquire one.
    expect(parseInvoiceTermsCode('Net 14')).toBeNull();
    expect(parseInvoiceTermsCode('')).toBeNull();
    expect(parseInvoiceTermsCode(undefined)).toBeNull();
    expect(parseInvoiceTermsCode(14)).toBeNull();
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

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-08-19', 14)).toBe('2026-09-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-08-19', 0)).toBe('2026-08-19');
  });

  it('picks the latest readable service day and ignores the rest', () => {
    expect(lastServiceDay(['2026-08-02', '2026-08-11', '2026-08-05'])).toBe('2026-08-11');
    expect(lastServiceDay(['2026-08-11T23:30:00.000Z'])).toBe('2026-08-11');
    expect(lastServiceDay(['', 'nope'])).toBeNull();
    expect(lastServiceDay([])).toBeNull();
  });
});
