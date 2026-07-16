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

const Args = z.object({
  familyId: z.string().min(1),
  invoiceId: z.string().min(1),
  payload: z.record(z.unknown()),
});

export async function postInvoiceEventHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  const args = Args.parse(req.data);
  // Canonical store is the FLAT top-level `invoices` collection (AuntieOS
  // Android + web write here). Stamp `kinfolkId` so the portal's
  // getMyInvoices (which filters where kinfolkId == id) can see this doc.
  const ref = db().collection('invoices').doc(args.invoiceId);
  const existing = await ref.get();
  const isNew = !existing.exists;
  await ref.set(
    { ...args.payload, kinfolkId: args.familyId, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await writeAuditEntry({
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

  return { ok: true };
}

export const postInvoiceEvent = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('postInvoiceEvent', postInvoiceEventHandler),
);
