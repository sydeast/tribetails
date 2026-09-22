/**
 * Who may edit an invoice, and how much of it. The SERVER-SIDE authority.
 *
 * THIS file is the enforcement, and it has to be, because `firestore.rules` grants
 * `allow update: if isAuntie()` on the whole `invoices` collection: a stale
 * bundle, a second client, or a direct callable invocation walks straight past
 * any UI gate. Same reasoning, and the same shape, as `bookingNoteCutoff.ts`.
 *
 * THE STATE ENUMERATION IS POSITIVE, NOT A NEGATION. This is the server-side
 * twin of `auntieos-admin/src/lib/invoiceFormat.ts#invoiceState`, and it repeats
 * that module's AO-12 fix on purpose: the wasm admin decided "paid" by ruling
 * out the other states ("not proven anything else, so call it paid"), which is
 * how an unredeemed CREDIT rendered as a confident PAID chip in production. Every
 * branch below is a positive read of either an explicit status string or a real
 * money field. Reintroducing a negation here would let an invoice become
 * editable, or frozen, by accident.
 *
 * THE ONE DEPENDENCY, AND WHY IT IS NOT A DEPARTURE. This module used to import
 * nothing at all, so the backfill script and the pure tests could load the
 * classifier without anything reaching Firestore. It now takes
 * `lib/amountDueRule.ts`, whose own single import is `lib/invoiceMath.ts`, which
 * imports nothing. That serves the same purpose rather than abandoning it: #902
 * was this classifier and `triggers/onInvoiceAutoApply.ts` answering "what does
 * a document with a `total` and no `amountDue` owe" differently, and money moved
 * on the difference. The answer is one module now, so no reader can drift from
 * another, and every file in the chain is still free of Firestore.
 */
import { amountDueCentsOf } from './amountDueRule';
import { invoiceTotalCentsOf } from './invoiceMath';

/** Every state this module will ever return. */
export const INVOICE_STATES = [
  'quote',
  'draft',
  'cancelled',
  'credit',
  'redeemed',
  'paid',
  'zero',
  'open',
] as const;

export type InvoiceState = (typeof INVOICE_STATES)[number];

/** The fields the classifier reads off a raw invoice doc. All optional: real docs are missing keys. */
export interface InvoiceStateDoc {
  status?: unknown;
  amountDue?: unknown;
  /** The integer-cents balance where a writer paired it with `amountDue`; see `amountDueRule.ts`. */
  amountDueCents?: unknown;
  total?: unknown;
  /**
   * The integer-cents total, which WINS over `total` (`invoiceTotalCentsOf`).
   * Read here from 2026-09-22: the classifier used to read only the float
   * dollars, so it and every other money reader could put a different number
   * against the same invoice. Docs carrying both are written from one source in
   * one pass and agree; a doc carrying only `totalCents` used to classify as if
   * it were worth nothing.
   */
  totalCents?: unknown;
  creditRedeemedAt?: unknown;
  /**
   * The household's answer to a quote, written by `portal/quoteDecision.ts`.
   * Read by the EDIT SCOPE, never by `invoiceStateOf`: an answered quote is
   * still whatever state its status and its money say it is (an accepted one
   * re-stamps to 'open'), and the answer only changes what may still be
   * changed about it. See `quoteAcceptanceOf` and `invoiceEditScope`.
   */
  quoteDecision?: unknown;
}

/**
 * Classifies one invoice doc. Precedence matches the admin twin (the portal's
 * `resolveStatus` was the third copy of this precedence until 2026-07-28,
 * when `portal/getMyInvoices.ts` retired it and started reading the stored
 * stamp this module's output writes): an explicit status wins, then a
 * negative balance is a credit even when unlabeled, then the money places an
 * unlabeled row.
 *
 * THE BALANCE COMES FROM THE SHARED RULE (#902), not from the raw field. Until
 * 2026-09-22 a missing `amountDue` was read as 0 here, so a migrated
 * `{ status: 'sent', total: 40 }` classified `paid` while the auto-apply trigger
 * read the same document as collectable and drew account credit against it. The
 * rule (`lib/amountDueRule.ts`) derives what such a document owes, and every
 * reader now asks it: a stated balance is returned untouched, so nothing this
 * classifier said about a document that HAS an `amountDue` has changed.
 *
 * `paidCents` is the sum of the invoice's `payments` subcollection, passed by
 * the callers that hold it (`invoiceStateStampOf`, `chaseRefusalOf`) and left
 * `null` by the ones that cannot fetch it. It is read ONLY to settle a document
 * that states no balance; for every other document the argument changes nothing,
 * which is why every existing call site keeps its meaning without passing it.
 * A legacy bill whose rows cover its total therefore reads `paid` to a caller
 * holding the rows, and a caller without them says `open` — the conservative
 * reading, and the one that keeps the bill visible and repairable.
 */
export function invoiceStateOf(doc: InvoiceStateDoc, paidCents: number | null = null): InvoiceState {
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : '';
  const amountDue = amountDueCentsOf(doc, paidCents);
  const total = invoiceTotalCentsOf(doc);

  if (status === 'quote') return 'quote';
  if (status === 'draft') return 'draft';
  if (status === 'cancelled') return 'cancelled';
  // `redeemed` joined the positive reads on 2026-07-28, when the state stamp
  // (`lib/invoiceStateStamp.ts`, ADR-0002) started writing this module's OUTPUT
  // back into `status`. Every output must classify to itself, or stamping a doc
  // could change what a re-run says about it: a credit whose money did not
  // independently signal credit (a positive-`amountDue` doc labelled `credit`,
  // reachable through `redeemCredit`'s own guard) would be stamped `redeemed`
  // and then re-read as `open`. It is a FAMILY label, not a state assertion:
  // `creditRedeemedAt` still decides credit vs redeemed below, so a doc
  // labelled `redeemed` with no redemption stamp honestly reads `credit`.
  if (status === 'credit' || status === 'redeemed' || amountDue < 0 || total < 0) {
    return doc.creditRedeemedAt !== undefined && doc.creditRedeemedAt !== null ? 'redeemed' : 'credit';
  }
  if (status === 'paid') return 'paid';
  if (amountDue > 0) return 'open';
  if (total === 0) return 'zero';
  return 'paid';
}

/**
 * How much of an invoice in [state] may change.
 *
 *   all           every field, including the line items and the discounts
 *   metadataOnly  the descriptive fields, but the money is frozen
 *   none          nothing
 */
export type InvoiceEditScope = 'all' | 'metadataOnly' | 'none';

/**
 * How far the recorded payments have got. THREE states, not two, and the third
 * one is the whole point of this type.
 *
 *   none      nothing has been collected
 *   partial   money has come in, and it does NOT cover the total
 *   settled   the total is covered (exactly, or beyond it)
 *
 * WHY THE MIDDLE STATE EXISTS. Until 2026-07-25 this was one boolean,
 * `hasPayments`, and the rule was "any payment at all freezes the money". For a
 * settled invoice that is right: the figures have stopped being a proposal.
 * For a PART-PAID invoice it was the second half of a money-losing defect.
 * `markInvoicePaid` wrote `status: 'paid', amountDue: 0` for a $20 payment
 * against a $40 invoice, the invoice dropped out of Outstanding, the callable
 * then REFUSED the second payment as already-paid, and this freeze meant
 * `updateInvoice` could not repair it either. The balance was unrecoverable by
 * any path. A part-paid invoice is exactly the invoice an operator most needs
 * to be able to correct, so it stays fully editable.
 */
export type InvoicePaymentStanding = 'none' | 'partial' | 'settled';

/**
 * The standing, from the two integer-cents figures. Deliberately takes the
 * numbers rather than the doc: the caller has already summed the `payments`
 * SUBCOLLECTION (`invoiceMath.ts#paidCentsFromPayments`), which is the only
 * field that can answer this, and passing the doc would invite someone to read
 * the `amountDue` scalar instead.
 */
export function paymentStandingOf(totalCents: number, paidCents: number): InvoicePaymentStanding {
  if (!Number.isFinite(paidCents) || paidCents <= 0) return 'none';
  if (!Number.isFinite(totalCents)) return 'settled';
  return paidCents < totalCents ? 'partial' : 'settled';
}

/**
 * Whether the household has answered the quote this invoice began life as.
 *
 *   undecided  no answer on the doc — either still out for one, or it was
 *              never a quote at all. The two are the same fact HERE: nobody
 *              has agreed to anything, so nothing is locked by agreement.
 *   accepted   the household said yes
 *   denied     the household said no
 *
 * WHY THE EDIT POLICY NEEDS A THIRD INPUT (issue #448). The operator ruling of
 * 2026-08-18 is that a quote is editable until it is ACCEPTED, and stays
 * editable when it is DECLINED. Neither half of that can be read off the state
 * alone: `acceptQuote` re-stamps an accepted quote to 'open' (that is what
 * makes the portal's Pay button appear), so by the time an edit arrives the
 * doc is indistinguishable from an ordinary sent invoice — which this module
 * deliberately keeps fully editable — and a DECLINED quote keeps `status:
 * 'quote'`, so it is indistinguishable from one still awaiting an answer.
 * `quoteDecision` is the only field that tells the three apart.
 *
 * NOT A NINTH STATE, and deliberately not. The eight `INVOICE_STATES` are
 * generated into both web clients and into Kotlin, and the portal's
 * `isPayable` is a total predicate over them (#470); a ninth entry would fork
 * "can this be paid" as the price of answering "can this be edited". The
 * acceptance is a separate dimension of the same doc, exactly as the payment
 * standing is, and it is passed alongside rather than folded in.
 */
export type QuoteAcceptance = 'undecided' | 'accepted' | 'denied';

/**
 * The stored answer, verified rather than trusted: anything that is not one of
 * the two values `portal/quoteDecision.ts` writes reads as 'undecided'.
 *
 * The same two-value vocabulary as `lib/quoteDecision.ts#quoteDecisionOf`,
 * restated here rather than imported because THIS module has no dependencies
 * at all — it is imported by the backfill script and by the pure tests, and
 * `quoteDecision.ts` reaches Firestore for the business time zone.
 */
export function quoteAcceptanceOf(doc: InvoiceStateDoc): QuoteAcceptance {
  const raw = doc.quoteDecision;
  if (raw === 'accepted') return 'accepted';
  if (raw === 'denied') return 'denied';
  return 'undecided';
}

/**
 * THE RULE, stated once.
 *
 * A draft or a quote is fully editable: nothing has been asserted to anyone yet.
 *
 * A SENT but unpaid invoice (`open`, and `zero` which is the same thing billed at
 * nothing yet) is ALSO fully editable. That is a deliberate call rather than an
 * oversight: correcting an invoice you have already sent, before anyone has paid
 * it, is ordinary invoicing practice, and freezing it would force the operator
 * into cancel-and-reissue for a typo. `zero` in particular MUST stay open, or a
 * blank invoice could never receive its first line item.
 *
 * The moment the invoice is SETTLED, the figures stop being a proposal and start
 * being a record of a closed transaction, so the money freezes while the
 * descriptive fields stay editable.
 *
 * A PART-PAID INVOICE STAYS FULLY EDITABLE, and this is the 2026-07-25 change.
 * The old rule froze the money on the first payment of any size, which is what
 * left a $40 invoice with $20 against it beyond repair: `markInvoicePaid` had
 * already written it `paid` with $0 due and would refuse the balance, and this
 * function then refused the correction too. Money that has come in is a fact
 * recorded in the subcollection and is not what an edit here changes; what an
 * edit changes is what the household was asked for, and that is precisely what
 * needs correcting while a bill is still part-collected.
 *
 * The standing is read from the `payments` SUBCOLLECTION, never from the
 * `amountDue` scalar, because the same defect wrote 0 into that scalar for a
 * partial payment on every invoice touched before the fix.
 *
 * `paid` DEFERS TO THE STANDING rather than freezing on the label alone. A doc
 * labelled paid whose recorded payments fall short of its total is not a settled
 * invoice, it is the corruption above, and it is the single case that most needs
 * to be repairable. `lib/invoicePaymentRepair.ts` restores those docs, and this
 * branch means an operator is not blocked in the meantime.
 *
 * `cancelled`, `credit` and `redeemed` are frozen outright: the money has been
 * withdrawn, or points the other way (a credit is owed TO the household, and
 * editing it here would contradict the redemption flow).
 *
 * AN ACCEPTED QUOTE IS FROZEN, and that is the 2026-08-18 ruling (issue #448).
 * Everything above is about a bill the office wrote and may correct. A quote
 * the household has ACCEPTED is different in kind: it is a figure two parties
 * have agreed on, and editing it afterwards would change what was agreed
 * without anyone being asked. So the acceptance overrides the state's own
 * answer and freezes the doc outright. A DECLINED quote is untouched by this
 * and stays fully editable, because revising a declined quote and sending it
 * back is the whole point of a decline — see `admin/resendQuote.ts`, which is
 * how it goes back out.
 *
 * THE REPAIR DOCTRINE OUTRANKS THE ACCEPTANCE LOCK. A PART-PAID invoice stays
 * fully editable even when it started as an accepted quote, for exactly the
 * reason the paragraph above gives: a part-collected bill is the one an
 * operator most needs to be able to correct, and the $40-invoice-with-$20 case
 * that motivated the three-state standing is not less likely on a quote the
 * household accepted. The lock protects an agreed figure; it must not create a
 * second unrepairable invoice.
 *
 * TOTAL BY CONSTRUCTION: the switch enumerates all eight states with no
 * `default`, so a ninth state is a compile error here rather than a silent
 * "editable" (or a silent "frozen") at runtime. `acceptance` is a REQUIRED
 * argument for the same reason: a call site that has not decided what the
 * household said cannot compile, rather than defaulting to "not accepted" and
 * quietly unlocking an agreed quote on the next re-stamp.
 */
export function invoiceEditScope(
  state: InvoiceState,
  standing: InvoicePaymentStanding,
  acceptance: QuoteAcceptance,
): InvoiceEditScope {
  const byState = ((): InvoiceEditScope => {
    switch (state) {
      case 'draft':
      case 'quote':
        return 'all';
      case 'open':
      case 'zero':
        return standing === 'settled' ? 'metadataOnly' : 'all';
      case 'paid':
        return standing === 'partial' ? 'all' : 'none';
      case 'cancelled':
      case 'credit':
      case 'redeemed':
        return 'none';
    }
  })();

  if (acceptance === 'accepted' && standing !== 'partial') return 'none';
  return byState;
}

export interface InvoiceEditRefusal {
  /** Clients branch on this, never on the message text. */
  code: 'invoice_not_editable' | 'invoice_money_locked' | 'quote_accepted_locked';
  message: string;
}

/** Why a frozen state is frozen, in the operator's words. */
function frozenBecause(state: InvoiceState): string {
  switch (state) {
    case 'paid':
      return 'This invoice is paid, so it can no longer be edited. Issue a credit instead.';
    case 'cancelled':
      return 'This invoice is cancelled, so it can no longer be edited.';
    case 'credit':
      return 'This is a credit owed to the household, so it can no longer be edited. Redeeming it is its own flow.';
    case 'redeemed':
      return 'This credit has been redeemed, so it can no longer be edited.';
    case 'draft':
    case 'quote':
    case 'open':
    case 'zero':
      // Not frozen. Unreachable from invoiceEditRefusal, which checks the scope
      // first; enumerated anyway so a new state cannot slip through untyped.
      return '';
  }
}

/**
 * The refusal for an attempted edit, or null when it is allowed.
 *
 * `touchesMoney` is whether the patch changes `lineItems` or a discount. A patch
 * that only renames the invoice or moves its due date is still allowed against a
 * settled invoice, which is why this takes the two separately rather than
 * refusing the whole patch on one flag.
 */
export function invoiceEditRefusal(
  state: InvoiceState,
  standing: InvoicePaymentStanding,
  touchesMoney: boolean,
  acceptance: QuoteAcceptance,
): InvoiceEditRefusal | null {
  const scope = invoiceEditScope(state, standing, acceptance);

  if (scope === 'none') {
    // WHICH OF THE TWO REASONS IS THE REAL ONE. An accepted quote classifies as
    // 'open' (acceptQuote re-stamps it), and `frozenBecause('open')` has
    // nothing to say, because 'open' is not a frozen state: without the
    // acceptance branch the refusal would arrive with an EMPTY message and the
    // operator would be told a bill they are looking at cannot be edited for no
    // stated reason. But an accepted quote that was later cancelled, paid, or
    // turned into a credit is frozen by that, and saying "the household
    // accepted it" would name the wrong fact. So the STATE answers whenever the
    // state alone is enough, and the acceptance answers only when it is the
    // thing doing the freezing.
    const frozenByState = invoiceEditScope(state, standing, 'undecided') === 'none';
    if (!frozenByState && acceptance === 'accepted') {
      return {
        code: 'quote_accepted_locked',
        message:
          'The household accepted this quote, so its figures are locked: editing them would change what was agreed. Issue a new quote if the work has changed.',
      };
    }
    return { code: 'invoice_not_editable', message: frozenBecause(state) };
  }
  if (scope === 'metadataOnly' && touchesMoney) {
    return {
      code: 'invoice_money_locked',
      message:
        'This invoice has been paid in full, so its line items and discounts are locked. The invoice number, dates and terms can still be changed.',
    };
  }
  return null;
}
