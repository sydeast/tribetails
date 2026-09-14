import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
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
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

/**
 * Stage 2 tail: admin-initiated on-demand resend of an invoice reminder for
 * ONE invoice, right now. The daily `invoiceRemindersCron` only fires once per
 * invoice inside a due-date window; this lets an admin nudge a specific invoice
 * at any time from the AuntieOS billing UI.
 *
 * Reuses the cron's per-invoice dispatch path verbatim: it enqueues the same
 * `invoice.reminder` catalog key to the same resolved kinfolk uid with the same
 * data shape, and stamps `reminderNotifiedAtMs` so the cron will not double-send
 * a reminder it already sent (idempotency parity with the cron field).
 *
 * #832: IT NOW READS THAT STAMP BACK. It used to write `reminderNotifiedAtMs`
 * and never look at it, so two presses, or a press after a timeout, chased the
 * household twice about one invoice. A reminder inside
 * INVOICE_REMINDER_RESEND_WINDOW_MS of the last one (manual OR cron) is refused
 * with `sent: false` and the time of the reminder that already went out, which
 * every client renders as a sentence rather than an error.
 *
 * Canonical store is the FLAT top-level `invoices` collection (the same one
 * createInvoice/postInvoiceEvent write), keyed by doc id with a `kinfolkId`
 * field used to resolve the recipient.
 */
const NOTIFIED_FIELD_REMINDER = 'reminderNotifiedAtMs';

/**
 * #832 DECISION (operator to confirm): at most one payment reminder per invoice
 * per 24 hours, counting both this button and the daily cron.
 *
 * WHY A DAY, AND WHY NOT THE DISPATCHER'S 5 MINUTES. The dispatcher window
 * (`NOTIFICATION_DEDUPE_WINDOW_MS`) exists to absorb retries of ONE event. A
 * reminder is different: every press is a deliberate new chase, and the harm the
 * issue names is a household "chased twice for one invoice", which a second
 * press ten minutes later does just as well as a double-tap. The cron that owns
 * reminders runs once a day (`invoiceRemindersCron`, 09:00 ET), so a day is the
 * cadence this business already chose for them. An operator who needs to reach
 * the household again the same day has the conversation tools for it.
 */
export const INVOICE_REMINDER_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
});

type InvoiceDoc = {
  kinfolkId?: string;
  status?: string;
  paymentStatus?: string;
  invoiceNumber?: string;
  dueDate?: string;
  invoiceDueDate?: string;
  amountDue?: number;
  total?: number;
  amountMinor?: number;
  currency?: string;
  [k: string]: unknown;
};

function isPaid(d: InvoiceDoc): boolean {
  return d.paymentStatus === 'PAID' || d.status === 'paid';
}

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported for the same reason `Args`
 * is: the contract guard freezes it and decision 2 generates the clients'
 * types from it. `.strict()`, so an added field is reported rather than
 * absorbed.
 *
 * #832 added the three reminder fields. `sent: false` is NOT a failure: the
 * call did its job, which was to make sure the household has been reminded,
 * and it is telling the admin when that happened.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** Echoed back so a caller batching several calls can pair up the answers. */
    invoiceId: z.string().min(1),
    /** True when THIS call sent a reminder; false when one already went out inside the window. */
    sent: z.boolean(),
    /** When the most recent reminder went out (ms epoch): this call's, or the earlier one that blocked it. */
    lastReminderAtMs: z.number().int().nonnegative(),
    /** The earliest moment another reminder will be accepted (ms epoch). */
    nextReminderAllowedAtMs: z.number().int().nonnegative(),
  })
  .strict();

type ResultShape = z.infer<typeof Result>;

function outcome(invoiceId: string, sent: boolean, lastReminderAtMs: number): ResultShape {
  return {
    ok: true,
    invoiceId,
    sent,
    lastReminderAtMs,
    nextReminderAllowedAtMs: lastReminderAtMs + INVOICE_REMINDER_RESEND_WINDOW_MS,
  };
}

function stampOf(d: InvoiceDoc | undefined): number | null {
  const v = d?.[NOTIFIED_FIELD_REMINDER];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export async function sendInvoiceReminderHandler(
  req: CallableRequest<unknown>,
): Promise<ResultShape> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'sendInvoiceReminder validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  const now = Date.now();

  /**
   * THE CLAIM. The stamp is read and, if no reminder is inside the window,
   * written, in one transaction, BEFORE anything is sent. Two presses racing
   * each other therefore cannot both see "no recent reminder": Firestore
   * serializes the two transactions and the loser reads the winner's stamp.
   * Preconditions (exists, unpaid, has a household) are checked on the same
   * read so they are judged against the document the claim is made on.
   */
  type Claim =
    | { kind: 'claimed'; data: InvoiceDoc; familyId: string; prior: number | null }
    | { kind: 'recent'; lastAtMs: number };
  const claim = await db().runTransaction(async (tx): Promise<Claim> => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    }
    const data = snap.data() as InvoiceDoc;
    if (isPaid(data)) {
      throw new HttpsError('failed-precondition', 'Invoice is already paid; nothing to remind.');
    }
    const familyId = data.kinfolkId;
    if (!familyId) {
      throw new HttpsError('failed-precondition', 'Invoice has no kinfolkId; cannot resolve recipient.');
    }
    const prior = stampOf(data);
    if (prior !== null && now - prior < INVOICE_REMINDER_RESEND_WINDOW_MS) {
      return { kind: 'recent', lastAtMs: prior };
    }
    tx.set(ref, { [NOTIFIED_FIELD_REMINDER]: now }, { merge: true });
    return { kind: 'claimed', data, familyId, prior };
  });

  if (claim.kind === 'recent') {
    logEvent({
      severity: 'info',
      function: 'sendInvoiceReminder',
      event: 'admin.invoice.reminder.refused-recent',
      uid,
      extra: { invoiceId: args.invoiceId, lastReminderAtMs: claim.lastAtMs, windowMs: INVOICE_REMINDER_RESEND_WINDOW_MS },
    });
    return validateResponse('sendInvoiceReminder', Result, outcome(args.invoiceId, false, claim.lastAtMs));
  }

  const { data, familyId, prior } = claim;

  /**
   * Hands the claim back when this call did not, in the end, send anything.
   * Conditional on the stamp still being OURS, so it can never erase a
   * reminder a concurrent call or the cron recorded in the meantime.
   */
  const releaseClaim = async (restoreTo: number | null) => {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (stampOf(snap.data() as InvoiceDoc | undefined) !== now) return;
      tx.set(ref, { [NOTIFIED_FIELD_REMINDER]: restoreTo }, { merge: true });
    });
  };

  const recipientUid = await resolveKinfolkUid(familyId);

  // Same dispatch the cron does, just fired now. Fail loud: if dispatch throws,
  // the callable surfaces it (no swallow) so the admin sees the reminder did
  // NOT go out, rather than a silent no-op, and the claim is released so a
  // retry is not refused for a reminder that never went out.
  let dispatched;
  try {
    dispatched = await enqueueNotificationDetailed({
      key: 'invoice.reminder',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: familyId,
        invoiceId: args.invoiceId,
        invoiceDueDate: data.invoiceDueDate ?? data.dueDate ?? null,
        amountMinor: data.amountMinor ?? null,
        currency: data.currency ?? null,
      },
      fireAtMs: now,
    });
  } catch (err) {
    await releaseClaim(prior).catch((releaseErr) => {
      logEvent({
        severity: 'warn',
        function: 'sendInvoiceReminder',
        event: 'reminder.claim.release.failed',
        uid,
        errorMessage: (releaseErr as Error)?.message,
        extra: { invoiceId: args.invoiceId },
      });
    });
    throw err;
  }

  // The second layer answered. If the dispatcher refused a duplicate, a
  // reminder reached this household inside its window even though the stamp
  // did not say so (a stamp cleared by hand, or written by something else).
  // Record THAT reminder's time and tell the admin, rather than claiming a
  // send that did not happen.
  const duplicate = dispatched.written.length === 0
    ? dispatched.suppressed.find((s) => s.reason === 'duplicate')
    : undefined;
  if (duplicate) {
    const lastAtMs = duplicate.lastAtMs ?? now;
    await releaseClaim(lastAtMs);
    logEvent({
      severity: 'info',
      function: 'sendInvoiceReminder',
      event: 'admin.invoice.reminder.refused-duplicate',
      uid,
      extra: { invoiceId: args.invoiceId, lastReminderAtMs: lastAtMs, existingId: duplicate.existingId ?? null },
    });
    return validateResponse('sendInvoiceReminder', Result, outcome(args.invoiceId, false, lastAtMs));
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_REMINDER_SENT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId,
    description: `Invoice reminder resent for ${data.invoiceNumber ?? args.invoiceId}`,
    payload: { invoiceId: args.invoiceId, kinfolkId: familyId, recipientUid: recipientUid ?? null },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'sendInvoiceReminder',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'sendInvoiceReminder',
    event: 'admin.invoice.reminder.sent',
    uid,
    extra: { invoiceId: args.invoiceId, kinfolkId: familyId },
  });

  return validateResponse('sendInvoiceReminder', Result, outcome(args.invoiceId, true, now));
}

export const sendInvoiceReminder = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('sendInvoiceReminder', sendInvoiceReminderHandler),
);
