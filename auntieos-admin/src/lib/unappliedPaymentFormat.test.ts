import { describe, it, expect } from 'vitest';
import {
  decideLeadLine,
  decisionSavedNote,
  decisionSummaryLine,
  openInvoiceOptionLabel,
  parseDecisionForm,
  unappliedPaymentDetail,
  unappliedPaymentTitle,
  type DecisionFormInput,
} from './unappliedPaymentFormat';
import type {
  ListUnappliedPaymentsResultPayment,
  ResolveUnappliedPaymentResult,
} from '../contracts/invoiceContracts.generated';

const SEP_27 = new Date(2026, 8, 27, 12).getTime();

const payment: ListUnappliedPaymentsResultPayment = {
  paymentId: 'evt_1',
  kinfolkId: 'fam1',
  invoiceId: 'inv1',
  invoiceNumber: 'INV-1042',
  amountCents: 2500,
  amountResolved: true,
  feeCents: 103,
  reason: 'the invoice was already marked paid',
  receivedAtMs: SEP_27,
  referenceNumber: 'pi_1',
};
const openInvoices = [
  { invoiceId: 'inv2', invoiceNumber: 'INV-1050', amountDueCents: 4000 },
  { invoiceId: 'inv3', invoiceNumber: 'INV-1051', amountDueCents: 1200 },
];

function form(over: Partial<DecisionFormInput> = {}): DecisionFormInput {
  return { creditText: '', reasonText: '', applyInvoiceId: '', applyText: '', ...over };
}

function result(over: Partial<ResolveUnappliedPaymentResult> = {}): ResolveUnappliedPaymentResult {
  return {
    ok: true,
    paymentId: 'evt_1',
    kinfolkId: 'fam1',
    paymentCents: 2500,
    creditedCents: 1000,
    creditId: 'crd_1',
    appliedCents: 1500,
    appliedInvoiceId: 'inv2',
    appliedInvoiceNumber: 'INV-1050',
    appliedInvoiceState: 'settled',
    appliedInvoiceAmountDueCents: 0,
    keptCents: 0,
    newAccountBalanceCents: 3700,
    replayed: false,
    ...over,
  };
}

describe('unappliedPaymentFormat: the lines (#1003)', () => {
  it('writes the row, the lead line and the picker option in the spec words', () => {
    expect(unappliedPaymentTitle(payment)).toBe('$25.00 card payment on invoice INV-1042');
    expect(unappliedPaymentDetail(payment)).toBe(
      'Sep 27, 2026. Not applied because the invoice was already marked paid.',
    );
    expect(decideLeadLine(payment)).toBe(
      'Card payment of $25.00 on invoice INV-1042. There are no refunds. Anything you do not credit or apply stays recorded on the payment.',
    );
    expect(openInvoiceOptionLabel(openInvoices[0]!)).toBe('INV-1050, $40.00 due');
  });

  it('does not double the full stop when the reason already ends in one', () => {
    expect(unappliedPaymentDetail({ ...payment, reason: 'the invoice was void.' })).toBe(
      'Sep 27, 2026. Not applied because the invoice was void.',
    );
  });

  it('summarises the split live, and says nothing while it does not read or overflows', () => {
    expect(decisionSummaryLine(payment, '10', '15')).toBe('Credit $10.00, apply $15.00, keep $0.00.');
    expect(decisionSummaryLine(payment, '', '')).toBe('Credit $0.00, apply $0.00, keep $25.00.');
    expect(decisionSummaryLine(payment, 'abc', '')).toBeNull();
    expect(decisionSummaryLine(payment, '20', '10')).toBeNull();
  });
});

describe('unappliedPaymentFormat: parseDecisionForm (#1003)', () => {
  it('an empty form is the legal all-zero "keep it as recorded" decision', () => {
    expect(parseDecisionForm(payment, openInvoices, form())).toEqual({
      ok: true,
      payload: { creditCents: 0, creditReason: '', applyInvoiceId: '', applyCents: 0 },
      keptCents: 2500,
    });
  });

  it('builds integer cents with a trimmed reason and the chosen invoice', () => {
    expect(
      parseDecisionForm(
        payment,
        openInvoices,
        form({ creditText: '10', reasonText: '  Paid twice  ', applyInvoiceId: 'inv2', applyText: '15.00' }),
      ),
    ).toEqual({
      ok: true,
      payload: { creditCents: 1000, creditReason: 'Paid twice', applyInvoiceId: 'inv2', applyCents: 1500 },
      keptCents: 0,
    });
  });

  it('sends no reason without a credit, and no invoice without an applied amount', () => {
    const parsed = parseDecisionForm(
      payment,
      openInvoices,
      form({ creditText: '0', reasonText: 'typed anyway', applyInvoiceId: 'inv2', applyText: '' }),
    );
    expect(parsed).toEqual({
      ok: true,
      payload: { creditCents: 0, creditReason: '', applyInvoiceId: '', applyCents: 0 },
      keptCents: 2500,
    });
  });

  it('refuses what the server would refuse, in the spec words', () => {
    const err = (f: Partial<DecisionFormInput>) => {
      const r = parseDecisionForm(payment, openInvoices, form(f));
      return r.ok ? null : r.error;
    };
    expect(err({ creditText: '-1' })).toBe('Enter an amount in dollars, like 12.50.');
    expect(err({ creditText: '1.234' })).toBe('Enter an amount in dollars, like 12.50.');
    expect(err({ applyInvoiceId: 'inv2', applyText: 'ten' })).toBe('Enter an amount in dollars, like 12.50.');
    expect(err({ applyText: '5' })).toBe('Choose an invoice for the applied amount.');
    expect(err({ applyInvoiceId: 'inv3', applyText: '20' })).toBe('That invoice owes only $12.00.');
    expect(err({ creditText: '20', reasonText: 'x', applyInvoiceId: 'inv2', applyText: '10' })).toBe(
      'The credit and the applied amount add up to more than this payment.',
    );
    expect(err({ creditText: '5', reasonText: '   ' })).toBe('Enter a reason for the credit.');
  });

  it('an unresolved payment (amount 0) accepts only the all-zero decision', () => {
    const unresolved = { ...payment, amountCents: 0, amountResolved: false };
    expect(parseDecisionForm(unresolved, openInvoices, form()).ok).toBe(true);
    const r = parseDecisionForm(unresolved, openInvoices, form({ creditText: '1', reasonText: 'x' }));
    expect(r).toEqual({ ok: false, error: 'The credit and the applied amount add up to more than this payment.' });
  });
});

describe('unappliedPaymentFormat: decisionSavedNote (#1003)', () => {
  it('writes every sentence from the server answer', () => {
    expect(decisionSavedNote(result())).toBe(
      'Decision saved. $10.00 to account credit (balance now $37.00). $15.00 on invoice INV-1050 (paid in full). $0.00 kept on the payment.',
    );
  });

  it('names what is still due when the invoice is not settled', () => {
    expect(
      decisionSavedNote(
        result({ creditedCents: 0, appliedCents: 1500, appliedInvoiceState: 'partial', appliedInvoiceAmountDueCents: 1200, keptCents: 1000 }),
      ),
    ).toBe('Decision saved. $15.00 on invoice INV-1050 ($12.00 still due). $10.00 kept on the payment.');
  });

  it('keeps only the kept sentence for the all-zero decision', () => {
    expect(
      decisionSavedNote(
        result({ creditedCents: 0, appliedCents: 0, appliedInvoiceId: '', appliedInvoiceNumber: '', appliedInvoiceState: '', keptCents: 2500 }),
      ),
    ).toBe('Decision saved. $25.00 kept on the payment.');
  });
});
