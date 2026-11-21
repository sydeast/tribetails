import { describe, it, expect } from 'vitest';
import {
  bigTipConfirmLabel,
  creditOnTopNote,
  feeClause,
  feeOverPaymentError,
  tipNeedsConfirming,
} from './recordPaymentChecks';

describe('recordPaymentChecks (#1975)', () => {
  it('refuses only a fee larger than the payment', () => {
    expect(feeOverPaymentError(50000, 10000)).toBe(
      'A fee of $500.00 is more than the $100.00 payment it came out of. Check the fee.',
    );
    expect(feeOverPaymentError(10000, 10000)).toBeNull();
    expect(feeOverPaymentError(300, 10000)).toBeNull();
  });
  it('asks about a tip larger than the invoice total, and nothing else', () => {
    expect(tipNeedsConfirming(999978200, 21700)).toBe(true);
    expect(tipNeedsConfirming(21700, 21700)).toBe(false);
    expect(tipNeedsConfirming(500, 21700)).toBe(false);
    expect(tipNeedsConfirming(500, null)).toBe(false);
    expect(bigTipConfirmLabel(999978200, 21700)).toBe(
      "The $9,999,782.00 tip is right. It is more than this invoice's $217.00 total.",
    );
  });
  it('says where the fee comes from', () => {
    expect(feeClause(0, 0)).toBe('');
    expect(feeClause(271, 1000)).toBe(' (the $2.71 fee comes out of it)');
    expect(feeClause(300, 0)).toBe(' (the $3.00 fee comes out of the payment)');
  });
  it('says a credit is on top only when Payment amount is blank', () => {
    expect(creditOnTopNote(50000, 10000, false)).toBe(
      ' The $500.00 credit is on top of the $100.00 collected. If the household paid less, enter what they paid under Payment amount.',
    );
    expect(creditOnTopNote(50000, 10000, true)).toBe('');
    expect(creditOnTopNote(0, 10000, false)).toBe('');
  });
});
