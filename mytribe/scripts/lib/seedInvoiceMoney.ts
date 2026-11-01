/**
 * Canonical invoice money for the seed scripts (#1368).
 *
 * The sandbox and demo seeds used to write invoice lines as `{label, amount}`,
 * a shape no reader understands (`getMyInvoices#storedLineItemsFrom` drops every
 * such row), and the sandbox wrote CENTS into the DOLLAR fields `total` and
 * `amountDue` ($4,500 for a $45 visit).
 *
 * This builds the same document fragment `admin/createInvoice.ts` writes:
 *
 *   lineItems[]   { description, qty, unitCents, discountCents, sessionId }
 *   *Cents        subtotalCents, totalCents, amountDueCents (integer truth),
 *                 paidCents (what the payment path stamps)
 *   total, amountDue
 *                 float DOLLARS, derived from the cents by `centsToDollars`
 *   editScope     the ADR-0002 state stamp's scope, from `invoiceStateStampOf`
 *                 (the seed's own `status` is asserted against the stamp in
 *                 the seed tests)
 *
 * Every number comes from `lib/invoiceMath.ts`, the single place the real
 * writers derive them, so the seed cannot drift from the writers by hand.
 * NEVER run a seed against prod; the callers gate on their own --apply flags.
 */
import { computeInvoiceTotals, centsToDollars } from '../../functions/src/lib/invoiceMath';
import { invoiceStateStampOf } from '../../functions/src/lib/invoiceStateStamp';
export interface SeedInvoiceLine {
  description: string;
  qty: number;
  /** INTEGER cents. Negative on a credit line. */
  unitCents: number;
  /** The visit this line bills for, or '' for a hand-typed line. */
  sessionId?: string;
}
export interface SeedInvoiceMoney {
  lineItems: Array<Required<SeedInvoiceLine> & { discountCents: number }>;
  invoiceDiscountCents: number;
  subtotalCents: number;
  totalCents: number;
  amountDueCents: number;
  paidCents: number;
  /** DOLLARS (float). */
  total: number;
  /** DOLLARS (float); negative is the credit signal. */
  amountDue: number;
  /** The ADR-0002 edit scope the stamp assigns this state. */
  editScope: string;
}
export function canonicalInvoiceMoney(
  lines: readonly SeedInvoiceLine[],
  paidCents = 0,
  /** The state the seed means this invoice to be in; the stamp must agree. */
  intendedStatus: 'open' | 'paid' | 'credit' = 'open',
): SeedInvoiceMoney {
  const lineItems = lines.map((l) => ({
    description: l.description,
    qty: l.qty,
    unitCents: l.unitCents,
    discountCents: 0,
    sessionId: l.sessionId ?? '',
  }));
  const totals = computeInvoiceTotals(lineItems, 0, paidCents);
  const total = centsToDollars(totals.totalCents);
  const amountDue = centsToDollars(totals.amountDueCents);
  const stamp = invoiceStateStampOf(
    { status: intendedStatus, total, amountDue, totalCents: totals.totalCents, amountDueCents: totals.amountDueCents },
    paidCents,
  );
  return {
    lineItems,
    invoiceDiscountCents: 0,
    subtotalCents: totals.subtotalCents,
    totalCents: totals.totalCents,
    amountDueCents: totals.amountDueCents,
    paidCents,
    total,
    amountDue,
    editScope: stamp.editScope,
  };
}

/**
 * A credit document: money owed BACK to the household, as a negative balance.
 *
 * It carries NO stored lines, deliberately. No writer produces a negative line:
 * the reader's `unitCents` is non-negative (`CentsSchema`), so a `-2000` line is
 * rejected by `InvoiceLineItemDtoSchema` and the whole invoice detail fails.
 * Real credits are the legacy shape, money fields only; the reader then derives
 * the breakdown from the invoice's `sessionIds`.
 */
export function canonicalCreditMoney(creditCents: number): SeedInvoiceMoney {
  const cents = -Math.abs(creditCents);
  const dollars = centsToDollars(cents);
  const stamp = invoiceStateStampOf(
    { status: 'credit', total: dollars, amountDue: dollars, totalCents: cents, amountDueCents: cents },
    0,
  );
  return {
    lineItems: [],
    invoiceDiscountCents: 0,
    subtotalCents: cents,
    totalCents: cents,
    amountDueCents: cents,
    paidCents: 0,
    total: dollars,
    amountDue: dollars,
    editScope: stamp.editScope,
  };
}
