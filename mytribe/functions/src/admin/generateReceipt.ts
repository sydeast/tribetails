import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { contentDedupeKey, enqueueNotification } from '../notifications/dispatcher';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

// Marks an existing invoice receipted and enqueues the kinfolk-facing
// invoice.receipt notification. Fails loud (not-found) when the invoice is
// missing rather than silently creating one.
export const Args = z.object({
  invoiceId: z.string().min(1),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Deliberately just `ok`: this
 * callable identifies the invoice in the REQUEST, and echoing an id back that
 * the caller supplied would read like a server-side confirmation of something
 * the server never minted. `.strict()`, so adding one is a deliberate act.
 */
export const Result = z.object({ ok: OkSchema }).strict();

/**
 * #832: the dispatcher identity of one receipt, named by WHAT IT RECEIPTS.
 *
 * A receipt says what was paid against an invoice: the total collected and
 * the payments that make it up. A second press, or a retry after the first
 * press committed, receipts the same payments and so carries the same key and
 * is deduped. A receipt issued after a new payment landed receipts something
 * different and sends.
 *
 * It replaces a stored receipt counter, which a retry after the first commit
 * read one higher and so sent a second, identical receipt.
 */
export function receiptDedupeKey(
  invoiceId: string,
  invoice: { total?: unknown; totalCents?: unknown } | undefined,
  payments: ReadonlyArray<{ id: string; data: PaymentAmount }>,
): string {
  return contentDedupeKey(`invoice:${invoiceId}:receipt`, {
    paidCents: paidCentsFromPayments(payments.map((p) => p.data)),
    paymentIds: payments.map((p) => p.id).sort(),
    total: invoice?.totalCents ?? invoice?.total ?? null,
  });
}

export async function generateReceiptHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  const args = Args.parse(req.data);

  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `invoice ${args.invoiceId} not found`);
  }
  const stored = snap.data() as { kinfolkId?: string; total?: unknown; totalCents?: unknown } | undefined;
  const familyId = stored?.kinfolkId ?? '';
  const paymentsSnap = await ref.collection('payments').get();
  const payments = paymentsSnap.docs.map((d) => ({ id: d.id, data: d.data() as PaymentAmount }));

  await ref.set(
    {
      receiptIssuedAt: FieldValue.serverTimestamp(),
      receiptIssuedBy: req.auth!.uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_RECEIPT_ISSUED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId,
    payload: { invoiceId: args.invoiceId },
  });

  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    await enqueueNotification({
      key: 'invoice.receipt',
      recipientUid: recipientUid ?? '',
      data: { kinfolkId: familyId, invoiceId: args.invoiceId },
      dedupeKey: receiptDedupeKey(args.invoiceId, stored, payments),
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'generateReceipt',
      event: 'notification.dispatch.failed',
      extra: { familyId, invoiceId: args.invoiceId, key: 'invoice.receipt', err: (err as Error)?.message },
    });
  }

  return validateResponse('generateReceipt', Result, { ok: true });
}

export const generateReceipt = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('generateReceipt', generateReceiptHandler),
);
