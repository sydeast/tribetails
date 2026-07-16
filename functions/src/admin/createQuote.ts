import { onCall, CallableRequest } from 'firebase-functions/v2/https';
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

/**
 * A quote is NOT a separate model: it is an invoice in QUOTE status. This
 * callable mirrors createInvoice's args + validation exactly, but forces the
 * doc into QUOTE status and (optionally) dispatches an issued-quote notification
 * to the kinfolk.
 *
 * Status is written on BOTH fields the system reads:
 *   - `status`        = 'QUOTE'  (the AuntieOS admin composer/list field)
 *   - `invoiceStatus` = 'quote'  (the portal's canonical resolver field, see
 *     getMyInvoices.resolveStatus)
 * so the quote is unambiguously distinguishable from a payable invoice on both
 * the admin and kinfolk sides. The caller-supplied `status` arg is ignored on
 * purpose; this endpoint always mints a quote.
 *
 * Accept/deny are already handled elsewhere via the quote.accepted /
 * quote.denied catalog keys; this endpoint covers only quote creation/issuance.
 *
 * The issued-quote notification reuses the existing `invoice.new` catalog key,
 * whose description is "New invoice/quote issued." (there is no separate
 * quote.issued key). targetType/targetId point the notification at the invoice
 * doc for open-linked + quick approve/deny.
 */
const Args = z.object({
  familyId: z.string().min(1),
  kinfolkName: z.string().default(''),
  invoiceNumber: z.string().min(1),
  client: z.string().default(''),
  address: z.string().default(''),
  date: z.string().default(''),
  terms: z.string().default(''),
  dueDate: z.string().default(''),
  discount: z.string().default(''),
  total: z.number().nonnegative(),
  amountDue: z.number().nonnegative(),
  // Accepted for arg-parity with createInvoice but ignored: a quote always
  // mints in QUOTE status regardless of what the caller passes.
  status: z.string().default(''),
  sessionIds: z.array(z.string()).default([]),
  /** When true, dispatch an issued-quote notification to the kinfolk. */
  sendToKinfolk: z.boolean().default(false),
});

export async function createQuoteHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; invoiceId: string }> {
  const args = Args.parse(req.data);

  const ref = db().collection('invoices').doc();
  await ref.set({
    kinfolkName: args.kinfolkName,
    invoiceNumber: args.invoiceNumber,
    client: args.client,
    address: args.address,
    date: args.date,
    terms: args.terms,
    dueDate: args.dueDate,
    discount: args.discount,
    total: args.total,
    amountDue: args.amountDue,
    // A quote is an invoice in QUOTE status. Stamp both the admin-side `status`
    // and the portal-canonical `invoiceStatus` so neither side mis-buckets it.
    status: 'QUOTE',
    invoiceStatus: 'quote',
    sessionIds: args.sessionIds,
    kinfolkId: args.familyId,
    _id: ref.id,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_QUOTE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: { invoiceId: ref.id, invoiceNumber: args.invoiceNumber, sendToKinfolk: args.sendToKinfolk },
  });

  if (args.sendToKinfolk) {
    const recipientUid = await resolveKinfolkUid(args.familyId);
    try {
      await enqueueNotification({
        // No quote.issued key exists; invoice.new is the catalog's
        // "New invoice/quote issued." key (audience: both).
        key: 'invoice.new',
        recipientUid: recipientUid ?? '',
        data: { kinfolkId: args.familyId, invoiceId: ref.id, isQuote: true },
        targetType: 'invoice',
        targetId: ref.id,
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'createQuote',
        event: 'notification.dispatch.failed',
        extra: { familyId: args.familyId, invoiceId: ref.id, key: 'invoice.new', err: (err as Error)?.message },
      });
    }
  }

  return { ok: true, invoiceId: ref.id };
}

export const createQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createQuote', createQuoteHandler),
);
