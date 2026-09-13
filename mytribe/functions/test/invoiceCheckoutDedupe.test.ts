import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_BALANCE_FIELD,
  CHECKOUT_ROUND_FIELD,
  CHECKOUT_ROUND_METADATA_KEY,
  SETTLED_INTENT_FIELD,
  checkoutRoundOf,
  duplicateCheckoutReason,
  invoiceOwesNothing,
  roundFromMetadata,
} from '../src/lib/invoiceCheckoutDedupe';
import { ACCOUNT_BALANCE_FIELD as ACCOUNT_CREDIT_FIELD } from '../src/lib/accountCredit';

/**
 * The invoice-level dedupe's decision, unit by unit (issue #826).
 *
 * The webhook suite proves the branch fires and what it writes; this proves the
 * boundaries, which is cheaper here than through six more fake Stripe events.
 */

/** An invoice with everything absent, so each test names only what it changes. */
function invoice(over: Record<string, unknown> = {}) {
  return {
    round: undefined,
    settledPaymentIntentId: undefined,
    amountDueCents: undefined,
    amountDue: undefined,
    ...over,
  };
}

describe('checkoutRoundOf', () => {
  it('reads a stored round', () => {
    expect(checkoutRoundOf(3)).toBe(3);
  });

  it('reads anything unreadable as round 0, the state every old invoice is in', () => {
    for (const v of [undefined, null, '2', 2.5, -1, NaN, {}]) {
      expect(checkoutRoundOf(v)).toBe(0);
    }
  });
});

describe('roundFromMetadata', () => {
  it('parses the string Stripe metadata always stores', () => {
    expect(roundFromMetadata('0')).toBe(0);
    expect(roundFromMetadata('11')).toBe(11);
  });

  it('answers NULL, not 0, when the session carries no round', () => {
    // The distinction the whole legacy path rests on: 0 is a real round a
    // stale-round comparison can fire on, so reading "absent" as 0 would refuse
    // a legitimate second payment on any invoice that has settled once.
    expect(roundFromMetadata(undefined)).toBeNull();
    expect(roundFromMetadata('')).toBeNull();
  });

  it('refuses anything that is not a clean non-negative integer', () => {
    for (const v of ['3 apples', '-1', '1.5', '1e3', ' 1', 3]) {
      expect(roundFromMetadata(v)).toBeNull();
    }
  });
});

describe('invoiceOwesNothing', () => {
  it('prefers the integer cents figure over the legacy dollar float', () => {
    expect(invoiceOwesNothing({ amountDueCents: 0, amountDue: 137.5 })).toBe(true);
    expect(invoiceOwesNothing({ amountDueCents: 5000, amountDue: 0 })).toBe(false);
  });

  it('falls back to the dollar float, which is all an older invoice carries', () => {
    expect(invoiceOwesNothing({ amountDueCents: undefined, amountDue: 0 })).toBe(true);
    expect(invoiceOwesNothing({ amountDueCents: undefined, amountDue: 12.5 })).toBe(false);
  });

  it('reads an invoice with NO balance fields as OWING, never as settled', () => {
    // Erring the other way diverts a household's first and only payment into
    // account credit and leaves the bill reading unpaid. A missing field is an
    // unknown balance, not a settled one.
    expect(invoiceOwesNothing({ amountDueCents: undefined, amountDue: undefined })).toBe(false);
    expect(invoiceOwesNothing({ amountDueCents: 'nope', amountDue: null })).toBe(false);
    expect(invoiceOwesNothing({ amountDueCents: NaN, amountDue: undefined })).toBe(false);
  });
});

describe('duplicateCheckoutReason', () => {
  it('lets the SAME payment through, because the intent ledger owns that case', () => {
    // The one ordering that would make this fix worse than the bug: the second
    // of the two events one card payment delivers must never read as a
    // cross-session duplicate.
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ [SETTLED_INTENT_FIELD]: 'pi_1', settledPaymentIntentId: 'pi_1', amountDue: 0 }),
        paymentIntentId: 'pi_1',
        eventRound: 0,
      }),
    ).toBeNull();
  });

  it('refuses a session minted for a round that has closed', () => {
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ round: 1, settledPaymentIntentId: 'pi_1', amountDue: 0 }),
        paymentIntentId: 'pi_2',
        eventRound: 0,
      }),
    ).toBe('stale-round');
  });

  it('refuses a stale session even while the invoice still shows a balance', () => {
    // A partial payment recorded between two sessions: the bill is genuinely
    // owed something, and the second session is still charging the OLD figure.
    // This is the only branch that can see it.
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ round: 1, amountDueCents: 5000 }),
        paymentIntentId: 'pi_2',
        eventRound: 0,
      }),
    ).toBe('stale-round');
  });

  it('names the settling intent when a legacy session lands on a settled invoice', () => {
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ settledPaymentIntentId: 'pi_1', amountDue: 0 }),
        paymentIntentId: 'pi_2',
        eventRound: null,
      }),
    ).toBe('settled-by-other-intent');
  });

  it('catches an invoice settled by a route that never touched Stripe', () => {
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ amountDueCents: 0 }),
        paymentIntentId: 'pi_2',
        eventRound: null,
      }),
    ).toBe('invoice-not-owed');
  });

  it('APPLIES a second payment minted after the last one settled', () => {
    // The case a key of `invoiceId` alone gets wrong. `payInvoice` has no amount
    // argument — it always charges the full remaining balance — so a second
    // Stripe payment happens exactly when the balance comes back, and it is
    // owed.
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ round: 1, settledPaymentIntentId: 'pi_1', amountDueCents: 5000 }),
        paymentIntentId: 'pi_2',
        eventRound: 1,
      }),
    ).toBeNull();
  });

  it('does not refuse forever just because SOME intent once settled the invoice', () => {
    // `stripeSettledPaymentIntentId` names the last Stripe payment and stays
    // named for the life of the invoice. On its own it would refuse every
    // legitimate later payment the invoice ever takes.
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ settledPaymentIntentId: 'pi_1', amountDue: 42 }),
        paymentIntentId: 'pi_2',
        eventRound: null,
      }),
    ).toBeNull();
  });

  it('applies the FIRST payment on an ordinary unpaid invoice', () => {
    expect(
      duplicateCheckoutReason({
        invoice: invoice({ amountDue: 137.5 }),
        paymentIntentId: 'pi_1',
        eventRound: 0,
      }),
    ).toBeNull();
  });
});

describe('the field names this module restates', () => {
  it('holds the same account-balance field `lib/accountCredit.ts` owns', () => {
    // The one duplicated string in the module, restated rather than imported so
    // a pure decision file does not drag `admin/markInvoicePaid`'s `onCall`
    // registration into the webhook's import graph. This assertion is what stops
    // the copy drifting.
    expect(ACCOUNT_BALANCE_FIELD).toBe(ACCOUNT_CREDIT_FIELD);
  });

  it('keys the stored fields and the Stripe metadata under stable names', () => {
    // Stored on live invoices and stamped into live Checkout Session metadata:
    // renaming one of these silently stops matching sessions already in flight.
    expect(CHECKOUT_ROUND_FIELD).toBe('stripeCheckoutRound');
    expect(SETTLED_INTENT_FIELD).toBe('stripeSettledPaymentIntentId');
    expect(CHECKOUT_ROUND_METADATA_KEY).toBe('checkoutRound');
  });
});
