/**
 * Who may edit an invoice, and how much of it. THE WEB MIRROR.
 *
 * THIS IS NOT THE ENFORCEMENT. `mytribe/functions/src/lib/invoiceEditPolicy.ts`
 * is, and it has to be: `firestore.rules:219-226` grants
 * `allow update: if isAuntie()` over the whole `invoices` collection, so a stale
 * bundle, a second client or a direct callable invocation walks straight past
 * anything decided here. This copy exists for ONE reason, to decide whether to
 * render an Edit affordance, so the operator is not offered a control that will
 * be rejected. If the two ever disagree, the server is right and this file is
 * the bug. Same relationship, and same reason, as `lib/invoiceMath.ts`.
 *
 * BECAUSE THIS IS ONLY A COURTESY, IT FAILS TOWARD OFFERING THE CONTROL rather
 * than toward hiding it. A wrongly-hidden Edit button is a dead end with no
 * explanation; a wrongly-offered one ends in a server refusal that this app
 * surfaces verbatim, which at least tells the operator what is actually true.
 * That asymmetry is the whole reason `paymentStatusFromDoc` below is allowed to
 * answer "none" when it genuinely cannot tell.
 *
 * ---
 *
 * COORDINATION NOTE, READ BEFORE EDITING. A concurrent change on
 * `fix/invoice-partial-payments` is adding a THIRD payment state to the SERVER
 * policy, between "no payments" and "settled", so that a PART-PAID invoice stays
 * repairable instead of freezing like a settled one. The server today takes a
 * `hasPayments: boolean`; it will take something three-valued.
 *
 * This mirror is therefore written three-valued FROM THE START
 * (`InvoicePaymentStatus`), so that landing the server change is a change to the
 * MAPPING in `invoiceEditScope` and not a change to this module's shape or to
 * any of its call sites. Until that change lands, `partial` deliberately behaves
 * exactly like `settled`, which is what the server does today. The branch is
 * marked PARTIAL-PAYMENT FOLLOW-UP below. Do not "simplify" it back to a
 * boolean.
 */

/** Every state the classifier will ever return. Mirrors the server enum exactly. */
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

/**
 * How far along the money is.
 *
 *   none      no payment has been recorded against this invoice
 *   partial   some money came in, but it does not settle the invoice
 *   settled   the invoice has been paid off
 */
export type InvoicePaymentStatus = 'none' | 'partial' | 'settled';

/**
 * How much of an invoice in a given state may change. Mirrors the server type.
 *
 *   all           every field, including the line items and the discounts
 *   metadataOnly  the descriptive fields, but the money is frozen
 *   none          nothing
 */
export type InvoiceEditScope = 'all' | 'metadataOnly' | 'none';

/**
 * THE RULE, mirrored. See the server file for the full rationale; the short
 * version is that a draft, a quote and a SENT-BUT-UNPAID invoice are all fully
 * editable, because correcting an invoice nobody has paid yet is ordinary
 * invoicing practice, and `zero` in particular must stay open or a blank invoice
 * could never receive its first line item. Once money has actually changed
 * hands, the figures stop being a proposal and become a record.
 *
 * TOTAL BY CONSTRUCTION: the switch enumerates all eight states with no
 * `default`, so a ninth state is a compile error here rather than a silent
 * "editable" (or a silent "frozen") at runtime. That is the AO-12 shape, and it
 * is the reason this is a switch on an enumerated state rather than a pile of
 * booleans.
 */
export function invoiceEditScope(state: InvoiceState, payments: InvoicePaymentStatus): InvoiceEditScope {
  switch (state) {
    case 'draft':
    case 'quote':
      return 'all';
    case 'open':
    case 'zero':
      // PARTIAL-PAYMENT FOLLOW-UP. `partial` is grouped with `settled` here
      // ONLY because that is what the server does today: its `hasPayments`
      // boolean cannot tell the two apart, so ANY recorded payment freezes the
      // money. Once `fix/invoice-partial-payments` lands its third state, the
      // `partial` case moves up to return 'all' (a part-paid invoice stays
      // repairable) and this comment goes away. Changing it BEFORE the server
      // does would offer an Edit control the server still refuses, which is the
      // one direction this mirror must not fail in.
      return payments === 'none' ? 'all' : 'metadataOnly';
    case 'paid':
    case 'cancelled':
    case 'credit':
    case 'redeemed':
      return 'none';
  }
}

/**
 * What this CLIENT can honestly conclude about payments from the invoice doc
 * alone, which is less than the server knows.
 *
 * THE HONEST ANSWER IS OFTEN "I CANNOT TELL", and this function says so by
 * answering `none` rather than by guessing. Two facts make that unavoidable:
 *
 *  - the truth lives in the `payments` SUBCOLLECTION, and the admin's invoice
 *    surfaces are fed by a collection listener over `invoices` that does not,
 *    and cheaply cannot, carry a subcollection per row;
 *  - the obvious scalar substitute is a trap. `markInvoicePaid.ts` sets
 *    `amountDue: 0` UNCONDITIONALLY, even for a partial payment, so a zero
 *    balance is not evidence of settlement and a non-zero balance is not
 *    evidence that nothing was paid.
 *
 * So the only sound reading is the explicit one: an invoice the classifier calls
 * `paid` has been settled; anything else is treated as unpaid for the purpose of
 * OFFERING the control, and the server has the last word. An operator who edits
 * a part-paid invoice gets `invoice_money_locked` back with a sentence
 * explaining it, which is a better outcome than a silently missing button.
 *
 * `partial` is never returned today. It is in the type because the server is
 * about to be able to distinguish it, and because a function that cannot express
 * the state would have to be re-shaped rather than re-pointed at that moment.
 */
export function paymentStatusFromDoc(state: InvoiceState): InvoicePaymentStatus {
  return state === 'paid' ? 'settled' : 'none';
}

export interface InvoiceEditRefusal {
  /** Mirrors the server's codes. Clients branch on this, never on message text. */
  code: 'invoice_not_editable' | 'invoice_money_locked';
  message: string;
}

/** Why a frozen state is frozen, in the operator's words. Mirrors the server copy. */
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
      // Not frozen. Unreachable from `invoiceEditRefusal`, which checks the
      // scope first; enumerated anyway so a new state cannot slip through.
      return '';
  }
}

/**
 * The refusal for an attempted edit, or null when it is allowed. Mirrors the
 * server function of the same name, including its two-argument split:
 * `touchesMoney` is kept separate so a patch that only renames an invoice or
 * moves its due date is still allowed against one whose money is frozen.
 */
export function invoiceEditRefusal(
  state: InvoiceState,
  payments: InvoicePaymentStatus,
  touchesMoney: boolean,
): InvoiceEditRefusal | null {
  const scope = invoiceEditScope(state, payments);

  if (scope === 'none') {
    return { code: 'invoice_not_editable', message: frozenBecause(state) };
  }
  if (scope === 'metadataOnly' && touchesMoney) {
    return {
      code: 'invoice_money_locked',
      message:
        'A payment has already been recorded against this invoice, so its line items and discounts are locked. The invoice number, dates and terms can still be changed.',
    };
  }
  return null;
}
