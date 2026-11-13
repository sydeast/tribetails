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
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { invoiceStateOf } from '../lib/invoiceEditPolicy';
import { readSessionReclaim, stageSessionLinks, visitsNamedBy, type ReclaimLoss } from '../lib/invoiceSessionLinks';

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
 *
 * #2168: RESTORING A DRAFT TAKES ITS VISITS BACK, BUT NEVER ONE BILLED SINCE.
 * Archiving a draft let go of its visits (`archiveInvoice`). Restoring it takes
 * back, in the same transaction as the restore, every visit it names that is
 * still free. A visit another invoice has billed since, one cancelled since,
 * or one with no record stays where it is, and the answer says which in plain
 * words (`notice`), so the operator can remove its line before sending the
 * draft. Taking it back would bill the same work twice. Any other invoice
 * never let go of its visits, so restoring it touches none.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
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
    /** #2168: the visits a restored draft took back. Empty for any other invoice. */
    reclaimedSessionIds: z.array(z.string()),
    /** #2168: the visits a restored draft could not take back, and why. */
    notReclaimed: z.array(
      z
        .object({
          sessionId: z.string(),
          reason: z.enum(['on_other_invoice', 'cancelled', 'not_found']),
          /** The invoice that bills it now, by number; '' for the other reasons. */
          invoiceNumber: z.string(),
        })
        .strict(),
    ),
    /** #2168: those visits in plain words, for every client to show after the restore. '' when none. */
    notice: z.string(),
  })
  .strict();
export async function unarchiveInvoiceHandler(
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
      throw new HttpsError('invalid-argument', 'unarchiveInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  // ONE TRANSACTION (#2168): the restore and the visits it takes back land
  // together, and each visit is read here, so a New invoice save for the same
  // visit is refereed by Firestore rather than by whoever writes last.
  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    const data = snap.data() as ArchivableInvoice;

    if (!isArchived(data)) {
      throw new HttpsError('failed-precondition', 'This invoice is not archived.', {
        code: 'invoice_not_archived',
      });
    }

    const update: Record<string, unknown> = {
      archivedAt: null,
      archivedBy: null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (invoiceStateOf(data) !== 'draft') {
      tx.set(ref, update, { merge: true });
      return { data, reclaimed: [] as string[], notReclaimed: [] as ReclaimLoss[], notice: '' };
    }
    const named = visitsNamedBy(data);
    const reclaim =
      named.length > 0 ? await readSessionReclaim(tx, db(), args.invoiceId, named, data['lineItems']) : null;
    if (reclaim !== null) {
      update['sessionIds'] = reclaim.plan.claim;
      update['releasedSessionIds'] = [];
    }
    tx.set(ref, update, { merge: true });
    if (reclaim !== null) stageSessionLinks(tx, db(), reclaim.plan, new Date().toISOString());
    return {
      data,
      reclaimed: reclaim?.plan.claim ?? [],
      notReclaimed: reclaim?.lost ?? [],
      notice: reclaim?.notice ?? '',
    };
  });
  const { data, reclaimed, notReclaimed, notice } = outcome;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_UNARCHIVED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    description: (await import('../lib/activityWords.js')).invoiceSentence(data.invoiceNumber, 'restored from the archive'),
    payload: { invoiceId: args.invoiceId, sessionsReclaimed: reclaimed, sessionsNotReclaimed: notReclaimed },
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
    extra: { invoiceId: args.invoiceId, reclaimed: reclaimed.length, notReclaimed: notReclaimed.length },
  });

  return validateResponse('unarchiveInvoice', Result, {
    ok: true,
    invoiceId: args.invoiceId,
    reclaimedSessionIds: reclaimed,
    notReclaimed,
    notice,
  });
}

export const unarchiveInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('unarchiveInvoice', unarchiveInvoiceHandler),
);
