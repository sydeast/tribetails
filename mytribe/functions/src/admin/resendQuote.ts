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
import { enqueueNotificationDetailed } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { InvoiceStateSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { businessTodayIso, quoteDecisionOf, quoteHasExpired } from '../lib/quoteDecision';

/**
 * SENDS A DECLINED QUOTE BACK OUT, revised (issue #448).
 *
 * OPERATOR RULING, 2026-08-18: a quote is editable until it is ACCEPTED, and a
 * DECLINE is not the end of the conversation — the office changes what needs
 * changing and sends the quote out again. Until this callable existed the
 * second half of that ruling had nowhere to happen. `portal/quoteDecision.ts`
 * recorded the decline on the doc and its header said reviving a declined
 * quote meant minting a brand-new one through `createQuote`; that leaves the
 * household with two quotes for one job, the declined one still sitting on
 * their screen, and it throws away the invoice number, the line items and the
 * sessions the first one carried.
 *
 * WHAT A RESEND ACTUALLY DOES. It CLEARS the household's answer:
 *
 *   quoteDecision      deleted   there is no answer on this quote any more
 *   quoteDecidedAt     deleted
 *   quoteDecidedByUid  deleted
 *   quoteResentAt      stamped   when the office sent it back
 *   quoteResentByUid   stamped   who sent it
 *   quoteResendCount   +1        how many times round this has been
 *
 * Clearing the decision is what makes the quote ANSWERABLE AGAIN, and it needs
 * no client change to do it: both portals gate their Accept/Decline buttons on
 * `quoteDecision == null` alongside a `quote` status (`mytribe/web`'s
 * `InvoiceDetail.tsx` and the Kotlin `InvoiceDetailScreen.kt`), and
 * `portal/quoteDecision.ts`'s own `quote_already_decided` guard re-reads the
 * same field, so the household can accept the revision the moment this
 * commits. `quoteResendCount` exists so the office can see a quote has been
 * round before, which the cleared decision no longer says.
 *
 * WHY ONLY A DECLINED QUOTE. An ACCEPTED one is agreed and frozen
 * (`lib/invoiceEditPolicy.ts`) — reopening it would put an agreed figure back
 * up for negotiation without telling the household why. One still AWAITING an
 * answer does not need resending; nudging it is `sendInvoiceReminder`, which
 * is the callable whose whole job that is. Refusing both by name, rather than
 * quietly succeeding, is what keeps this endpoint one action.
 *
 * AN EXPIRED QUOTE IS REFUSED, and this is the trap the guard exists for: a
 * quote whose `dueDate` has passed can still be DECLINED but can never be
 * ACCEPTED (`quoteDecisionRefusal`'s `quote_expired` branch), so resending one
 * unchanged would hand the household a screen whose only working button is the
 * one that says no. The refusal names the fix — give it a new due date first,
 * which is an ordinary edit because a declined quote is fully editable.
 *
 * THE NOTIFICATION GOES FIRST, and its failure is NOT swallowed, mirroring
 * `reviewAndSendDraftInvoice.ts` for the same reason: sending is the point of
 * this callable, so there must be no path that reopens the quote while leaving
 * the household untold. The inverse order would also strand a retry — the
 * second attempt would find the decision already cleared and refuse as
 * "not declined".
 */
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). `status` is the Invoice State Stamp
 * this write left behind, read back out of the transaction: always 'quote',
 * because a resend does not change what the doc is, only whether it is waiting
 * for an answer. Returned rather than assumed so a client renders the outcome
 * without a second round trip, exactly as the two decision callables do.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    status: InvoiceStateSchema,
  })
  .strict();

/** Refusal codes clients branch on. The message is what a person reads. */
export type ResendQuoteCode =
  | 'quote_not_a_quote'
  | 'quote_accepted_locked'
  | 'quote_not_declined'
  | 'quote_expired';

interface ResendRefusal {
  code: ResendQuoteCode;
  message: string;
}

/**
 * Why a quote cannot be sent back out, or null when it can.
 *
 * PURE and separately tested, same call as `quoteDecisionRefusal`: every branch
 * is a sentence an operator reads, and the expiry arithmetic is the kind that
 * is wrong by a day if nobody pins it down.
 *
 * `todayIso` is the business's own local day, or '' when the zone could not be
 * resolved — in which case the expiry check is SKIPPED rather than guessed,
 * because refusing a resend over an unreadable settings doc would be the worst
 * of the outcomes.
 */
export function resendQuoteRefusal(
  doc: Record<string, unknown>,
  todayIso: string,
): ResendRefusal | null {
  const decision = quoteDecisionOf(doc['quoteDecision']);

  // Checked BEFORE the status, because an accepted quote no longer reads as a
  // quote at all (`acceptQuote` re-stamps it to 'open'), and "this is an
  // invoice, not a quote" would be a true sentence that tells the operator
  // nothing about why.
  if (decision === 'accepted') {
    return {
      code: 'quote_accepted_locked',
      message:
        'The household accepted this quote, so it is a bill now and cannot be sent back out as a quote. Issue a new quote if the work has changed.',
    };
  }

  const rawStatus = doc['status'] ?? doc['invoiceStatus'];
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  if (status !== 'quote') {
    return {
      code: 'quote_not_a_quote',
      message: 'This is an invoice, not a quote, so there is nothing here to send back out.',
    };
  }
  if (decision === null) {
    return {
      code: 'quote_not_declined',
      message:
        'This quote is still waiting for an answer, so there is nothing to revive. Send a reminder if the household needs a nudge.',
    };
  }
  if (quoteHasExpired(doc['dueDate'], todayIso)) {
    return {
      code: 'quote_expired',
      message: `This quote was only good through ${String(doc['dueDate'])}, so the household could decline it again but never accept it. Give it a new due date, then send it back out.`,
    };
  }
  return null;
}

export async function resendQuoteHandler(
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
      throw new HttpsError('invalid-argument', 'resendQuote validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const firestore = db();
  const ref = firestore.collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Quote '${args.invoiceId}' not found.`);
  const data = snap.data() as Record<string, unknown>;

  const kinfolkId = typeof data['kinfolkId'] === 'string' ? (data['kinfolkId'] as string) : '';
  if (kinfolkId === '') {
    throw new HttpsError('failed-precondition', 'This quote is not linked to a household, so there is nobody to send it to.');
  }

  // The business's own calendar day, read only when there is a due date to
  // measure against, exactly as the decision callables do.
  const todayIso =
    typeof data['dueDate'] === 'string' && data['dueDate'].trim() !== ''
      ? await businessTodayIso(firestore, Date.now())
      : '';

  // The pre-flight refusal, so an obviously wrong resend costs no notification.
  // The transaction below re-checks it against the committed doc; this one is
  // the courtesy, that one is the guard.
  const preflight = resendQuoteRefusal(data, todayIso);
  if (preflight) {
    throw new HttpsError('failed-precondition', preflight.message, { code: preflight.code });
  }

  const invoiceNumber = typeof data['invoiceNumber'] === 'string' ? (data['invoiceNumber'] as string) : '';
  const recipientUid = await resolveKinfolkUid(kinfolkId);

  // #832: no household account means nobody the resend is FOR. `invoice.new`
  // also copies the office, so without this the dispatcher would write that
  // copy, report something written, and the quote would reopen having reached
  // no household at all. Refused before anything is sent.
  if (recipientUid === null) {
    throw new HttpsError(
      'failed-precondition',
      'This household has no portal account to send the quote to, so it was not sent again. The quote is still declined.',
      { code: 'quote_resend_unreachable' },
    );
  }

  // FAIL LOUD, and BEFORE the write. See the header: a resend that reopened the
  // quote without telling the household would look like it worked and reach
  // nobody, and a retry after a swallowed failure would refuse as
  // "not declined" because the first attempt had already cleared the decision.
  //
  // #832: THIS RESEND HAS ITS OWN IDENTITY. `createQuote` sends the same key
  // for the same invoice, so without a `dedupeKey` a resend inside the
  // dispatcher's window of the original issue (or of an earlier resend) was
  // refused as a duplicate and the dispatcher returned nothing, silently. The
  // key is the resend's ordinal: a retry of THIS resend (the transaction below
  // never committed, so the count did not move) carries the same number and is
  // deduped, while the next real resend, after the household declines again,
  // carries the next one and sends.
  const resendNumber =
    (typeof data['quoteResendCount'] === 'number' ? (data['quoteResendCount'] as number) : 0) + 1;
  const dispatched = await enqueueNotificationDetailed({
    // There is no quote.issued key; `invoice.new` is the catalog's
    // "New invoice/quote issued." row, and it is what createQuote sends when it
    // issues one in the first place.
    key: 'invoice.new',
    recipientUid,
    data: { kinfolkId, invoiceId: args.invoiceId, isQuote: true, resent: true },
    actorUid: uid,
    targetType: 'invoice',
    targetId: args.invoiceId,
    dedupeKey: `quote:${args.invoiceId}:resend:${resendNumber}`,
  });

  // STILL FAIL LOUD when the dispatcher answered without reaching the household:
  // the header's reasoning applies to "nothing was enqueued" exactly as to "it
  // threw".
  //
  // ONE EXCEPTION, AND IT IS NOT A FAILURE. A household `duplicate` means an
  // earlier attempt at THIS resend (same ordinal) already reached them, and only
  // its reopening transaction did not land. The household has the quote, so the
  // honest thing is to finish the job: reopen it and answer ok. Refusing would
  // leave a quote the household was told about still declined, and the next
  // press would try again with no way to succeed.
  const householdMiss = dispatched.suppressed.find((s) => s.recipientUid === recipientUid);
  const alreadyReachedHousehold = householdMiss?.reason === 'duplicate';
  if (alreadyReachedHousehold) {
    logEvent({
      severity: 'info',
      function: 'resendQuote',
      event: 'quote.resend.already-delivered',
      uid,
      extra: {
        invoiceId: args.invoiceId,
        resendNumber,
        existingId: householdMiss?.existingId ?? null,
        lastAtMs: householdMiss?.lastAtMs ?? null,
      },
    });
  } else if (dispatched.written.length === 0 || householdMiss) {
    const reason = householdMiss?.reason ?? dispatched.suppressed[0]?.reason ?? null;
    if (reason === 'prefs') {
      throw new HttpsError(
        'failed-precondition',
        "The household's notification settings block new quote messages, so a resend would reach nobody. The quote is still declined.",
        { code: 'quote_resend_suppressed' },
      );
    }
    throw new HttpsError(
      'failed-precondition',
      'Nobody could be notified about this quote, so it was not sent again. The quote is still declined.',
      { code: 'quote_resend_unreachable' },
    );
  }

  const status = await firestore.runTransaction(async (tx) => {
    const txSnap = await tx.get(ref);
    if (!txSnap.exists) throw new HttpsError('not-found', `Quote '${args.invoiceId}' not found.`);
    const txData = txSnap.data() as Record<string, unknown>;

    // ATOMIC guard, the same shape `acceptQuote` uses: re-read the decision
    // inside the transaction that clears it, so a resend racing an acceptance
    // (or a second resend) re-reads the committed answer and fails instead of
    // reopening a quote somebody has just agreed to.
    const refusal = resendQuoteRefusal(txData, todayIso);
    if (refusal) throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });

    const update: Record<string, unknown> = {
      quoteDecision: FieldValue.delete(),
      quoteDecidedAt: FieldValue.delete(),
      quoteDecidedByUid: FieldValue.delete(),
      quoteResentAt: FieldValue.serverTimestamp(),
      quoteResentByUid: uid,
      quoteResendCount: FieldValue.increment(1),
      // Re-asserted rather than assumed. A declined quote already carries both
      // spellings as 'quote' (declining never moved them), but writing them
      // here means a doc some other path left inconsistent goes back out as an
      // unambiguous quote rather than as whatever it had drifted to.
      status: 'quote',
      invoiceStatus: 'quote',
      updatedAt: FieldValue.serverTimestamp(),
    };

    // The state stamp (ADR-0002) in the SAME write. The stamp is computed over
    // the post-write doc with `quoteDecision` spelled out as null rather than
    // left as the delete sentinel, so the acceptance dimension of
    // `invoiceEditScope` reads the answer this write actually leaves behind:
    // no decision, a quote, fully editable again. paidCents is 0 by
    // construction — a quote cannot have been paid.
    const stamp = invoiceStateStampOf({ ...txData, ...update, quoteDecision: null }, 0);
    tx.set(ref, { ...update, ...stamp }, { merge: true });
    return stamp.status;
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_QUOTE_RESENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: kinfolkId,
    description: `Declined quote ${invoiceNumber === '' ? args.invoiceId : invoiceNumber} revised and sent again`,
    payload: {
      invoiceId: args.invoiceId,
      invoiceNumber,
      kinfolkId,
      recipientUid: recipientUid ?? null,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'resendQuote',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'resendQuote',
    event: 'admin.quote.resent',
    uid,
    extra: { invoiceId: args.invoiceId, kinfolkId, status },
  });

  return validateResponse('resendQuote', Result, { ok: true, invoiceId: args.invoiceId, status });
}

export const resendQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('resendQuote', resendQuoteHandler),
);
