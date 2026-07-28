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
import { invoiceStateOf } from '../lib/invoiceEditPolicy';
import { isArchived, amountStillOwed, formatOwed, type ArchivableInvoice } from '../lib/invoiceArchive';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

/**
 * Archives one invoice: hides it from the operator's default list view and from
 * the outstanding / billed totals.
 *
 * Archiving is NOT deletion and NOT cancellation. The invoice keeps every field
 * it had; `archivedAt` only says the operator has stopped working it. The
 * kinfolk portal is unaffected.
 *
 * THE PRECONDITION, and why it is not merely advisory: archiving an invoice that
 * a household still owes money on removes it from the very total that would
 * remind anyone to collect it. That is a decision to write off real money, so it
 * is refused by default and permitted only with an explicit `force`, which is
 * recorded distinctly in the audit trail. A draft or a quote is exempt because
 * neither was ever claimed from anyone: abandoning a draft is routine.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  /** Archive anyway when money is still owed. Audited separately. */
  force: z.boolean().optional(),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported for the same reason `Args`
 * is: the contract guard freezes it and decision 2 generates the clients'
 * types from it. `.strict()`, so an added field is reported rather than
 * absorbed.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** Echoed back so a caller batching several calls can pair up the answers. */
    invoiceId: z.string().min(1),
  })
  .strict();
export async function archiveInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'archiveInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  const data = snap.data() as ArchivableInvoice;

  if (isArchived(data)) {
    throw new HttpsError('failed-precondition', 'This invoice is already archived.', {
      code: 'invoice_already_archived',
    });
  }

  const state = invoiceStateOf(data);
  const owed = amountStillOwed(data);
  const exempt = state === 'draft' || state === 'quote';
  const forced = args.force === true;

  if (!exempt && owed > 0 && !forced) {
    throw new HttpsError(
      'failed-precondition',
      `This invoice still has ${formatOwed(owed)} owing. Archiving it would drop that from the outstanding total. Record the payment first, or archive it anyway to write it off.`,
      { code: 'invoice_still_owing' },
    );
  }

  await ref.set(
    { archivedAt: FieldValue.serverTimestamp(), archivedBy: uid, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_ARCHIVED,
    severity: forced ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    description: `Invoice ${data.invoiceNumber ?? args.invoiceId} archived${forced ? ' (forced, money still owed)' : ''}`,
    payload: { invoiceId: args.invoiceId, state, owed, forced },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'archiveInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'archiveInvoice',
    event: 'admin.invoice.archived',
    uid,
    extra: { invoiceId: args.invoiceId, state, forced },
  });

  return validateResponse('archiveInvoice', Result, { ok: true, invoiceId: args.invoiceId });
}

export const archiveInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('archiveInvoice', archiveInvoiceHandler),
);
