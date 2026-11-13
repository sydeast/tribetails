import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import {
  FieldValue,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
// #1005: money notices go to a member with billing access, not the last-synced account.
import { resolveBillingRecipientUid } from '../lib/resolveBillingRecipientUid';
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { householdAppOnly } from '../notifications/appOnly';
import { TRIBETAILS_CORS } from '../lib/cors';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { payMethodSnapshotForIssue } from '../lib/payMethodSnapshot';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { refuseIfArchived } from '../lib/invoiceArchive';
import { readSendClaims, stageSessionLinks, storedSessionIds } from '../lib/invoiceSessionLinks';

/**
 * Dedicated draft-review-and-send callable, replacing the AuntieOS admin's
 * prior `postInvoiceEvent({ payload: { status: '' } })` workaround (see
 * auntieos-admin/src/api/invoicesWrite.ts's pre-existing header note). That
 * path cleared the status field with no guard that the invoice was actually a
 * draft, and no validation that the draft was complete enough to send, an
 * admin could "send" an empty-total, household-less, or invoice-number-less
 * draft and postInvoiceEvent would happily merge it.
 *
 * This callable adds both: a precondition that the invoice IS currently a
 * draft, and a sendability check (total, household, invoice number) that
 * fails loud (`failed-precondition`, naming exactly what's missing) rather
 * than silently sending an incomplete bill.
 *
 * Canonical status convention, matching createQuote.ts's dual-stamp pattern:
 *   - `status`        = 'open'  (the AuntieOS admin composer/list field;
 *     matches createInvoice's own field, and invoiceFormat.ts's
 *     `invoiceState` falls through unrecognized/'' status to 'open' when
 *     amountDue > 0, so this is the positive, explicit spelling of that same
 *     state rather than relying on the fallback)
 *   - `invoiceStatus` = 'open'  (the portal's canonical resolver field, see
 *     getMyInvoices.ts's `Status` union, which lists 'open' as a first-class
 *     value)
 *
 * The `invoice.new` notification is dispatched BEFORE the Firestore status
 * flip, and its failure is NOT swallowed (fail loud, mirroring
 * sendInvoiceReminder.ts, whose whole purpose is likewise a dispatch): if the
 * notify throws, the draft is left untouched so a retry cannot produce a
 * "flipped to open but the household was never told" state. This is the
 * inverse ordering from createInvoice.ts/createQuote.ts, which write first
 * and swallow-log notification failures, because their primary deliverable
 * is the invoice record, not the send itself.
 *
 * #2168 review: TWO MORE REFUSALS, each decided twice. An archived invoice is
 * read-only until restored (`refuseIfArchived`), and a draft is sent only when
 * every visit its lines bill is its own (`readSendClaims`): a visit another
 * invoice now bills, a cancelled one or one with no record refuses the send,
 * named by its day. Both are checked in a transaction BEFORE the dispatch, so a
 * refusal sends nothing and writes nothing, and again in the transaction that
 * flips the status, so an archive or a New invoice save landing between the
 * two cannot slip a visit billed twice through. The first transaction also
 * claims any line's visit whose back-link is still blank (a draft made before
 * #1901), which takes it off the un-invoiced list before the household hears.
 */
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
});

type InvoiceDoc = {
  kinfolkId?: string;
  kinfolkName?: string;
  status?: string;
  invoiceNumber?: string;
  total?: number;
  amountDue?: number;
  currency?: string;
  dueDate?: string;
  invoiceDueDate?: string;
  [k: string]: unknown;
};

function normalizedStatus(d: InvoiceDoc): string {
  return typeof d.status === 'string' ? d.status.trim().toLowerCase() : '';
}

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported for the same reason `Args`
 * is: the contract guard freezes it and decision 2 generates the clients'
 * types from it. `.strict()`, so an added field is reported rather than
 * absorbed.
 *
 * #1511: `appOnly` is present when this call wrote the household's copy of
 * `invoice.new`, and true when every delivery channel was off for them: the
 * invoice is in their notifications list and nothing was emailed or texted.
 * Absent when the household has no portal account, so only the office copy
 * was written and there is no household delivery to describe.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** Echoed back so a caller batching several calls can pair up the answers. */
    invoiceId: z.string().min(1),
    appOnly: z.boolean().optional(),
  })
  .strict();

/**
 * The draft as read, or the refusal. Shared by the check and the flip so the
 * two cannot disagree about what may be sent.
 */
function sendableDraft(snap: DocumentSnapshot, invoiceId: string): InvoiceDoc {
  if (!snap.exists) {
    throw new HttpsError('not-found', `Invoice '${invoiceId}' not found.`);
  }
  const data = snap.data() as InvoiceDoc;

  // #2168: an archived draft is sent only after it is restored, which is what
  // takes its visits back and says which it could not.
  refuseIfArchived(data);

  if (normalizedStatus(data) !== 'draft') {
    throw new HttpsError('failed-precondition', 'Invoice is not a draft; nothing to send.');
  }

  const missing: string[] = [];
  if (typeof data.total !== 'number' || !(data.total > 0)) missing.push('total');
  if (typeof data.kinfolkId !== 'string' || data.kinfolkId.length === 0) missing.push('household');
  if (typeof data.invoiceNumber !== 'string' || data.invoiceNumber.trim().length === 0) {
    missing.push('invoice number');
  }
  if (missing.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `Draft invoice is missing: ${missing.join(', ')}. Complete it before sending.`,
    );
  }
  return data;
}

/**
 * Stages the back-link on each line's visit the draft did not hold yet, and
 * adds it to the draft's `sessionIds`, so both sides agree. Writes nothing when
 * every visit is already the draft's own.
 */
function stageClaims(
  tx: Transaction,
  ref: DocumentReference,
  draft: InvoiceDoc,
  plan: Awaited<ReturnType<typeof readSendClaims>>,
): void {
  if (plan.claim.length === 0) return;
  const stored = storedSessionIds(draft);
  tx.set(ref, { sessionIds: Array.from(new Set([...stored, ...plan.claim])) }, { merge: true });
  stageSessionLinks(tx, db(), plan, new Date().toISOString());
}

export async function reviewAndSendDraftInvoiceHandler(
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
      throw new HttpsError('invalid-argument', 'reviewAndSendDraftInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);

  // THE PRE-SEND CHECK, before anything reaches the household. Every refusal
  // is decided on what this transaction read, before it writes anything.
  const data = await db().runTransaction(async (tx) => {
    const draft = sendableDraft(await tx.get(ref), args.invoiceId);
    const plan = await readSendClaims(tx, db(), args.invoiceId, draft['lineItems']);
    stageClaims(tx, ref, draft, plan);
    return draft;
  });

  const familyId = data.kinfolkId as string;
  const recipientUid = await resolveBillingRecipientUid(familyId);

  // Fail loud: if dispatch throws, the callable surfaces it (no swallow) and
  // the invoice stays in DRAFT, so the admin sees the send did NOT happen
  // rather than a silent no-op paired with a flipped status.
  const dispatched = await enqueueNotificationDetailed({
    key: 'invoice.new',
    recipientUid: recipientUid ?? '',
    data: { kinfolkId: familyId, invoiceId: args.invoiceId },
    targetType: 'invoice',
    targetId: args.invoiceId,
  });
  // #1511: read for the household alone. `invoice.new` also writes an office
  // copy, and the office's email is not the household's. With no household
  // uid, or a household copy the dispatcher held back, there is no household
  // delivery to describe, and the answer omits it.
  const appOnly = householdAppOnly(dispatched, recipientUid);

  // THIS is the moment a draft becomes a bill, so this is where the payment
  // options are frozen onto it (issue #409). Turning a method off tomorrow
  // stops offering it on new invoices; this one keeps what the household was
  // sent. Fail-soft: no snapshot means live settings, i.e. today's behaviour.
  const payMethodSnapshot = await payMethodSnapshotForIssue('reviewAndSendDraftInvoice');

  // THE FLIP, in a transaction that re-reads the invoice and every visit its
  // lines bill, so an archive or a claim committed since the check above is
  // refused here rather than overwritten.
  await db().runTransaction(async (tx) => {
    const draft = sendableDraft(await tx.get(ref), args.invoiceId);
    const plan = await readSendClaims(tx, db(), args.invoiceId, draft['lineItems']);
    // The state stamp (ADR-0002), in the same write as the flip. The standing is
    // read from the payments SUBCOLLECTION; on a real draft it is empty (a draft
    // cannot take a payment, markInvoicePaid refuses it), but reading it keeps
    // the rule uniform rather than asserted per call site.
    const paymentsSnap = await tx.get(ref.collection('payments'));
    const paidCents = paidCentsFromPayments(paymentsSnap.docs.map((d) => d.data() as PaymentAmount));
    const update = {
      status: 'open',
      invoiceStatus: 'open',
      sentAt: FieldValue.serverTimestamp(),
      sentBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(
      ref,
      { ...update, ...invoiceStateStampOf({ ...draft, ...update }, paidCents), ...payMethodSnapshot },
      { merge: true },
    );
    stageClaims(tx, ref, draft, plan);
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_DRAFT_INVOICE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId,
    description: `Draft ${(await import('../lib/activityWords.js')).invoiceWords(data.invoiceNumber).replace(/^an /, '')} reviewed and sent`,
    payload: { invoiceId: args.invoiceId, kinfolkId: familyId, recipientUid: recipientUid ?? null },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'reviewAndSendDraftInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'reviewAndSendDraftInvoice',
    event: 'admin.invoice.draft.sent',
    uid,
    extra: { invoiceId: args.invoiceId, kinfolkId: familyId },
  });

  return validateResponse('reviewAndSendDraftInvoice', Result, {
    ok: true,
    invoiceId: args.invoiceId,
    ...(appOnly === undefined ? {} : { appOnly }),
  });
}

export const reviewAndSendDraftInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('reviewAndSendDraftInvoice', reviewAndSendDraftInvoiceHandler),
);
