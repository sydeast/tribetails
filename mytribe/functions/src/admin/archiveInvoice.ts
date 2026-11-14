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
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { amountDueCentsOf, statesNoBalance } from '../lib/amountDueRule';
import { centsToDollars, formatUsdCents, invoiceTotalCentsOf, paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import {
  INVOICE_STILL_OWING_CODE,
  WRITE_OFFS_SUBCOLLECTION,
  WRITTEN_OFF_STATUS,
  formatOwed,
  isArchived,
  isWrittenOff,
  stillOwingArchiveRefusal,
  writeOffRefusalOf,
  type ArchivableInvoice,
} from '../lib/invoiceArchive';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema } from '../lib/invoiceResponseSchema';
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
 * THE PRECONDITION (#2090, operator ruling 2026-11-12: "Archive is only
 * tidying"). An invoice a household still owes money on is NEVER archived.
 * Archiving used to take a `force` flag that dropped the balance from the
 * Outstanding total and called that a write-off, while the household was still
 * shown the bill with Pay now. Writing a balance off is its own owner-only
 * action now (`writeOffInvoice`), which zeroes the balance everywhere the
 * household and the office read it; once it has run, archiving is allowed. A
 * draft or a quote is exempt because neither was ever claimed from anyone:
 * abandoning a draft is routine. `force` is still accepted so an older client's
 * call gets the plain refusal below rather than a validation error, and it
 * changes nothing.
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
  /**
   * IGNORED since #2090: an invoice with money owed is never archived, forced or
   * not. Kept in the shape so an older client's call is refused in words.
   */
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

    // #2090: WHAT IS OWED IS THE SHARED RULE'S ANSWER (`amountDueCentsOf`), the
    // same one the household's screen, `payInvoice` and the write-off read. A
    // migrated bill with a `total` and no stated balance is owed in full there,
    // so it is owed here too, unless its own payment rows say it was paid off:
    // those are read, as `payInvoice` reads them, only for a doc that states no
    // balance, and before any write.
    let paidCents: number | null = null;
    if (statesNoBalance(data)) {
      const rows = await tx.get(ref.collection('payments'));
      paidCents = paidCentsFromPayments(rows.docs.map((d) => d.data() as PaymentAmount));
    }
    const state = invoiceStateOf(data, paidCents);
    const owedCents = amountDueCentsOf(data, paidCents);
    const owed = owedCents / 100;
    const exempt = state === 'draft' || state === 'quote' || state === 'cancelled';

    // `force` is not read: archiving is tidying and never touches money (#2090).
    // A written-off invoice owes nothing, so it passes here.
    if (!exempt && owedCents > 0) {
      throw new HttpsError('failed-precondition', stillOwingArchiveRefusal(formatOwed(owed)), {
        code: INVOICE_STILL_OWING_CODE,
        owedCents,
      });
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
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    // #1752: the number, never the id, in the sentence.
    description: (await import('../lib/activityWords.js')).invoiceSentence(data.invoiceNumber, 'archived'),
    payload: { invoiceId: args.invoiceId, state, owed, sessionsReleased: released },
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
    extra: { invoiceId: args.invoiceId, state, released: released.length },
  });

  return validateResponse('archiveInvoice', Result, { ok: true, invoiceId: args.invoiceId, releasedSessionIds: released });
}

export const archiveInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('archiveInvoice', archiveInvoiceHandler),
);

/**
 * #2090: WRITE OFF WHAT IS LEFT ON ONE INVOICE. Owner-only: it is not on the
 * Auntie list in `lib/auntieAccess.ts`, so `wrapAdminCallable` refuses her.
 *
 * Operator ruling 2026-11-12: archiving is only tidying, and an invoice with
 * money owed cannot be archived. Giving up the balance is this action, behind
 * its own confirm (which names the household, the invoice number and the
 * amount), after which the household is no longer asked to pay and the invoice
 * may be archived like any settled one.
 *
 * WHAT IT WRITES, IN ONE TRANSACTION:
 *   - `invoices/{id}/writeOffs/{auto}`: the entry, with the cents given up and
 *     who gave them up. Its own ledger: not a payment (the `payments` sum is
 *     what was collected, and this was not), not account credit, not a refund.
 *   - the invoice: `status: 'written_off'` (a classifier state of its own, so it
 *     never reads as paid), a zero balance in both denominations, and the
 *     `writtenOff*` stamp. Every reminder, overdue notice, Outstanding total,
 *     portal amount due and auto-apply reads the balance or the state, so they
 *     all stop counting it from this commit on.
 *
 * NO NOTICE TO THE HOUSEHOLD. Archiving sent none, and an invoice edit is
 * silent (ruling 2026-09-22); the household sees the invoice read "Written off"
 * with nothing to pay the next time it opens Invoices.
 *
 * IN THIS MODULE, NOT ITS OWN: one entry carries archive and write-off, as
 * `quoteActions.ts` carries convert and withdraw, so the cold-start graph
 * (`test/coldStartImportGraph.test.ts`) gains no module.
 *
 * ONE WINNER AGAINST A PAYMENT. The invoice and its `payments` subcollection
 * are read inside the transaction, so a payment committing first changes the
 * balance this reads (and the confirm's `amountCents` no longer matches, so the
 * write-off is refused with the new figure), and a payment arriving after
 * finds `written_off` in its own transaction and is refused
 * (`markInvoicePaid`, `recordPayment`, the credit draw). A card payment from a
 * checkout opened before the write-off lands as an unapplied payment for the
 * owner to decide on, which is what the Stripe webhook already does for an
 * invoice that owes nothing.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const WriteOffArgs = z
  .object({
    invoiceId: z.string().min(1).max(200),
    /**
     * The balance the confirm showed, in cents. Refused when the invoice owes a
     * different amount by the time the write-off runs, so the owner never gives
     * up a figure she was not shown.
     */
    amountCents: z.number().int().positive(),
  })
  .strict();

export const WriteOffResult = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** The `invoices/{id}/writeOffs/{writeOffId}` entry written. */
    writeOffId: z.string().min(1),
    /** What was written off, in cents. */
    writtenOffCents: CentsSchema,
  })
  .strict();

export async function writeOffInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof WriteOffResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof WriteOffArgs>;
  try {
    args = WriteOffArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'writeOffInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  const entryRef = ref.collection(WRITE_OFFS_SUBCOLLECTION).doc();

  const outcome = await db().runTransaction(async (tx) => {
    // EVERY READ BEFORE EVERY WRITE: the invoice and what has been paid on it.
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    const data = (snap.data() ?? {}) as ArchivableInvoice;
    const paymentsSnap = await tx.get(ref.collection('payments'));
    const paidCents = paidCentsFromPayments(paymentsSnap.docs.map((d) => d.data() as PaymentAmount));

    const state = invoiceStateOf(data, paidCents);
    const owedCents = amountDueCentsOf(data, paidCents);
    const refusal = writeOffRefusalOf({
      archived: isArchived(data),
      writtenOff: isWrittenOff(data),
      state,
      owedCents,
      expectedCents: args.amountCents,
    });
    if (refusal !== null) {
      throw new HttpsError('failed-precondition', refusal.message, {
        code: refusal.code,
        ...(refusal.code === 'write_off_amount_changed' ? { owedCents } : {}),
      });
    }

    const totalCents = invoiceTotalCentsOf(data);
    tx.create(entryRef, {
      invoiceId: args.invoiceId,
      invoiceNumber: typeof data.invoiceNumber === 'string' ? data.invoiceNumber : null,
      kinfolkId: typeof data.kinfolkId === 'string' ? data.kinfolkId : null,
      amountCents: owedCents,
      totalCents,
      paidCents,
      writtenOffAt: FieldValue.serverTimestamp(),
      writtenOffBy: uid,
    });
    const update: Record<string, unknown> = {
      status: WRITTEN_OFF_STATUS,
      amountDue: 0,
      amountDueCents: 0,
      writtenOffCents: owedCents,
      writtenOffAmount: centsToDollars(owedCents),
      writtenOffAt: FieldValue.serverTimestamp(),
      writtenOffBy: uid,
      writeOffId: entryRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    };
    // The state stamp (ADR-0002) in the same commit: written_off / none.
    Object.assign(update, invoiceStateStampOf({ ...data, ...update }, paidCents));
    tx.set(ref, update, { merge: true });
    return { data, owedCents, paidCents, totalCents, state };
  });

  const { data, owedCents, paidCents, totalCents, state } = outcome;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_WRITTEN_OFF,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    // #1752: the number, never the id, in the sentence.
    description: (await import('../lib/activityWords.js')).invoiceSentence(
      data.invoiceNumber,
      `balance of ${formatUsdCents(owedCents)} written off`,
    ),
    payload: {
      invoiceId: args.invoiceId,
      writeOffId: entryRef.id,
      writtenOffCents: owedCents,
      paidCents,
      totalCents,
      stateBefore: state,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'writeOffInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'writeOffInvoice',
    event: 'admin.invoice.written_off',
    uid,
    extra: { invoiceId: args.invoiceId, writeOffId: entryRef.id, writtenOffCents: owedCents },
  });

  return validateResponse('writeOffInvoice', WriteOffResult, {
    ok: true,
    invoiceId: args.invoiceId,
    writeOffId: entryRef.id,
    writtenOffCents: owedCents,
  });
}

export const writeOffInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('writeOffInvoice', writeOffInvoiceHandler),
);
