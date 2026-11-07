import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import {
  INVOICE_NUMBER_COUNTER_PATH,
  formatInvoiceNumber,
  invoiceNumberStyleAt,
  invoiceNumberTaken,
  mintInvoiceNumber,
  plainNumberValue,
  storedSequence,
} from '../src/lib/invoiceNumber';

vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

const NOV_2026 = new Date('2026-11-06T18:00:00Z');
const MAR_2027 = new Date('2027-03-01T18:00:00Z');

function counterWrite(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.filter((w) => w.path === INVOICE_NUMBER_COUNTER_PATH).at(-1)?.data;
}

describe('formatInvoiceNumber', () => {
  it('zero-pads the sequence to four digits', () => {
    expect(formatInvoiceNumber(2027, 1)).toBe('INV-2027-0001');
    expect(formatInvoiceNumber(2027, 42)).toBe('INV-2027-0042');
    expect(formatInvoiceNumber(2027, 9999)).toBe('INV-2027-9999');
  });
  it('lets the sequence grow past the padding rather than wrapping', () => {
    expect(formatInvoiceNumber(2027, 10000)).toBe('INV-2027-10000');
  });
  it('never produces a zero or negative sequence', () => {
    expect(formatInvoiceNumber(2027, 0)).toBe('INV-2027-0001');
    expect(formatInvoiceNumber(2027, -3)).toBe('INV-2027-0001');
  });
});

describe('storedSequence', () => {
  it('reads nothing usable as "not seeded" rather than throwing', () => {
    expect(storedSequence(undefined)).toBeNull();
    expect(storedSequence('42')).toBeNull();
    expect(storedSequence(Number.NaN)).toBeNull();
    expect(storedSequence(0)).toBeNull();
    expect(storedSequence(-8)).toBeNull();
  });
  it('reads a real counter as itself', () => {
    expect(storedSequence(42)).toBe(42);
    expect(storedSequence(42.7)).toBe(42);
  });
});

describe('plainNumberValue', () => {
  it('reads an all-digit number and nothing else', () => {
    expect(plainNumberValue('1019')).toBe(1019);
    expect(plainNumberValue(' 1001 ')).toBe(1001);
    expect(plainNumberValue('INV-2026-0001')).toBeNull();
    expect(plainNumberValue('#1018')).toBeNull();
    expect(plainNumberValue('')).toBeNull();
    expect(plainNumberValue(undefined)).toBeNull();
  });
});

/** #1609 ruling: plain count until 2027-01-01 in America/Chicago, then the year style. */
describe('invoiceNumberStyleAt', () => {
  it('is plain up to the last instant of 2026 in Chicago', () => {
    // 2027-01-01T05:59Z is 23:59 on Dec 31 in Chicago (CST, UTC-6).
    expect(invoiceNumberStyleAt(new Date('2027-01-01T05:59:59Z'))).toEqual({ style: 'plain' });
  });
  it('switches to the year style at midnight Chicago time', () => {
    expect(invoiceNumberStyleAt(new Date('2027-01-01T06:00:00Z'))).toEqual({ style: 'year', year: 2027 });
  });
  it('restarts with the year after', () => {
    expect(invoiceNumberStyleAt(new Date('2028-01-01T06:00:00Z'))).toEqual({ style: 'year', year: 2028 });
    expect(invoiceNumberStyleAt(new Date('2028-01-01T05:00:00Z'))).toEqual({ style: 'year', year: 2027 });
  });
});

describe('mintInvoiceNumber, plain count (2026)', () => {
  it('continues one past the highest plain number stored, ignoring year-style and missing ones', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        invoices: [
          { id: 'a', data: { invoiceNumber: '1001' } },
          { id: 'b', data: { invoiceNumber: '1019' } },
          { id: 'c', data: { invoiceNumber: '1005' } },
          { id: 'd', data: { invoiceNumber: 'INV-2026-0001' } },
          { id: 'e', data: {} },
        ],
      },
    });
    expect(await mintInvoiceNumber(ctx.db as never, NOV_2026)).toBe('1020');
    expect(counterWrite(ctx)?.nextPlain).toBe(1021);
  });
  it('uses the stored counter once it exists, in one transaction', async () => {
    const ctx = buildDbMock({ docs: { [INVOICE_NUMBER_COUNTER_PATH]: { next: 2, nextPlain: 1023 } } });
    expect(await mintInvoiceNumber(ctx.db as never, NOV_2026)).toBe('1023');
    expect(counterWrite(ctx)?.nextPlain).toBe(1024);
    expect((ctx.db as never as { runTransaction: { mock: { calls: unknown[] } } }).runTransaction.mock.calls)
      .toHaveLength(1);
  });
  it('starts at 1 on a deployment with no invoices at all', async () => {
    const ctx = buildDbMock({});
    expect(await mintInvoiceNumber(ctx.db as never, NOV_2026)).toBe('1');
  });
  it('steps over a number somebody typed onto another invoice', async () => {
    const ctx = buildDbMock({
      docs: { [INVOICE_NUMBER_COUNTER_PATH]: { nextPlain: 1020 } },
      queryDocs: {
        invoices: [
          { id: 'typed', data: { invoiceNumber: '1020' } },
          { id: 'typed2', data: { invoiceNumber: '1021' } },
        ],
      },
    });
    expect(await mintInvoiceNumber(ctx.db as never, NOV_2026)).toBe('1022');
    expect(counterWrite(ctx)?.nextPlain).toBe(1023);
  });
});

describe('mintInvoiceNumber, year style (2027 on)', () => {
  it('opens each year at 0001, whatever the plain counter holds', async () => {
    const ctx = buildDbMock({ docs: { [INVOICE_NUMBER_COUNTER_PATH]: { nextPlain: 1090 } } });
    expect(await mintInvoiceNumber(ctx.db as never, MAR_2027)).toBe('INV-2027-0001');
    expect(counterWrite(ctx)?.byYear).toEqual({ '2027': 2 });
  });
  it('continues the year sequence, and restarts the next year', async () => {
    const ctx = buildDbMock({ docs: { [INVOICE_NUMBER_COUNTER_PATH]: { byYear: { '2027': 41 } } } });
    expect(await mintInvoiceNumber(ctx.db as never, MAR_2027)).toBe('INV-2027-0041');
    const next = buildDbMock({ docs: { [INVOICE_NUMBER_COUNTER_PATH]: { byYear: { '2027': 41 } } } });
    expect(await mintInvoiceNumber(next.db as never, new Date('2028-02-01T18:00:00Z'))).toBe('INV-2028-0001');
  });
  it('leaves the existing INV-2026-0001 alone: 2026 is never a year-style year', async () => {
    const ctx = buildDbMock({ queryDocs: { invoices: [{ id: 'old', data: { invoiceNumber: 'INV-2026-0001' } }] } });
    expect(await mintInvoiceNumber(ctx.db as never, NOV_2026)).toBe('1');
  });
});

describe('invoiceNumberTaken', () => {
  it('answers for other invoices only', async () => {
    const ctx = buildDbMock({ queryDocs: { invoices: [{ id: 'inv-a', data: { invoiceNumber: '1018' } }] } });
    expect(await invoiceNumberTaken(ctx.db as never, '1018', null)).toBe(true);
    expect(await invoiceNumberTaken(ctx.db as never, '1018', 'inv-a')).toBe(false);
    expect(await invoiceNumberTaken(ctx.db as never, '1019', null)).toBe(false);
  });
});
