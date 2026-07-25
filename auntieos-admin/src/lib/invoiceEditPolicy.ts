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
 * THE THREE-VALUED STANDING IS LOAD-BEARING. Do not "simplify" it back to a
 * boolean. The server took a `hasPayments: boolean` until 2026-07-25, and that
 * missing distinction is the whole defect: any payment of any size froze the
 * money, so a $40 invoice with $20 against it could not be repaired by any path.
 * The server now takes `InvoicePaymentStanding`, and this mirror matches it
 * branch for branch (`mytribe/functions/src/lib/invoiceEditPolicy.ts`).
 *
 * The standing must be derived from the sum of the `payments` SUBCOLLECTION,
 * never from the `amountDue` scalar, because the same defect wrote 0 into that
 * scalar for a partial payment on every invoice it touched.
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
      // A PART-PAID INVOICE STAYS FULLY EDITABLE. Only a settled one freezes.
      // Money already in is a fact recorded in the `payments` subcollection and
      // is not what an edit changes; what an edit changes is what the household
      // was ASKED for, which is exactly what needs correcting while a bill is
      // still part-collected.
      return payments === 'settled' ? 'metadataOnly' : 'all';
    case 'paid':
      // `paid` DEFERS TO THE STANDING rather than freezing on the label alone. A
      // doc labelled paid whose recorded payments fall short of its total is not
      // a settled invoice, it is the corruption the 2026-07-25 fix exists to
      // undo, and it is the single case that most needs to stay repairable.
      return payments === 'partial' ? 'all' : 'none';
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
 * READ `paidCents`, NEVER `amountDue`. The dollar `amountDue` scalar is a trap:
 * `markInvoicePaid` set it to 0 UNCONDITIONALLY until 2026-07-25, even for a
 * partial payment, so on every invoice that write touched a zero balance is not
 * evidence of settlement. `paidCents` is written from the SUM of the `payments`
 * subcollection in the same pass that decides the status, so it is the one field
 * on the doc that answers this. `total - amountDue` is the same trap by
 * subtraction and would report the whole total as collected.
 *
 * WHEN `paidCents` IS ABSENT THE ANSWER IS STILL "I CANNOT TELL", and this
 * function says so by answering `none` rather than by guessing. Absent means a
 * legacy doc written before the field existed, which is most of the collection
 * until `repairInvoicePayments` has run. `none` offers the control and lets the
 * server have the last word, which is the safe direction for a courtesy mirror:
 * a wrongly-offered Edit ends in a refusal this app prints verbatim, while a
 * wrongly-hidden one is a dead end with no explanation.
 */
export function paymentStatusFromDoc(
  state: InvoiceState,
  totalCents?: number,
  paidCents?: number,
): InvoicePaymentStatus {
  if (typeof paidCents !== 'number' || !Number.isFinite(paidCents) || paidCents <= 0) {
    // No recorded figure. Fall back to the label, which is all the old mirror
    // ever had: a doc the classifier calls `paid` is treated as settled.
    return state === 'paid' ? 'settled' : 'none';
  }
  if (typeof totalCents !== 'number' || !Number.isFinite(totalCents)) return 'settled';
  return paidCents < totalCents ? 'partial' : 'settled';
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
