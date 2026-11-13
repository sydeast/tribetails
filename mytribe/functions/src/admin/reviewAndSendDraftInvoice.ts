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
import { isArchived, refuseIfArchived } from '../lib/invoiceArchive';
import { readSendClaims, stageSessionLinks, storedSessionIds } from '../lib/invoiceSessionLinks';
import { QUOTE_DRAFT_FIELD, isQuoteDraft, quoteDecisionOf } from '../lib/quoteDecision';

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
 * ORDER (#2168 review): the checks and the status flip are ONE transaction, and
 * the `invoice.new` notification is dispatched only after it commits. Until
 * then the notice went out first and the flip followed, so any refusal decided
 * at the flip (an archive, a visit cancelled, a second send) left a household
 * told about an invoice that stayed a draft, which Kinfolk cannot see.
 *
 * The notice's failure is still NOT swallowed (fail loud, mirroring
 * sendInvoiceReminder.ts, whose whole purpose is likewise a dispatch): when it
 * throws, the invoice is put back to the draft it was (`putBackToDraft`) and
 * the error surfaces, so an error still means "not sent" and a retry starts
 * clean. If it cannot be put back (a payment landed, it was archived), the
 * error says it went out unannounced. createInvoice.ts/createQuote.ts write
 * first and swallow-log notification failures, because their primary
 * deliverable is the invoice record, not the send itself.
 *
 * #2168 review: TWO MORE REFUSALS. An archived invoice is read-only until
 * restored (`refuseIfArchived`), and a draft is sent only when every visit its
 * lines bill is its own (`readSendClaims`): a visit another invoice now bills,
 * a cancelled one or one with no record refuses the send, named by its day.
 * The same transaction claims any line's visit whose back-link is still blank
 * (a draft made before #1901), which takes it off the un-invoiced list.
 *
 * #2087: A QUOTE SAVED UNSENT IS SENT HERE TOO, AND GOES OUT AS A QUOTE. A
 * quote made with "Send to kinfolk now" off is a draft carrying the quote mark
 * (`lib/quoteDecision.ts#isQuoteDraft`), hidden from the household. Sending it
 * moves it to `quote`, never to `open`: it is a proposal the household
 * accepts or declines, not a bill. Every installed admin client already sends
 * a draft through this callable (directly, or through `postInvoiceEvent`), so
 * an older client pressing its draft send on a quote sends the quote rather
 * than billing work nobody agreed to. `createQuote` with the switch on saves
 * the draft and sends it through this same core (`sendDraft`), so a quote has
 * one way out to the household, with one put-back when the notice fails. The
 * notice carries `isQuote` and its own identity (`quote:<id>:send`), so a
 * retry that the household already heard about is a `duplicate`, and a quote
 * later turned into an invoice is announced again when that invoice is sent.
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
    // #2087: a quote that has gone out is not a draft any more; say so in its
    // own words rather than calling it an invoice.
    if (normalizedStatus(data) === 'quote') {
      throw new HttpsError('failed-precondition', 'This quote has already been sent to the household.', {
        code: 'quote_already_sent',
      });
    }
    throw new HttpsError('failed-precondition', 'Invoice is not a draft; nothing to send.');
  }

  const quote = isQuoteDraft(data);
  const missing: string[] = [];
  // A quote may be for nothing yet (a $0 quote is a real proposal, and
  // createQuote has always allowed one); a bill for nothing is refused.
  if (!quote && (typeof data.total !== 'number' || !(data.total > 0))) missing.push('total');
  if (typeof data.kinfolkId !== 'string' || data.kinfolkId.length === 0) missing.push('household');
  if (typeof data.invoiceNumber !== 'string' || data.invoiceNumber.trim().length === 0) {
    missing.push(quote ? 'quote number' : 'invoice number');
  }
  if (missing.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `${quote ? 'This quote' : 'Draft invoice'} is missing: ${missing.join(', ')}. Complete it before sending.`,
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

/**
 * The notice failed after the flip committed: put the invoice back to the
 * draft it was, in a transaction, so the "an error means it is still a draft"
 * contract holds. Only when nothing has happened to it since: still `open`,
 * sent by this caller, not archived, no payment recorded. The visits it
 * claimed stay claimed, since its lines bill them either way. When it cannot
 * be put back, the error the admin sees says the invoice went out unannounced.
 */
async function putBackToDraft(
  ref: DocumentReference,
  uid: string,
  prior: Record<string, unknown>,
  invoiceId: string,
  cause: unknown,
  quote: boolean,
): Promise<void> {
  let restored = false;
  try {
    restored = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const paymentsSnap = await tx.get(ref.collection('payments'));
      const now = (snap.exists ? snap.data() : undefined) as Record<string, unknown> | undefined;
      // #2087: a quote is put back only while nobody has answered it, nor
      // withdrawn, turned or archived it since: still the quote this send made.
      const untouched =
        now !== undefined &&
        (quote
          ? normalizedStatus(now as InvoiceDoc) === 'quote' &&
            now['quoteSentBy'] === uid &&
            quoteDecisionOf(now['quoteDecision']) === null
          : normalizedStatus(now as InvoiceDoc) === 'open' && now['sentBy'] === uid) &&
        !isArchived(now) &&
        paymentsSnap.docs.length === 0;
      if (!untouched) return false;
      const doc: Record<string, unknown> = { ...now, updatedAt: FieldValue.serverTimestamp() };
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete doc[k];
        else doc[k] = v;
      }
      // A whole-document set, not a merge: a field the draft never had is
      // removed rather than left holding the sent value.
      tx.set(ref, doc);
      return true;
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'reviewAndSendDraftInvoice',
      event: 'invoice.draft.send.revert.failed',
      extra: { invoiceId },
      errorMessage: (err as Error)?.message,
    });
  }
  logEvent({
    severity: restored ? 'warn' : 'error',
    function: 'reviewAndSendDraftInvoice',
    event: restored ? 'invoice.draft.send.reverted' : 'invoice.draft.sent.unannounced',
    uid,
    extra: { invoiceId },
    errorMessage: (cause as Error)?.message,
  });
  if (!restored) {
    throw quote
      ? new HttpsError(
          'internal',
          'The quote was sent and the household can see it in MyTribe, but they could not be told about it. Let them know it is there.',
          { code: 'quote_sent_not_announced' },
        )
      : new HttpsError(
          'internal',
          'The invoice was sent, but the household could not be told about it. Use Send reminder to tell them.',
          { code: 'invoice_sent_not_announced' },
        );
  }
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

  return sendDraft(uid, args.invoiceId);
}

/**
 * The send itself, after sign-in and arguments are checked. Exported for
 * `createQuote`, which sends a quote it has just saved through this same core
 * (#2087), so the two cannot disagree about the order, the refusals or the
 * put-back.
 */
export async function sendDraft(uid: string, invoiceId: string): Promise<z.infer<typeof Result>> {
  const args = { invoiceId };
  const ref = db().collection('invoices').doc(args.invoiceId);

  // THIS is the moment a draft becomes a bill, so this is where the payment
  // options are frozen onto it (issue #409). Turning a method off tomorrow
  // stops offering it on new invoices; this one keeps what the household was
  // sent. Fail-soft: no snapshot means live settings, i.e. today's behaviour.
  // Read before the transaction, whose callback Firestore may run again.
  const payMethodSnapshot = await payMethodSnapshotForIssue('reviewAndSendDraftInvoice');

  // THE CHECK AND THE FLIP, ONE TRANSACTION, BEFORE THE HOUSEHOLD HEARS
  // (#2168 review). Every refusal (archived, not a draft, incomplete, a line's
  // visit billed elsewhere, cancelled or gone) is decided on what this
  // transaction read, before it writes anything, and before any notification.
  // A second send racing this one re-runs here, reads `open`, and is refused
  // before it dispatches. The notice goes out only once the invoice is open,
  // so a household is never told about an invoice it cannot open (drafts are
  // hidden from Kinfolk).
  const { data, prior, quote } = await db().runTransaction(async (tx) => {
    const draft = sendableDraft(await tx.get(ref), args.invoiceId);
    // #2087: read off the draft THIS transaction read, so a quote turned into
    // an invoice a moment ago goes out as the invoice it now is.
    const quote = isQuoteDraft(draft);
    const plan = await readSendClaims(tx, db(), args.invoiceId, draft['lineItems'], quote ? 'quote' : 'draft');
    // The state stamp (ADR-0002), in the same write as the flip. The standing is
    // read from the payments SUBCOLLECTION; on a real draft it is empty (a draft
    // cannot take a payment, markInvoicePaid refuses it), but reading it keeps
    // the rule uniform rather than asserted per call site.
    const paymentsSnap = await tx.get(ref.collection('payments'));
    const paidCents = paidCentsFromPayments(paymentsSnap.docs.map((d) => d.data() as PaymentAmount));
    // A quote becomes a QUOTE (a proposal waiting for an answer), never `open`,
    // and loses the draft mark; `quoteSentBy` is what a failed notice's
    // put-back checks, as `sentBy` is for an invoice.
    const update: Record<string, unknown> = quote
      ? {
          status: 'quote',
          invoiceStatus: 'quote',
          [QUOTE_DRAFT_FIELD]: FieldValue.delete(),
          quoteSentAt: FieldValue.serverTimestamp(),
          quoteSentBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        }
      : {
          status: 'open',
          invoiceStatus: 'open',
          sentAt: FieldValue.serverTimestamp(),
          sentBy: uid,
          updatedAt: FieldValue.serverTimestamp(),
        };
    const flip: Record<string, unknown> = {
      ...update,
      ...invoiceStateStampOf({ ...draft, ...update }, paidCents),
      ...payMethodSnapshot,
    };
    tx.set(ref, flip, { merge: true });
    stageClaims(tx, ref, draft, plan);
    // What each flipped field held before, so a failed notice can put the
    // draft back exactly (`updatedAt` is restamped, not restored).
    const before = draft as Record<string, unknown>;
    const prior = Object.fromEntries(
      Object.keys(flip)
        .filter((k) => k !== 'updatedAt')
        .map((k) => [k, before[k]]),
    ) as Record<string, unknown>;
    return { data: draft, prior, quote };
  });

  const familyId = data.kinfolkId as string;
  let recipientUid: string | null;
  let dispatched: Awaited<ReturnType<typeof enqueueNotificationDetailed>>;
  try {
    recipientUid = await resolveBillingRecipientUid(familyId);
    dispatched = await enqueueNotificationDetailed(
      quote
        ? {
            // No quote.issued key exists; invoice.new is the catalog's
            // "New invoice/quote issued." row, and `isQuote` says which.
            key: 'invoice.new',
            recipientUid: recipientUid ?? '',
            data: { kinfolkId: familyId, invoiceId: args.invoiceId, isQuote: true },
            targetType: 'invoice',
            targetId: args.invoiceId,
            dedupeKey: `quote:${args.invoiceId}:send`,
          }
        : {
            key: 'invoice.new',
            recipientUid: recipientUid ?? '',
            data: { kinfolkId: familyId, invoiceId: args.invoiceId },
            targetType: 'invoice',
            targetId: args.invoiceId,
          },
    );
  } catch (err) {
    // Fail loud, as before: the callable surfaces the error and the invoice is
    // a DRAFT again, so the admin sees the send did NOT happen and a retry
    // starts clean.
    await putBackToDraft(ref, uid, prior, args.invoiceId, err, quote);
    throw err;
  }
  // #1511: read for the household alone. `invoice.new` also writes an office
  // copy, and the office's email is not the household's. With no household
  // uid, or a household copy the dispatcher held back, there is no household
  // delivery to describe, and the answer omits it.
  const appOnly = householdAppOnly(dispatched, recipientUid);

  const words = await import('../lib/activityWords.js');
  await writeAuditEntry({
    status: 'SUCCESS',
    event: quote ? AUDIT_EVENTS.BILLING_QUOTE_SENT : AUDIT_EVENTS.BILLING_DRAFT_INVOICE_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId,
    description: quote
      ? words.quoteSentence(data.invoiceNumber, 'sent to the household')
      : `Draft ${words.invoiceWords(data.invoiceNumber).replace(/^an /, '')} reviewed and sent`,
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
    event: quote ? 'admin.quote.sent' : 'admin.invoice.draft.sent',
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
