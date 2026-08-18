import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { InvoiceStateSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import {
  businessTodayIso,
  quoteDecisionOf,
  quoteHasExpired,
  type QuoteDecision,
} from '../lib/quoteDecision';

/**
 * THE TWO ENDS OF A QUOTE'S LIFE. `admin/createQuote.ts` mints one; these two
 * callables are how the household answers it.
 *
 * Until now they did not exist. The catalog carried `quote.accepted` and
 * `quote.denied` as two switches on the notification gate, `createQuote`'s
 * header asserted that "accept/deny are already handled elsewhere", and
 * `docs/notification_audit.md` named `onInvoicesWrite.ts` as the emitter. All
 * three were wrong in the same direction: no code anywhere emitted either key,
 * and a household had no way to answer a quote at all. Issue #385.
 *
 * WHAT A DECISION DOES TO THE DOC. A quote is not a separate model, it is an
 * invoice in QUOTE status, so the decision is recorded on the invoice:
 *
 *   quoteDecision      'accepted' | 'denied'  — what the household said
 *   quoteDecidedAt     server timestamp       — when they said it
 *   quoteDecidedByUid  the deciding member    — who said it
 *
 * ACCEPT ALSO RE-STAMPS THE STATE. An accepted quote stops being a proposal and
 * becomes a bill, so `status`/`invoiceStatus` move off 'quote' and the Invoice
 * State Classifier (ADR-0002) re-reads the doc: an ordinary quote with a
 * balance lands on 'open', which is precisely what makes the portal's Pay
 * button appear (`payable = status === 'open' && amountDue > 0`) with no client
 * change at all. A quote billed at nothing lands on 'zero'. The classifier
 * decides; this file does not hand-pick the resulting state.
 *
 * DENY DOES NOT. A declined quote keeps `status: 'quote'`, and that is a
 * deliberate call rather than an omission. `cancelled` in this codebase means
 * the OPERATOR withdrew a bill; the household saying no is a different fact and
 * the office needs to tell the two apart. It also matters to the household:
 * `getMyInvoices` puts a cancelled invoice in no bucket at all, so cancelling
 * here would delete the quote off their screen the instant they pressed
 * Decline, and the detail route they are standing on would answer "we couldn't
 * find that invoice" as the result of their own action. The quote stays where
 * it is, marked with what they decided.
 *
 * A DECISION IS TERMINAL. Neither callable will overwrite the other's, and
 * neither will repeat its own — the guards below refuse with
 * `failed-precondition`. Reviving a declined quote is not an edit, it is a new
 * quote through `createQuote`, which is the path that notifies the household
 * that something new is waiting for them.
 *
 * CONCURRENCY. Guard and write run inside ONE transaction that re-reads
 * `quoteDecision`, exactly as `redeemCredit` claims a credit: two Accept taps
 * racing each other cannot both pass, because the second re-reads the committed
 * decision and fails.
 */

/**
 * THE REQUEST AND RESPONSE SHAPES (ADR-0001 step W3-1). The two callables take
 * and return the same fields, and they still get FOUR schemas rather than two
 * shared ones: the codegen keys its generated types on schema IDENTITY, so a
 * shared object would emit `AcceptQuoteArgs` and then leave `denyQuote` with no
 * type at all for its clients to import. Built by a factory so the two copies
 * cannot drift into disagreeing about what a decision is.
 *
 * `status` on the result is the STAMPED state the decision left behind, read
 * back out of the transaction that wrote it, so a client can render the outcome
 * without a second round trip. After an accept it is normally 'open'; after a
 * decline it is 'quote', which is not a no-op — the doc now carries the
 * decision beside it.
 */
function decisionArgs() {
  return z.object({
    invoiceId: z.string().min(1),
    /** The household, when the caller belongs to more than one. */
    kinfolkId: z.string().optional(),
  });
}

function decisionResult() {
  return z
    .object({
      ok: OkSchema,
      /** Echoed so a caller can pair the answer with the row it came from. */
      invoiceId: z.string().min(1),
      /** The Invoice State Stamp this decision wrote. */
      status: InvoiceStateSchema,
    })
    .strict();
}

export const AcceptQuoteArgs = decisionArgs();
export const AcceptQuoteResult = decisionResult();
export const DenyQuoteArgs = decisionArgs();
export const DenyQuoteResult = decisionResult();

type DecisionResultShape = z.infer<ReturnType<typeof decisionResult>>;

/** Refusal codes clients branch on. The message is what a person reads. */
export type QuoteDecisionCode = 'quote_not_a_quote' | 'quote_already_decided' | 'quote_expired';

/**
 * Why a quote cannot be decided, or null when it can.
 *
 * PURE, and separately tested: every branch here is a sentence a household
 * reads on their own screen, and the arithmetic behind the expiry one is the
 * kind that is wrong by a day if nobody pins it down.
 *
 * `todayIso` is the business's own local day (see `lib/quoteDecision.ts`), or
 * '' when the zone could not be resolved — in which case the expiry check is
 * SKIPPED rather than guessed. Refusing a household's acceptance because our
 * own settings doc was unreadable would be the worst of the three outcomes.
 */
export function quoteDecisionRefusal(
  doc: Record<string, unknown>,
  decision: QuoteDecision,
  todayIso: string,
): { code: QuoteDecisionCode; message: string } | null {
  const rawStatus = doc['status'] ?? doc['invoiceStatus'];
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  const existing = quoteDecisionOf(doc['quoteDecision']);

  if (existing !== null) {
    return {
      code: 'quote_already_decided',
      message:
        existing === 'accepted'
          ? 'This quote has already been accepted. Your Auntie has it and will be in touch.'
          : 'This quote has already been declined. Ask your Auntie for a fresh one if you have changed your mind.',
    };
  }
  if (status !== 'quote') {
    return {
      code: 'quote_not_a_quote',
      message: 'This is an invoice, not a quote, so there is nothing here to accept or decline.',
    };
  }
  // Declining an expired quote is still an honest answer, and refusing it would
  // leave the household with a screen they cannot clear. Only ACCEPTING an
  // expired quote is refused, because accepting is what turns it into a bill at
  // a price nobody stands behind any more.
  if (decision === 'accepted' && quoteHasExpired(doc['dueDate'], todayIso)) {
    return {
      code: 'quote_expired',
      message: `This quote was only good through ${String(doc['dueDate'])}, so it can no longer be accepted. Ask your Auntie for an up-to-date one.`,
    };
  }
  return null;
}

interface DecisionOutcome {
  invoiceId: string;
  kinfolkId: string;
  status: z.infer<typeof InvoiceStateSchema>;
  invoiceNumber: string;
}

/**
 * The shared body of both callables. `decision` is the only thing that differs
 * before the write; after it, the audit event and the notification key differ
 * too, and both are named here rather than in two near-identical files.
 */
async function decideQuote(
  req: CallableRequest<unknown>,
  decision: QuoteDecision,
  functionName: 'acceptQuote' | 'denyQuote',
): Promise<DecisionResultShape> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = (decision === 'accepted' ? AcceptQuoteArgs : DenyQuoteArgs).parse(req.data);

  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowed.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');

  const invoiceRef = firestore.collection('invoices').doc(args.invoiceId);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) throw new HttpsError('not-found', 'Quote not found.');
  const inv = invoiceSnap.data() as Record<string, unknown>;

  const invKinfolkId = typeof inv['kinfolkId'] === 'string' ? (inv['kinfolkId'] as string) : null;
  if (!invKinfolkId) throw new HttpsError('failed-precondition', 'Quote not linked to a tribe.');
  if (!allowed.includes(invKinfolkId)) {
    throw new HttpsError('permission-denied', 'This quote belongs to another household.');
  }
  // Same gate the money paths use: answering a quote commits the household to a
  // bill, so it is the primary kinfolk's call, not a secondary member's.
  await requireKinfolkPrimary(uid, invKinfolkId, req.auth?.token?.admin === true, functionName);

  // Read the business's own calendar day ONLY when the quote carries a due date
  // to be measured against, so an undated quote costs no extra read.
  const todayIso =
    decision === 'accepted' && typeof inv['dueDate'] === 'string' && inv['dueDate'].trim() !== ''
      ? await businessTodayIso(firestore, Date.now())
      : '';

  const outcome = await firestore.runTransaction(async (tx): Promise<DecisionOutcome> => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const txInv = snap.data() as Record<string, unknown>;

    // ATOMIC guard: re-read inside the transaction, written inside the same
    // transaction, so a concurrent second decision re-reads this one and fails.
    const refusal = quoteDecisionRefusal(txInv, decision, todayIso);
    if (refusal) throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });

    const update: Record<string, unknown> = {
      quoteDecision: decision,
      quoteDecidedAt: FieldValue.serverTimestamp(),
      quoteDecidedByUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
      // An accepted quote is a bill. Both spellings move together, exactly as
      // createQuote writes both: `status` is the admin/classifier field and
      // `invoiceStatus` is the legacy one the sandbox seeds still write.
      ...(decision === 'accepted' ? { status: 'open', invoiceStatus: 'open' } : {}),
    };
    // The state stamp (ADR-0002) in the SAME write, over the merged doc. On a
    // decline the merged doc still says 'quote', so the stamp re-affirms it
    // rather than inventing a state. paidCents is 0 without reading the
    // payments subcollection: a quote cannot have been paid, and after an
    // accept the doc is a brand-new bill with nothing collected against it.
    const stamp = invoiceStateStampOf({ ...txInv, ...update }, 0);
    tx.set(invoiceRef, { ...update, ...stamp }, { merge: true });

    return {
      invoiceId: args.invoiceId,
      kinfolkId: invKinfolkId,
      status: stamp.status,
      invoiceNumber: typeof txInv['invoiceNumber'] === 'string' ? txInv['invoiceNumber'] : '',
    };
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: decision === 'accepted' ? AUDIT_EVENTS.BILLING_QUOTE_ACCEPTED : AUDIT_EVENTS.BILLING_QUOTE_DENIED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: uid,
    familyId: outcome.kinfolkId,
    description: decision === 'accepted' ? 'Kinfolk accepted a quote' : 'Kinfolk declined a quote',
    payload: {
      invoiceId: outcome.invoiceId,
      invoiceNumber: outcome.invoiceNumber,
      status: outcome.status,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  // THE TWO KEYS THIS ISSUE IS ABOUT. Emitted after the transaction commits and
  // wrapped, same as createQuote's: the decision is recorded either way, and a
  // notification that could not be built must not undo it.
  //
  // `quote.accepted` is audience 'both' (kinfolkAcct primary + businessAdmins
  // secondary), so it needs the household's uid; `quote.denied` is business
  // only and resolves its own recipients, but the household id still rides in
  // `data` because the template enricher hydrates {{kinName}} from it.
  const key = decision === 'accepted' ? 'quote.accepted' : 'quote.denied';
  try {
    const recipientUid = decision === 'accepted' ? await resolveKinfolkUid(outcome.kinfolkId) : null;
    await enqueueNotification({
      key,
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: outcome.kinfolkId,
        invoiceId: outcome.invoiceId,
        invoiceNumber: outcome.invoiceNumber,
      },
      actorUid: uid,
      targetType: 'invoice',
      targetId: outcome.invoiceId,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'notification.dispatch.failed',
      uid,
      extra: {
        kinfolkId: outcome.kinfolkId,
        invoiceId: outcome.invoiceId,
        key,
        err: (err as Error)?.message,
      },
    });
  }

  logEvent({
    severity: 'info',
    function: functionName,
    event: decision === 'accepted' ? 'portal.quote.accepted' : 'portal.quote.denied',
    uid,
    extra: { invoiceId: outcome.invoiceId, kinfolkId: outcome.kinfolkId, status: outcome.status },
  });

  return validateResponse(functionName, decision === 'accepted' ? AcceptQuoteResult : DenyQuoteResult, {
    ok: true,
    invoiceId: outcome.invoiceId,
    status: outcome.status,
  });
}

export async function acceptQuoteHandler(
  req: CallableRequest<unknown>,
): Promise<DecisionResultShape> {
  return decideQuote(req, 'accepted', 'acceptQuote');
}

export async function denyQuoteHandler(
  req: CallableRequest<unknown>,
): Promise<DecisionResultShape> {
  return decideQuote(req, 'denied', 'denyQuote');
}

export const acceptQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('acceptQuote', acceptQuoteHandler),
);

export const denyQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('denyQuote', denyQuoteHandler),
);
