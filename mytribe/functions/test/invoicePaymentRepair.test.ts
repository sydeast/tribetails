import { describe, it, expect } from 'vitest';
import {
  repairPlanFor,
  isRepairPlan,
  claimedAmountDueCentsOf,
  type RepairInvoiceDoc,
} from '../src/lib/invoicePaymentRepair';
import type { PaymentAmount } from '../src/lib/invoiceMath';

/**
 * THE CORRUPT FIXTURE, exactly as the pre-2026-07-25 write left it: a $40
 * invoice reading `paid` with `amountDue: 0`, over a payments subcollection that
 * records only $20. Every "fixes a corrupt fixture" test below starts here.
 */
const CORRUPT: RepairInvoiceDoc = {
  status: 'paid',
  paymentStatus: 'PAID',
  amountDue: 0,
  total: 40,
  invoiceNumber: 'INV-9',
  kinfolkId: 'fam1',
};
const HALF_PAID: PaymentAmount[] = [{ amount: 20 }];

function planOf(doc: RepairInvoiceDoc, payments: PaymentAmount[] = HALF_PAID) {
  return repairPlanFor('inv1', doc, payments);
}

describe('claimedAmountDueCentsOf', () => {
  it('prefers the integer field over the float dollar one', () => {
    expect(claimedAmountDueCentsOf({ amountDueCents: 2000, amountDue: 0 })).toBe(2000);
  });

  it('projects the dollar field on a doc that predates the integer one', () => {
    expect(claimedAmountDueCentsOf({ amountDue: 20 })).toBe(2000);
  });

  it('reads a doc with neither field as claiming nothing is owed', () => {
    expect(claimedAmountDueCentsOf({})).toBe(0);
  });
});

describe('repairPlanFor finds the corruption', () => {
  it('detects the reported shape and reconstructs the real balance from the payments', () => {
    const outcome = planOf(CORRUPT);
    expect(isRepairPlan(outcome)).toBe(true);
    const plan = outcome as Extract<typeof outcome, { finding: unknown }>;
    expect(plan.finding.totalCents).toBe(4000);
    expect(plan.finding.paidCents).toBe(2000);
    expect(plan.finding.claimedAmountDueCents).toBe(0);
    expect(plan.finding.correctAmountDueCents).toBe(2000);
    expect(plan.finding.understatedCents).toBe(2000);
  });

  it('re-opens the invoice with a real dollar balance so it returns to Outstanding', () => {
    const plan = planOf(CORRUPT) as Extract<ReturnType<typeof planOf>, { finding: unknown }>;
    expect(plan.update.status).toBe('open');
    expect(plan.update.amountDue).toBe(20);
    expect(plan.update.amountDueCents).toBe(2000);
    expect(plan.update.paidCents).toBe(2000);
    expect(plan.update.totalCents).toBe(4000);
    expect(plan.update.partialPaymentRepairedAt).toBeTypeOf('string');
  });

  it('carries the state stamp (ADR-0002): a repaired invoice is open and fully editable', () => {
    // Every plan is by construction a part-paid open invoice, and part-paid
    // stays fully editable (the 2026-07-25 rule this whole module serves).
    const plan = planOf(CORRUPT) as Extract<ReturnType<typeof planOf>, { finding: unknown }>;
    expect(plan.update.status).toBe('open');
    expect(plan.update.editScope).toBe('all');
  });

  it('keeps the paidAt/paidBy history rather than tidying away evidence of how it happened', () => {
    const plan = planOf(CORRUPT) as Extract<ReturnType<typeof planOf>, { finding: unknown }>;
    expect(plan.update).not.toHaveProperty('paidAt');
    expect(plan.update).not.toHaveProperty('paidBy');
  });

  it('DETECTS BY ARITHMETIC, so an unenforced status casing cannot hide a casualty', () => {
    // `status` casing is unenforced across this collection. A detector keyed on
    // status === 'paid' would silently skip every one of these.
    for (const status of ['Paid', 'PAID', ' paid ', '', undefined]) {
      const outcome = planOf({ ...CORRUPT, status });
      expect(isRepairPlan(outcome)).toBe(true);
    }
  });

  it('detects a doc carrying totalCents instead of a dollar total', () => {
    const outcome = planOf({ ...CORRUPT, total: undefined, totalCents: 4000 });
    expect(isRepairPlan(outcome)).toBe(true);
  });

  it('sums a multi-payment subcollection rather than reading only the last one', () => {
    const plan = planOf({ ...CORRUPT, total: 100 }, [
      { amount: 20 },
      { amount: 30, amountCents: 3000 },
    ]) as Extract<ReturnType<typeof planOf>, { finding: unknown }>;
    expect(plan.finding.paidCents).toBe(5000);
    expect(plan.finding.correctAmountDueCents).toBe(5000);
  });
});

describe('repairPlanFor leaves everything else alone', () => {
  it('is a NO-OP on a healthy paid invoice whose payments cover it', () => {
    const outcome = planOf({ ...CORRUPT, total: 40 }, [{ amount: 40 }]);
    expect(isRepairPlan(outcome)).toBe(false);
    expect(outcome).toEqual({ skipped: 'payments_cover_total' });
  });

  it('is a NO-OP on a healthy open invoice that nobody has paid', () => {
    const outcome = planOf({ status: 'open', amountDue: 40, total: 40 }, []);
    expect(outcome).toEqual({ skipped: 'no_payments' });
  });

  it('leaves a paid invoice with NO recorded payments alone rather than inventing a debt', () => {
    // stripeWebhook.ts records card payments into the ROOT `payments`
    // collection, not this subcollection, so a genuinely card-paid invoice sums
    // to zero here. Re-opening it would bill a household that already paid.
    const outcome = planOf({ ...CORRUPT }, []);
    expect(outcome).toEqual({ skipped: 'no_payments' });
  });

  it('reports an invoice with no total rather than assuming one', () => {
    const outcome = planOf({ status: 'paid', amountDue: 0 }, HALF_PAID);
    expect(outcome).toEqual({ skipped: 'no_total' });
  });

  it('IS IDEMPOTENT: the output of a repair is no longer a candidate', () => {
    const first = planOf(CORRUPT) as Extract<ReturnType<typeof planOf>, { finding: unknown }>;
    // Feed the repaired doc straight back in, exactly as a second pass would
    // read it out of Firestore.
    const repaired: RepairInvoiceDoc = { ...CORRUPT, ...(first.update as RepairInvoiceDoc) };
    const second = planOf(repaired);
    expect(isRepairPlan(second)).toBe(false);
    expect(second).toEqual({ skipped: 'balance_already_correct' });
  });

  it('NEVER LOWERS A BALANCE: an overstated claim is reported, not silently reduced', () => {
    // The doc says $40 is owed; the payments say $20 is. Correcting downward
    // would forgive $20 of a real debt on the strength of arithmetic nobody has
    // reviewed, so the pass declines to touch it.
    const outcome = planOf({ status: 'open', amountDue: 40, total: 40 }, [{ amount: 20 }]);
    expect(isRepairPlan(outcome)).toBe(false);
    expect(outcome).toEqual({ skipped: 'would_lower_balance' });
  });

  it('never produces an update that reduces what is owed, across a sweep of shapes', () => {
    const shapes: Array<[RepairInvoiceDoc, PaymentAmount[]]> = [
      [CORRUPT, HALF_PAID],
      [{ ...CORRUPT, amountDue: 5 }, HALF_PAID],
      [{ ...CORRUPT, total: 100 }, [{ amount: 99 }]],
      [{ ...CORRUPT, amountDue: 39 }, HALF_PAID],
    ];
    for (const [doc, payments] of shapes) {
      const outcome = repairPlanFor('inv1', doc, payments);
      if (!isRepairPlan(outcome)) continue;
      expect(outcome.finding.correctAmountDueCents).toBeGreaterThan(outcome.finding.claimedAmountDueCents);
      expect(outcome.update.amountDueCents as number).toBeGreaterThanOrEqual(0);
    }
  });
});
