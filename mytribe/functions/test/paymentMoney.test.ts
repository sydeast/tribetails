import { describe, it, expect } from 'vitest';
import {
  AMOUNT_SOURCES,
  TIP_BASES,
  TIP_BASIS_FIELD,
  centsToDollars,
  dollarsToCents,
  paymentMoneyOf,
  paymentOverApplied,
  paymentReconciles,
  readAmountSource,
  readTipBasis,
  resolveLedgerAmountCents,
} from '../src/lib/paymentMoney';

/**
 * The arithmetic behind the fee, and the marker that says which tip convention
 * a row follows.
 *
 * INVOICE #1029 IS THE ANCHOR CASE and appears in several of these on purpose:
 * it is real, it is the row the operator brought in, and it is the one that
 * could not be made to add up. Amount $137.50, Applied $127.50, Tip $7.29,
 * Balance $0.00, with $2.71 unaccounted for.
 */

describe('paymentMoneyOf: invoice #1029, the row the dropped fee ruined', () => {
  const input = {
    amountCents: 13750,
    // THE GROSS TIP. The legacy system stored 729, the net, and the fee that
    // would have recovered this number was dropped on the way in.
    tipCents: 1000,
    feeCents: 271,
    appliedCents: 12750,
    tipBasis: 'gross' as const,
  };

  it('closes the identity the operator could not check: amount = applied + tipGross', () => {
    const m = paymentMoneyOf(input);
    expect(m.appliedCents + m.tipCents + m.unappliedCents).toBe(m.amountCents);
    expect(m.unappliedCents).toBe(0);
  });

  it('derives the $7.29 the legacy system stored, instead of storing it', () => {
    expect(paymentMoneyOf(input).tipNetCents).toBe(729);
  });

  it('reports what she actually banks: the collection less the processor fee', () => {
    expect(paymentMoneyOf(input).proceedsCents).toBe(13479);
  });

  it('keeps the fee OUT of the household-facing identity', () => {
    // The client paid $137.50. The fee is a deduction from her proceeds, not
    // from what the household owed, so it must not move `applied` or
    // `unapplied` by a cent.
    const withFee = paymentMoneyOf(input);
    const withoutFee = paymentMoneyOf({ ...input, feeCents: 0 });
    expect(withFee.appliedCents).toBe(withoutFee.appliedCents);
    expect(withFee.unappliedCents).toBe(withoutFee.unappliedCents);
    expect(withFee.proceedsCents).not.toBe(withoutFee.proceedsCents);
  });
});

describe('paymentMoneyOf: the unapplied balance', () => {
  it('is what is left after the bill and the tip, the figure she checks before saving', () => {
    // $300 handed over, $180 applied to the one open invoice, $20 tip. $100 is
    // left, and Auto-apply is what decides that becomes account credit.
    const m = paymentMoneyOf({
      amountCents: 30000,
      tipCents: 2000,
      feeCents: 0,
      appliedCents: 18000,
      tipBasis: 'gross',
    });
    expect(m.appliedCents).toBe(18000);
    expect(m.unappliedCents).toBe(10000);
  });

  it('is the WHOLE payment when nothing is applied, which is the standalone row', () => {
    const m = paymentMoneyOf({
      amountCents: 4000,
      tipCents: 0,
      feeCents: 0,
      appliedCents: 0,
      tipBasis: 'gross',
    });
    expect(m.unappliedCents).toBe(4000);
  });

  it('goes NEGATIVE rather than clamping, so an over-application stays visible', () => {
    // The callable refuses to create this. A row already carrying it must not
    // render as though it balanced.
    const m = paymentMoneyOf({
      amountCents: 5000,
      tipCents: 0,
      feeCents: 0,
      appliedCents: 8000,
      tipBasis: 'gross',
    });
    expect(m.unappliedCents).toBe(-3000);
    expect(paymentOverApplied(m)).toBe(true);
  });

  it('counts a tip that swallows the whole payment as over-applied, not as zero', () => {
    const m = paymentMoneyOf({
      amountCents: 1000,
      tipCents: 1500,
      feeCents: 0,
      appliedCents: 0,
      tipBasis: 'gross',
    });
    expect(m.unappliedCents).toBe(-500);
    expect(paymentOverApplied(m)).toBe(true);
  });

  it('is not over-applied when it lands exactly on zero', () => {
    const m = paymentMoneyOf({
      amountCents: 4000,
      tipCents: 0,
      feeCents: 0,
      appliedCents: 4000,
      tipBasis: 'gross',
    });
    expect(paymentOverApplied(m)).toBe(false);
  });
});

describe('paymentMoneyOf: the net tip is derived only where it can be', () => {
  it('is null on an unknown basis, because subtracting a fee from a guess is a guess', () => {
    const m = paymentMoneyOf({
      amountCents: 13750,
      tipCents: 729,
      feeCents: 271,
      appliedCents: 0,
      tipBasis: 'unknown',
    });
    expect(m.tipNetCents).toBeNull();
  });

  it('is null on a net basis, because the fee is already out of it', () => {
    // Charging it twice would report a $4.58 tip on a $7.29 one.
    const m = paymentMoneyOf({
      amountCents: 13750,
      tipCents: 729,
      feeCents: 271,
      appliedCents: 0,
      tipBasis: 'net',
    });
    expect(m.tipNetCents).toBeNull();
  });

  it('goes negative when a fee exceeds a small tip, which really happens', () => {
    // A $0.50 tip on a $300 transfer does not cover a $2.71 fee. Reported, not
    // floored: she is out of pocket on that tip, and that is a fact for her
    // return.
    const m = paymentMoneyOf({
      amountCents: 30050,
      tipCents: 50,
      feeCents: 271,
      appliedCents: 0,
      tipBasis: 'gross',
    });
    expect(m.tipNetCents).toBe(-221);
  });
});

describe('paymentMoneyOf: broken inputs read as zero, never as NaN', () => {
  it('survives a non-numeric amount rather than propagating NaN onto a screen', () => {
    const m = paymentMoneyOf({
      amountCents: Number.NaN,
      tipCents: 0,
      feeCents: 0,
      appliedCents: 0,
      tipBasis: 'gross',
    });
    expect(m.amountCents).toBe(0);
    expect(m.unappliedCents).toBe(0);
  });

  it('reads a broken applied amount as no evidence, never as Infinity', () => {
    const m = paymentMoneyOf({
      amountCents: 4000,
      tipCents: 0,
      feeCents: 0,
      appliedCents: Number.POSITIVE_INFINITY,
      tipBasis: 'gross',
    });
    expect(m.appliedCents).toBe(0);
    expect(m.unappliedCents).toBe(4000);
  });

  it('survives a broken fee without corrupting the proceeds', () => {
    const m = paymentMoneyOf({
      amountCents: 4000,
      tipCents: 0,
      feeCents: Number.NaN,
      appliedCents: 0,
      tipBasis: 'gross',
    });
    expect(m.feeCents).toBe(0);
    expect(m.proceedsCents).toBe(4000);
  });
});

describe('readTipBasis: absence is UNKNOWN, never net', () => {
  it('reads the value this server writes', () => {
    expect(readTipBasis('gross')).toBe('gross');
  });

  it('reads a proven net basis, for an import that carries both numbers', () => {
    expect(readTipBasis('net')).toBe('net');
  });

  it('reads an ABSENT marker as unknown, not as net', () => {
    // The deliberate difference from createdAtSource, which defaults to 'live'.
    // There, absence was evidence: one import had ever run and it stamped
    // everything it touched. Here it is not. This collection was written by a
    // legacy migration, by stripeWebhook and by recordPayment before today, and
    // defaulting all of them to 'net' would state a fact nobody checked on the
    // exact field whose last unchecked assumption is the bug being fixed.
    expect(readTipBasis(undefined)).toBe('unknown');
    expect(readTipBasis(null)).toBe('unknown');
    expect(readTipBasis('')).toBe('unknown');
  });

  it('reads an UNRECOGNIZED marker as unknown rather than throwing', () => {
    // This runs inside ledger rendering. One malformed document must not blank
    // an operator's payment history.
    expect(readTipBasis('GROSS')).toBe('unknown');
    expect(readTipBasis('net-ish')).toBe('unknown');
    expect(readTipBasis(42)).toBe('unknown');
    expect(readTipBasis({ tipBasis: 'gross' })).toBe('unknown');
  });

  it('names the stored field once, so the writer and the readers cannot drift', () => {
    expect(TIP_BASIS_FIELD).toBe('tipBasis');
    expect(TIP_BASES).toEqual(['gross', 'net', 'unknown']);
  });
});

describe('paymentReconciles: which rows can be checked, and which must be marked', () => {
  it('is TRUE for a row this server wrote', () => {
    expect(paymentReconciles({ tipCents: 1000, tipBasis: 'gross' })).toBe(true);
  });

  it('is FALSE for a legacy tip of unrecorded basis, which is invoice #1029', () => {
    expect(paymentReconciles({ tipCents: 729, tipBasis: 'unknown' })).toBe(false);
  });

  it('is FALSE for a known-net tip, because the gross it came from is not on the row', () => {
    expect(paymentReconciles({ tipCents: 729, tipBasis: 'net' })).toBe(false);
  });

  it('is TRUE for any row with NO tip, whatever its basis says', () => {
    // Every Stripe row and every payment nobody tipped on. There is no
    // convention to be wrong about when the number is zero, and a caveat on all
    // of them is the noise that trains an operator to stop reading caveats.
    expect(paymentReconciles({ tipCents: 0, tipBasis: 'unknown' })).toBe(true);
    expect(paymentReconciles({ tipCents: 0, tipBasis: 'net' })).toBe(true);
  });

  it('treats a broken tip as no tip rather than as an unreconcilable one', () => {
    expect(paymentReconciles({ tipCents: Number.NaN, tipBasis: 'unknown' })).toBe(true);
  });
});

describe('readAmountSource: absence and garbage both read as null', () => {
  it('reads the three values stripeWebhook.ts writes', () => {
    expect(readAmountSource('stripe-event')).toBe('stripe-event');
    expect(readAmountSource('local-invoice')).toBe('local-invoice');
    expect(readAmountSource('unresolved')).toBe('unresolved');
    expect(AMOUNT_SOURCES).toEqual(['stripe-event', 'local-invoice', 'unresolved']);
  });

  it('reads an absent or unrecognized marker as null, not as a guess', () => {
    expect(readAmountSource(undefined)).toBeNull();
    expect(readAmountSource(null)).toBeNull();
    expect(readAmountSource('')).toBeNull();
    expect(readAmountSource('STRIPE-EVENT')).toBeNull();
    expect(readAmountSource(42)).toBeNull();
  });
});

describe('resolveLedgerAmountCents: the 100x defect, fixed in one place', () => {
  it('reads invoice #1029 correctly: a stripe-event row stores CENTS, not dollars', () => {
    // The live case from the bug report: $137.50 collected, stored as
    // `amount: 13750` (already cents) because Stripe's own event supplied it.
    // The old reader ran this through dollarsToCents and produced $13,750.00.
    const r = resolveLedgerAmountCents({ amount: 13750, amountSource: 'stripe-event' });
    expect(r).toEqual({ amountCents: 13750, resolved: true });
  });

  it('reads a local-invoice row as DOLLARS, the other branch stripeWebhook can take', () => {
    const r = resolveLedgerAmountCents({ amount: 30, amountSource: 'local-invoice' });
    expect(r).toEqual({ amountCents: 3000, resolved: true });
  });

  it('reads a row with NO amountSource as dollars too — every recordPayment.ts row, the only writer that never sets this marker', () => {
    const r = resolveLedgerAmountCents({ amount: 45.5 });
    expect(r).toEqual({ amountCents: 4550, resolved: true });
  });

  it('prefers a present, valid amountCents over BOTH branches — the modern-row case', () => {
    // Even a stripe-event row with a (wrong-looking) dollar-shaped `amount`
    // must not override a real, already-correct amountCents.
    const r = resolveLedgerAmountCents({ amount: 1, amountCents: 13750, amountSource: 'stripe-event' });
    expect(r).toEqual({ amountCents: 13750, resolved: true });
  });

  it('does NOT guess a number for an unresolved row: amountResolved false, not a plausible zero', () => {
    // amountSource: 'unresolved' rows carry amount: null on the doc. The old
    // reader ran null through dollarsToCents and silently produced $0.00 —
    // indistinguishable from a $0 payment. This must be reported as unresolved.
    const r = resolveLedgerAmountCents({ amount: null, amountSource: 'unresolved' });
    expect(r.resolved).toBe(false);
    expect(r.amountCents).toBe(0);
  });

  it('reports unresolved for a stripe-event row whose amount is not a usable number', () => {
    // A shape nothing in this codebase writes, but a reader that assumed a
    // number here and multiplied garbage by 1 would be trusting the same kind
    // of unchecked input that caused the original bug.
    expect(resolveLedgerAmountCents({ amountSource: 'stripe-event' }).resolved).toBe(false);
    expect(resolveLedgerAmountCents({ amount: 'oops', amountSource: 'stripe-event' }).resolved).toBe(
      false,
    );
  });

  it('reports unresolved for a dollars-branch row with no numeric amount at all', () => {
    expect(resolveLedgerAmountCents({}).resolved).toBe(false);
    expect(resolveLedgerAmountCents({ amountSource: 'local-invoice' }).resolved).toBe(false);
  });

  it('rejects a negative or non-integer amountCents rather than trusting a corrupt row', () => {
    // Falls through to the amountSource-driven read, same as if amountCents
    // were absent — a negative or fractional cents value is not "the truth
    // the writer computed", it's a shape nothing here ever wrote.
    const negative = resolveLedgerAmountCents({ amountCents: -5, amount: 30, amountSource: 'local-invoice' });
    expect(negative).toEqual({ amountCents: 3000, resolved: true });
    const fractional = resolveLedgerAmountCents({ amountCents: 12.5, amount: 30, amountSource: 'local-invoice' });
    expect(fractional).toEqual({ amountCents: 3000, resolved: true });
  });
});

describe('unit conversion rounds once, in one direction', () => {
  it('rounds dollars to cents exactly once', () => {
    expect(dollarsToCents(137.5)).toBe(13750);
    expect(dollarsToCents(2.71)).toBe(271);
    // The classic float: 0.1 + 0.2 is 0.30000000000000004 in dollars, 30 in cents.
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });

  it('floors a negative dollar amount at zero rather than storing a negative fee', () => {
    expect(dollarsToCents(-5)).toBe(0);
  });

  it('reads a non-number as no evidence', () => {
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents('137.50')).toBe(0);
    expect(dollarsToCents(Number.NaN)).toBe(0);
  });

  it('projects cents back to dollars without a trailing-precision tail', () => {
    expect(centsToDollars(13479)).toBe(134.79);
    expect(centsToDollars(271)).toBe(2.71);
    expect(centsToDollars(0)).toBe(0);
  });
});
