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
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { chaseRefusalOf, legacyEvidenceWanted, type ChaseRefusal, type PaymentEvidence } from '../lib/invoiceChase';
import { paidCentsFromPayments } from '../lib/invoiceMath';

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
 * #832: IT NOW READS THAT STAMP BACK, and it writes it only for a reminder
 * that actually went out. It used to write `reminderNotifiedAtMs` and never
 * look at it, so two presses, or a press after a timeout, chased the household
 * twice about one invoice.
 *
 * Canonical store is the FLAT top-level `invoices` collection (the same one
 * createInvoice/postInvoiceEvent write), keyed by doc id with a `kinfolkId`
 * field used to resolve the recipient.
 */
const NOTIFIED_FIELD_REMINDER = 'reminderNotifiedAtMs';

/**
 * The in-flight claim. Deliberately NOT the stamp above: the stamp means "a
 * reminder went out", and every client renders it as "Last reminder", so it
 * must never be written for a send that has not happened yet.
 */
const CLAIM_FIELD_REMINDER = 'reminderClaimAtMs';

/**
 * #832 DECISION (operator to confirm): the reminder BUTTON sends at most one
 * payment reminder per invoice per 24 hours.
 *
 * WHAT IT GOVERNS. The daily cron (`invoiceRemindersCron`, 09:00 ET) reminds
 * once per invoice, EVER: it skips any invoice that already carries
 * `reminderNotifiedAtMs`, however old the stamp is. So this window is the
 * button's rule, and it counts a cron reminder too. The other direction is part
 * of the same decision and worth saying plainly: a manual press stamps the
 * invoice, so the cron will NOT send its own due-soon reminder for that invoice
 * later. A press is the invoice's reminder.
 *
 * WHY A DAY, AND WHY NOT THE DISPATCHER'S 5 MINUTES. The dispatcher window
 * (`NOTIFICATION_DEDUPE_WINDOW_MS`) exists to absorb retries of ONE event. A
 * reminder press is a deliberate new chase, and the harm the issue names is a
 * household "chased twice for one invoice", which a second press ten minutes
 * later does just as well as a double-tap. The cron's once-a-day cadence is the
 * one this business already chose for reminders.
 */
export const INVOICE_REMINDER_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claim holds before another press may take it over (#832).
 *
 * A claim that never finished (the instance died between claiming and
 * sending) must not block the button for long, and it never touches the stamp,
 * so it blocks nothing else: not the cron, not the "Last reminder" row.
 *
 *   - LONGER than a callable can live (the 60s default timeout), so a claim is
 *     never taken over while its own send is still running.
 *   - A crash AFTER the dispatcher delivered but before the stamp was written
 *     does not rely on the lease at all: the dispatch asks the dispatcher to
 *     look back INVOICE_REMINDER_RESEND_WINDOW_MS, so any press inside the 24
 *     hours meets the ledger's record of that reminder, stamps it, and answers
 *     `recent` instead of sending a second one.
 */
export const INVOICE_REMINDER_CLAIM_LEASE_MS = 3 * 60 * 1000;

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

/**
 * #871: WHY A PRESS IS REFUSED, in the operator's words. The press used to be
 * refused only for a `paid` label or `paymentStatus: 'PAID'`, so a stale client
 * or a direct call reminded a household about a cancelled bill, a draft, a
 * credit or a quote they never accepted. It now asks `chaseRefusalOf`, the same
 * rule both crons use (lib/invoiceChase.ts). The paid wording is unchanged.
 */
function refusalMessage(refusal: ChaseRefusal): string {
  if (refusal.reason === 'archived') return 'This invoice is archived, so there is nothing to remind anyone about.';
  if (refusal.reason === 'unaccepted_quote') {
    return 'The household has not accepted this quote, so there is no bill to remind them about yet.';
  }
  // #902 retired `legacy_balance_unproven`. A migrated bill with a `total` and
  // no `amountDue` is classified now rather than special-cased: unpaid it reads
  // `open` and this function is never reached, and paid off by its own rows it
  // reads `paid` and gets the paid wording below, which is the true reason.
  switch (refusal.state) {
    case 'paid':
      return 'Invoice is already paid; nothing to remind.';
    case 'cancelled':
      return 'This invoice is cancelled, so there is nothing to remind anyone about.';
    case 'draft':
      return 'This invoice is still a draft. Send it before reminding anyone about it.';
    case 'quote':
      return 'The household has not accepted this quote, so there is no bill to remind them about yet.';
    case 'credit':
    case 'redeemed':
      return 'This is a credit owed to the household, so there is nothing to remind them about.';
    case 'zero':
      return 'This invoice is for $0, so there is nothing to remind anyone about.';
    case 'open':
      return '';
  }
}

/**
 * Why a press did or did not send.
 *   - `sent`: this call sent the reminder.
 *   - `recent`: a reminder went out inside the window; nothing sent.
 *   - `in-progress`: another press is sending one right now; nothing sent.
 *   - `suppressed`: the household's notification settings block reminders, so
 *     nothing was sent and nothing is recorded as sent.
 */
export const ReminderReasonSchema = z.enum(['sent', 'recent', 'in-progress', 'suppressed']);

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported for the same reason `Args`
 * is: the contract guard freezes it and decision 2 generates the clients'
 * types from it. `.strict()`, so an added field is reported rather than
 * absorbed.
 *
 * #832 added the reminder fields. `sent: false` is NOT a failure; `reason`
 * says which of the three non-sends it was, and every client renders it as a
 * sentence.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** Echoed back so a caller batching several calls can pair up the answers. */
    invoiceId: z.string().min(1),
    /** True only when THIS call sent a reminder. */
    sent: z.boolean(),
    reason: ReminderReasonSchema,
    /** When the most recent reminder actually went out (ms epoch), or null if none ever did. */
    lastReminderAtMs: z.number().int().nonnegative().nullable(),
    /** The earliest moment a press can send again (ms epoch), or null when waiting would not help. */
    nextReminderAllowedAtMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

type ResultShape = z.infer<typeof Result>;
type Reason = z.infer<typeof ReminderReasonSchema>;

/** Floored: stored stamps feed these, and the schema is integer ms. */
function ms(v: number | null): number | null {
  return v === null ? null : Math.floor(v);
}

function answer(invoiceId: string, reason: Reason, last: number | null, next: number | null): ResultShape {
  return {
    ok: true,
    invoiceId,
    sent: reason === 'sent',
    reason,
    lastReminderAtMs: ms(last),
    nextReminderAllowedAtMs: ms(next),
  };
}

function numberField(d: InvoiceDoc | undefined, field: string): number | null {
  const v = d?.[field];
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
   * #871: the payment rows, read only for the legacy total-only shape, the one
   * doc the classifier cannot settle alone (lib/invoiceChase.ts). Read before
   * the claim transaction; inside it the doc is re-read, and a doc that is not
   * that shape ignores the evidence.
   *
   * #902: the rows now reach the classifier itself rather than a refusal branch
   * beside it, so this read is what tells a migrated bill that was paid off
   * before `amountDue` existed from one still owed. Without it the rule reads
   * such a bill as open, which is the conservative answer, not the true one.
   */
  let evidence: PaymentEvidence | null = null;
  const peek = await ref.get();
  if (peek.exists && legacyEvidenceWanted(peek.data() as InvoiceDoc)) {
    const rows = await ref.collection('payments').get();
    evidence = {
      rows: rows.size,
      paidCents: paidCentsFromPayments(rows.docs.map((d) => d.data() as { amount?: number; amountCents?: number })),
    };
  }

  /**
   * THE CLAIM, as a lease. Read the stamp and the claim and, if neither blocks,
   * take the claim, in one transaction, BEFORE anything is sent. Two presses
   * racing each other cannot both take it: Firestore serializes the two
   * transactions and the loser reads the winner's claim. Preconditions (exists,
   * unpaid, has a household) are judged on the same read.
   */
  type Claim =
    | { kind: 'claimed'; data: InvoiceDoc; familyId: string; prior: number | null }
    | { kind: 'recent'; lastAtMs: number }
    | { kind: 'in-progress'; prior: number | null; claimAtMs: number };
  const claim = await db().runTransaction(async (tx): Promise<Claim> => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    }
    const data = snap.data() as InvoiceDoc;
    const refusal = chaseRefusalOf(data, evidence);
    if (refusal) {
      throw new HttpsError('failed-precondition', refusalMessage(refusal), {
        code: 'invoice_not_remindable',
        reason: refusal.reason,
        state: refusal.state,
      });
    }
    const familyId = data.kinfolkId;
    if (!familyId) {
      throw new HttpsError('failed-precondition', 'Invoice has no kinfolkId; cannot resolve recipient.');
    }
    const prior = numberField(data, NOTIFIED_FIELD_REMINDER);
    if (prior !== null && now - prior < INVOICE_REMINDER_RESEND_WINDOW_MS) {
      return { kind: 'recent', lastAtMs: prior };
    }
    const held = numberField(data, CLAIM_FIELD_REMINDER);
    if (held !== null && now - held < INVOICE_REMINDER_CLAIM_LEASE_MS) {
      return { kind: 'in-progress', prior, claimAtMs: held };
    }
    tx.set(ref, { [CLAIM_FIELD_REMINDER]: now }, { merge: true });
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
    return validateResponse(
      'sendInvoiceReminder',
      Result,
      answer(args.invoiceId, 'recent', claim.lastAtMs, claim.lastAtMs + INVOICE_REMINDER_RESEND_WINDOW_MS),
    );
  }
  if (claim.kind === 'in-progress') {
    logEvent({
      severity: 'info',
      function: 'sendInvoiceReminder',
      event: 'admin.invoice.reminder.refused-in-progress',
      uid,
      extra: { invoiceId: args.invoiceId, claimAtMs: claim.claimAtMs, leaseMs: INVOICE_REMINDER_CLAIM_LEASE_MS },
    });
    return validateResponse(
      'sendInvoiceReminder',
      Result,
      answer(args.invoiceId, 'in-progress', claim.prior, claim.claimAtMs + INVOICE_REMINDER_CLAIM_LEASE_MS),
    );
  }

  const { data, familyId, prior } = claim;

  /**
   * Settles the claim. Clears it only while it is still OURS, so a press that
   * took over an expired lease is never robbed of its own. `sentAtMs` records
   * a reminder that really went out; it is written even if the claim was
   * taken over, because the reminder went out either way.
   */
  const settle = async (sentAtMs: number | null) => {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const ours = numberField(snap.data() as InvoiceDoc | undefined, CLAIM_FIELD_REMINDER) === now;
      const patch: Record<string, unknown> = {};
      if (ours) patch[CLAIM_FIELD_REMINDER] = FieldValue.delete();
      if (sentAtMs !== null) patch[NOTIFIED_FIELD_REMINDER] = sentAtMs;
      if (Object.keys(patch).length > 0) tx.set(ref, patch, { merge: true });
    });
  };

  // EVERYTHING after the claim runs inside this try. A throw anywhere in it
  // (resolving the household, the dispatch) releases the claim and surfaces
  // the error, so the admin sees the reminder did NOT go out and can press
  // again at once. A crash that skips the release leaves only the lease, which
  // expires on its own; the stamp is untouched either way.
  let recipientUid: string | null;
  let dispatched: Awaited<ReturnType<typeof enqueueNotificationDetailed>>;
  try {
    recipientUid = await resolveKinfolkUid(familyId);
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
      // #832: look back the whole reminder window, not the dispatcher's 5
      // minutes. If an earlier press delivered and then died before writing the
      // stamp, the ledger still holds that reminder; the duplicate answer below
      // carries its time, the stamp is written from it, and the admin is told
      // `recent`, however long after the crash the next press comes.
      dedupeWindowMs: INVOICE_REMINDER_RESEND_WINDOW_MS,
    });
  } catch (err) {
    await settle(null).catch((releaseErr) => {
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

  if (dispatched.written.length === 0) {
    const duplicate = dispatched.suppressed.find((s) => s.reason === 'duplicate');
    if (duplicate) {
      // The second layer answered: a reminder reached this household inside the
      // dispatcher window though the stamp did not say so (the stamp write of an
      // earlier press died, or someone cleared it). That reminder is real, so it
      // is recorded, and the admin is told when it went out.
      const lastAtMs = duplicate.lastAtMs ?? now;
      await settle(lastAtMs);
      logEvent({
        severity: 'info',
        function: 'sendInvoiceReminder',
        event: 'admin.invoice.reminder.refused-duplicate',
        uid,
        extra: { invoiceId: args.invoiceId, lastReminderAtMs: lastAtMs, existingId: duplicate.existingId ?? null },
      });
      return validateResponse(
        'sendInvoiceReminder',
        Result,
        answer(args.invoiceId, 'recent', lastAtMs, lastAtMs + INVOICE_REMINDER_RESEND_WINDOW_MS),
      );
    }
    // Every recipient's prefs blocked it. Nothing went out, so nothing is
    // stamped: the cron and the "Last reminder" row keep telling the truth.
    await settle(null);
    logEvent({
      severity: 'info',
      function: 'sendInvoiceReminder',
      event: 'admin.invoice.reminder.suppressed',
      uid,
      extra: { invoiceId: args.invoiceId, kinfolkId: familyId },
    });
    return validateResponse('sendInvoiceReminder', Result, answer(args.invoiceId, 'suppressed', prior, null));
  }

  // The reminder went out. A failure to RECORD it must not be reported as a
  // failure to send it: the household has the reminder. It is logged loudly;
  // the lease expires on its own, and a press after that meets the dispatcher's
  // duplicate refusal inside its window, which records the stamp then.
  await settle(now).catch((stampErr) => {
    logEvent({
      severity: 'error',
      function: 'sendInvoiceReminder',
      event: 'reminder.stamp.failed',
      uid,
      errorMessage: (stampErr as Error)?.message,
      extra: { invoiceId: args.invoiceId, sentAtMs: now },
    });
  });

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

  return validateResponse(
    'sendInvoiceReminder',
    Result,
    answer(args.invoiceId, 'sent', now, now + INVOICE_REMINDER_RESEND_WINDOW_MS),
  );
}

export const sendInvoiceReminder = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('sendInvoiceReminder', sendInvoiceReminderHandler),
);
