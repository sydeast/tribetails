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
import { computeInvoiceTotals, validateInvoiceMoney, centsToDollars } from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { payMethodSnapshotForIssue } from '../lib/payMethodSnapshot';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { InvoiceDayArg } from '../lib/invoiceDay';

/**
 * A quote is NOT a separate model: it is an invoice in QUOTE status. This
 * callable mirrors createInvoice's args + validation exactly, but forces the
 * doc into QUOTE status and (optionally) dispatches an issued-quote notification
 * to the kinfolk.
 *
 * Status is written on BOTH fields the system reads:
 *   - `status`        = 'quote'  (the AuntieOS admin composer/list field.
 *     Lowercase since the state stamp, 2026-07-28: the stamp canonicalizes the
 *     stored value to the classifier's vocabulary. The admin's chip still
 *     renders 'QUOTE', because it derives from `invoiceFormat.ts#invoiceState`,
 *     which lowercases before matching, exactly as it did for the old spelling.)
 *   - `invoiceStatus` = 'quote'  (the legacy spelling; the portal now renders
 *     the stored stamp and reads this field only as `statusFromStamp`'s
 *     fallback, see getMyInvoices.ts)
 * so the quote is unambiguously distinguishable from a payable invoice on both
 * the admin and kinfolk sides. The caller-supplied `status` arg is ignored on
 * purpose; this endpoint always mints a quote.
 *
 * This endpoint covers only quote creation and issuance. The household's answer
 * is `portal/quoteDecision.ts` (`acceptQuote` / `denyQuote`), which records the
 * decision on this same doc and is what finally emits the `quote.accepted` and
 * `quote.denied` catalog keys. Until it landed, those two catalog rows were
 * switches on the notification gate for events nothing in the repository could
 * cause (issue #385).
 *
 * The issued-quote notification reuses the existing `invoice.new` catalog key,
 * whose description is "New invoice/quote issued." (there is no separate
 * quote.issued key). targetType/targetId point the notification at the invoice
 * doc for open-linked + quick approve/deny.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
const LineItem = z.object({
  description: z.string().min(1).max(200),
  qty: z.number().positive().max(999),
  unitCents: z.number().int().min(0).max(10_000_000),
  discountCents: z.number().int().min(0).optional(),
});

export const Args = z.object({
  familyId: z.string().min(1),
  kinfolkName: z.string().default(''),
  invoiceNumber: z.string().min(1),
  client: z.string().default(''),
  address: z.string().default(''),
  // A DAY, not free text, for the reason spelled out in lib/invoiceDay.ts: a
  // quote lands in the same flat `invoices` collection the admin list windows
  // and orders on, so a free-text date here is the same sorting bug.
  date: InvoiceDayArg,
  terms: z.string().default(''),
  dueDate: InvoiceDayArg,
  discount: z.string().default(''),
  total: z.number().nonnegative(),
  amountDue: z.number().nonnegative(),
  // Accepted for arg-parity with createInvoice but ignored: a quote always
  // mints in QUOTE status regardless of what the caller passes.
  status: z.string().default(''),
  sessionIds: z.array(z.string()).default([]),
  /** Optional itemization. Omitted by every legacy caller; see the header. */
  lineItems: z.array(LineItem).max(100).optional(),
  /** Whole-invoice reduction, integer cents. Only meaningful alongside `lineItems`. */
  invoiceDiscountCents: z.number().int().min(0).optional(),
  /** When true, dispatch an issued-quote notification to the kinfolk. */
  sendToKinfolk: z.boolean().default(false),
});

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
export async function createQuoteHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  const args = Args.parse(req.data);

  // The itemized fields, or nothing at all. An un-itemized quote must not
  // pick up a `lineItems: []` or a `totalCents: 0`: mirrors createInvoice.
  let money: Record<string, unknown> = {};

  if (args.lineItems !== undefined) {
    const invoiceDiscountCents = args.invoiceDiscountCents ?? 0;

    const moneyError = validateInvoiceMoney(args.lineItems, invoiceDiscountCents);
    if (moneyError) {
      throw new HttpsError('failed-precondition', moneyError, { code: 'invoice_money_invalid' });
    }

    const totals = computeInvoiceTotals(args.lineItems, invoiceDiscountCents, 0);
    const derivedTotal = centsToDollars(totals.totalCents);
    const derivedAmountDue = centsToDollars(totals.amountDueCents);

    if (args.total !== derivedTotal) {
      throw new HttpsError(
        'failed-precondition',
        `The total sent ($${args.total.toFixed(2)}) is not the sum of the line items ($${(totals.totalCents / 100).toFixed(2)}). The line items decide the total, so send that figure or correct the items.`,
        { code: 'invoice_total_mismatch' },
      );
    }
    if (args.amountDue !== derivedAmountDue) {
      throw new HttpsError(
        'failed-precondition',
        `The amount due sent ($${args.amountDue.toFixed(2)}) is not the line-item total ($${(totals.amountDueCents / 100).toFixed(2)}). A new quote has no payments recorded against it, so the two are the same figure.`,
        { code: 'invoice_amount_due_mismatch' },
      );
    }

    money = {
      lineItems: args.lineItems,
      invoiceDiscountCents,
      subtotalCents: totals.subtotalCents,
      totalCents: totals.totalCents,
      amountDueCents: totals.amountDueCents,
    };
  }

  const ref = db().collection('invoices').doc();
  const doc = {
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
    // The state stamp below canonicalizes `status` to the classifier's
    // lowercase 'quote'; asserting it here as well keeps this endpoint's whole
    // point, ignoring the caller's status arg, visible in one place.
    status: 'quote',
    invoiceStatus: 'quote',
    sessionIds: args.sessionIds,
    kinfolkId: args.familyId,
    _id: ref.id,
    ...money,
  };
  // The payment options live at the moment this quote is issued, frozen onto
  // it (issue #409), so a quote the household accepts next month still offers
  // what it offered when they read it. Fail-soft: no snapshot means the portal
  // resolves live settings, exactly as it did before this shipped.
  const payMethodSnapshot = await payMethodSnapshotForIssue('createQuote');
  // The state stamp (ADR-0002), in the same write. paidCents is 0 by
  // construction on a brand-new doc.
  await ref.set({
    ...doc,
    ...invoiceStateStampOf(doc, 0),
    ...payMethodSnapshot,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_QUOTE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: {
      invoiceId: ref.id,
      invoiceNumber: args.invoiceNumber,
      sendToKinfolk: args.sendToKinfolk,
      itemized: args.lineItems !== undefined,
      lineCount: args.lineItems?.length ?? 0,
    },
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

  return validateResponse('createQuote', Result, { ok: true, invoiceId: ref.id });
}

export const createQuote = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createQuote', createQuoteHandler),
);
