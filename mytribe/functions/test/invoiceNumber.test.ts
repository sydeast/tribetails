import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import {
  INVOICE_NUMBER_COUNTER_PATH,
  formatInvoiceNumber,
  mintInvoiceNumber,
  nextSequence,
} from '../src/lib/invoiceNumber';

vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

describe('formatInvoiceNumber', () => {
  it('zero-pads the sequence to four digits', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber(2026, 42)).toBe('INV-2026-0042');
    expect(formatInvoiceNumber(2026, 9999)).toBe('INV-2026-9999');
  });

  it('lets the sequence grow past the padding rather than wrapping', () => {
    expect(formatInvoiceNumber(2026, 10000)).toBe('INV-2026-10000');
  });

  it('never produces a zero or negative sequence', () => {
    expect(formatInvoiceNumber(2026, 0)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber(2026, -3)).toBe('INV-2026-0001');
  });
});

describe('nextSequence', () => {
  it('starts at 1 on a counter that does not exist yet', () => {
    expect(nextSequence(undefined)).toBe(1);
    expect(nextSequence(null)).toBe(1);
  });

  it('starts at 1 rather than throwing over a counter somebody edited by hand', () => {
    // Refusing to create an invoice because a counter document holds junk
    // would be a worse answer than starting the sequence.
    expect(nextSequence('42')).toBe(1);
    expect(nextSequence(Number.NaN)).toBe(1);
    expect(nextSequence(0)).toBe(1);
    expect(nextSequence(-8)).toBe(1);
  });

  it('reads a real counter as itself', () => {
    expect(nextSequence(42)).toBe(42);
    expect(nextSequence(42.7)).toBe(42);
  });
});

describe('mintInvoiceNumber', () => {
  it('hands out the stored value and stores its successor, in one transaction', async () => {
    const ctx = buildDbMock({ docs: { [INVOICE_NUMBER_COUNTER_PATH]: { next: 12 } } });

    const number = await mintInvoiceNumber(ctx.db as never, '2026-08-19');

    expect(number).toBe('INV-2026-0012');
    expect(ctx.writes.find((w) => w.path === INVOICE_NUMBER_COUNTER_PATH)?.data.next).toBe(13);
    expect((ctx.db as never as { runTransaction: { mock: { calls: unknown[] } } }).runTransaction.mock.calls)
      .toHaveLength(1);
  });

  it('starts the sequence on a deployment that has never minted one', async () => {
    const ctx = buildDbMock({});
    expect(await mintInvoiceNumber(ctx.db as never, '2026-08-19')).toBe('INV-2026-0001');
  });

  it('takes the year from the invoice date, so a back-dated invoice is numbered for the year it is for', async () => {
    const ctx = buildDbMock({});
    expect(await mintInvoiceNumber(ctx.db as never, '2025-12-30', new Date('2026-01-04T00:00:00Z'))).toBe(
      'INV-2025-0001',
    );
  });

  it('falls back to today when the invoice has no date of its own', async () => {
    const ctx = buildDbMock({});
    expect(await mintInvoiceNumber(ctx.db as never, '', new Date('2026-08-19T00:00:00Z'))).toBe(
      'INV-2026-0001',
    );
  });
});
