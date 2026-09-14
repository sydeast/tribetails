import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

// Marks an existing invoice receipted and enqueues the kinfolk-facing
// invoice.receipt notification. Fails loud (not-found) when the invoice is
// missing rather than silently creating one.
export const Args = z.object({
  invoiceId: z.string().min(1),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Deliberately just `ok`: this
 * callable identifies the invoice in the REQUEST, and echoing an id back that
 * the caller supplied would read like a server-side confirmation of something
 * the server never minted. `.strict()`, so adding one is a deliberate act.
 */
export const Result = z.object({ ok: OkSchema }).strict();

export async function generateReceiptHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  const args = Args.parse(req.data);

  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `invoice ${args.invoiceId} not found`);
  }
  const stored = snap.data() as { kinfolkId?: string; receiptVersion?: unknown } | undefined;
  const familyId = stored?.kinfolkId ?? '';
  // #832: each issue of a receipt is a VERSION of it, and the version is the
  // notification's identity. Every receipt for one invoice used to share
  // `invoice:<id>`, so a receipt re-issued inside the dispatcher window (a
  // correction, a household asking again) was dropped. Read-then-write rather
  // than an increment on purpose: two presses racing each other read the same
  // version and deliver once, while an issue after the first one landed gets
  // the next version and sends.
  const receiptVersion =
    (typeof stored?.receiptVersion === 'number' && Number.isFinite(stored.receiptVersion) ? stored.receiptVersion : 0) + 1;

  await ref.set(
    {
      receiptIssuedAt: FieldValue.serverTimestamp(),
      receiptIssuedBy: req.auth!.uid,
      receiptVersion,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_RECEIPT_ISSUED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId,
    payload: { invoiceId: args.invoiceId },
  });

  const recipientUid = await resolveKinfolkUid(familyId);
  try {
    await enqueueNotification({
      key: 'invoice.receipt',
      recipientUid: recipientUid ?? '',
      data: { kinfolkId: familyId, invoiceId: args.invoiceId },
      dedupeKey: `invoice:${args.invoiceId}:receipt:${receiptVersion}`,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'generateReceipt',
      event: 'notification.dispatch.failed',
      extra: { familyId, invoiceId: args.invoiceId, key: 'invoice.receipt', err: (err as Error)?.message },
    });
  }

  return validateResponse('generateReceipt', Result, { ok: true });
}

export const generateReceipt = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('generateReceipt', generateReceiptHandler),
);
