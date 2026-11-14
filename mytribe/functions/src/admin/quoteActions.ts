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
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { validateResponse } from '../lib/callableResponse';
import { InvoiceStateSchema, OkSchema } from '../lib/invoiceResponseSchema';
import { INVOICE_STATES } from '../lib/invoiceEditPolicy';
import { refuseIfArchived } from '../lib/invoiceArchive';
import { QUOTE_DRAFT_FIELD, isQuoteDraft, isSentQuote, quoteDecisionOf } from '../lib/quoteDecision';
import {
  quoteWithdrawn,
  readDeclineRelease,
  readQuoteReopen,
  stageSessionLinks,
  storedReleasedSessionIds,
} from '../lib/invoiceSessionLinks';

/**
 * #2088: WHAT THE OFFICE CAN DO WITH A QUOTE ONCE IT EXISTS, besides sending it
 * (`reviewAndSendDraftInvoice`) and sending a declined one back out
 * (`resendQuote`). Operator ruling 2026-11-12: a quote is an invoice status,
 * and it stays a quote until the Kinfolk accepts or declines it, or the office
 * changes it. These are the two changes:
 *
 *   convertQuoteToInvoice  the quote becomes a DRAFT INVOICE. It keeps its
 *                          number, its lines and the visits it holds (a
 *                          declined one takes its visits back, by the resend
 *                          rule), and any answer on it is cleared. Money
 *                          becomes owed only when the office sends that
 *                          draft, through the ordinary draft send, so the
 *                          household hears about the bill once, at that
 *                          moment. Until then MyTribe shows it to no one
 *                          (`lib/quoteDecision.ts#hiddenFromHousehold`).
 *   withdrawQuote          the quote is CANCELLED, the codebase's word for the
 *                          office withdrawing something, which MyTribe shows
 *                          no one. Its visits go back on the not-yet-invoiced
 *                          list exactly as a decline lets them go
 *                          (`readDeclineRelease`). Its lines stay as the
 *                          record of what was quoted.
 *
 * Both work on a quote saved unsent (a draft carrying the quote mark), a sent
 * quote waiting for an answer, and a declined one. An ACCEPTED quote is an
 * open invoice and is refused: it is handled as the bill it is. An archived
 * one is read-only until it is restored (`refuseIfArchived`).
 *
 * ONE TRANSACTION each: the check, the visits and the status flip land
 * together or not at all, so an Accept racing either is refereed by Firestore.
 * Whichever commits second re-runs, reads the other's write, and is refused
 * (`acceptQuote` refuses a withdrawn or turned quote; these refuse an accepted
 * one). Neither tells the household anything: an office change to a quote is
 * silent, as an invoice edit is.
 */

export const ConvertQuoteToInvoiceArgs = z.object({
  invoiceId: z.string().min(1).max(200),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). `status` is the stamp the write
 * left behind, always 'draft', returned so a client renders the outcome
 * without a second read. `.strict()`, so an added field is reported.
 */
export const ConvertQuoteToInvoiceResult = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    status: InvoiceStateSchema,
  })
  .strict();

export const WithdrawQuoteArgs = z.object({
  invoiceId: z.string().min(1).max(200),
});

/**
 * The RESPONSE shape. `status` is always 'cancelled'; `releasedSessionIds` is
 * the visits withdrawing put back on the not-yet-invoiced list, empty for a
 * declined quote, which held none.
 */
export const WithdrawQuoteResult = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    status: InvoiceStateSchema,
    releasedSessionIds: z.array(z.string()),
  })
  .strict();

/** Refusal codes clients branch on. The message is what a person reads. */
export type QuoteActionCode = 'quote_not_a_quote' | 'quote_accepted_locked';

/**
 * Why this doc is not a quote the office can change, or null when it is one.
 * PURE, so every sentence is pinned by a test. Read on the snapshot the
 * transaction took.
 */
export function quoteActionRefusal(
  doc: Record<string, unknown>,
  action: 'convert' | 'withdraw',
): { code: QuoteActionCode; message: string } | null {
  // Checked before the status: an accepted quote reads as an open invoice,
  // and "this is not a quote" would be true and say nothing about why.
  if (quoteDecisionOf(doc['quoteDecision']) === 'accepted') {
    return {
      code: 'quote_accepted_locked',
      message:
        action === 'convert'
          ? 'The household accepted this quote, so it is an invoice already.'
          : 'The household accepted this quote, so it is an invoice now and cannot be withdrawn as a quote.',
    };
  }
  if (!isQuoteDraft(doc) && !isSentQuote(doc)) {
    // What the quote became, when it was one: "not a quote" is true of both,
    // and says nothing about which of the two the office already did.
    if (action === 'convert' && quoteWithdrawn(doc)) {
      return { code: 'quote_not_a_quote', message: 'This quote was withdrawn, so it cannot be turned into an invoice.' };
    }
    if (action === 'withdraw' && wasConverted(doc)) {
      return {
        code: 'quote_not_a_quote',
        message: 'This quote was turned into an invoice, so there is no quote left to withdraw.',
      };
    }
    return {
      code: 'quote_not_a_quote',
      message:
        action === 'convert'
          ? 'This is not a quote, so there is nothing to turn into an invoice.'
          : 'This is not a quote, so there is nothing to withdraw.',
    };
  }
  return null;
}

/** #2088: the office turned this quote into an invoice (it is no longer a quote). */
function wasConverted(doc: Record<string, unknown>): boolean {
  return (
    doc['quoteConvertedAt'] !== undefined &&
    doc['quoteConvertedAt'] !== null &&
    !isQuoteDraft(doc) &&
    !isSentQuote(doc)
  );
}

/**
 * True when the change asked for has already been made: a retry of a Turn into
 * invoice or a Withdraw that succeeded, whose answer the client never saw. The
 * retry answers success and writes nothing, rather than "This is not a quote",
 * which would tell the office its change failed when it did not. PURE.
 */
export function quoteActionAlreadyDone(doc: Record<string, unknown>, action: 'convert' | 'withdraw'): boolean {
  return action === 'convert' ? wasConverted(doc) : quoteWithdrawn(doc);
}

/** The stored state, for a retry's answer; 'draft' when the stamp is unreadable. */
function storedState(doc: Record<string, unknown>): z.infer<typeof InvoiceStateSchema> {
  const raw = doc['status'] ?? doc['invoiceStatus'];
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (INVOICE_STATES as readonly string[]).includes(status)
    ? (status as z.infer<typeof InvoiceStateSchema>)
    : 'draft';
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, name: string): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', `${name} validation failed`, {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

/** The fields that record a household's answer, cleared when the quote stops being one. */
const ANSWER_FIELDS = ['quoteDecision', 'quoteDecidedAt', 'quoteDecidedByUid', 'quoteDecidedByName'] as const;

async function audit(entry: Parameters<typeof writeAuditEntry>[0], fn: string, uid: string): Promise<void> {
  await writeAuditEntry(entry).catch((err) => {
    logEvent({ severity: 'warn', function: fn, event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });
}

export async function convertQuoteToInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof ConvertQuoteToInvoiceResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parse(ConvertQuoteToInvoiceArgs, req.data, 'convertQuoteToInvoice');
  const firestore = db();
  const ref = firestore.collection('invoices').doc(args.invoiceId);

  const outcome = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'That quote could not be found.');
    const data = snap.data() as Record<string, unknown>;
    // A retry of a convert that already happened: nothing to write or record.
    if (quoteActionAlreadyDone(data, 'convert')) return { alreadyDone: true as const, status: storedState(data) };
    refuseIfArchived(data);
    const refusal = quoteActionRefusal(data, 'convert');
    if (refusal) throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });

    // The invoice it becomes bills its visits, so every one its lines are for
    // must be its own or free: one billed elsewhere, cancelled or gone refuses
    // the change by its day, with nothing written. A declined quote let its
    // visits go, and takes the free ones back here.
    const visits = await readQuoteReopen(tx, firestore, args.invoiceId, data, 'convert');
    const update: Record<string, unknown> = {
      ...visits.fields,
      status: 'draft',
      invoiceStatus: 'draft',
      [QUOTE_DRAFT_FIELD]: FieldValue.delete(),
      ...Object.fromEntries(ANSWER_FIELDS.map((k) => [k, FieldValue.delete()])),
      quoteConvertedAt: FieldValue.serverTimestamp(),
      quoteConvertedBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Stamped over the doc this write leaves: a draft, with no answer on it.
    const stamp = invoiceStateStampOf({ ...data, ...update, quoteDecision: null }, 0);
    tx.set(ref, { ...update, ...stamp }, { merge: true });
    stageSessionLinks(tx, firestore, visits.plan, new Date().toISOString());
    return {
      alreadyDone: false as const,
      status: stamp.status,
      kinfolkId: typeof data['kinfolkId'] === 'string' ? (data['kinfolkId'] as string) : undefined,
      invoiceNumber: data['invoiceNumber'],
      wasSent: isSentQuote(data),
      decision: quoteDecisionOf(data['quoteDecision']),
      sessionsLinked: visits.plan.claim,
    };
  });

  if (outcome.alreadyDone) {
    logEvent({
      severity: 'info',
      function: 'convertQuoteToInvoice',
      event: 'admin.quote.convert.retry-of-completed',
      uid,
      extra: { invoiceId: args.invoiceId },
    });
    return validateResponse('convertQuoteToInvoice', ConvertQuoteToInvoiceResult, {
      ok: true,
      invoiceId: args.invoiceId,
      status: outcome.status,
    });
  }

  const words = await import('../lib/activityWords.js');
  await audit(
    {
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BILLING_QUOTE_CONVERTED,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.invoiceId,
      targetCollection: 'invoices',
      familyId: outcome.kinfolkId,
      description: words.quoteSentence(outcome.invoiceNumber, 'turned into a draft invoice'),
      payload: {
        invoiceId: args.invoiceId,
        wasSent: outcome.wasSent,
        // The answer this change cleared, so the record keeps it.
        clearedDecision: outcome.decision,
        sessionsLinked: outcome.sessionsLinked,
      },
    },
    'convertQuoteToInvoice',
    uid,
  );
  logEvent({
    severity: 'info',
    function: 'convertQuoteToInvoice',
    event: 'admin.quote.converted',
    uid,
    extra: { invoiceId: args.invoiceId, wasSent: outcome.wasSent },
  });
  return validateResponse('convertQuoteToInvoice', ConvertQuoteToInvoiceResult, {
    ok: true,
    invoiceId: args.invoiceId,
    status: outcome.status,
  });
}

export async function withdrawQuoteHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof WithdrawQuoteResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parse(WithdrawQuoteArgs, req.data, 'withdrawQuote');
  const firestore = db();
  const ref = firestore.collection('invoices').doc(args.invoiceId);

  const outcome = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'That quote could not be found.');
    const data = snap.data() as Record<string, unknown>;
    // A retry of a withdraw that already happened: it answers with the visits
    // that withdrawal put back, and writes and records nothing.
    if (quoteActionAlreadyDone(data, 'withdraw')) {
      return { alreadyDone: true as const, status: storedState(data), released: storedReleasedSessionIds(data) };
    }
    refuseIfArchived(data);
    const refusal = quoteActionRefusal(data, 'withdraw');
    if (refusal) throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });

    // Like a decline: every visit the quote holds goes back on the list.
    const visits = await readDeclineRelease(tx, firestore, args.invoiceId, data);
    const update: Record<string, unknown> = {
      ...visits.fields,
      status: 'cancelled',
      invoiceStatus: 'cancelled',
      [QUOTE_DRAFT_FIELD]: FieldValue.delete(),
      // A declined quote's answer goes too: nothing about a withdrawn quote is
      // waiting on the household or the office. The audit entry keeps it.
      ...Object.fromEntries(ANSWER_FIELDS.map((k) => [k, FieldValue.delete()])),
      quoteWithdrawnAt: FieldValue.serverTimestamp(),
      quoteWithdrawnBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    const stamp = invoiceStateStampOf({ ...data, ...update, quoteDecision: null }, 0);
    tx.set(ref, { ...update, ...stamp }, { merge: true });
    stageSessionLinks(tx, firestore, visits.plan, new Date().toISOString());
    return {
      alreadyDone: false as const,
      status: stamp.status,
      kinfolkId: typeof data['kinfolkId'] === 'string' ? (data['kinfolkId'] as string) : undefined,
      invoiceNumber: data['invoiceNumber'],
      wasSent: isSentQuote(data),
      decision: quoteDecisionOf(data['quoteDecision']),
      released: visits.plan.release,
    };
  });

  if (outcome.alreadyDone) {
    logEvent({
      severity: 'info',
      function: 'withdrawQuote',
      event: 'admin.quote.withdraw.retry-of-completed',
      uid,
      extra: { invoiceId: args.invoiceId },
    });
    return validateResponse('withdrawQuote', WithdrawQuoteResult, {
      ok: true,
      invoiceId: args.invoiceId,
      status: outcome.status,
      releasedSessionIds: outcome.released,
    });
  }

  const words = await import('../lib/activityWords.js');
  await audit(
    {
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BILLING_QUOTE_WITHDRAWN,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.invoiceId,
      targetCollection: 'invoices',
      familyId: outcome.kinfolkId,
      description: words.quoteSentence(outcome.invoiceNumber, 'withdrawn'),
      payload: {
        invoiceId: args.invoiceId,
        wasSent: outcome.wasSent,
        clearedDecision: outcome.decision,
        sessionsReleased: outcome.released,
      },
    },
    'withdrawQuote',
    uid,
  );
  logEvent({
    severity: 'info',
    function: 'withdrawQuote',
    event: 'admin.quote.withdrawn',
    uid,
    extra: { invoiceId: args.invoiceId, wasSent: outcome.wasSent, released: outcome.released.length },
  });
  return validateResponse('withdrawQuote', WithdrawQuoteResult, {
    ok: true,
    invoiceId: args.invoiceId,
    status: outcome.status,
    releasedSessionIds: outcome.released,
  });
}

export const convertQuoteToInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('convertQuoteToInvoice', convertQuoteToInvoiceHandler),
);

export const withdrawQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('withdrawQuote', withdrawQuoteHandler),
);
