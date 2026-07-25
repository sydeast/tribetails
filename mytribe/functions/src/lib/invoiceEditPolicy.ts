/**
 * Who may edit an invoice, and how much of it. The SERVER-SIDE authority.
 *
 * The admin mirrors this to decide whether to render an Edit button
 * (`auntieos-admin/src/lib/invoiceEditPolicy.ts`). That mirror is a courtesy so
 * the operator is not offered a control that will be rejected. THIS file is the
 * enforcement, and it has to be, because `firestore.rules` grants
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
 * The moment a payment actually exists, the figures stop being a proposal and
 * start being a record of a real transaction, so the money freezes while the
 * descriptive fields stay editable. `hasPayments` is read from the `payments`
 * SUBCOLLECTION, never from the `amountDue` scalar, because `markInvoicePaid.ts`
 * sets that scalar to 0 unconditionally even for a partial payment.
 *
 * `paid`, `cancelled`, `credit` and `redeemed` are frozen outright: the money has
 * settled, been withdrawn, or points the other way (a credit is owed TO the
 * household, and editing it here would contradict the redemption flow).
 *
 * TOTAL BY CONSTRUCTION: the switch enumerates all eight states with no
 * `default`, so a ninth state is a compile error here rather than a silent
 * "editable" (or a silent "frozen") at runtime.
 */
export function invoiceEditScope(state: InvoiceState, hasPayments: boolean): InvoiceEditScope {
  switch (state) {
    case 'draft':
    case 'quote':
      return 'all';
    case 'open':
    case 'zero':
      return hasPayments ? 'metadataOnly' : 'all';
    case 'paid':
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
 * part-paid invoice, which is why this takes the two separately rather than
 * refusing the whole patch on one flag.
 */
export function invoiceEditRefusal(
  state: InvoiceState,
  hasPayments: boolean,
  touchesMoney: boolean,
): InvoiceEditRefusal | null {
  const scope = invoiceEditScope(state, hasPayments);

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
