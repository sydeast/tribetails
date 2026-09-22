import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';
import { reviewAndSendDraftInvoiceHandler } from './reviewAndSendDraftInvoice';

/**
 * ── #906: THIS CALLABLE NO LONGER MERGES AN ARBITRARY PAYLOAD ─────────────
 *
 * It used to take `payload: z.record(z.string(), z.unknown())` and merge it
 * onto `invoices/{invoiceId}` verbatim. That let an admin payload carry
 * `status` and `amountDue`, move an invoice from open into paid with no
 * payment row behind it, and — because this path wrote no
 * `paymentAppliedNoticeOwner` stamp — make `onInvoicesWrite` announce
 * `invoice.payment.applied` to the household and the office for money nobody
 * had paid. Same class as #884, on a different path. It could also rewrite the
 * total with no audit of the amounts and none of the checks `markInvoicePaid`
 * and `recordPayment` apply, and stamp `kinfolkId` from the caller's
 * `familyId`, silently reassigning an invoice to another household.
 *
 * The payload is now an explicit, `.strict()` schema built from the CALLER
 * INVENTORY, not from what the merge happened to allow. Every caller in the
 * monorepo sends exactly one thing:
 *
 *   | Caller                                                      | Payload              |
 *   |-------------------------------------------------------------|----------------------|
 *   | Admin Android, `InvoiceRepository.reviewAndSendDraftInvoice` | `{ status: 'sent' }` |
 *   | Desktop console, `FirestoreClient.reviewAndSendDraftInvoice` | `{ status: 'sent' }` |
 *   | Admin React web                                             | (none — moved to the |
 *   |                                                             | dedicated callables) |
 *   | `mytribe/scripts`, n8n                                      | (none)               |
 *
 * So the one real need is the draft send, and the draft send has a dedicated,
 * guarded home: `reviewAndSendDraftInvoice`. Rather than rebuild its owner
 * stamp and audit here, this callable now VALIDATES and DELEGATES to that
 * handler, which is the issue's "route it through the same owner stamp and
 * audit as `updateInvoice`" for the one lifecycle change a real caller makes.
 * The installed clients keep working, byte for byte on the wire.
 *
 * Everything else is refused with a message naming where it belongs. Nothing
 * is silently dropped: a refused key is an `invalid-argument` error, so an
 * admin sees that the write did NOT happen rather than a cheerful `ok: true`
 * over a payload the server ignored.
 */
export const Args = z.object({
  familyId: z.string().min(1),
  invoiceId: z.string().min(1),
  /**
   * The ONLY payload this callable accepts, and the only one any caller sends:
   * the draft send. `.strict()`, so an added key is a deliberate act with its
   * own review rather than a field that slips through a record type.
   */
  payload: z.object({ status: z.literal('sent') }).strict(),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Deliberately just `ok`: this
 * callable identifies the invoice in the REQUEST, and echoing an id back that
 * the caller supplied would read like a server-side confirmation of something
 * the server never minted. `.strict()`, so adding one is a deliberate act.
 */
export const Result = z.object({ ok: OkSchema }).strict();

/** Money. Refused here; `recordPayment` / `markInvoicePaid` / `updateInvoice` own these. */
export const REFUSED_MONEY_KEYS = [
  'total',
  'totalCents',
  'amountDue',
  'amountDueCents',
  'amountPaid',
  'amountPaidCents',
  'paidCents',
  'amountMinor',
  'currency',
  'discount',
  'invoiceDiscountCents',
  'lineItems',
] as const;

/**
 * Lifecycle. `status` is here too: it is accepted ONLY as the literal `'sent'`
 * (the draft send), and any other value is a lifecycle move that belongs to a
 * callable that knows what it means for the money.
 */
export const REFUSED_LIFECYCLE_KEYS = [
  'status',
  'invoiceStatus',
  'editScope',
  'invoiceEditRevision',
  'sentAt',
  'sentBy',
  'archivedAt',
  'cancelledAt',
  'receiptIssuedAt',
  'receiptIssuedBy',
] as const;

/**
 * Owner stamps (#866/#884). Every `paymentAppliedNotice*` field is written by
 * the path that actually took the payment, and it is what tells the trigger to
 * stand down. A caller that could set one could silence a real payment notice.
 */
export const REFUSED_OWNER_STAMP_PREFIX = 'paymentAppliedNotice';

const MONEY = new Set<string>(REFUSED_MONEY_KEYS);
const LIFECYCLE = new Set<string>(REFUSED_LIFECYCLE_KEYS);

export type PayloadRefusal = { key: string; use: string; message: string };

/**
 * Why one payload key is refused, and what to call instead. PURE, and exported
 * so the refusal table is testable key by key without a Firestore mock.
 *
 * Returns null for the one accepted pair, `status: 'sent'`.
 */
export function refusalForKey(key: string, value: unknown): PayloadRefusal | null {
  if (key === 'status' && value === 'sent') return null;
  if (MONEY.has(key)) {
    return {
      key,
      use: 'recordPayment | markInvoicePaid | updateInvoice',
      message:
        `'${key}' is money and postInvoiceEvent cannot write it. Use recordPayment to log a ` +
        `payment, markInvoicePaid to settle an invoice, or updateInvoice to correct a figure.`,
    };
  }
  if (key.startsWith(REFUSED_OWNER_STAMP_PREFIX)) {
    return {
      key,
      use: 'recordPayment | markInvoicePaid',
      message:
        `'${key}' is a payment-notice owner stamp, written only by the path that takes the ` +
        `payment. Use recordPayment or markInvoicePaid, which stamp it in the write that pays.`,
    };
  }
  if (LIFECYCLE.has(key)) {
    return {
      key,
      use: 'reviewAndSendDraftInvoice | markInvoicePaid | recordPayment | updateInvoice',
      message:
        `'${key}' is a lifecycle field. Use reviewAndSendDraftInvoice to send a draft, ` +
        `markInvoicePaid or recordPayment to settle one, or updateInvoice to edit one. ` +
        `postInvoiceEvent accepts only { status: 'sent' }.`,
    };
  }
  return {
    key,
    use: 'updateInvoice',
    message:
      `postInvoiceEvent no longer merges arbitrary invoice fields; it accepts only ` +
      `{ status: 'sent' }, the draft send. Use updateInvoice to edit '${key}'.`,
  };
}

/** Every refusal in one payload, in the caller's key order. */
export function payloadRefusals(payload: Record<string, unknown>): PayloadRefusal[] {
  return Object.entries(payload)
    .map(([k, v]) => refusalForKey(k, v))
    .filter((r): r is PayloadRefusal => r !== null);
}

/**
 * The invoice fields an `invoice.updated` notification can show a household,
 * and so the ones that made two edits DIFFERENT notifications (#832).
 *
 * ORPHANED BY #906 and kept deliberately, not deleted: this callable no longer
 * merges edits, so nothing computes an edit-identity dedupe key here any more.
 * The list is the record of which invoice fields a household actually sees
 * rendered, which is a fact about the templates rather than about this file,
 * and `updateInvoice` is where an edit now goes. Reported as orphaned rather
 * than removed, per the standing rule on payment code.
 */
export const INVOICE_RENDERED_FIELDS = [
  'invoiceNumber',
  'kinfolkId',
  'kinfolkName',
  'client',
  'total',
  'totalCents',
  'amountDue',
  'amountDueCents',
  'amountMinor',
  'currency',
  'discount',
  'invoiceDiscountCents',
  'lineItems',
  'date',
  'dueDate',
  'invoiceDueDate',
  'terms',
  'status',
] as const;

/**
 * Structural equality for Firestore field values, used only to ask "does this
 * payload change anything?". Key order is ignored; Timestamps and other
 * objects compare by their JSON form, which is enough to recognise a byte-for-
 * byte retry and errs toward "changed" (and so toward notifying) otherwise.
 *
 * ORPHANED BY #906 with `isUnchanged` below, and kept for the same reason.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * #832's UNCHANGED check: the payload sets nothing the stored invoice does not
 * already hold, so the call is a retry that landed after the first attempt
 * committed. ORPHANED BY #906: a repeat draft send is now refused outright by
 * `reviewAndSendDraftInvoice`'s draft precondition (the invoice is `open` by
 * then), which is a stronger guarantee than a content comparison — it cannot
 * be defeated by a payload that differs in a field no template renders.
 */
export function isUnchanged(
  existing: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): boolean {
  const stored = existing ?? {};
  return Object.entries(payload).every(([k, v]) => sameValue(stored[k], v));
}

export async function postInvoiceEventHandler(req: CallableRequest<unknown>): Promise<z.infer<typeof Result>> {
  const raw = (req.data ?? {}) as Record<string, unknown>;
  const rawPayload = raw['payload'];
  if (rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    const refusals = payloadRefusals(rawPayload as Record<string, unknown>);
    if (refusals.length > 0) {
      logEvent({
        severity: 'warn',
        function: 'postInvoiceEvent',
        event: 'invoice.payload.refused',
        extra: {
          invoiceId: typeof raw['invoiceId'] === 'string' ? raw['invoiceId'] : null,
          keys: refusals.map((r) => r.key),
        },
      });
      throw new HttpsError('invalid-argument', refusals.map((r) => r.message).join(' '), {
        refusedKeys: refusals.map((r) => ({ key: r.key, use: r.use })),
      });
    }
  }

  const args = Args.parse(req.data);

  // The invoice must already exist. This callable used to CREATE one when the
  // doc was missing (and send `invoice.new` about it); `createInvoice` and
  // `createQuote` mint invoices, server id and all, and they are the only two.
  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError(
      'not-found',
      `Invoice '${args.invoiceId}' not found. postInvoiceEvent no longer creates invoices; ` +
        `use createInvoice or createQuote.`,
    );
  }
  // `kinfolkId` used to be stamped from the caller's `familyId` on every call,
  // so a mismatched id moved the invoice to another household without a word.
  // It is now a precondition, never a write.
  const storedKinfolkId = (snap.data() as { kinfolkId?: unknown } | undefined)?.kinfolkId;
  if (typeof storedKinfolkId === 'string' && storedKinfolkId.length > 0 && storedKinfolkId !== args.familyId) {
    throw new HttpsError(
      'permission-denied',
      `Invoice '${args.invoiceId}' belongs to household '${storedKinfolkId}', not ` +
        `'${args.familyId}'. postInvoiceEvent no longer reassigns an invoice to another ` +
        `household; use updateInvoice.`,
    );
  }

  // The delegation. `reviewAndSendDraftInvoice` owns the draft precondition,
  // the sendability check (total, household, invoice number), the state stamp,
  // the pay-method snapshot, the `BILLING_DRAFT_INVOICE_SENT` audit entry and
  // the `invoice.new` dispatch — and it reads `kinfolkId` off the doc, so no
  // household id travels from the caller into the write. Its refusals surface
  // verbatim (fail loud); its `invoiceId` echo is dropped because this
  // callable's frozen response signature is the bare ack.
  await reviewAndSendDraftInvoiceHandler({ ...req, data: { invoiceId: args.invoiceId } });
  logEvent({
    severity: 'info',
    function: 'postInvoiceEvent',
    event: 'invoice.draft.sent.delegated',
    uid: req.auth?.uid,
    extra: { invoiceId: args.invoiceId, familyId: args.familyId, to: 'reviewAndSendDraftInvoice' },
  });

  return validateResponse('postInvoiceEvent', Result, { ok: true });
}

export const postInvoiceEvent = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('postInvoiceEvent', postInvoiceEventHandler),
);
