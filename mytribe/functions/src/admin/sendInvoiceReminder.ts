import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
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
 * Canonical store is the FLAT top-level `invoices` collection (the same one
 * createInvoice/postInvoiceEvent write), keyed by doc id with a `kinfolkId`
 * field used to resolve the recipient.
 */
const NOTIFIED_FIELD_REMINDER = 'reminderNotifiedAtMs';

const Args = z.object({
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
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** Echoed back so a caller batching several calls can pair up the answers. */
    invoiceId: z.string().min(1),
  })
  .strict();
export async function sendInvoiceReminderHandler(
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
      throw new HttpsError('invalid-argument', 'sendInvoiceReminder validation failed', {
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

  if (isPaid(data)) {
    throw new HttpsError('failed-precondition', 'Invoice is already paid; nothing to remind.');
  }
  const familyId = data.kinfolkId;
  if (!familyId) {
    throw new HttpsError('failed-precondition', 'Invoice has no kinfolkId; cannot resolve recipient.');
  }

  const now = Date.now();
  const recipientUid = await resolveKinfolkUid(familyId);

  // Same dispatch the cron does, just fired now. Fail loud: if dispatch throws,
  // the callable surfaces it (no swallow) so the admin sees the reminder did
  // NOT go out, rather than a silent no-op.
  await enqueueNotification({
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

  await ref.set({ [NOTIFIED_FIELD_REMINDER]: now }, { merge: true });

  await writeAuditEntry({
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

  return validateResponse('sendInvoiceReminder', Result, { ok: true, invoiceId: args.invoiceId });
}

export const sendInvoiceReminder = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('sendInvoiceReminder', sendInvoiceReminderHandler),
);
