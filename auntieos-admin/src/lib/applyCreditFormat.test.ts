import { describe, it, expect } from 'vitest';

import {
  applyCreditConfirmLine,
  availableCreditLine,
  creditAppliedNotice,
  invoiceWords,
  parseApplyCreditAmount,
} from './applyCreditFormat';

/**
 * #1872: the amount box for applying account credit to an invoice. The server
 * makes every one of these checks again; these are the words she reads beside
 * the field before the round trip.
 */
describe('parseApplyCreditAmount', () => {
  const limits = { availableCents: 12000, dueCents: 10000 };

  it('accepts an amount within both limits', () => {
    expect(parseApplyCreditAmount('25.00', limits)).toEqual({ ok: true, amountCents: 2500 });
    expect(parseApplyCreditAmount('25', limits)).toEqual({ ok: true, amountCents: 2500 });
  });

  it('accepts exactly what the invoice owes, and exactly what the household holds', () => {
    expect(parseApplyCreditAmount('100.00', limits)).toEqual({ ok: true, amountCents: 10000 });
    expect(parseApplyCreditAmount('50.00', { availableCents: 5000, dueCents: 10000 })).toEqual({
      ok: true,
      amountCents: 5000,
    });
  });

  it('refuses a blank box, text and more than two decimals', () => {
    for (const raw of ['', '   ', 'abc', '12.345', '1e3']) {
      expect(parseApplyCreditAmount(raw, limits), raw).toEqual({
        ok: false,
        error: 'Enter an amount in dollars, like 25.00.',
      });
    }
  });

  it('refuses zero', () => {
    expect(parseApplyCreditAmount('0', limits)).toEqual({ ok: false, error: 'Enter an amount above $0.00.' });
    expect(parseApplyCreditAmount('0.00', limits)).toEqual({ ok: false, error: 'Enter an amount above $0.00.' });
  });

  it('refuses a negative amount', () => {
    expect(parseApplyCreditAmount('-5', limits).ok).toBe(false);
  });

  it('refuses more than the household holds, and says how much that is', () => {
    expect(parseApplyCreditAmount('20.01', { availableCents: 2000, dueCents: 10000 })).toEqual({
      ok: false,
      error: 'This household has $20.00 of account credit. Enter that much or less.',
    });
  });

  it('refuses more than the invoice owes, and says how much that is', () => {
    expect(parseApplyCreditAmount('100.01', limits)).toEqual({
      ok: false,
      error: 'This invoice has $100.00 left to pay. Enter that much or less.',
    });
  });

  it('leaves the invoice limit to the server when the balance could not be read', () => {
    expect(parseApplyCreditAmount('110.00', { availableCents: 12000, dueCents: null })).toEqual({
      ok: true,
      amountCents: 11000,
    });
  });
});

describe('the words', () => {
  it('names the invoice by its number, never by a stored id', () => {
    expect(invoiceWords('1026')).toBe('invoice 1026');
    expect(invoiceWords('')).toBe('this invoice');
    expect(invoiceWords(null)).toBe('this invoice');
    expect(invoiceWords(undefined)).toBe('this invoice');
  });

  it('the confirmation states the amount, the invoice and both balances afterwards', () => {
    expect(
      applyCreditConfirmLine({ amountCents: 2500, invoiceNumber: '1026', availableCents: 12000, dueCents: 10000 }),
    ).toBe(
      'Apply $25.00 of account credit to invoice 1026? The invoice will have $75.00 left to pay. The household keeps $95.00 of credit.',
    );
  });

  it('the confirmation says the invoice will be paid when the amount covers it', () => {
    expect(
      applyCreditConfirmLine({ amountCents: 10000, invoiceNumber: '1026', availableCents: 12000, dueCents: 10000 }),
    ).toBe(
      'Apply $100.00 of account credit to invoice 1026? The invoice will be paid. The household keeps $20.00 of credit.',
    );
  });

  it('the confirmation makes no claim about a balance it could not read', () => {
    expect(
      applyCreditConfirmLine({ amountCents: 2500, invoiceNumber: '', availableCents: 12000, dueCents: null }),
    ).toBe('Apply $25.00 of account credit to this invoice? The household keeps $95.00 of credit.');
  });

  it('the notice afterwards repeats the server figures', () => {
    expect(
      creditAppliedNotice({ appliedCents: 2500, amountDueCents: 7500, accountBalanceCents: 9500, invoiceNumber: '1026' }),
    ).toBe('Applied $25.00 of account credit to invoice 1026. $75.00 is left to pay. The household has $95.00 of credit left.');
    expect(
      creditAppliedNotice({ appliedCents: 10000, amountDueCents: 0, accountBalanceCents: 2000, invoiceNumber: '1026' }),
    ).toBe('Applied $100.00 of account credit to invoice 1026. The invoice is paid. The household has $20.00 of credit left.');
  });

  it('says what is available, or that there is none', () => {
    expect(availableCreditLine(1200)).toBe('$12.00 available');
    expect(availableCreditLine(0)).toBe('This household has no account credit.');
  });
});
