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
import {
  quoteHoldsNoVisits,
  readDeclineRelease,
  readSessionsHeldBy,
  stageSessionLinks,
  storedSessionIds,
  visitsNamedBy,
} from '../lib/invoiceSessionLinks';

/**
 * Archives one invoice: hides it from the operator's default list view and from
 * the outstanding / billed totals.
 *
 * Archiving is NOT deletion and NOT cancellation. The invoice keeps every field
 * it had; `archivedAt` only says the operator has stopped working it. The
 * kinfolk portal is unaffected, except that an archived quote is not shown
 * there at all (#2195, below).
 *
 * THE PRECONDITION, and why it is not merely advisory: archiving an invoice that
 * a household still owes money on removes it from the very total that would
 * remind anyone to collect it. That is a decision to write off real money, so it
 * is refused by default and permitted only with an explicit `force`, which is
 * recorded distinctly in the audit trail. A draft or a quote is exempt because
 * neither was ever claimed from anyone: abandoning a draft is routine.
 *
 * #2168: ARCHIVING A DRAFT LETS GO OF ITS VISITS. A draft made in New invoice
 * marks its visits as billed by it (#1901), and archiving is the only way to
 * abandon one, so in the same transaction as the archive stamp every visit the
 * draft holds gets its back-link cleared and goes back on the un-invoiced list.
 * The draft's `sessionIds` empties and the set is kept in `releasedSessionIds`,
 * which `unarchiveInvoice` takes back from. Its lines are left as they were.
 * Any other invoice keeps its visits: it was sent, so it billed them.
 *
 * #2195 (lead ruling 2026-11-13): ARCHIVING A QUOTE WORKS LIKE ARCHIVING A
 * DRAFT. MyTribe stops showing it (`lib/quoteDecision.ts#hiddenFromHousehold`)
 * and it cannot be accepted or declined (`quoteDecisionRefusal`), so in the same
 * transaction as the archive stamp every visit it holds goes back on the
 * un-invoiced list (`readDeclineRelease`, the decline's own release, which adds
 * to `releasedSessionIds` rather than replacing it). A declined quote holds
 * none and moves none. `unarchiveInvoice` takes back only the ones still free.
 * An accepted quote is an open invoice and is archived by the rules for one.
 * A withdrawn quote (`cancelled`) was never claimed from anyone, so it is
 * exempt from the money check like a draft or a quote.
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
    /** #2168 / #2195: the visits archiving a draft or a quote put back on the un-invoiced list. Empty for any other invoice. */
    releasedSessionIds: z.array(z.string()),
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
  const forced = args.force === true;
  // ONE TRANSACTION (#2168): the archive stamp and the release of a draft's
  // visits land together or not at all. Every refusal is decided on what the
  // transaction read, before anything is written.
  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    const data = snap.data() as ArchivableInvoice;
    if (isArchived(data)) {
      throw new HttpsError('failed-precondition', 'This invoice is already archived.', {
        code: 'invoice_already_archived',
      });
    }

    const state = invoiceStateOf(data);
    const owed = amountStillOwed(data);
    const exempt = state === 'draft' || state === 'quote' || state === 'cancelled';

    if (!exempt && owed > 0 && !forced) {
      throw new HttpsError(
        'failed-precondition',
        `This invoice still has ${formatOwed(owed)} owing. Archiving it would drop that from the outstanding total. Record the payment first, or archive it anyway to write it off.`,
        { code: 'invoice_still_owing' },
      );
    }

    const update: Record<string, unknown> = {
      archivedAt: FieldValue.serverTimestamp(),
      archivedBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    let released: string[] = [];
    if (state === 'draft') {
      const named = visitsNamedBy(data);
      const plan = named.length > 0 ? await readSessionsHeldBy(tx, db(), args.invoiceId, named) : null;
      const stored = storedSessionIds(data);
      if (plan !== null && (stored.length > 0 || plan.release.length > 0)) {
        update['sessionIds'] = [];
        update['releasedSessionIds'] = Array.from(new Set([...stored, ...plan.release]));
      }
      tx.set(ref, update, { merge: true });
      if (plan !== null) stageSessionLinks(tx, db(), plan, new Date().toISOString());
      released = plan?.release ?? [];
    } else if (state === 'quote' && !quoteHoldsNoVisits(data)) {
      // #2195: a quote waiting for an answer lets go of its visits like a draft.
      const visits = await readDeclineRelease(tx, db(), args.invoiceId, data);
      tx.set(ref, { ...update, ...visits.fields }, { merge: true });
      stageSessionLinks(tx, db(), visits.plan, new Date().toISOString());
      released = visits.plan.release;
    } else {
      tx.set(ref, update, { merge: true });
    }
    return { data, state, owed, released };
  });

  const { data, state, owed, released } = outcome;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_ARCHIVED,
    severity: forced ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    // #1752: the number, never the id, in the sentence.
    description: (await import('../lib/activityWords.js')).invoiceSentence(data.invoiceNumber, `archived${forced ? ' (forced, money still owed)' : ''}`),
    payload: { invoiceId: args.invoiceId, state, owed, forced, sessionsReleased: released },
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
    extra: { invoiceId: args.invoiceId, state, forced, released: released.length },
  });

  return validateResponse('archiveInvoice', Result, { ok: true, invoiceId: args.invoiceId, releasedSessionIds: released });
}

export const archiveInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('archiveInvoice', archiveInvoiceHandler),
);
