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
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { isSessionClaimed, isSessionDoNotInvoice } from '../lib/sessionInvoicing';

/**
 * Takes completed visits out of the un-invoiced queue without billing for them,
 * and puts them back.
 *
 * WHY THE QUEUE NEEDS THIS. `listUninvoicedSessions` answers "what work has
 * nobody billed yet", and with no way to say "this one is never going to be
 * billed" the answer only ever grows: a comped visit, a duplicate the office
 * logged twice, a make-good after a bad job. Each one sits in the composer
 * forever, and the moment a count is derived from that list, the count is
 * wrong. Precise Petcare offers Do Not Invoice beside Create Invoice on the
 * same selection for exactly this reason (issue #408 research).
 *
 * IT IS A STATE, NOT A DELETION, AND IT REVERSES. Nothing is removed and no
 * money moves: the visit keeps every field it had and gains a flag, a reason,
 * and who set it when. Calling this with `doNotInvoice: false` clears the flag
 * and the visit rejoins the queue. An operator who excludes the wrong visit
 * loses nothing but a click, which is the difference between a decision and a
 * trap.
 *
 * A VISIT AN INVOICE ALREADY CLAIMS IS REFUSED, and the refusal names the
 * invoice. Marking a billed visit do-not-invoice would say two contradictory
 * things about the same work, and the household is holding the version that
 * charges them. Unlink it from the invoice first (`linkInvoiceSessions`), then
 * exclude it.
 *
 * THE WHOLE BATCH IS CHECKED BEFORE ANY OF IT IS WRITTEN. A selection of eight
 * visits where the fourth is already billed writes nothing and says which one:
 * a partial application would leave the operator guessing which half of their
 * selection took effect.
 */

/** Exported so the callable-contract drift guard can freeze this request shape. */
export const Args = z
  .object({
    /**
     * The visits to mark, or unmark. Batched because the operator works from a
     * selection, not one row at a time.
     */
    sessionIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    /** True excludes them from invoicing; false puts them back in the queue. */
    doNotInvoice: z.boolean(),
    /**
     * Why, in the operator's words. Optional, and kept: six months later the
     * flag alone cannot say whether a visit was comped or logged twice.
     */
    reason: z.string().max(500).default(''),
  })
  .strict();

export type SetSessionDoNotInvoiceArgs = z.infer<typeof Args>;

/**
 * The RESPONSE shape (ADR-0001 step W3-1). `.strict()`, so an added field is
 * reported rather than absorbed.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** The state every listed visit is now in, echoed so a caller can assert it. */
    doNotInvoice: z.boolean(),
    /** Visits this call changed. */
    changed: z.array(z.string()),
    /**
     * Visits that were ALREADY in the requested state. Not an error and not a
     * silent success: re-marking a visit somebody else already marked is a
     * no-op worth reporting so the confirmation can count honestly.
     */
    unchanged: z.array(z.string()),
  })
  .strict();

export type SetSessionDoNotInvoiceResult = z.infer<typeof Result>;

const SESSIONS_COLLECTION = 'kin_care_sessions';

export async function setSessionDoNotInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: SetSessionDoNotInvoiceArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'setSessionDoNotInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // De-duplicated: the same id twice in one selection is a caller bug, not two
  // visits, and counting it twice would make the confirmation lie.
  const ids = [...new Set(args.sessionIds)];
  const firestore = db();
  const refs = ids.map((id) => firestore.collection(SESSIONS_COLLECTION).doc(id));
  const snaps = await firestore.getAll(...refs);

  const missing: string[] = [];
  const claimed: Array<{ sessionId: string; invoiceId: string }> = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  snaps.forEach((snap, i) => {
    const id = ids[i]!;
    if (!snap.exists) {
      missing.push(id);
      return;
    }
    const data = snap.data() as Record<string, unknown>;
    // Only excluding is blocked by a claim. UNDOING an exclusion on a visit
    // that has since been invoiced is harmless (it is already out of the queue
    // for the better reason), and refusing it would strand the flag.
    if (args.doNotInvoice && isSessionClaimed(data['invoiceId'])) {
      claimed.push({ sessionId: id, invoiceId: String(data['invoiceId']).trim() });
      return;
    }
    if (isSessionDoNotInvoice(data) === args.doNotInvoice) unchanged.push(id);
    else changed.push(id);
  });

  if (missing.length > 0) {
    throw new HttpsError(
      'not-found',
      missing.length === 1
        ? `Visit '${missing[0]!}' no longer exists, so nothing was changed. Refresh the list and try again.`
        : `${String(missing.length)} of these visits no longer exist (${missing.join(', ')}), so nothing was changed. Refresh the list and try again.`,
      { code: 'session_not_found', sessionIds: missing },
    );
  }

  if (claimed.length > 0) {
    const first = claimed[0]!;
    throw new HttpsError(
      'failed-precondition',
      claimed.length === 1
        ? `That visit is already billed on invoice ${first.invoiceId}, so it cannot be marked do not invoice. Unlink it from that invoice first, then mark it.`
        : `${String(claimed.length)} of these visits are already billed (the first is on invoice ${first.invoiceId}), so nothing was changed. Unlink them from their invoices first, then mark them.`,
      { code: 'session_already_invoiced', sessionIds: claimed.map((c) => c.sessionId) },
    );
  }

  if (changed.length > 0) {
    const batch = firestore.batch();
    for (const id of changed) {
      const ref = firestore.collection(SESSIONS_COLLECTION).doc(id);
      batch.set(
        ref,
        args.doNotInvoice
          ? {
              doNotInvoice: true,
              doNotInvoiceReason: args.reason.trim(),
              doNotInvoiceAt: FieldValue.serverTimestamp(),
              doNotInvoiceBy: uid,
            }
          : // Cleared to false rather than deleted, so "never excluded" and
            // "excluded and put back" stay distinguishable on the document, and
            // so the reason does not outlive the decision it explained.
            {
              doNotInvoice: false,
              doNotInvoiceReason: '',
              doNotInvoiceClearedAt: FieldValue.serverTimestamp(),
              doNotInvoiceClearedBy: uid,
            },
        { merge: true },
      );
    }
    await batch.commit();
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: args.doNotInvoice
      ? AUDIT_EVENTS.BILLING_SESSION_DO_NOT_INVOICE_SET
      : AUDIT_EVENTS.BILLING_SESSION_DO_NOT_INVOICE_CLEARED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SESSIONS_COLLECTION,
    description: args.doNotInvoice
      ? `${String(changed.length)} visit(s) marked do not invoice${args.reason.trim() === '' ? '' : `: ${args.reason.trim()}`}`
      : `${String(changed.length)} visit(s) put back in the un-invoiced queue`,
    payload: { changed, unchanged, reason: args.reason.trim() },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'setSessionDoNotInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'setSessionDoNotInvoice',
    event: args.doNotInvoice ? 'admin.session.doNotInvoice.set' : 'admin.session.doNotInvoice.cleared',
    uid,
    extra: { changed: changed.length, unchanged: unchanged.length },
  });

  return validateResponse('setSessionDoNotInvoice', Result, {
    ok: true,
    doNotInvoice: args.doNotInvoice,
    changed,
    unchanged,
  });
}

export const setSessionDoNotInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setSessionDoNotInvoice', setSessionDoNotInvoiceHandler),
);
