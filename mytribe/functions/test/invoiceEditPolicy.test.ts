import { describe, it, expect } from 'vitest';
import {
  invoiceStateOf,
  invoiceEditScope,
  invoiceEditRefusal,
  paymentStandingOf,
  quoteAcceptanceOf,
  INVOICE_STATES,
  type InvoiceState,
  type InvoicePaymentStanding,
  type QuoteAcceptance,
} from '../src/lib/invoiceEditPolicy';

const STANDINGS: InvoicePaymentStanding[] = ['none', 'partial', 'settled'];
const ACCEPTANCES: QuoteAcceptance[] = ['undecided', 'accepted', 'denied'];

/**
 * #884: the invoice trigger decides "payment applied" from this classifier, so
 * every state it can return is pinned here, with the doc shapes that reach it.
 */
describe('invoiceStateOf table (#884)', () => {
  const TABLE: Array<[InvoiceState, Record<string, unknown>, string]> = [
    ['quote', { status: 'quote' }, 'an amount-less quote'],
    ['quote', { status: 'QUOTE', amountDue: 0, total: 0 }, 'a $0 quote, any case'],
    ['draft', { status: 'draft', amountDue: 40, total: 40 }, 'a draft with a balance'],
    ['draft', { status: 'draft', amountDue: 0, total: 0 }, 'a $0 draft'],
    ['cancelled', { status: 'cancelled', amountDue: 0, total: 40 }, 'a cancelled bill'],
    ['credit', { amountDue: -25, total: -25 }, 'an unlabeled negative balance'],
    ['credit', { status: 'open', amountDue: -25, total: -25 }, 'a negative balance labelled open'],
    ['credit', { status: 'credit', amountDue: 25 }, 'a credit label on a positive amount'],
    ['redeemed', { status: 'credit', amountDue: -25, total: -25, creditRedeemedAt: 'ts' }, 'a redeemed credit'],
    ['redeemed', { status: 'redeemed', amountDue: -25, creditRedeemedAt: 'ts' }, 'its own stamp'],
    ['paid', { status: 'paid', amountDue: 0, total: 40 }, 'a paid label'],
    ['paid', { status: 'paid', amountDue: 20, total: 40 }, 'a paid label on a part-paid bill (the corruption)'],
    ['paid', { status: 'open', amountDue: 0, total: 40 }, 'an open label with nothing left due'],
    ['paid', { status: 'paid', total: 40 }, 'a paid label with no amountDue: the rule reads nothing owed'],
    ['zero', { status: 'open', amountDue: 0, total: 0 }, 'a $0 comped invoice'],
    ['zero', {}, 'a doc with no fields'],
    ['open', { status: 'open', amountDue: 40, total: 40 }, 'an open bill'],
    ['open', { status: 'overdue', amountDue: 40, total: 40 }, 'an overdue label with a balance'],
    // #902. This row used to read `paid`: a missing balance was 0, so a migrated
    // bill classified settled while onInvoiceAutoApply drew credit against it.
    ['open', { status: 'overdue', total: 40 }, 'a total with no amountDue: the rule says the total is owed'],
    ['open', { status: 'sent', totalCents: 4000 }, 'totalCents alone, which used to classify zero'],
  ];

  it('covers every state the classifier can return', () => {
    expect(new Set(TABLE.map(([s]) => s))).toEqual(new Set(INVOICE_STATES));
  });

  for (const [state, doc, why] of TABLE) {
    it(`${state}: ${why}`, () => {
      expect(invoiceStateOf(doc)).toBe(state);
    });
  }

  it('an explicit paid label wins over a positive balance', () => {
    expect(invoiceStateOf({ status: 'paid ', amountDue: 40, total: 40 })).toBe('paid');
  });
});

describe('invoiceStateOf (server-side twin of the admin lib/invoiceFormat.ts enumerator)', () => {
  it('reads an explicit status first, case-insensitively and trimmed', () => {
    expect(invoiceStateOf({ status: ' QUOTE ' })).toBe('quote');
    expect(invoiceStateOf({ status: 'Draft' })).toBe('draft');
    expect(invoiceStateOf({ status: 'cancelled' })).toBe('cancelled');
    expect(invoiceStateOf({ status: 'paid' })).toBe('paid');
  });

  it('treats a negative balance as a credit even with no label', () => {
    expect(invoiceStateOf({ status: '', amountDue: -25, total: -25 })).toBe('credit');
    expect(invoiceStateOf({ status: '', amountDue: 0, total: -25 })).toBe('credit');
  });

  it('splits credit from redeemed on creditRedeemedAt', () => {
    expect(invoiceStateOf({ status: 'credit', creditRedeemedAt: 'anything' })).toBe('redeemed');
    expect(invoiceStateOf({ status: 'credit' })).toBe('credit');
  });

  it("reads 'redeemed' as a credit-FAMILY label, added 2026-07-28 for the state stamp", () => {
    // The stamp writes this module's own output back into `status`, so
    // `redeemed` has to classify as itself even when the money does not
    // independently signal credit (the positive-amountDue credit that
    // redeemCredit's guard allows through).
    expect(invoiceStateOf({ status: 'redeemed', amountDue: 5, creditRedeemedAt: 'anything' })).toBe(
      'redeemed',
    );
    // A family label, not a state assertion: with no redemption stamp there is
    // no evidence of a redemption, and the honest reading is credit.
    expect(invoiceStateOf({ status: 'redeemed', amountDue: 5 })).toBe('credit');
  });

  it('classifies an unlabeled row from its money, positively', () => {
    expect(invoiceStateOf({ status: '', amountDue: 40, total: 40 })).toBe('open');
    expect(invoiceStateOf({ status: '', amountDue: 0, total: 0 })).toBe('zero');
    expect(invoiceStateOf({ status: '', amountDue: 0, total: 40 })).toBe('paid');
  });

  it('survives a document with no status and no money fields at all', () => {
    // A doc predating these fields must not throw: reading one blind is what
    // blanked the whole admin invoices page over a single bad row (AO-12 notes).
    expect(invoiceStateOf({})).toBe('zero');
  });

  it('reads a non-finite amount as no evidence rather than as a real zero', () => {
    expect(invoiceStateOf({ status: '', amountDue: Number.NaN, total: Number.NaN })).toBe('zero');
  });
});

describe('paymentStandingOf (the third state, added 2026-07-25)', () => {
  it('reads nothing collected as none', () => {
    expect(paymentStandingOf(4000, 0)).toBe('none');
  });

  it('reads money that does not cover the total as partial', () => {
    expect(paymentStandingOf(4000, 2000)).toBe('partial');
    // One cent short is still short. The boundary is not "roughly settled".
    expect(paymentStandingOf(4000, 3999)).toBe('partial');
  });

  it('reads an exact payoff as settled', () => {
    expect(paymentStandingOf(4000, 4000)).toBe('settled');
  });

  it('reads an overpayment as settled, never as partial', () => {
    expect(paymentStandingOf(4000, 4500)).toBe('settled');
  });

  it('reads a negative or nonsense paid figure as none rather than as evidence', () => {
    expect(paymentStandingOf(4000, -100)).toBe('none');
    expect(paymentStandingOf(4000, Number.NaN)).toBe('none');
  });
});

describe('invoiceEditScope', () => {
  it('lets a draft or a quote be edited completely', () => {
    expect(invoiceEditScope('draft', 'none', 'undecided')).toBe('all');
    expect(invoiceEditScope('quote', 'none', 'undecided')).toBe('all');
    // A draft cannot have payments, but the answer must not depend on that.
    expect(invoiceEditScope('draft', 'settled', 'undecided')).toBe('all');
  });

  it('lets a sent-but-unpaid invoice be corrected completely', () => {
    // Correcting an invoice you have already sent, before anyone pays it, is
    // ordinary practice. Freezing it here would push the operator into
    // cancel-and-reissue for a typo.
    expect(invoiceEditScope('open', 'none', 'undecided')).toBe('all');
    expect(invoiceEditScope('zero', 'none', 'undecided')).toBe('all');
  });

  it('KEEPS A PART-PAID INVOICE FULLY EDITABLE', () => {
    // The 2026-07-25 change. Freezing the money on the first payment of any
    // size is the second half of the defect that made a part-collected balance
    // unrecoverable: markInvoicePaid refused the balance, and this refused the
    // correction. A part-collected bill is the one an operator most needs to be
    // able to fix.
    expect(invoiceEditScope('open', 'partial', 'undecided')).toBe('all');
    expect(invoiceEditScope('zero', 'partial', 'undecided')).toBe('all');
  });

  it('freezes the money only once the invoice is settled, and still allows metadata', () => {
    expect(invoiceEditScope('open', 'settled', 'undecided')).toBe('metadataOnly');
    expect(invoiceEditScope('zero', 'settled', 'undecided')).toBe('metadataOnly');
  });

  it('refuses every edit once the money has settled or been withdrawn', () => {
    expect(invoiceEditScope('paid', 'none', 'undecided')).toBe('none');
    expect(invoiceEditScope('paid', 'settled', 'undecided')).toBe('none');
    expect(invoiceEditScope('cancelled', 'none', 'undecided')).toBe('none');
    expect(invoiceEditScope('credit', 'none', 'undecided')).toBe('none');
    expect(invoiceEditScope('redeemed', 'none', 'undecided')).toBe('none');
  });

  it('re-opens a doc LABELLED paid whose payments fall short, so the corruption is repairable', () => {
    // The exact shape the pre-fix write produced: status 'paid' over a
    // subcollection that only half covers the total. Freezing it on the label
    // is what left it beyond repair from every direction at once.
    expect(invoiceEditScope('paid', 'partial', 'undecided')).toBe('all');
  });

  it('is total: every enumerated state has an answer for every standing and answer', () => {
    for (const state of INVOICE_STATES) {
      for (const standing of STANDINGS) {
        for (const acceptance of ACCEPTANCES) {
          expect(['all', 'metadataOnly', 'none']).toContain(
            invoiceEditScope(state, standing, acceptance),
          );
        }
      }
    }
  });
  // ISSUE #448. The operator ruling of 2026-08-18: a quote is editable until it
  // is ACCEPTED, and a DECLINED one stays editable so it can be revised and
  // sent back out. Before the fix `editScope` was 'all' in every quote state,
  // including after the household had agreed to the figure.
  it('FREEZES A QUOTE THE HOUSEHOLD HAS ACCEPTED', () => {
    // 'open' is the state an accepted quote actually lands in: acceptQuote
    // re-stamps it, which is what makes the portal's Pay button appear. Without
    // the acceptance dimension this reads 'all', exactly like any other sent
    // invoice, and the agreed figure is editable.
    expect(invoiceEditScope('open', 'none', 'accepted')).toBe('none');
    expect(invoiceEditScope('zero', 'none', 'accepted')).toBe('none');
    expect(invoiceEditScope('open', 'settled', 'accepted')).toBe('none');
  });
  it('leaves a DECLINED quote fully editable, because revising it is the next step', () => {
    expect(invoiceEditScope('quote', 'none', 'denied')).toBe('all');
    expect(invoiceEditScope('quote', 'none', 'undecided')).toBe('all');
  });
  it('lets the repair doctrine outrank the acceptance lock on a PART-PAID invoice', () => {
    // A part-collected bill is the one an operator most needs to be able to
    // correct, and it does not stop being that because the household accepted
    // the quote it grew out of.
    expect(invoiceEditScope('open', 'partial', 'accepted')).toBe('all');
    expect(invoiceEditScope('paid', 'partial', 'accepted')).toBe('all');
  });
});
describe('quoteAcceptanceOf', () => {
  it('reads the two values the decision callables write, and nothing else', () => {
    expect(quoteAcceptanceOf({ quoteDecision: 'accepted' })).toBe('accepted');
    expect(quoteAcceptanceOf({ quoteDecision: 'denied' })).toBe('denied');
  });
  it('reads an absent, null or unrecognized answer as undecided', () => {
    expect(quoteAcceptanceOf({})).toBe('undecided');
    expect(quoteAcceptanceOf({ quoteDecision: null })).toBe('undecided');
    expect(quoteAcceptanceOf({ quoteDecision: 'ACCEPTED' })).toBe('undecided');
    expect(quoteAcceptanceOf({ quoteDecision: 'maybe' })).toBe('undecided');
  });
  it('does NOT change what state the doc is in', () => {
    // The acceptance is a separate dimension: an accepted quote is still
    // classified by its status and its money, which is what keeps the eight
    // states (and the portal's isPayable over them) untouched.
    expect(invoiceStateOf({ status: 'open', amountDue: 240, quoteDecision: 'accepted' })).toBe('open');
  });
});

describe('invoiceEditRefusal', () => {
  it('permits a money edit only where the scope is all', () => {
    expect(invoiceEditRefusal('draft', 'none', true, 'undecided')).toBeNull();
    expect(invoiceEditRefusal('open', 'none', true, 'undecided')).toBeNull();
  });

  it('permits a metadata-only edit where money is frozen but the invoice is not', () => {
    expect(invoiceEditRefusal('open', 'settled', false, 'undecided')).toBeNull();
  });

  it('PERMITS a money edit against a part-paid invoice', () => {
    expect(invoiceEditRefusal('open', 'partial', true, 'undecided')).toBeNull();
    // Including the corrupt shape, which is labelled paid but is not.
    expect(invoiceEditRefusal('paid', 'partial', true, 'undecided')).toBeNull();
  });

  it('refuses a money edit against a settled invoice, and says why', () => {
    const refusal = invoiceEditRefusal('open', 'settled', true, 'undecided');
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('invoice_money_locked');
    expect(refusal!.message).toContain('paid in full');
  });

  it('refuses any edit to a paid invoice, and says why', () => {
    const refusal = invoiceEditRefusal('paid', 'settled', false, 'undecided');
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('invoice_not_editable');
    expect(refusal!.message).toContain('paid');
  });

  it('names the actual state in the refusal, so the operator is not guessing', () => {
    expect(invoiceEditRefusal('cancelled', 'none', false, 'undecided')!.message).toContain('cancelled');
    expect(invoiceEditRefusal('credit', 'none', false, 'undecided')!.message).toContain('credit');
  });

  it('REFUSES AN EDIT TO AN ACCEPTED QUOTE, in words the operator can act on', () => {
    // The accepted quote classifies as 'open', a state that is NOT frozen, so
    // the generic "why is this frozen" sentence has nothing to say about it.
    // The refusal must name the acceptance or the operator is told a bill they
    // are looking at cannot be edited, with no reason given.
    const refusal = invoiceEditRefusal('open', 'none', false, 'accepted');
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('quote_accepted_locked');
    expect(refusal!.message).toContain('accepted this quote');
    expect(refusal!.message.length).toBeGreaterThan(20);
    // A money edit is refused for the same reason, with the same sentence.
    expect(invoiceEditRefusal('open', 'none', true, 'accepted')!.code).toBe('quote_accepted_locked');
  });
  it('names the STATE, not the acceptance, when the state is what froze it', () => {
    // An accepted quote that was later cancelled is frozen by the cancellation,
    // and "the household accepted this quote" would be a true sentence about
    // the wrong fact.
    const refusal = invoiceEditRefusal('cancelled', 'none', false, 'accepted');
    expect(refusal!.code).toBe('invoice_not_editable');
    expect(refusal!.message).toContain('cancelled');
    expect(invoiceEditRefusal('paid', 'settled', false, 'accepted')!.message).toContain('paid');
  });
  it('PERMITS every edit to a declined quote', () => {
    expect(invoiceEditRefusal('quote', 'none', true, 'denied')).toBeNull();
    expect(invoiceEditRefusal('quote', 'none', false, 'denied')).toBeNull();
  });
  it('gives every frozen state a refusal rather than falling through to null', () => {
    const frozen: InvoiceState[] = ['paid', 'cancelled', 'credit', 'redeemed'];
    for (const state of frozen) {
      expect(invoiceEditRefusal(state, 'none', false, 'undecided')).not.toBeNull();
    }
  });
});
