import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

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
 */
const Args = z.object({
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
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** Echoed back so a caller batching several calls can pair up the answers. */
    invoiceId: z.string().min(1),
  })
  .strict();
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
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  }
  const data = snap.data() as InvoiceDoc;

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

  const familyId = data.kinfolkId as string;
  const recipientUid = await resolveKinfolkUid(familyId);

  // Fail loud: if dispatch throws, the callable surfaces it (no swallow) and
  // the invoice stays in DRAFT, so the admin sees the send did NOT happen
  // rather than a silent no-op paired with a flipped status.
  await enqueueNotification({
    key: 'invoice.new',
    recipientUid: recipientUid ?? '',
    data: { kinfolkId: familyId, invoiceId: args.invoiceId },
    targetType: 'invoice',
    targetId: args.invoiceId,
  });

  const update = {
    status: 'open',
    invoiceStatus: 'open',
    sentAt: FieldValue.serverTimestamp(),
    sentBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  };
  // The state stamp (ADR-0002), in the same write as the flip. The standing is
  // read from the payments SUBCOLLECTION; on a real draft it is empty (a draft
  // cannot take a payment, markInvoicePaid refuses it), but reading it keeps
  // the rule uniform rather than asserted per call site.
  const paymentsSnap = await ref.collection('payments').get();
  const paidCents = paidCentsFromPayments(paymentsSnap.docs.map((d) => d.data() as PaymentAmount));
  await ref.set({ ...update, ...invoiceStateStampOf({ ...data, ...update }, paidCents) }, { merge: true });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_DRAFT_INVOICE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId,
    description: `Draft invoice ${data.invoiceNumber ?? args.invoiceId} reviewed and sent`,
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

  return validateResponse('reviewAndSendDraftInvoice', Result, { ok: true, invoiceId: args.invoiceId });
}

export const reviewAndSendDraftInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('reviewAndSendDraftInvoice', reviewAndSendDraftInvoiceHandler),
);
