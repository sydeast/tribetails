import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { contentDedupeKey, enqueueNotificationDetailed } from '../notifications/dispatcher';
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

/**
 * The invoice fields an `invoice.updated` notification can show a household,
 * and so the ones that make two edits DIFFERENT notifications (#832).
 *
 * The enricher renders `invoiceNumber` and `kinName` for this key and `amount`,
 * `dueDate`, `invoiceNumber`, `kinfolkName`, `kinName` for `invoice.new`
 * (enrichTemplateData.ts). `amount` and the due date are derived from the money
 * and date fields below, which is why those are listed rather than the token
 * names: a corrected total or due date must change the key.
 */
export const INVOICE_RENDERED_FIELDS = [
  'invoiceNumber',
  'kinfolkId',
  'kinfolkName',
  'client',
  'total',
  'totalCents',
  'amountDue',
  'amountDueCents',
  'amountMinor',
  'currency',
  'discount',
  'invoiceDiscountCents',
  'lineItems',
  'date',
  'dueDate',
  'invoiceDueDate',
  'terms',
  'status',
] as const;

/**
 * Structural equality for Firestore field values, used only to ask "does this
 * payload change anything?". Key order is ignored; Timestamps and other
 * objects compare by their JSON form, which is enough to recognise a byte-for-
 * byte retry and errs toward "changed" (and so toward notifying) otherwise.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * #832: this callable used to re-enqueue on EVERY call. Two things now stop a
 * repeat, and neither can stop a real edit:
 *
 *   1. UNCHANGED (here). The payload sets nothing the stored invoice does not
 *      already hold. That is a retry that landed after the first attempt
 *      committed, and the notable case is a retried CREATE: the first attempt
 *      wrote the doc and sent `invoice.new`, so the retry sees an existing doc
 *      and would have sent `invoice.updated` about a change that never happened.
 *      The dispatcher cannot catch that one, because the two keys differ.
 *   2. CONTENT IDENTITY (the dispatcher). An edit's `invoice.updated` carries a
 *      `dedupeKey` hashed from INVOICE_RENDERED_FIELDS of the invoice as the
 *      edit leaves it. Two attempts at the same edit that both read the doc
 *      before either wrote produce the same key and deliver once; a second,
 *      different edit (a corrected amount minutes after the invoice went out)
 *      produces a new key and sends, to the household and to the office copy.
 *
 * There is deliberately no "this household was notified a moment ago" skip: it
 * dropped exactly the correction a household most needs to see.
 */
function isUnchanged(existing: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  const stored = existing ?? {};
  return Object.entries(payload).every(([k, v]) => sameValue(stored[k], v));
}

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
  const stored = existing.data() as Record<string, unknown> | undefined;
  // Compared against the doc as it stood BEFORE this merge; `kinfolkId` is
  // part of what the call sets, so it takes part in the comparison too.
  const intended: Record<string, unknown> = { ...args.payload, kinfolkId: args.familyId };
  const merged: Record<string, unknown> = {
    ...(stored ?? {}),
    ...intended,
  };
  const stamp = invoiceStateStampOf(merged, paidCents);
  await ref.set(
    {
      ...args.payload,
      kinfolkId: args.familyId,
      ...stamp,
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

  const key = isNew ? 'invoice.new' : 'invoice.updated';
  if (!isNew && isUnchanged(stored, intended)) {
    logEvent({
      severity: 'info',
      function: 'postInvoiceEvent',
      event: 'notification.skipped',
      extra: { familyId: args.familyId, invoiceId: args.invoiceId, key, reason: 'unchanged' },
    });
    return validateResponse('postInvoiceEvent', Result, { ok: true });
  }

  const recipientUid = await resolveKinfolkUid(args.familyId);
  const data = { kinfolkId: args.familyId, invoiceId: args.invoiceId };
  const after: Record<string, unknown> = { ...merged, ...stamp };
  const rendered = Object.fromEntries(INVOICE_RENDERED_FIELDS.map((f) => [f, after[f] ?? null]));
  try {
    const outcome = await enqueueNotificationDetailed({
      key,
      recipientUid: recipientUid ?? '',
      data,
      // A new invoice keeps the plain `invoice:<id>` identity: there is one
      // issue per invoice. An edit is named by what it leaves on the invoice.
      ...(isNew ? {} : { dedupeKey: contentDedupeKey(`invoice:${args.invoiceId}:updated`, rendered) }),
    });
    const duplicate = outcome.suppressed.find((s) => s.reason === 'duplicate');
    if (duplicate) {
      logEvent({
        severity: 'info',
        function: 'postInvoiceEvent',
        event: 'notification.dispatch.deduped',
        extra: {
          familyId: args.familyId,
          invoiceId: args.invoiceId,
          key,
          existingId: duplicate.existingId ?? null,
          lastAtMs: duplicate.lastAtMs ?? null,
        },
      });
    }
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
