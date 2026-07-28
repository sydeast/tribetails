import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { computeInvoiceTotals, validateInvoiceMoney, centsToDollars } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';

/**
 * Server-mints the invoice doc id so the id is authoritative (the composer does
 * not have to invent one). Writes to the canonical FLAT top-level `invoices`
 * collection, stamping `kinfolkId` so the portal's getMyInvoices can see it.
 *
 * `lineItems` IS PURELY ADDITIVE. Every payload that validated before this
 * change still validates and still behaves identically: omit the field and the
 * caller's `total` / `amountDue` are stored verbatim, exactly as they always
 * were, and none of the cents fields are written at all. That matters because
 * the Android composer, every existing test and any un-migrated client still
 * send the legacy 13-key shape.
 *
 * WHEN LINE ITEMS ARE PRESENT, THE SERVER OWNS THE MONEY. Every figure is
 * recomputed from the lines through `lib/invoiceMath.ts`, and the cents fields
 * plus the legacy dollar projection are written from that ONE computation, the
 * same rule `updateInvoice` enforces. `updateInvoice` can state that simply by
 * having no `total` field in its request at all; this callable cannot, because
 * `total` and `amountDue` are REQUIRED by the legacy shape and removing them
 * would break every existing caller.
 *
 * SO A DISAGREEMENT IS REFUSED, NOT SILENTLY OVERWRITTEN. A caller that
 * itemizes an invoice and also asserts a total that is not the sum of those
 * items has a bug, and quietly substituting the server's number would hide that
 * bug while changing what a household is billed. The refusal names BOTH
 * figures. The admin composer derives its total through the MIRRORED
 * `invoiceMath` module, whose fixture table is asserted identical in both trees,
 * so an honest client cannot round its way into this error.
 *
 * `paidCents` is 0 by construction here: an invoice cannot have a payment
 * recorded against it before it exists, so `amountDueCents` equals `totalCents`
 * on creation. It is passed explicitly rather than assumed, so the reader can
 * see which of the four figures is being asserted and which is derived.
 */
const LineItem = z.object({
  description: z.string().min(1).max(200),
  qty: z.number().positive().max(999),
  unitCents: z.number().int().min(0).max(10_000_000),
  discountCents: z.number().int().min(0).optional(),
});

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  familyId: z.string().min(1),
  kinfolkName: z.string().default(''),
  invoiceNumber: z.string().min(1),
  client: z.string().default(''),
  address: z.string().default(''),
  date: z.string().default(''),
  terms: z.string().default(''),
  dueDate: z.string().default(''),
  discount: z.string().default(''),
  total: z.number().nonnegative(),
  amountDue: z.number().nonnegative(),
  status: z.string().default(''),
  sessionIds: z.array(z.string()).default([]),
  /** Optional itemization. Omitted by every legacy caller; see the header. */
  lineItems: z.array(LineItem).max(100).optional(),
  /** Whole-invoice reduction, integer cents. Only meaningful alongside `lineItems`. */
  invoiceDiscountCents: z.number().int().min(0).optional(),
});

/** "$36.00" / "-$12.50" from an integer count of cents, for the refusal message. */
function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Dollars as sent by the caller, for a refusal that has to name their figure too. */
function usdFromDollars(dollars: number): string {
  const sign = dollars < 0 ? '-' : '';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

export async function createInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; invoiceId: string }> {
  const args = Args.parse(req.data);

  // The itemized fields, or nothing at all. An un-itemized invoice must not
  // pick up a `lineItems: []` or a `totalCents: 0`: "nobody itemized this" and
  // "this was itemized as worth nothing" are different claims, and the whole
  // `updateInvoice` un-itemized guard turns on being able to tell them apart.
  let money: Record<string, unknown> = {};

  if (args.lineItems !== undefined) {
    const invoiceDiscountCents = args.invoiceDiscountCents ?? 0;

    const moneyError = validateInvoiceMoney(args.lineItems, invoiceDiscountCents);
    if (moneyError) {
      throw new HttpsError('failed-precondition', moneyError, { code: 'invoice_money_invalid' });
    }

    const totals = computeInvoiceTotals(args.lineItems, invoiceDiscountCents, 0);
    const derivedTotal = centsToDollars(totals.totalCents);
    const derivedAmountDue = centsToDollars(totals.amountDueCents);

    // Name both numbers. "Total does not match the line items" without the two
    // figures leaves the caller guessing which one to change.
    if (args.total !== derivedTotal) {
      throw new HttpsError(
        'failed-precondition',
        `The total sent (${usdFromDollars(args.total)}) is not the sum of the line items (${usd(totals.totalCents)}). The line items decide the total, so send that figure or correct the items.`,
        { code: 'invoice_total_mismatch' },
      );
    }
    if (args.amountDue !== derivedAmountDue) {
      throw new HttpsError(
        'failed-precondition',
        `The amount due sent (${usdFromDollars(args.amountDue)}) is not the line-item total (${usd(totals.amountDueCents)}). A new invoice has no payments recorded against it, so the two are the same figure.`,
        { code: 'invoice_amount_due_mismatch' },
      );
    }

    money = {
      lineItems: args.lineItems,
      invoiceDiscountCents,
      subtotalCents: totals.subtotalCents,
      totalCents: totals.totalCents,
      amountDueCents: totals.amountDueCents,
    };
  }

  const ref = db().collection('invoices').doc();
  const doc = {
    kinfolkName: args.kinfolkName,
    invoiceNumber: args.invoiceNumber,
    client: args.client,
    address: args.address,
    date: args.date,
    terms: args.terms,
    dueDate: args.dueDate,
    discount: args.discount,
    total: args.total,
    amountDue: args.amountDue,
    status: args.status,
    sessionIds: args.sessionIds,
    kinfolkId: args.familyId,
    _id: ref.id,
    ...money,
  };
  // The state stamp (ADR-0002), IN THE SAME WRITE as the money it describes.
  // Spread AFTER the caller's fields: it canonicalizes `status` to the
  // classifier's reading of this very doc (a caller's 'sent' or '' stores as
  // 'open'), which is the vocabulary all three clients' own classifiers
  // already resolve these fields to. paidCents is 0 by construction: a payment
  // cannot be recorded against an invoice before it exists.
  await ref.set({
    ...doc,
    ...invoiceStateStampOf(doc, 0),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: {
      invoiceId: ref.id,
      invoiceNumber: args.invoiceNumber,
      itemized: args.lineItems !== undefined,
      lineCount: args.lineItems?.length ?? 0,
    },
  });

  const recipientUid = await resolveKinfolkUid(args.familyId);
  try {
    await enqueueNotification({
      key: 'invoice.new',
      recipientUid: recipientUid ?? '',
      data: { kinfolkId: args.familyId, invoiceId: ref.id },
      targetType: 'invoice',
      targetId: ref.id,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'createInvoice',
      event: 'notification.dispatch.failed',
      extra: { familyId: args.familyId, invoiceId: ref.id, key: 'invoice.new', err: (err as Error)?.message },
    });
  }

  return { ok: true, invoiceId: ref.id };
}

export const createInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createInvoice', createInvoiceHandler),
);
