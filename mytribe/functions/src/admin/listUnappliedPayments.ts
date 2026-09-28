import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';

import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { refuseAuntie } from '../lib/staffGate';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { invoiceIsPaid } from '../lib/invoicePaidGate';
import { invoiceTotalCentsOf } from '../lib/invoiceMath';
import { isDraftOrQuote, refusedLifecycle, type InvoiceDoc } from './markInvoicePaid';
import { unappliedReasonLabel } from '../lib/invoiceCheckoutDedupe';

/**
 * THE PAYMENTS WAITING FOR THE ADMIN'S DECISION, for one household (#1003).
 *
 * Reads the root `payments` rows the Stripe webhook flagged with
 * `needsAdminDecision: true` (docket Q5, PR #1001), and the household's open
 * invoices a decision may apply one to. The second list is here so every admin
 * client picks from the same server-vetted set instead of restating "open":
 * sent, not cancelled or a credit note, not paid by label or by money
 * (`lib/invoicePaidGate.ts`), and something still owed. `resolveUnappliedPayment`
 * re-checks all of it inside its transaction, so this list is a convenience and
 * never the gate.
 *
 * WHO. Same as `resolveUnappliedPayment`: the owner, or a sandbox test admin
 * inside their own test tribe. An Auntie never sees money. Kinfolk are refused.
 * The household is told nothing until the admin decides, so there is no portal
 * reader.
 *
 * Two equality filters and no `orderBy`, so no composite index. Sorted here,
 * newest first.
 */

/** More than any household will ever have waiting; a guard, not a page size. */
export const MAX_UNAPPLIED_LISTED = 200;
/** The household's invoices scanned for open ones. */
export const MAX_INVOICES_SCANNED = 500;

export const Args = z
  .object({
    kinfolkId: z.string().min(1).max(200),
  })
  .strict();

const UnappliedPaymentSchema = z
  .object({
    paymentId: z.string().min(1),
    kinfolkId: z.string(),
    /** The invoice the charge came in for (already paid, or a stale round). */
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    /** 0 when Stripe reported no amount; see `amountResolved`. */
    amountCents: CentsSchema,
    amountResolved: z.boolean(),
    /** Stripe's fee, 0 when unknown. Shown, never subtracted from what can be credited. */
    feeCents: CentsSchema,
    /** A plain sentence: why it was not applied. */
    reason: z.string(),
    /** When the charge was recorded, epoch ms; 0 when unknown. */
    receivedAtMs: z.number().int(),
    referenceNumber: z.string(),
  })
  .strict();

const OpenInvoiceSchema = z
  .object({
    invoiceId: z.string().min(1),
    invoiceNumber: z.string(),
    amountDueCents: CentsSchema,
  })
  .strict();

export const Result = z
  .object({
    ok: OkSchema,
    kinfolkId: z.string().min(1),
    /** Newest first. */
    payments: z.array(UnappliedPaymentSchema),
    /** Invoices a decision may apply a payment to, oldest first. */
    openInvoices: z.array(OpenInvoiceSchema),
  })
  .strict();

export type ListUnappliedPaymentsArgs = z.infer<typeof Args>;
export type ListUnappliedPaymentsResult = z.infer<typeof Result>;
export type UnappliedPaymentDto = z.infer<typeof UnappliedPaymentSchema>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function intOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** Firestore Timestamp, Date, or millis to epoch ms. 0 when none of those. */
export function millisOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (v instanceof Date) return v.getTime();
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => unknown }).toMillis();
    return typeof ms === 'number' ? ms : 0;
  }
  return 0;
}

/** What is still owed, from the stored fields. The resolve re-derives it from the payments. */
export function openAmountDueCents(doc: Record<string, unknown>): number {
  const cents = doc['amountDueCents'];
  if (typeof cents === 'number' && Number.isFinite(cents)) return Math.max(0, Math.round(cents));
  const dollars = doc['amountDue'];
  if (typeof dollars === 'number' && Number.isFinite(dollars)) return Math.max(0, Math.round(dollars * 100));
  return Math.max(0, invoiceTotalCentsOf(doc as never));
}

/** Can a decision apply money to this invoice, on what it states about itself? */
export function invoiceTakesDecision(doc: Record<string, unknown>): boolean {
  const inv = doc as InvoiceDoc;
  if (isDraftOrQuote(inv)) return false;
  if (refusedLifecycle(inv) !== null) return false;
  if (invoiceIsPaid(doc as never)) return false;
  if (doc['archived'] === true) return false;
  return openAmountDueCents(doc) > 0;
}

export async function listUnappliedPaymentsHandler(
  req: CallableRequest<unknown>,
): Promise<ListUnappliedPaymentsResult> {
  initSentry();
  refuseAuntie(req.auth, 'listUnappliedPayments');
  const actor = resolveInvoiceWriteActor(req, 'listUnappliedPayments');

  let args: ListUnappliedPaymentsArgs;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listUnappliedPayments validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  if (!testOwnsDoc(actor.testMode, args.kinfolkId)) {
    throw new HttpsError('permission-denied', 'This household is outside your test sandbox.');
  }

  const firestore = db();
  const [paymentsSnap, invoicesSnap] = await Promise.all([
    firestore
      .collection('payments')
      .where('kinfolkId', '==', args.kinfolkId)
      .where('needsAdminDecision', '==', true)
      .limit(MAX_UNAPPLIED_LISTED)
      .get(),
    firestore.collection('invoices').where('kinfolkId', '==', args.kinfolkId).limit(MAX_INVOICES_SCANNED).get(),
  ]);

  const numberById = new Map<string, string>();
  const openInvoices: Array<{ invoiceId: string; invoiceNumber: string; amountDueCents: number; at: number }> = [];
  for (const d of invoicesSnap.docs) {
    const data = (d.data() ?? {}) as Record<string, unknown>;
    numberById.set(d.id, str(data['invoiceNumber']));
    if (!invoiceTakesDecision(data)) continue;
    openInvoices.push({
      invoiceId: d.id,
      invoiceNumber: str(data['invoiceNumber']),
      amountDueCents: openAmountDueCents(data),
      at: millisOf(data['createdAt']) || millisOf(data['issueDate']),
    });
  }
  openInvoices.sort((a, b) => a.at - b.at || a.invoiceId.localeCompare(b.invoiceId));

  const payments = paymentsSnap.docs
    .map((d) => {
      const row = (d.data() ?? {}) as Record<string, unknown>;
      const invoiceId = str(row['invoiceId']);
      const amountCents = intOr0(row['amountCents']);
      return {
        paymentId: d.id,
        kinfolkId: str(row['kinfolkId']),
        invoiceId,
        invoiceNumber: str(row['invoiceNumber']) || numberById.get(invoiceId) || '',
        amountCents,
        amountResolved: row['amountResolved'] !== false && amountCents > 0,
        feeCents: intOr0(row['feeCents']),
        reason: unappliedReasonLabel(typeof row['duplicateCheckoutReason'] === 'string' ? row['duplicateCheckoutReason'] : null),
        receivedAtMs: millisOf(row['date']),
        referenceNumber: str(row['referenceNumber']),
      };
    })
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs || a.paymentId.localeCompare(b.paymentId));

  return validateResponse('listUnappliedPayments', Result, {
    ok: true,
    kinfolkId: args.kinfolkId,
    payments,
    openInvoices: openInvoices.map(({ at: _at, ...rest }) => rest),
  });
}

export const listUnappliedPayments = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('listUnappliedPayments', listUnappliedPaymentsHandler),
);
