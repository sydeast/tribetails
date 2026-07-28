import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveInvoiceWriteActor, scopedKinfolkId } from '../lib/testMode';

/**
 * Creates a row in the ROOT `payments` collection. W2-1 of ADR-0002
 * (docs/adr/0002-callable-only-invoice-writes.md): this absorbs
 * `AuntieRepository.createPayment`, Android's last direct Firestore write on
 * money data.
 *
 * THIS IS NOT `markInvoicePaid`, AND DELIBERATELY DOES NOT CALL IT. The two
 * write different collections with different jobs, and Android's own
 * record-payment flow (`InvoiceDetailViewModel.recordPayment`) already calls
 * them as two steps:
 *
 *   1. `markInvoicePaid`, the MONEY AUTHORITY. Writes the
 *      `invoices/{id}/payments` SUBCOLLECTION entry and re-derives the
 *      invoice's settlement from the sum of every recorded payment, in one
 *      batch. Requires an invoice; refuses drafts, quotes, cancelled invoices,
 *      credits and settled invoices.
 *   2. The ROOT `payments` row, a DISPLAY RECORD. The payments screens
 *      (`getPayments`, `getPaymentsForKinfolk`, the invoice detail's
 *      linked-payments list joined on `invoiceId`) read this collection and
 *      nothing else; the server's settlement arithmetic never reads it, so the
 *      two cannot double-count. `stripeWebhook.ts` writes card payments here
 *      too. It can also exist with NO invoice at all (the admin Payments tab
 *      records standalone payments through `AdminDataViewModel.createPayment`).
 *
 * Step 1 already goes through a callable; step 2 is the direct write this
 * callable replaces. Folding step 1 into this one was considered and rejected:
 * `markInvoicePaid`'s refusal surface (already-settled, draft, credit) is
 * wrong for a standalone display row, and a combined callable would force the
 * standalone flow to skip those guards with a flag, which is how guards stop
 * being guards.
 *
 * TESTMODE SCOPING IS SERVER-SIDE now (lib/testMode.ts). Android's version was
 * client-side: `mode.scopedKinfolkId(payment.kinfolkId)` rewrote the field
 * before the write, which any modified client could skip. Here a sandbox
 * caller's row is stamped `kinfolkId = testTribeId` no matter what the request
 * says.
 *
 * NO CLASSIFIER STATE IS PERSISTED HERE: `status`/`editScope` live on invoice
 * docs and this callable writes none (the invoice side of a payment is
 * `markInvoicePaid`'s write, which the feat/invoice-state-persist sweep
 * covers).
 *
 * The field set mirrors Android's `Payment` model (data/model/Models.kt)
 * verbatim, dollars-as-floats included: this is the legacy display shape,
 * per the money-units note in CALLABLE_CONTRACT.md. `date` and `email` are
 * free text like the rest of the legacy billing fields. The server adds
 * `recordedBy` + `createdAt`, which the direct write never had: a payment row
 * nobody signed was fine when only admins could write it, and is not fine as
 * an audit-relevant record.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  /** Household the payment belongs to. May be blank (legacy standalone rows). Overridden by the sandbox scope in test mode. */
  kinfolkId: z.string().max(120).default(''),
  kinfolkName: z.string().max(200).default(''),
  client: z.string().max(200).default(''),
  address: z.string().max(500).default(''),
  /** Free text, like every legacy billing date field. */
  date: z.string().max(40).default(''),
  paymentMethod: z.string().max(200).default(''),
  referenceNumber: z.string().max(200).default(''),
  email: z.string().max(200).default(''),
  /** DOLLARS, floating point: the legacy shape of this collection. */
  amount: z.number().min(0).max(10_000_000),
  tip: z.number().min(0).max(10_000_000).default(0),
  notes: z.string().max(4000).default(''),
  /** Confident payment->invoice link; '' for a standalone payment. */
  invoiceId: z.string().max(200).default(''),
  invoiceNumber: z.string().max(200).default(''),
});

export interface RecordPaymentResult {
  ok: true;
  paymentId: string;
  /** The kinfolkId actually stored: the sandbox id when the caller is a test admin. */
  kinfolkId: string;
}

export async function recordPaymentHandler(
  req: CallableRequest<unknown>,
): Promise<RecordPaymentResult> {
  initSentry();
  const actor = resolveInvoiceWriteActor(req, 'recordPayment');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'recordPayment validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const kinfolkId = scopedKinfolkId(actor.testMode, args.kinfolkId);
  const ref = db().collection('payments').doc();
  // No `id` field inside the doc: Android's `@DocumentId` property is excluded
  // from serialization, so the direct write never stored one either.
  await ref.set({
    kinfolkId,
    kinfolkName: args.kinfolkName,
    client: args.client,
    address: args.address,
    date: args.date,
    paymentMethod: args.paymentMethod,
    referenceNumber: args.referenceNumber,
    email: args.email,
    amount: args.amount,
    tip: args.tip,
    notes: args.notes,
    invoiceId: args.invoiceId,
    invoiceNumber: args.invoiceNumber,
    recordedBy: actor.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_PAYMENT_RECORDED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: actor.uid,
    targetUid: ref.id,
    targetCollection: 'payments',
    familyId: kinfolkId || undefined,
    description: args.invoiceId
      ? `Payment row recorded against invoice ${args.invoiceNumber || args.invoiceId}`
      : 'Standalone payment row recorded',
    payload: {
      paymentId: ref.id,
      kinfolkId,
      invoiceId: args.invoiceId,
      amount: args.amount,
      tip: args.tip,
      method: args.paymentMethod,
      reference: args.referenceNumber,
      testMode: actor.testMode.active,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'audit.write.failed',
      uid: actor.uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'recordPayment',
    event: 'admin.payment.recorded',
    uid: actor.uid,
    extra: {
      paymentId: ref.id,
      kinfolkId,
      invoiceId: args.invoiceId,
      testMode: actor.testMode.active,
    },
  });

  return { ok: true, paymentId: ref.id, kinfolkId };
}

export const recordPayment = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped
  // test admin (ADR-0002 funnels the sandbox through this same callable).
  // resolveInvoiceWriteActor at the top of the handler is the whole gate.
  wrapCallable('recordPayment', recordPaymentHandler),
);
