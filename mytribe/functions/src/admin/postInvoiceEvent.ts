import { onCall, CallableRequest } from 'firebase-functions/v2/https';
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
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

export const Args = z.object({
  familyId: z.string().min(1),
  invoiceId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Deliberately just `ok`: this
 * callable identifies the invoice in the REQUEST, and echoing an id back that
 * the caller supplied would read like a server-side confirmation of something
 * the server never minted. `.strict()`, so adding one is a deliberate act.
 */
export const Result = z.object({ ok: OkSchema }).strict();

export async function postInvoiceEventHandler(req: CallableRequest<unknown>): Promise<z.infer<typeof Result>> {
  const args = Args.parse(req.data);
  // Canonical store is the FLAT top-level `invoices` collection (AuntieOS
  // Android + web write here). Stamp `kinfolkId` so the portal's
  // getMyInvoices (which filters where kinfolkId == id) can see this doc.
  const ref = db().collection('invoices').doc(args.invoiceId);
  const existing = await ref.get();
  const isNew = !existing.exists;
  // This callable merges an ARBITRARY payload, so of all the invoice writers
  // it is the one that most needs the state stamp (ADR-0002): any field the
  // classifier reads may be about to change. The stamp is derived from the doc
  // as this merge leaves it, with the payment standing read from the payments
  // SUBCOLLECTION (never the amountDue scalar), and joins the same set. It is
  // spread AFTER the payload: a payload status spelling the classifier does
  // not recognize is canonicalized, exactly as every client classifier would
  // have resolved it at read time.
  const paymentsSnap = await ref.collection('payments').get();
  const paidCents = paidCentsFromPayments(paymentsSnap.docs.map((d) => d.data() as PaymentAmount));
  const merged: Record<string, unknown> = {
    ...(existing.data() ?? {}),
    ...args.payload,
    kinfolkId: args.familyId,
  };
  await ref.set(
    {
      ...args.payload,
      kinfolkId: args.familyId,
      ...invoiceStateStampOf(merged, paidCents),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: { invoiceId: args.invoiceId },
  });

  const recipientUid = await resolveKinfolkUid(args.familyId);
  const key = isNew ? 'invoice.new' : 'invoice.updated';
  try {
    await enqueueNotification({
      key,
      recipientUid: recipientUid ?? '',
      data: { kinfolkId: args.familyId, invoiceId: args.invoiceId },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'postInvoiceEvent',
      event: 'notification.dispatch.failed',
      extra: { familyId: args.familyId, invoiceId: args.invoiceId, key, err: (err as Error)?.message },
    });
  }

  return validateResponse('postInvoiceEvent', Result, { ok: true });
}

export const postInvoiceEvent = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('postInvoiceEvent', postInvoiceEventHandler),
);
