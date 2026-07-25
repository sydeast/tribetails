import { describe, it, expect } from 'vitest';
import {
  lineAmountCents,
  computeInvoiceTotals,
  centsToDollars,
  paidCentsFromPayments,
  validateInvoiceMoney,
  invoiceTotalCentsOf,
  settleInvoice,
  isPartiallyPaid,
  type InvoiceLineItemInput,
} from '../src/lib/invoiceMath';

function line(over: Partial<InvoiceLineItemInput> = {}): InvoiceLineItemInput {
  return { description: 'Dog walking', qty: 1, unitCents: 2500, ...over };
}

describe('lineAmountCents', () => {
  it('multiplies qty by unitCents and returns an integer count of cents', () => {
    expect(lineAmountCents(line({ qty: 3, unitCents: 2500 }))).toBe(7500);
  });

  it('subtracts a per-line discount', () => {
    expect(lineAmountCents(line({ qty: 2, unitCents: 2500, discountCents: 500 }))).toBe(4500);
  });

  it('is exact where the equivalent float-dollar arithmetic is not', () => {
    // $10.10 x 3. In dollars this is 30.299999999999997, which is the whole
    // reason this module counts cents.
    expect(lineAmountCents(line({ qty: 3, unitCents: 1010 }))).toBe(3030);
    expect(10.1 * 3).not.toBe(30.3);
  });

  it('rounds a fractional qty half-up, once, at the line', () => {
    // 1.5 hours at $0.01 = 1.5 cents.
    expect(lineAmountCents(line({ qty: 1.5, unitCents: 1 }))).toBe(2);
    // 0.005 x $1.00 = 0.5 cents.
    expect(lineAmountCents(line({ qty: 0.005, unitCents: 100 }))).toBe(1);
    // 2.5 hours at $30.00/hr, a real fractional-visit case.
    expect(lineAmountCents(line({ qty: 2.5, unitCents: 3000 }))).toBe(7500);
  });

  it('reads a non-finite qty or unit price as no evidence, never as NaN', () => {
    // Matches lib/invoiceFormat.ts's financeNumber: a broken number must not
    // propagate into a total that then renders "$NaN" on an operator's screen.
    expect(lineAmountCents(line({ qty: Number.NaN }))).toBe(0);
    expect(lineAmountCents(line({ unitCents: Number.POSITIVE_INFINITY }))).toBe(0);
  });
});

describe('computeInvoiceTotals', () => {
  it('sums line amounts exactly where summing float dollars would not', () => {
    // $0.10 + $0.20. In dollars that is 0.30000000000000004.
    const totals = computeInvoiceTotals([line({ unitCents: 10 }), line({ unitCents: 20 })], 0, 0);
    expect(totals.subtotalCents).toBe(30);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('returns all zeros for an invoice with no lines', () => {
    expect(computeInvoiceTotals([], 0, 0)).toEqual({
      subtotalCents: 0,
      totalCents: 0,
      paidCents: 0,
      amountDueCents: 0,
    });
  });

  it('applies the whole-invoice discount after the line subtotal', () => {
    const totals = computeInvoiceTotals([line({ qty: 4, unitCents: 2500 })], 1000, 0);
    expect(totals.subtotalCents).toBe(10000);
    expect(totals.totalCents).toBe(9000);
  });

  it('subtracts payments to reach amountDue', () => {
    const totals = computeInvoiceTotals([line({ qty: 4, unitCents: 2500 })], 0, 4000);
    expect(totals.totalCents).toBe(10000);
    expect(totals.paidCents).toBe(4000);
    expect(totals.amountDueCents).toBe(6000);
  });

  it('reports a negative total honestly rather than clamping it at zero', () => {
    // An over-large discount is an operator error. validateInvoiceMoney refuses
    // it; the math itself must not quietly floor it, which would hide the error
    // behind a plausible looking $0.00.
    const totals = computeInvoiceTotals([line({ unitCents: 1000 })], 2500, 0);
    expect(totals.totalCents).toBe(-1500);
  });

  it('reports overpayment as a negative amountDue rather than zero', () => {
    const totals = computeInvoiceTotals([line({ unitCents: 1000 })], 0, 2500);
    expect(totals.amountDueCents).toBe(-1500);
  });
});

describe('paidCentsFromPayments', () => {
  it('converts each dollar-denominated payment to cents and sums exactly', () => {
    // The payments subcollection stores DOLLARS (markInvoicePaid.ts writes
    // `amount` straight from the callable arg), so each one is rounded to cents
    // on the way in and only then added.
    expect(paidCentsFromPayments([{ amount: 10.1 }, { amount: 20.2 }])).toBe(3030);
  });

  it('ignores a payment whose amount is missing or non-numeric', () => {
    expect(paidCentsFromPayments([{ amount: 5 }, {}, { amount: Number.NaN }])).toBe(500);
  });

  it('is zero for no payments', () => {
    expect(paidCentsFromPayments([])).toBe(0);
  });
});

describe('centsToDollars', () => {
  it('projects cents onto the legacy dollar scalar', () => {
    expect(centsToDollars(3030)).toBe(30.3);
    expect(centsToDollars(0)).toBe(0);
    expect(centsToDollars(-1500)).toBe(-15);
  });

  it('never yields more than two decimal places', () => {
    expect(centsToDollars(1)).toBe(0.01);
    expect(centsToDollars(999999)).toBe(9999.99);
  });
});

describe('validateInvoiceMoney', () => {
  it('accepts a well-formed set of lines', () => {
    expect(validateInvoiceMoney([line()], 0)).toBeNull();
  });

  it('refuses a discount larger than the subtotal, naming both numbers', () => {
    const err = validateInvoiceMoney([line({ unitCents: 1000 })], 2500);
    expect(err).not.toBeNull();
    expect(err).toContain('25.00');
    expect(err).toContain('10.00');
  });

  it('refuses a per-line discount larger than that line', () => {
    expect(validateInvoiceMoney([line({ qty: 1, unitCents: 1000, discountCents: 1500 })], 0)).toContain(
      'Dog walking',
    );
  });

  it('refuses a non-positive qty', () => {
    expect(validateInvoiceMoney([line({ qty: 0 })], 0)).not.toBeNull();
    expect(validateInvoiceMoney([line({ qty: -1 })], 0)).not.toBeNull();
  });

  it('refuses a non-integer unitCents, which would reintroduce fractional cents', () => {
    expect(validateInvoiceMoney([line({ unitCents: 10.5 })], 0)).not.toBeNull();
  });

  it('refuses a blank description', () => {
    expect(validateInvoiceMoney([line({ description: '   ' })], 0)).not.toBeNull();
  });
});
describe('paidCentsFromPayments prefers the integer field', () => {
  it('uses amountCents when present, so no dollar rounding is re-applied', () => {
    expect(paidCentsFromPayments([{ amount: 20, amountCents: 2000 }])).toBe(2000);
  });
  it('falls back to the dollar amount on payments recorded before amountCents existed', () => {
    expect(paidCentsFromPayments([{ amount: 20 }, { amount: 0.1 }])).toBe(2010);
  });
  it('rounds each dollar payment to cents individually rather than summing floats first', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in float dollars. Rounded per row it is
    // exactly 30 cents, which is the whole reason this module is cents-first.
    expect(paidCentsFromPayments([{ amount: 0.1 }, { amount: 0.2 }])).toBe(30);
  });
  it('ignores a row carrying no usable amount rather than reading it as zero-and-valid', () => {
    expect(paidCentsFromPayments([{ amount: 20 }, {}, { amount: Number.NaN }])).toBe(2000);
  });
});
describe('invoiceTotalCentsOf', () => {
  it('prefers the stored integer totalCents', () => {
    expect(invoiceTotalCentsOf({ totalCents: 4000, total: 39.99 })).toBe(4000);
  });
  it('projects the float dollar total for an invoice that was never itemized', () => {
    expect(invoiceTotalCentsOf({ total: 40 })).toBe(4000);
    expect(invoiceTotalCentsOf({ total: 10.1 })).toBe(1010);
  });
  it('reads an invoice carrying neither field as 0, which refuses a payment rather than inventing one', () => {
    expect(invoiceTotalCentsOf({})).toBe(0);
    expect(invoiceTotalCentsOf({ total: Number.NaN })).toBe(0);
  });
});
describe('settleInvoice', () => {
  it('reads an untouched invoice as unpaid with the whole total owing', () => {
    const s = settleInvoice(4000, 0);
    expect(s.state).toBe('unpaid');
    expect(s.amountDueCents).toBe(4000);
    expect(s.overpaidCents).toBe(0);
  });
  it('THE BUG: $20 against a $40 invoice is partial, with $20 still owed', () => {
    const s = settleInvoice(4000, 2000);
    expect(s.state).toBe('partial');
    expect(s.amountDueCents).toBe(2000);
    expect(isPartiallyPaid(s)).toBe(true);
  });
  it('settles on an exact payoff', () => {
    const s = settleInvoice(4000, 4000);
    expect(s.state).toBe('settled');
    expect(s.amountDueCents).toBe(0);
    expect(s.overpaidCents).toBe(0);
    expect(isPartiallyPaid(s)).toBe(false);
  });
  it('CLAMPS AN OVERPAYMENT AT ZERO and reports the excess separately', () => {
    // A negative amountDue is this codebase's CREDIT signal. If an overpayment
    // wrote one, a household who rounded $39.50 up to $40 would have minted
    // themselves a credit with its own redemption flow. The excess is reported,
    // never converted.
    const s = settleInvoice(3950, 4000);
    expect(s.state).toBe('overpaid');
    expect(s.amountDueCents).toBe(0);
    expect(s.amountDueCents).toBeGreaterThanOrEqual(0);
    expect(s.overpaidCents).toBe(50);
  });
  it('reads money against a zero-total invoice as overpaid, not settled', () => {
    const s = settleInvoice(0, 500);
    expect(s.state).toBe('overpaid');
    expect(s.overpaidCents).toBe(500);
  });
  it('never returns a negative amountDueCents for any input', () => {
    for (const [total, paid] of [[4000, 9999], [0, 1], [-500, 100], [100, 100]]) {
      expect(settleInvoice(total, paid).amountDueCents).toBeGreaterThanOrEqual(0);
    }
  });
  it('reads non-finite figures as no evidence rather than propagating NaN into money', () => {
    const s = settleInvoice(Number.NaN, Number.NaN);
    expect(Number.isNaN(s.amountDueCents)).toBe(false);
    expect(s.state).toBe('unpaid');
  });
});
