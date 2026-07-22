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

/**
 * Dedicated manual-payment callable, replacing the AuntieOS admin's prior
 * `postInvoiceEvent({ payload: { status: 'paid', amountDue: 0 } })` workaround
 * (see auntieos-admin/src/api/invoicesWrite.ts's pre-existing header note).
 * That path merged a status flip with no dedicated guard and, critically, no
 * payment record: `postInvoiceEvent` only ever merges an arbitrary payload
 * onto the invoice doc, so a manually-recorded payment left no trace of who
 * recorded it, by what method, or against what reference number.
 *
 * This callable closes that gap: it writes a `payments` subcollection entry
 * (the audit-grade record: amount/method/reference/paidAt/recordedBy) in the
 * SAME batch as the invoice status flip, so the two either both land or
 * neither does, there is never a "marked paid with no payment record" state.
 *
 * Canonical store is the FLAT top-level `invoices` collection (the same one
 * createInvoice/postInvoiceEvent/sendInvoiceReminder read and write).
 *
 * Notification: deliberately NOT enqueued here. `onInvoicesWrite` (the
 * invoices-collection trigger) already fires `invoice.payment.applied`
 * whenever a Firestore write to ANY invoice doc flips its resolved lifecycle
 * into 'paid' (admin UI direct write, callable, or the Stripe webhook, per
 * that trigger's own header comment). Enqueuing the same notification again
 * here would double-send it for this write path specifically. The trigger
 * reacts to the actual persisted state, so it can never fire out of step
 * with what this callable really wrote.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  /** Dollar amount actually collected. Defaults to the invoice's current amountDue (paying it off in full). */
  amount: z.number().nonnegative().optional(),
  /** Free-text payment method, e.g. "check", "cash", "venmo". */
  method: z.string().trim().min(1).max(200).optional(),
  /** Free-text reference/confirmation number for the payment. */
  reference: z.string().trim().min(1).max(200).optional(),
  /** ISO-8601 timestamp for when the payment was actually received (for recording a past payment). Defaults to now. */
  paidAt: z.string().optional(),
});

type InvoiceDoc = {
  kinfolkId?: string;
  status?: string;
  paymentStatus?: string;
  invoiceNumber?: string;
  amountDue?: number;
  total?: number;
  [k: string]: unknown;
};

function normalizedStatus(d: InvoiceDoc): string {
  return typeof d.status === 'string' ? d.status.trim().toLowerCase() : '';
}

function isAlreadyPaid(d: InvoiceDoc): boolean {
  return d.paymentStatus === 'PAID' || normalizedStatus(d) === 'paid';
}

function isDraftOrQuote(d: InvoiceDoc): boolean {
  const s = normalizedStatus(d);
  return s === 'draft' || s === 'quote';
}

export async function markInvoicePaidHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; invoiceId: string; paymentId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'markInvoicePaid validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  }
  const data = snap.data() as InvoiceDoc;

  if (isAlreadyPaid(data)) {
    throw new HttpsError('failed-precondition', 'Invoice is already paid.');
  }
  if (isDraftOrQuote(data)) {
    throw new HttpsError(
      'failed-precondition',
      'Invoice is a draft or quote; send it first before recording a payment.',
    );
  }

  const familyId = data.kinfolkId;
  const paidAmount = args.amount ?? (typeof data.amountDue === 'number' ? data.amountDue : 0);
  const paidAtIso = args.paidAt ?? new Date().toISOString();

  const paymentRef = ref.collection('payments').doc();
  const batch = db().batch();
  batch.set(paymentRef, {
    amount: paidAmount,
    method: args.method ?? null,
    reference: args.reference ?? null,
    paidAt: paidAtIso,
    recordedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    ref,
    {
      status: 'paid',
      amountDue: 0,
      paymentMethod: args.method ?? null,
      paymentReference: args.reference ?? null,
      paidAt: FieldValue.serverTimestamp(),
      paidBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_PAID,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId,
    description: `Invoice ${data.invoiceNumber ?? args.invoiceId} marked paid manually`,
    payload: {
      invoiceId: args.invoiceId,
      kinfolkId: familyId ?? null,
      amount: paidAmount,
      method: args.method ?? null,
      reference: args.reference ?? null,
      paymentId: paymentRef.id,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'markInvoicePaid',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'markInvoicePaid',
    event: 'admin.invoice.paid.recorded',
    uid,
    extra: { invoiceId: args.invoiceId, kinfolkId: familyId, paymentId: paymentRef.id },
  });

  return { ok: true, invoiceId: args.invoiceId, paymentId: paymentRef.id };
}

export const markInvoicePaid = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('markInvoicePaid', markInvoicePaidHandler),
);
