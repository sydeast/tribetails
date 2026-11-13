import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
// #1005: money notices go to a member with billing access, not the last-synced account.
import { resolveBillingRecipientUid } from '../lib/resolveBillingRecipientUid';
import {
  NOTIFICATION_DEDUPE_WINDOW_MS,
  enqueueNotificationDetailed,
  lastDeliveredAtMs,
} from '../notifications/dispatcher';
import { reachedAppOnly } from '../notifications/appOnly';
import { TRIBETAILS_CORS } from '../lib/cors';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { InvoiceStateSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { quoteDecisionOf } from '../lib/quoteDecision';
import { INVOICE_ARCHIVED_CODE, isArchived } from '../lib/invoiceArchive';
import { readQuoteReopen, readSessionsHeldBy, stageSessionLinks, visitsNamedBy } from '../lib/invoiceSessionLinks';

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
 *   quoteDecidedByName deleted   #1039: goes with the three above
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
 * #2088 (operator ruling 2026-11-12): A QUOTE DOES NOT EXPIRE, so a declined
 * quote whose due date has passed is sent back out like any other. #2195: an
 * ARCHIVED quote is refused, as every write to an archived invoice is
 * (`refuseIfArchived`): the household cannot see it, so it is restored first.
 *
 * ORDER (#2156 review, the order `reviewAndSendDraftInvoice.ts` took in the
 * #2168 review): the checks, the claim on the quote's visits and the reopen are
 * ONE transaction, and the household's notice goes out only after it commits.
 * The notice used to go first, so a New invoice that took one of the quote's
 * visits before the reopen left the household told about a quote holding
 * nothing, whose Accept was then refused.
 *
 * The notice's failure is still NOT swallowed: sending is the point of this
 * callable, so there must be no path that reopens the quote while leaving the
 * household untold. When it fails, the quote is put back to the declined quote
 * it was and the visits it took go back on the list (`putBackToDeclined`), so
 * an error still means "not sent" and a retry starts clean. The retry carries
 * the same resend ordinal, so a notice the failed attempt did deliver is a
 * `duplicate` and is not sent twice (#832).
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
 *
 * #1507: `appOnly` is present when THIS call wrote the household's copy, and
 * true when every delivery channel was off for them: the quote is in their
 * notifications list and nothing was emailed or texted. Absent on the retry
 * of a resend that already completed, which sends nothing and has no new
 * answer to give.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    status: InvoiceStateSchema,
    appOnly: z.boolean().optional(),
  })
  .strict();

/** Refusal codes clients branch on. The message is what a person reads. */
export type ResendQuoteCode =
  | 'quote_not_a_quote'
  | 'quote_accepted_locked'
  | 'quote_not_declined'
  | 'invoice_archived';

interface ResendRefusal {
  code: ResendQuoteCode;
  message: string;
}

/**
 * Why a quote cannot be sent back out, or null when it can.
 *
 * PURE and separately tested, same call as `quoteDecisionRefusal`: every branch
 * is a sentence an operator reads.
 */
export function resendQuoteRefusal(doc: Record<string, unknown>): ResendRefusal | null {
  const decision = quoteDecisionOf(doc['quoteDecision']);

  // #2195: an archived invoice is read-only until it is restored, the same
  // sentence and code every other write gives (`refuseIfArchived`).
  if (isArchived(doc)) {
    return {
      code: INVOICE_ARCHIVED_CODE,
      message: 'This invoice is archived. Restore it before sending or changing it.',
    };
  }

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
  return null;
}

/**
 * The ok answer for a retry of a resend that already completed, or null when
 * this is not one (#832).
 *
 * The last completed resend used ordinal `quoteResendCount` (the transaction
 * bumped the count after sending), so its identity is
 * `quote:<id>:resend:<count>`. Only a delivery to the household inside
 * NOTIFICATION_DEDUPE_WINDOW_MS counts: an older one is a quote that has simply
 * been waiting, and gets the ordinary refusal.
 */
async function completedResendAnswer(
  invoiceId: string,
  kinfolkId: string,
  data: Record<string, unknown>,
): Promise<z.infer<typeof Result> | null> {
  const count = data['quoteResendCount'];
  if (typeof count !== 'number' || count < 1) return null;
  const recipientUid = await resolveBillingRecipientUid(kinfolkId);
  if (recipientUid === null) return null;
  const at = await lastDeliveredAtMs('invoice.new', `quote:${invoiceId}:resend:${count}`, recipientUid);
  if (at === null || Date.now() - at >= NOTIFICATION_DEDUPE_WINDOW_MS) return null;
  logEvent({
    severity: 'info',
    function: 'resendQuote',
    event: 'quote.resend.retry-of-completed',
    extra: { invoiceId, resendNumber: count, deliveredAtMs: at },
  });
  return validateResponse('resendQuote', Result, {
    ok: true,
    invoiceId,
    status: invoiceStateStampOf(data, 0).status,
  });
}

/**
 * #2156 review: the notice failed after the reopen committed. Puts the quote
 * back to the declined quote it was, in a transaction, and lets go of the
 * visits this resend took, so "an error means it was not sent" stays true and
 * the visits are back on the un-invoiced list. Only when nothing has happened
 * to it since: still a quote with no answer, reopened by this caller, on this
 * resend's ordinal. When it cannot be put back, the error says it went out
 * unannounced.
 */
async function putBackToDeclined(
  ref: DocumentReference,
  uid: string,
  invoiceId: string,
  prior: Record<string, unknown>,
  claimed: readonly string[],
  resendNumber: number,
  cause: unknown,
): Promise<void> {
  let restored = false;
  try {
    restored = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = (snap.exists ? snap.data() : undefined) as Record<string, unknown> | undefined;
      const rawStatus = now?.['status'] ?? now?.['invoiceStatus'];
      const untouched =
        now !== undefined &&
        typeof rawStatus === 'string' &&
        rawStatus.trim().toLowerCase() === 'quote' &&
        quoteDecisionOf(now['quoteDecision']) === null &&
        now['quoteResentByUid'] === uid &&
        now['quoteResendCount'] === resendNumber;
      if (!untouched) return false;
      // Every read before any write: the visits this resend claimed, and any
      // other visit the quote names now (an Edit landing while the notice was
      // failing can add a line and take its visit). A declined quote holds
      // none, so every one still naming the quote is let go.
      const candidates = Array.from(new Set([...claimed, ...visitsNamedBy(now)]));
      const plan = candidates.length > 0 ? await readSessionsHeldBy(tx, db(), invoiceId, candidates) : null;
      const doc: Record<string, unknown> = { ...now, updatedAt: FieldValue.serverTimestamp() };
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete doc[k];
        else doc[k] = v;
      }
      // A whole-document set, not a merge: a field the declined quote never
      // had (a first resend's `quoteResentAt`) is removed, not left behind.
      tx.set(ref, doc);
      if (plan !== null) stageSessionLinks(tx, db(), plan, new Date().toISOString());
      return true;
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'resendQuote',
      event: 'quote.resend.revert.failed',
      extra: { invoiceId },
      errorMessage: (err as Error)?.message,
    });
  }
  logEvent({
    severity: restored ? 'warn' : 'error',
    function: 'resendQuote',
    event: restored ? 'quote.resend.reverted' : 'quote.resent.unannounced',
    uid,
    extra: { invoiceId, resendNumber },
    errorMessage: (cause as Error)?.message,
  });
  if (!restored) {
    throw new HttpsError(
      'internal',
      'The quote was sent back out, but the household could not be told about it. Use Send reminder to tell them.',
      { code: 'quote_resent_not_announced' },
    );
  }
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


  // The pre-flight refusal, so an obviously wrong resend costs no notification.
  // The transaction below re-checks it against the committed doc; this one is
  // the courtesy, that one is the guard.
  const preflight = resendQuoteRefusal(data);
  if (preflight) {
    // #832: a client retry of a resend that COMPLETED. The quote is already
    // reopened, so it reads as "still waiting for an answer", and refusing with
    // that sentence would tell the operator their resend failed when it went
    // out. When the ledger has this resend reaching the household inside the
    // dispatcher window, it is the same action: answer ok.
    if (preflight.code === 'quote_not_declined') {
      const done = await completedResendAnswer(args.invoiceId, kinfolkId, data);
      if (done) return done;
    }
    throw new HttpsError('failed-precondition', preflight.message, { code: preflight.code });
  }

  const invoiceNumber = typeof data['invoiceNumber'] === 'string' ? (data['invoiceNumber'] as string) : '';
  const recipientUid = await resolveBillingRecipientUid(kinfolkId);

  // #832: no household account means nobody the resend is FOR. `invoice.new`
  // also copies the office, so without this the dispatcher would write that
  // copy, report something written, and the quote would reopen having reached
  // no household at all. Refused before anything is written or sent.
  if (recipientUid === null) {
    throw new HttpsError(
      'failed-precondition',
      'This household has no portal account to send the quote to, so it was not sent again. The quote is still declined.',
      { code: 'quote_resend_unreachable' },
    );
  }

  // THE CHECK, THE CLAIM AND THE REOPEN: ONE TRANSACTION, BEFORE THE HOUSEHOLD
  // HEARS (#2156 review). The order `reviewAndSendDraftInvoice` moved to in the
  // #2168 review, for the same reason. Until now the notice went out first and
  // the reopen followed, so a New invoice that took one of the quote's visits
  // in between left the household told about a quote that reopened holding
  // nothing and whose Accept was then refused. Every refusal (not declined,
  // accepted, archived, a line's visit billed elsewhere, cancelled or gone) is
  // decided on what this transaction read, before it writes anything and
  // before any notification. A New invoice save or a second resend racing this
  // one is refereed by Firestore: whichever commits second re-runs and sees
  // the other.
  const { status, sessionsLinked, resendNumber, prior } = await firestore.runTransaction(async (tx) => {
    const txSnap = await tx.get(ref);
    if (!txSnap.exists) throw new HttpsError('not-found', `Quote '${args.invoiceId}' not found.`);
    const txData = txSnap.data() as Record<string, unknown>;

    // ATOMIC guard, the same shape `acceptQuote` uses: re-read the decision
    // inside the transaction that clears it, so a resend racing an acceptance
    // (or a second resend) re-reads the committed answer and fails instead of
    // reopening a quote somebody has just agreed to.
    const refusal = resendQuoteRefusal(txData);
    if (refusal) throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });
    // #2156: declining let the quote's visits go back on the un-invoiced list,
    // and sending it back out takes them back, or refuses when a line's visit
    // can no longer be quoted (accepting it would bill that work twice).
    const visits = await readQuoteReopen(tx, firestore, args.invoiceId, txData);

    // #832: THIS RESEND'S ORDINAL, written as a number rather than an
    // increment, so a failed notice can put the count back exactly.
    const resendNumber =
      (typeof txData['quoteResendCount'] === 'number' ? (txData['quoteResendCount'] as number) : 0) + 1;
    const update: Record<string, unknown> = {
      ...visits.fields,
      quoteDecision: FieldValue.delete(),
      quoteDecidedAt: FieldValue.delete(),
      quoteDecidedByUid: FieldValue.delete(),
      // #1039: the name goes with the decision it named. Deleted alongside
      // the other three so a resent quote never carries the PREVIOUS round's
      // "Sam accepted" into an invoice nobody has answered yet.
      quoteDecidedByName: FieldValue.delete(),
      quoteResentAt: FieldValue.serverTimestamp(),
      quoteResentByUid: uid,
      quoteResendCount: resendNumber,
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
    const write = { ...update, ...stamp };
    tx.set(ref, write, { merge: true });
    stageSessionLinks(tx, firestore, visits.plan, new Date().toISOString());
    // What each written field held before, so a failed notice can put the
    // quote back exactly (`updatedAt` is restamped, not restored).
    const prior = Object.fromEntries(
      Object.keys(write)
        .filter((k) => k !== 'updatedAt')
        .map((k) => [k, txData[k]]),
    ) as Record<string, unknown>;
    return { status: stamp.status, sessionsLinked: visits.plan.claim, resendNumber, prior };
  });

  // The notice, now that the quote is reopened and holds its visits. FAIL
  // LOUD: a resend that reopened the quote without telling the household would
  // look like it worked and reach nobody, so any failure below puts the quote
  // back to declined and lets the visits it just took go again
  // (`putBackToDeclined`), and an error still means "not sent".
  //
  // #832: THIS RESEND HAS ITS OWN IDENTITY. `createQuote` sends the same key
  // for the same invoice, so without a `dedupeKey` a resend inside the
  // dispatcher's window of the original issue (or of an earlier resend) was
  // refused as a duplicate and the dispatcher returned nothing, silently. The
  // key is the resend's ordinal. A failed attempt puts the count back, so its
  // retry carries the same number: a notice the failed attempt did deliver
  // reads as a `duplicate` below and is not sent twice. The next real resend,
  // after the household declines again, carries the next number and sends.
  const putBack = (cause: unknown) =>
    putBackToDeclined(ref, uid, args.invoiceId, prior, sessionsLinked, resendNumber, cause);
  let dispatched: Awaited<ReturnType<typeof enqueueNotificationDetailed>>;
  try {
    dispatched = await enqueueNotificationDetailed({
      // There is no quote.issued key; `invoice.new` is the catalog's
      // "New invoice/quote issued." row, and it is what createQuote sends when
      // it issues one in the first place.
      key: 'invoice.new',
      recipientUid,
      data: { kinfolkId, invoiceId: args.invoiceId, isQuote: true, resent: true },
      actorUid: uid,
      targetType: 'invoice',
      targetId: args.invoiceId,
      dedupeKey: `quote:${args.invoiceId}:resend:${resendNumber}`,
    });
  } catch (err) {
    await putBack(err);
    throw err;
  }

  // STILL FAIL LOUD when the dispatcher answered without reaching the household:
  // the header's reasoning applies to "nothing was enqueued" exactly as to "it
  // threw".
  //
  // ONE EXCEPTION, AND IT IS NOT A FAILURE. A household `duplicate` means an
  // earlier attempt at THIS resend (same ordinal) already reached them, and
  // that attempt was then put back. The household has the quote, so the honest
  // thing is to finish the job: keep it reopened and answer ok. Refusing would
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
    const refusal =
      reason === 'prefs'
        ? new HttpsError(
            'failed-precondition',
            "The household's notification settings block new quote messages, so a resend would reach nobody. The quote is still declined.",
            { code: 'quote_resend_suppressed' },
          )
        : // The pre-launch household gate is shut (notifications/householdSendGate.ts).
          // Its own message, because the fix has nothing to do with this
          // household: `quote_resend_suppressed` would send the operator to a
          // notification settings screen that is not the problem, and the
          // generic message below reads as a broken recipient roster. The quote
          // is put back to declined, so pressing again once the gate is open
          // does exactly what this press meant to do.
          reason === 'gate'
          ? new HttpsError(
              'failed-precondition',
              'Household notifications are switched off until the business goes live, so this quote was not sent again. It is still declined. Turn household notifications on, then press again.',
              { code: 'quote_resend_gated' },
            )
          : new HttpsError(
              'failed-precondition',
              'Nobody could be notified about this quote, so it was not sent again. The quote is still declined.',
              { code: 'quote_resend_unreachable' },
            );
    await putBack(refusal);
    throw refusal;
  }

  // #1507: the household's copy exists; this says whether anything was sent
  // behind it. Read for the household alone: `invoice.new` also writes an
  // office copy, and the office's email is not the household's.
  const appOnly = alreadyReachedHousehold ? false : reachedAppOnly(dispatched, recipientUid);

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_QUOTE_RESENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: kinfolkId,
    description: (await import('../lib/activityWords.js')).quoteRevisedWords(invoiceNumber),
    payload: {
      invoiceId: args.invoiceId,
      invoiceNumber,
      kinfolkId,
      recipientUid: recipientUid ?? null,
      // #2156: the visits the quote took back from the un-invoiced list.
      sessionsLinked,
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
    extra: { invoiceId: args.invoiceId, kinfolkId, status, appOnly },
  });

  return validateResponse('resendQuote', Result, { ok: true, invoiceId: args.invoiceId, status, appOnly });
}

export const resendQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('resendQuote', resendQuoteHandler),
);
