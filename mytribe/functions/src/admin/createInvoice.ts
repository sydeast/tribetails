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

// Server-mints the invoice doc id so the id is authoritative (the composer does
// not have to invent one). Writes to the canonical FLAT top-level `invoices`
// collection, stamping `kinfolkId` so the portal's getMyInvoices can see it.
const Args = z.object({
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
});

export async function createInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; invoiceId: string }> {
  const args = Args.parse(req.data);

  const ref = db().collection('invoices').doc();
  await ref.set({
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
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: { invoiceId: ref.id, invoiceNumber: args.invoiceNumber },
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
