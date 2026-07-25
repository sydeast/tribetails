/**
 * Does an invoice's stored total actually agree with the lines it lists?
 *
 * WHY THIS EXISTS AT ALL, because "the server recomputes it, so they cannot
 * disagree" is the intuition and it is WRONG. Two live paths write the invoice
 * doc without going through any callable:
 *
 *   - `mytribe/firestore.rules:219-226` is `allow update: if isAuntie()` over
 *     the entire `invoices` collection. Any admin credential can set `total` to
 *     anything, from a console, a script, or an older build of this app.
 *   - `postInvoiceEvent` merges an arbitrary payload onto the doc.
 *
 * So a stored total that is not the sum of the stored lines is a REACHABLE
 * STATE, not a hypothetical. An invoice in that state is one where the operator
 * and the household are looking at two different numbers, and neither of them
 * knows it.
 *
 * THE RULE THIS MODULE ENCODES: NAME BOTH FIGURES, RECONCILE NEITHER.
 *
 * It does not pick a winner. It does not quietly re-derive the total for
 * display, which would hide the drift from the one person who could fix it. It
 * does not write a correction, because a silent repair to a money field is
 * exactly how the drift got there. It reports, with both numbers and where each
 * one came from, and leaves the decision to a human. This is the same call as
 * the `StatCard` dash-not-zero rule in `components/DenScreenKit.tsx`: inventing
 * agreement is the same class of lie as inventing a number.
 *
 * WHAT IS DELIBERATELY NOT COMPARED: `amountDue`. Reconciling it needs
 * `paidCents`, which lives in the `payments` SUBCOLLECTION that this client does
 * not load, and the `amountDue` scalar itself cannot substitute because
 * `markInvoicePaid.ts` zeroes it even for a PARTIAL payment. Comparing against a
 * figure we cannot compute would manufacture false alarms on every part-paid
 * invoice, which would train the operator to ignore this banner, which would
 * cost more than the check is worth. Only the total is checked, because only the
 * total can be checked honestly.
 */

import { computeInvoiceTotals, type InvoiceLineItemInput } from './invoiceMath';

/** The subset of an invoice doc this comparison reads. All optional: real docs miss keys. */
export interface ReconcilableInvoice {
  lineItems?: unknown;
  invoiceDiscountCents?: unknown;
  /** Integer cents, written by the 5.1 callables. Absent on every legacy invoice. */
  totalCents?: unknown;
  /** Legacy floating-point DOLLARS. Present on effectively every invoice. */
  total?: unknown;
}

export interface InvoiceTotalCheck {
  /** True only when this invoice carries a `lineItems` ARRAY (even an empty one). */
  itemized: boolean;
  /** The sum of the lines, less the invoice discount, in integer cents. */
  derivedTotalCents: number;
  /** What the doc claims, in integer cents. Null when the doc claims nothing readable. */
  storedTotalCents: number | null;
  /**
   * Which field `storedTotalCents` came from, so the banner can say so. An
   * operator told "the stored total is $40" will ask where that is stored.
   */
  storedFrom: 'totalCents' | 'total' | null;
  /** True only when both figures are known AND they differ. */
  disagrees: boolean;
}

/** A finite number, or null. A non-finite money field is "no reading", never 0. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The stored line items, or null when this invoice was never itemized.
 *
 * PRESENCE OF THE ARRAY, not its length. An absent `lineItems` means nobody has
 * itemized this invoice, which is every invoice created before Task 5.1. An
 * EMPTY array means somebody itemized it as billing nothing. Those are different
 * claims and the whole un-itemized guard in `updateInvoice` turns on telling
 * them apart, so this reader keeps the distinction rather than flattening it.
 */
function storedLines(doc: ReconcilableInvoice): InvoiceLineItemInput[] | null {
  if (!Array.isArray(doc.lineItems)) return null;
  const out: InvoiceLineItemInput[] = [];
  for (const entry of doc.lineItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const li = entry as Record<string, unknown>;
    const qty = finiteOrNull(li['qty']);
    const unitCents = finiteOrNull(li['unitCents']);
    if (qty === null || unitCents === null) continue;
    out.push({
      description: typeof li['description'] === 'string' ? li['description'] : '',
      qty,
      unitCents,
      discountCents: finiteOrNull(li['discountCents']) ?? 0,
    });
  }
  return out;
}

/**
 * Compares the sum of the lines against the stored total.
 *
 * `totalCents` is preferred over `total` when both are present, because it is
 * the exact integer the server wrote and `total` is its rounded dollar
 * projection. Falling back to `total` matters: an invoice edited outside the
 * callables can easily carry a changed `total` and a stale or absent
 * `totalCents`, and that is precisely the case worth catching.
 *
 * The dollar fallback is converted with `Math.round(total * 100)` rather than
 * compared in dollars, so the comparison happens entirely in integers and a
 * float representation artifact can never masquerade as a real disagreement.
 */
export function checkInvoiceTotal(doc: ReconcilableInvoice): InvoiceTotalCheck {
  const lines = storedLines(doc);

  if (lines === null) {
    // NOT A DISAGREEMENT. An un-itemized invoice has nothing to disagree WITH;
    // its stored total is the only assertion anyone has ever made about it.
    // Reporting drift here would flag every invoice in the collection.
    return {
      itemized: false,
      derivedTotalCents: 0,
      storedTotalCents: null,
      storedFrom: null,
      disagrees: false,
    };
  }

  const invoiceDiscountCents = finiteOrNull(doc.invoiceDiscountCents) ?? 0;
  const { totalCents: derivedTotalCents } = computeInvoiceTotals(lines, invoiceDiscountCents, 0);

  const exact = finiteOrNull(doc.totalCents);
  if (exact !== null) {
    return {
      itemized: true,
      derivedTotalCents,
      storedTotalCents: exact,
      storedFrom: 'totalCents',
      disagrees: exact !== derivedTotalCents,
    };
  }

  const dollars = finiteOrNull(doc.total);
  if (dollars !== null) {
    const asCents = Math.round(dollars * 100);
    return {
      itemized: true,
      derivedTotalCents,
      storedTotalCents: asCents,
      storedFrom: 'total',
      disagrees: asCents !== derivedTotalCents,
    };
  }

  // Itemized, but the doc asserts no total at all. There is no second figure to
  // disagree with, so this is not drift; it is a missing field, and the detail
  // panel says so separately rather than raising a false alarm here.
  return {
    itemized: true,
    derivedTotalCents,
    storedTotalCents: null,
    storedFrom: null,
    disagrees: false,
  };
}

/** "$36.00" / "-$12.50" from an integer count of cents. */
export function formatCentsUsd(cents: number): string {
  const n = Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

/** Which doc field a stored total came from, in words the operator can act on. */
export function storedTotalSourceLabel(from: 'totalCents' | 'total'): string {
  return from === 'totalCents'
    ? 'the total stored on the invoice'
    : 'the total stored on the invoice (its legacy dollar field)';
}
