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
import { isArchived, type ArchivableInvoice } from '../lib/invoiceArchive';

/**
 * Restores an archived invoice to the operator's working list.
 *
 * Writes `archivedAt: null` rather than deleting the field. See
 * `lib/invoiceArchive.ts` for why that shape matters: a restored invoice then
 * carries what a future backfill would give every legacy invoice, and the
 * admin's `isArchivedInvoice` already reads null as "not archived".
 *
 * Refuses an invoice that was never archived, rather than writing a null over a
 * field that was already absent. That write would look like a no-op but would
 * quietly change which Firestore predicates the document matches, which is
 * exactly the class of silent change the archive rules here exist to avoid.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
});

export async function unarchiveInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; invoiceId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'unarchiveInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  const data = snap.data() as ArchivableInvoice;

  if (!isArchived(data)) {
    throw new HttpsError('failed-precondition', 'This invoice is not archived.', {
      code: 'invoice_not_archived',
    });
  }

  await ref.set(
    { archivedAt: null, archivedBy: null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_UNARCHIVED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    description: `Invoice ${data.invoiceNumber ?? args.invoiceId} restored from the archive`,
    payload: { invoiceId: args.invoiceId },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'unarchiveInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'unarchiveInvoice',
    event: 'admin.invoice.unarchived',
    uid,
    extra: { invoiceId: args.invoiceId },
  });

  return { ok: true, invoiceId: args.invoiceId };
}

export const unarchiveInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('unarchiveInvoice', unarchiveInvoiceHandler),
);
