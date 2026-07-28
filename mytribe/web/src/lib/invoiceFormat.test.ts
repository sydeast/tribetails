import { describe, expect, it } from 'vitest';
import {
  calTileFor,
  creditTargetLabel,
  formatCentsUsd,
  formatUsd,
  invoiceStatusInfo,
  longDateLabel,
  parseDateMs,
  partPaidStatusInfo,
  partPaidSummary,
  shortDateLabel,
} from './invoiceFormat';

describe('formatUsd', () => {
  it('formats positive amounts with two decimals', () => {
    expect(formatUsd(36)).toBe('$36.00');
    expect(formatUsd(72.5)).toBe('$72.50');
  });

  it('formats negative amounts with a leading minus outside the dollar sign', () => {
    expect(formatUsd(-15)).toBe('-$15.00');
  });

  it('formats zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('formatCentsUsd', () => {
  it('converts cents to dollars', () => {
    expect(formatCentsUsd(3600)).toBe('$36.00');
    expect(formatCentsUsd(150)).toBe('$1.50');
  });
});

describe('parseDateMs', () => {
  it('parses a valid ISO date string', () => {
    expect(parseDateMs('2026-06-07')).not.toBeNull();
  });

  it('returns null for null/unparseable input', () => {
    expect(parseDateMs(null)).toBeNull();
    expect(parseDateMs('not-a-date')).toBeNull();
  });
});

describe('shortDateLabel', () => {
  it('formats a parseable date without zero-padding the day', () => {
    expect(shortDateLabel('2026-06-02T12:00:00Z')).toBe('Jun 2');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(shortDateLabel('Net 14')).toBe('Net 14');
  });

  it('returns null for null/empty input', () => {
    expect(shortDateLabel(null)).toBeNull();
    expect(shortDateLabel('')).toBeNull();
  });
});

describe('longDateLabel', () => {
  it('formats a parseable date with a zero-padded day and year', () => {
    expect(longDateLabel('2026-06-01T12:00:00Z')).toBe('Jun 01, 2026');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(longDateLabel('draft estimate')).toBe('draft estimate');
  });
});

describe('calTileFor', () => {
  it('formats a parseable date as month + zero-padded day', () => {
    expect(calTileFor('2026-06-07T12:00:00Z')).toEqual({ month: 'Jun', day: '07' });
  });

  it('falls back to an em-dash tile when unparseable/absent', () => {
    expect(calTileFor(null)).toEqual({ month: '—', day: '--' });
    expect(calTileFor('not a date')).toEqual({ month: '—', day: '--' });
  });
});

describe('invoiceStatusInfo', () => {
  it('maps each status to its friendly label + chip/row classes', () => {
    expect(invoiceStatusInfo('draft', null)).toEqual({ label: 'Draft', chipLabel: 'DRAFT', cssClass: 'draft', invClass: 'draft' });
    expect(invoiceStatusInfo('open', null)).toEqual({ label: 'Pending', chipLabel: 'PENDING', cssClass: 'pending', invClass: 'due' });
    expect(invoiceStatusInfo('paid', null)).toEqual({ label: 'Paid', chipLabel: 'PAID', cssClass: 'paid', invClass: '' });
    expect(invoiceStatusInfo('cancelled', null)).toEqual({ label: 'Cancelled', chipLabel: 'CANCELLED', cssClass: 'cancelled', invClass: '' });
  });

  it('covers the stamped states the retired 5-state enum could not spell (ADR-0002)', () => {
    // A quote is a proposal, not a bill: no due-row treatment, and its chip is
    // not the pending orange.
    expect(invoiceStatusInfo('quote', null)).toEqual({ label: 'Quote', chipLabel: 'QUOTE', cssClass: 'quote', invClass: 'draft' });
    // A genuinely $0 invoice is not "Paid": nothing was collected.
    expect(invoiceStatusInfo('zero', null)).toEqual({ label: 'Zero balance', chipLabel: 'ZERO', cssClass: 'zero', invClass: '' });
    // The stamp says redeemed directly; no redemption-time refinement needed.
    expect(invoiceStatusInfo('redeemed', null)).toEqual({ label: 'Redeemed', chipLabel: 'REDEEMED', cssClass: 'redeemed', invClass: 'credit' });
  });

  it('distinguishes redeemed vs unredeemed credit', () => {
    expect(invoiceStatusInfo('credit', null)).toEqual({ label: 'Credit', chipLabel: 'CREDIT', cssClass: 'creditc', invClass: 'credit' });
    // The fail-soft path: an unstamped doc can still say `credit` while
    // carrying a redemption time, and a spent credit must never be re-offered.
    expect(invoiceStatusInfo('credit', 1_750_000_000_000)).toEqual({
      label: 'Redeemed',
      chipLabel: 'REDEEMED',
      cssClass: 'redeemed',
      invClass: 'credit',
    });
  });
});

describe('creditTargetLabel', () => {
  // 'originalPaymentMethod' is deliberately absent: credits are NOT refundable,
  // so account balance is the only target the type permits.
  it.each([
    ['accountBalance', 'Saved to Account Balance'],
    [null, 'Redeemed'],
  ] as const)('%s -> %s', (target, expected) => {
    expect(creditTargetLabel(target)).toBe(expected);
  });
});
describe('part-paid rendering (the portal must not call it paid or unpaid)', () => {
  const partPaid = { partiallyPaid: true, paidCents: 2000, total: 40 };
  it('gives a part-paid invoice its own chip, distinct from PAID and from PENDING', () => {
    const info = partPaidStatusInfo();
    expect(info.chipLabel).toBe('PART PAID');
    expect(info.chipLabel).not.toBe(invoiceStatusInfo('paid', null).chipLabel);
    expect(info.chipLabel).not.toBe(invoiceStatusInfo('open', null).chipLabel);
  });
  it('keeps the open row treatment, so a part-paid invoice is still payable and still chased', () => {
    expect(partPaidStatusInfo().invClass).toBe(invoiceStatusInfo('open', null).invClass);
  });
  it('spells out both numbers rather than leaving the household to subtract', () => {
    expect(partPaidSummary(partPaid)).toBe('$20.00 of $40.00 paid');
  });
  it('says nothing at all when the invoice is not part-paid', () => {
    expect(partPaidSummary({ partiallyPaid: false, paidCents: 0, total: 40 })).toBeNull();
    // Not even when a stale paidCents is present without the flag.
    expect(partPaidSummary({ partiallyPaid: false, paidCents: 2000, total: 40 })).toBeNull();
  });
});
