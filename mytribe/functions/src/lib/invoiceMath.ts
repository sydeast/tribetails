/**
 * Invoice money arithmetic. Integer cents throughout, and the single place any
 * invoice total is derived.
 *
 * WHY CENTS, WHEN THE INVOICE DOC STORES DOLLARS. `invoices/{id}.total` and
 * `.amountDue` are floating-point DOLLARS (`createInvoice.ts`'s zod schema is
 * `z.number().nonnegative()`), and the kinfolk portal, the PDF renderer, the
 * Stripe path (`payInvoice.ts`) and the `onInvoicesWrite` trigger all read them
 * that way. Those fields are NOT going away and are not being re-based here.
 *
 * But they are NOT the arithmetic domain. Adding float dollars is the classic
 * money bug (0.1 + 0.2 is 0.30000000000000004, and $10.10 x 3 is
 * 30.299999999999997), and this codebase already settled on integer cents for
 * new money: `admin/expenses.ts` stores `amountCents`, and the admin's
 * `api/expenses.ts` documents the rule as "an integer count of cents (never a
 * float dollar amount)".
 *
 * So the split is deliberate and one-directional:
 *
 *   lineItems[].unitCents, subtotalCents, totalCents, amountDueCents
 *       are the TRUTH. Every sum below is integer addition, which is exact.
 *
 *   total, amountDue (dollars)
 *       are a DERIVED PROJECTION of the above, written by the same server code
 *       from the same source in one pass. THEY ARE NEVER AN INPUT. Do not edit
 *       one of the two by hand and expect the other to follow; nothing reads a
 *       client-sent total at all.
 *
 * The only multiplication is qty x unitCents, rounded ONCE, half-up, at the line
 * level, before anything is summed. qty is capped at 999 and unitCents at
 * 10,000,000 by the callable's schema, so the product is at most 1e10, well
 * inside the 2^53 exact-integer range: the multiply is exact and the rounding is
 * a deliberate decision about fractional cents, not floating-point slop.
 */

export interface InvoiceLineItemInput {
  description: string;
  /** Units billed. May be fractional (2.5 hours); the line rounds to whole cents. */
  qty: number;
  /** Price per unit, an INTEGER count of cents. */
  unitCents: number;
  /** Optional per-line reduction, an integer count of cents. */
  discountCents?: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
}

/**
 * A broken number reads as "no evidence" (0), never as NaN.
 *
 * Same rule and same reason as `auntieos-admin/src/lib/invoiceFormat.ts`'s
 * `financeNumber`: a single non-finite field must not propagate into a total
 * that then renders "$NaN" on an operator's screen. Refusing the input is the
 * validator's job (`validateInvoiceMoney`); keeping the arithmetic renderable is
 * this function's.
 */
function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * One line's charge, in whole cents. Rounds half-up exactly once, here, so no
 * fractional cent ever reaches a sum.
 */
export function lineAmountCents(li: InvoiceLineItemInput): number {
  const qty = finite(li.qty);
  const unitCents = finite(li.unitCents);
  const discountCents = finite(li.discountCents ?? 0);
  return Math.round(qty * unitCents) - discountCents;
}

/**
 * Every derived figure for one invoice.
 *
 * Negative results are reported HONESTLY rather than clamped at zero. A discount
 * larger than the subtotal, or a payment larger than the total, is an operator
 * error that `validateInvoiceMoney` refuses up front; flooring it here would
 * replace a visible mistake with a plausible-looking $0.00, which is the exact
 * failure class this codebase refuses (see the StatCard dash-not-zero note in
 * `auntieos-admin/src/components/DenScreenKit.tsx`).
 */
export function computeInvoiceTotals(
  lines: readonly InvoiceLineItemInput[],
  invoiceDiscountCents: number,
  paidCents: number,
): InvoiceTotals {
  let subtotalCents = 0;
  for (const li of lines) subtotalCents += lineAmountCents(li);

  const totalCents = subtotalCents - finite(invoiceDiscountCents);
  const paid = finite(paidCents);

  return {
    subtotalCents,
    totalCents,
    paidCents: paid,
    amountDueCents: totalCents - paid,
  };
}

/** One entry of the `invoices/{id}/payments` subcollection, as far as money goes. */
export interface PaymentAmount {
  /** DOLLARS. `markInvoicePaid.ts` writes the callable's `amount` arg verbatim. */
  amount?: number;
}

/**
 * What has actually been collected, in cents.
 *
 * Reads the `payments` SUBCOLLECTION rather than the invoice's own `amountDue`
 * scalar, and that is load-bearing: `markInvoicePaid.ts` sets `amountDue: 0`
 * unconditionally, even when the recorded `amount` is a PARTIAL payment. The
 * scalar therefore cannot answer "how much came in"; only the subcollection can.
 *
 * Each payment is dollar-denominated, so it is rounded to cents individually on
 * the way in and only then added. Rounding after summing floats would reintroduce
 * the drift this module exists to prevent.
 */
export function paidCentsFromPayments(payments: readonly PaymentAmount[]): number {
  let cents = 0;
  for (const p of payments) {
    if (typeof p.amount !== 'number' || !Number.isFinite(p.amount)) continue;
    cents += Math.round(p.amount * 100);
  }
  return cents;
}

/**
 * The legacy dollar projection of a cents figure.
 *
 * `Number((cents / 100).toFixed(2))` rather than a bare division: the division
 * alone can land on a value whose shortest representation carries more than two
 * decimals, and that number is what gets written to a field the portal renders
 * as money.
 */
export function centsToDollars(cents: number): number {
  return Number((finite(cents) / 100).toFixed(2));
}

/** "$36.00" / "-$12.50" from an integer count of cents. */
function usd(cents: number): string {
  const n = finite(cents);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

/**
 * Refuses money that would be a lie if stored. Returns the first problem as
 * operator-facing text, or null when the set is sound.
 *
 * Fail loud and NAME THE NUMBERS: "discount is larger than the subtotal" without
 * the two figures leaves the operator guessing which one to change.
 */
export function validateInvoiceMoney(
  lines: readonly InvoiceLineItemInput[],
  invoiceDiscountCents: number,
): string | null {
  for (const li of lines) {
    const label = li.description.trim();
    if (label === '') return 'Every line item needs a description.';
    if (!Number.isFinite(li.qty) || li.qty <= 0) {
      return `Quantity for "${label}" must be greater than zero.`;
    }
    if (!Number.isInteger(li.unitCents)) {
      return `Unit price for "${label}" must be a whole number of cents.`;
    }
    const discountCents = li.discountCents ?? 0;
    if (!Number.isInteger(discountCents) || discountCents < 0) {
      return `Discount for "${label}" must be a whole number of cents, zero or more.`;
    }
    // Compared against the pre-discount charge, so the message can name it.
    const gross = Math.round(finite(li.qty) * finite(li.unitCents));
    if (discountCents > gross) {
      return `Discount for "${label}" (${usd(discountCents)}) is larger than the line itself (${usd(gross)}).`;
    }
  }

  if (!Number.isInteger(invoiceDiscountCents) || invoiceDiscountCents < 0) {
    return 'Invoice discount must be a whole number of cents, zero or more.';
  }

  const { subtotalCents } = computeInvoiceTotals(lines, 0, 0);
  if (invoiceDiscountCents > subtotalCents) {
    return `Invoice discount (${usd(invoiceDiscountCents)}) is larger than the subtotal (${usd(subtotalCents)}).`;
  }

  return null;
}
