import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { invoiceStateOf, invoiceEditRefusal } from '../lib/invoiceEditPolicy';
import {
  computeInvoiceTotals,
  paidCentsFromPayments,
  validateInvoiceMoney,
  centsToDollars,
  type InvoiceLineItemInput,
} from '../lib/invoiceMath';

/**
 * Edits an invoice: its descriptive fields, its line items, or both.
 *
 * THE SERVER OWNS EVERY TOTAL. The request has no `total` and no `amountDue`
 * field, and `patch` is `.strict()`, so a client that tries to assert what an
 * invoice is worth gets `invalid-argument` rather than having its number quietly
 * dropped. Every money field on the doc is recomputed here from the stored line
 * items and the recorded payments (`lib/invoiceMath.ts`), so the figure the
 * household sees can only ever be the sum of the lines it is shown.
 *
 * WHY A CALLABLE AT ALL, when `firestore.rules` already lets an admin write this
 * collection (`allow update: if isAuntie()`): the rule validates NOTHING. It
 * cannot recompute a total, it cannot read the payments subcollection to decide
 * whether the money is frozen, and it cannot refuse an edit to a paid invoice.
 * A UI-only version of those rules is not a guard, as the booking-notes cutoff
 * incident already established in this codebase.
 *
 * @see lib/invoiceEditPolicy.ts for WHICH invoices may be edited and how much.
 * @see lib/invoiceMath.ts for the cents-vs-dollars split.
 */

const LineItem = z.object({
  description: z.string().min(1).max(200),
  qty: z.number().positive().max(999),
  unitCents: z.number().int().min(0).max(10_000_000),
  discountCents: z.number().int().min(0).optional(),
});

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  patch: z
    .object({
      invoiceNumber: z.string().min(1).max(60).optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      terms: z.string().max(2000).optional(),
      lineItems: z.array(LineItem).max(100).optional(),
      invoiceDiscountCents: z.number().int().min(0).optional(),
    })
    .strict()
    // An empty patch is a caller bug, not a no-op to absorb: it would stamp
    // `updatedAt` and write an audit entry describing a change that did not
    // happen.
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must change at least one field' }),
});

type InvoiceDoc = {
  kinfolkId?: string;
  invoiceNumber?: string;
  status?: unknown;
  amountDue?: unknown;
  total?: unknown;
  creditRedeemedAt?: unknown;
  lineItems?: unknown;
  invoiceDiscountCents?: unknown;
  [k: string]: unknown;
};

/** The stored line items, or null when this invoice has never been itemized. */
function storedLineItems(data: InvoiceDoc): InvoiceLineItemInput[] | null {
  return Array.isArray(data.lineItems) ? (data.lineItems as InvoiceLineItemInput[]) : null;
}

export async function updateInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<{
  ok: true;
  invoiceId: string;
  totals: { subtotalCents: number; totalCents: number; paidCents: number; amountDueCents: number };
}> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'updateInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { invoiceId, patch } = args;
  const ref = db().collection('invoices').doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Invoice '${invoiceId}' not found.`);
  const data = snap.data() as InvoiceDoc;

  // The payments SUBCOLLECTION, not the `amountDue` scalar. markInvoicePaid
  // zeroes that scalar even for a partial payment, so it cannot answer either
  // "has anyone paid" or "how much came in".
  const paymentsSnap = await ref.collection('payments').get();
  const payments = paymentsSnap.docs.map((d) => d.data() as { amount?: number });
  const hasPayments = payments.length > 0;
  const paidCents = paidCentsFromPayments(payments);

  const touchesMoney = patch.lineItems !== undefined || patch.invoiceDiscountCents !== undefined;

  const refusal = invoiceEditRefusal(invoiceStateOf(data), hasPayments, touchesMoney);
  if (refusal) {
    throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (patch.invoiceNumber !== undefined) update['invoiceNumber'] = patch.invoiceNumber;
  if (patch.date !== undefined) update['date'] = patch.date;
  if (patch.dueDate !== undefined) update['dueDate'] = patch.dueDate;
  if (patch.terms !== undefined) update['terms'] = patch.terms;

  // WHETHER TO RECOMPUTE AT ALL. Every invoice that exists today is
  // un-itemized, so "sum of zero lines" is NOT the same statement as "this
  // invoice is worth nothing". Recomputing here would silently rewrite a real
  // $40 invoice to $0 because the operator corrected its due date. The money is
  // only ever recomputed when this invoice actually has lines, or when this
  // patch is the thing giving it its first ones.
  const lines: InvoiceLineItemInput[] | null = touchesMoney
    ? (patch.lineItems ?? storedLineItems(data) ?? [])
    : storedLineItems(data);

  let totals = computeInvoiceTotals(lines ?? [], 0, paidCents);

  if (lines !== null) {
    const invoiceDiscountCents =
      patch.invoiceDiscountCents ??
      (typeof data.invoiceDiscountCents === 'number' ? data.invoiceDiscountCents : 0);

    const moneyError = validateInvoiceMoney(lines, invoiceDiscountCents);
    if (moneyError) throw new HttpsError('failed-precondition', moneyError, { code: 'invoice_money_invalid' });

    totals = computeInvoiceTotals(lines, invoiceDiscountCents, paidCents);

    if (patch.lineItems !== undefined) update['lineItems'] = patch.lineItems;
    update['invoiceDiscountCents'] = invoiceDiscountCents;
    update['subtotalCents'] = totals.subtotalCents;
    update['totalCents'] = totals.totalCents;
    update['amountDueCents'] = totals.amountDueCents;
    // The legacy dollar scalars, written from the SAME cents figures in the same
    // pass so the two can never disagree. A projection, never an input.
    update['total'] = centsToDollars(totals.totalCents);
    update['amountDue'] = centsToDollars(totals.amountDueCents);
  }

  await ref.set(update, { merge: true });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    description: `Invoice ${data.invoiceNumber ?? invoiceId} edited`,
    payload: {
      invoiceId,
      fields: Object.keys(patch),
      itemized: lines !== null,
      totalCents: lines !== null ? totals.totalCents : null,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'updateInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'updateInvoice',
    event: 'admin.invoice.updated',
    uid,
    extra: { invoiceId, fields: Object.keys(patch), itemized: lines !== null },
  });

  return { ok: true, invoiceId, totals };
}

export const updateInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('updateInvoice', updateInvoiceHandler),
);
