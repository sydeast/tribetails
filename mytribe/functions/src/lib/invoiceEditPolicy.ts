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
 */

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
  total?: unknown;
  creditRedeemedAt?: unknown;
}

/** A non-finite or non-numeric field reads as "no evidence" (0), never as NaN. */
function money(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Classifies one invoice doc. Precedence matches the admin twin and
 * `portal/getMyInvoices.ts#resolveStatus`: an explicit status wins, then a
 * negative balance is a credit even when unlabeled, then the money places an
 * unlabeled row.
 */
export function invoiceStateOf(doc: InvoiceStateDoc): InvoiceState {
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : '';
  const amountDue = money(doc.amountDue);
  const total = money(doc.total);

  if (status === 'quote') return 'quote';
  if (status === 'draft') return 'draft';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'credit' || amountDue < 0 || total < 0) {
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
 * TOTAL BY CONSTRUCTION: the switch enumerates all eight states with no
 * `default`, so a ninth state is a compile error here rather than a silent
 * "editable" (or a silent "frozen") at runtime.
 */
export function invoiceEditScope(state: InvoiceState, standing: InvoicePaymentStanding): InvoiceEditScope {
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
}

export interface InvoiceEditRefusal {
  /** Clients branch on this, never on the message text. */
  code: 'invoice_not_editable' | 'invoice_money_locked';
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
): InvoiceEditRefusal | null {
  const scope = invoiceEditScope(state, standing);

  if (scope === 'none') {
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
