import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  invoiceStateOf,
  invoiceEditRefusal,
  paymentStandingOf,
  quoteAcceptanceOf,
} from '../lib/invoiceEditPolicy';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { PAYMENT_APPLIED_OWNER_FIELD, paymentAppliedOwner } from '../lib/paymentAppliedOwner';
import { randomUUID } from 'node:crypto';
import { InvoiceTermsCodeArg } from '../lib/invoiceTerms';
import { resolveStructuredTerms, serviceDaysForSessions } from '../lib/invoiceCreateFields';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';
import {
  computeInvoiceTotals,
  paidCentsFromPayments,
  invoiceTotalCentsOf,
  settleInvoice,
  validateInvoiceMoney,
  centsToDollars,
  type InvoiceLineItemInput,
  type PaymentAmount,
} from '../lib/invoiceMath';

/**
 * Edits an invoice: its descriptive fields, its line items, or both.
 *
 * THE SERVER OWNS EVERY TOTAL. The request has no `total` and no `amountDue`
 * field, and `patch` is `.strict()`, so a client that tries to assert what an
 * invoice is worth gets `invalid-argument` rather than having its number quietly
 * dropped. Every money field on the doc is recomputed here from the stored line
 * items and the recorded payments (`lib/invoiceMath.ts`), so the figure the
 * household sees can only ever be the sum of the lines it is shown.
 *
 * WHY A CALLABLE AT ALL, when `firestore.rules` already lets an admin write this
 * collection (`allow update: if isAuntie()`): the rule validates NOTHING. It
 * cannot recompute a total, it cannot read the payments subcollection to decide
 * whether the money is frozen, and it cannot refuse an edit to a paid invoice.
 * A UI-only version of those rules is not a guard, as the booking-notes cutoff
 * incident already established in this codebase.
 *
 * @see lib/invoiceEditPolicy.ts for WHICH invoices may be edited and how much.
 * @see lib/invoiceMath.ts for the cents-vs-dollars split.
 */

const LineItem = z.object({
  description: z.string().min(1).max(200),
  qty: z.number().positive().max(999),
  unitCents: z.number().int().min(0).max(10_000_000),
  discountCents: z.number().int().min(0).optional(),
  /**
   * The visit this line bills for, when it was drawn from one (#408). Accepted
   * here and not only at creation, because `lineItems` is replaced WHOLESALE by
   * this patch: without it, editing any line on an invoice built from visits
   * would quietly cut every line loose from the work it bills for, and the
   * household's copy would lose the dates with it.
   */
  sessionId: z.string().max(200).optional(),
});

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  patch: z
    .object({
      invoiceNumber: z.string().min(1).max(60).optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      terms: z.string().max(2000).optional(),
      /**
       * Structured payment terms (#408). Sent INSTEAD of `terms` + `dueDate`:
       * the server writes the rule in words and works the due date out from the
       * visits this invoice already links, exactly as creation does. Sending it
       * alongside a `dueDate` that disagrees is refused rather than absorbed.
       */
      termsCode: InvoiceTermsCodeArg.optional(),
      // W2-1 (ADR-0002): the descriptive fields Android's whole-model
      // merge-set can change that this patch previously could not express.
      // All metadata: none is read by the money computation below.
      // `discount` is the LEGACY FREE-TEXT field ("10%"), display-only and
      // never arithmetic; `invoiceDiscountCents` is the computed one.
      // Deliberately still absent: `status` (the classifier owns it, ADR-0002),
      // `sessionIds`/`_attribution` (linkInvoiceSessions owns the link),
      // `archivedAt`/`archivedBy` (archiveInvoice/unarchiveInvoice), and
      // `kinfolkId` (re-homing an invoice to another household is not an edit).
      kinfolkName: z.string().max(200).optional(),
      client: z.string().max(200).optional(),
      address: z.string().max(500).optional(),
      discount: z.string().max(200).optional(),
      lineItems: z.array(LineItem).max(100).optional(),
      invoiceDiscountCents: z.number().int().min(0).optional(),
    })
    .strict()
    // An empty patch is a caller bug, not a no-op to absorb: it would stamp
    // `updatedAt` and write an audit entry describing a change that did not
    // happen.
    .refine((p) => Object.keys(p).length > 0, { message: 'patch must change at least one field' }),
});

type InvoiceDoc = {
  kinfolkId?: string;
  invoiceNumber?: string;
  status?: unknown;
  amountDue?: unknown;
  total?: unknown;
  creditRedeemedAt?: unknown;
  lineItems?: unknown;
  invoiceDiscountCents?: unknown;
  [k: string]: unknown;
};

/** The stored line items, or null when this invoice has never been itemized. */
function storedLineItems(data: InvoiceDoc): InvoiceLineItemInput[] | null {
  return Array.isArray(data.lineItems) ? (data.lineItems as InvoiceLineItemInput[]) : null;
}

/**
 * The RESPONSE shape (ADR-0001 step W3-1).
 *
 * `totals` IS THE POINT OF THE RESPONSE, not a courtesy echo. The request
 * carries no `total` at all (the server recomputes every figure from the
 * stored lines and the recorded payments), so this block is the only way a
 * caller learns what the invoice is now worth, and the admin's
 * `updateInvoice` wrapper returns it and nothing else.
 *
 * `totals` IS NOT WHAT THIS CALLABLE PERSISTED, and W3-1 is the first time
 * that has been written down anywhere. It is the RAW SIGNED arithmetic of
 * `computeInvoiceTotals`; the doc is written from `settleInvoice`, which
 * clamps the balance at 0 and moves the excess into `overpaidCents` (a field
 * this response does not carry at all). Two consequences, both real on
 * today's data and both previously undescribed by the doc and by the React
 * admin's `InvoiceTotalsResult` mirror:
 *
 *   1. An edit that drops an itemized invoice BELOW what has already been
 *      collected answers with a NEGATIVE `amountDueCents` while the doc
 *      stores 0 + `overpaidCents`.
 *   2. On an UN-ITEMIZED invoice patched without lines (the money is
 *      deliberately not recomputed, and every invoice predating the line-item
 *      editor is un-itemized), `totals` is the zero-line computation:
 *      `subtotalCents` 0, `totalCents` 0, `paidCents` as recorded, and
 *      `amountDueCents` therefore `-paidCents`. The invoice itself is
 *      untouched and still worth what it was worth.
 *
 * The schema describes that rather than the tidier statement, because three
 * clients read this and W3-1 is a guard, not a redesign: a schema asserting
 * `.min(0)` here would fire on an ordinary metadata edit of a part-paid
 * invoice and train everyone to ignore the alert. Clamping the wire, or
 * adding `overpaidCents` to it, is a shape change and belongs to its own PR.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    totals: z
      .object({
        /** 0 when the money was not recomputed. See the header. */
        subtotalCents: CentsSchema,
        /** 0 when the money was not recomputed. NOT the invoice's stored total. */
        totalCents: CentsSchema,
        /** Summed from the `payments` subcollection, never off the doc scalar. */
        paidCents: CentsSchema,
        /**
         * `totalCents - paidCents`, SIGNED and unclamped. See the header for
         * the two ways it goes negative. The doc's `amountDueCents` is the
         * clamped `settleInvoice` reading and is a different number.
         */
        amountDueCents: SignedCentsSchema,
      })
      .strict(),
  })
  .strict();

export async function updateInvoiceHandler(
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
      throw new HttpsError('invalid-argument', 'updateInvoice validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { invoiceId, patch } = args;
  const ref = db().collection('invoices').doc(invoiceId);
  // #884 review: THE READ, THE DECISION AND THE WRITE SHARE ONE TRANSACTION.
  // Everything this edit writes (the money, the state stamp, and the owner
  // stamp that says the edit settled the bill) is computed from the invoice and
  // its payments as read. As separate round trips, a markInvoicePaid committing
  // between that read and this write was overwritten by a stale snapshot: its
  // `paidCents`, and its `markInvoicePaid:<id>` owner stamp, which recordPayment
  // then could not claim, so the office never heard about a real payment. In a
  // transaction that commit re-runs this plan against what B wrote.
  const edit = await db().runTransaction((tx) => planEdit(tx, ref, patch));
  return finishEdit(uid, invoiceId, patch, edit);
}

type EditPatch = z.infer<typeof Args>['patch'];

/**
 * Reads the invoice and its payments, decides the edit, and stages the one
 * write, all inside the caller's transaction. Firestore re-runs it when either
 * read changed before the commit. Nothing here may have a side effect beyond
 * `tx`: the audit entry and the log line wait for the commit (`finishEdit`).
 */
async function planEdit(tx: Transaction, ref: DocumentReference, patch: EditPatch) {
  const invoiceId = ref.id;
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError('not-found', `Invoice '${invoiceId}' not found.`);
  const data = snap.data() as InvoiceDoc;

  // The payments SUBCOLLECTION, not the `amountDue` scalar. Before 2026-07-25
  // markInvoicePaid zeroed that scalar even for a partial payment, so on any
  // invoice it touched the scalar cannot answer either "has anyone paid" or
  // "how much came in".
  const paymentsSnap = await tx.get(ref.collection('payments'));
  const payments = paymentsSnap.docs.map((d) => d.data() as PaymentAmount);
  const paidCents = paidCentsFromPayments(payments);

  // THREE states, not "has payments". A part-paid invoice stays fully editable:
  // freezing it on the first payment of any size is what left a part-collected
  // invoice with no repair path at all. See invoiceEditPolicy.ts.
  const standing = paymentStandingOf(invoiceTotalCentsOf(data), paidCents);

  const touchesMoney = patch.lineItems !== undefined || patch.invoiceDiscountCents !== undefined;

  // The FOURTH input is the household's answer (issue #448). An accepted quote
  // is frozen outright, and it has to be checked here rather than left to the
  // state: `acceptQuote` re-stamps the doc to 'open', so by the time an edit
  // arrives the only thing separating an agreed figure from an ordinary sent
  // invoice is `quoteDecision`.
  const refusal = invoiceEditRefusal(
    invoiceStateOf(data),
    standing,
    touchesMoney,
    quoteAcceptanceOf(data),
  );
  if (refusal) {
    throw new HttpsError('failed-precondition', refusal.message, { code: refusal.code });
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (patch.invoiceNumber !== undefined) update['invoiceNumber'] = patch.invoiceNumber;
  if (patch.date !== undefined) update['date'] = patch.date;
  if (patch.dueDate !== undefined) update['dueDate'] = patch.dueDate;
  if (patch.terms !== undefined) {
    update['terms'] = patch.terms;
    // FREE TEXT REPLACES THE RULE, IT DOES NOT SIT BESIDE IT. An invoice whose
    // terms were typed over by hand no longer follows a code, and leaving the
    // old one on the doc would let it read "whatever was typed" while still
    // claiming, in a field nothing renders today, to be net 14. That is exactly
    // the kind of disagreement that rots unseen until the settings work reads
    // the code back. Cleared to '' rather than deleted, so "never had a code"
    // and "had one until an edit" stay tellable apart.
    if (patch.termsCode === undefined) update['termsCode'] = '';
  }
  // STRUCTURED TERMS DECIDE THE DUE DATE, here as at creation. Resolved from
  // the visits the invoice ALREADY links (`sessionIds` on the doc, which this
  // patch cannot change: linkInvoiceSessions owns that link) and from the date
  // this same patch is setting, so correcting the date and the terms in one
  // edit lands one consistent due date rather than two half-applied ones.
  if (patch.termsCode !== undefined) {
    const sessionIds = Array.isArray(data.sessionIds)
      ? (data.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const serviceDates = await serviceDaysForSessions(db(), sessionIds);
    const outcome = resolveStructuredTerms({
      termsCode: patch.termsCode,
      date: patch.date ?? (typeof data.date === 'string' ? data.date : ''),
      // Custom terms keep whatever due date the invoice already carries when
      // the patch does not name one: the operator changing the terms TO custom
      // is not thereby wiping the date. Every other code resolves its own date,
      // so only a date sent alongside is checked against it.
      dueDate:
        patch.termsCode === 'custom'
          ? (patch.dueDate ?? (typeof data.dueDate === 'string' ? data.dueDate : ''))
          : (patch.dueDate ?? ''),
      serviceDates,
      now: new Date().toISOString().slice(0, 10),
    });
    if (!outcome.ok) {
      throw new HttpsError('failed-precondition', outcome.message, { code: outcome.code });
    }
    update['terms'] = outcome.fields.terms;
    update['termsCode'] = outcome.fields.termsCode;
    update['dueDate'] = outcome.fields.dueDate;
  }
  if (patch.kinfolkName !== undefined) update['kinfolkName'] = patch.kinfolkName;
  if (patch.client !== undefined) update['client'] = patch.client;
  if (patch.address !== undefined) update['address'] = patch.address;
  if (patch.discount !== undefined) update['discount'] = patch.discount;

  // WHETHER TO RECOMPUTE AT ALL. Every invoice that exists today is
  // un-itemized, so "sum of zero lines" is NOT the same statement as "this
  // invoice is worth nothing". Recomputing here would silently rewrite a real
  // $40 invoice to $0 because the operator corrected its due date. The money is
  // only ever recomputed when this invoice actually has lines, or when this
  // patch is the thing giving it its first ones.
  const lines: InvoiceLineItemInput[] | null = touchesMoney
    ? (patch.lineItems ?? storedLineItems(data) ?? [])
    : storedLineItems(data);

  let totals = computeInvoiceTotals(lines ?? [], 0, paidCents);

  if (lines !== null) {
    const invoiceDiscountCents =
      patch.invoiceDiscountCents ??
      (typeof data.invoiceDiscountCents === 'number' ? data.invoiceDiscountCents : 0);

    const moneyError = validateInvoiceMoney(lines, invoiceDiscountCents);
    if (moneyError) throw new HttpsError('failed-precondition', moneyError, { code: 'invoice_money_invalid' });

    totals = computeInvoiceTotals(lines, invoiceDiscountCents, paidCents);

    // The PERSISTED balance goes through the same settlement the payment path
    // uses, so an edit that drops the total below what has already been
    // collected writes a zero balance plus an explicit `overpaidCents`, not a
    // negative `amountDue`. A negative `amountDue` is this codebase's CREDIT
    // signal (invoiceStateOf — whose stamp the portal now renders — plus the
    // admin and Android classifiers all read it that way), so writing one here would silently turn
    // an over-collected invoice into a credit owed back to the household.
    // `totals` keeps the raw signed arithmetic for the caller; the doc gets the
    // settled reading.
    const settled = settleInvoice(totals.totalCents, paidCents);

    if (patch.lineItems !== undefined) update['lineItems'] = patch.lineItems;
    update['invoiceDiscountCents'] = invoiceDiscountCents;
    update['subtotalCents'] = totals.subtotalCents;
    update['totalCents'] = settled.totalCents;
    update['paidCents'] = settled.paidCents;
    update['amountDueCents'] = settled.amountDueCents;
    update['overpaidCents'] = settled.overpaidCents;
    // The legacy dollar scalars, written from the SAME cents figures in the same
    // pass so the two can never disagree. A projection, never an input.
    update['total'] = centsToDollars(settled.totalCents);
    update['amountDue'] = centsToDollars(settled.amountDueCents);
  }

  // The state stamp (ADR-0002), computed over the doc AS THIS WRITE LEAVES IT
  // and merged in the same set, so there is no window where the money moved
  // but the stored state describes the old money. Note it runs on the
  // PERSISTED (clamped) figures, not on the raw signed `totals` returned to
  // the caller: an over-collected edit stamps paid/none, never credit.
  const stamp = invoiceStateStampOf({ ...data, ...update }, paidCents);
  update['status'] = stamp.status;
  update['editScope'] = stamp.editScope;

  // #884: SETTLED BY AN EDIT, NOT A PAYMENT. Lowering the total to what has
  // already been paid turns the invoice paid with no money moving, so nobody is
  // told: the household did not pay anything just now, and the audit entry
  // below (`settledByEdit`) is the office's record. The owner stamp, in this
  // same write, is how `onInvoicesWrite` knows to stay silent. A fresh id every
  // time, and only on the move INTO paid, for the reasons in
  // lib/paymentAppliedOwner.ts.
  const stateBefore = invoiceStateOf(data);
  const settledByEdit = stateBefore !== 'paid' && stamp.status === 'paid';
  if (settledByEdit) {
    update[PAYMENT_APPLIED_OWNER_FIELD] = paymentAppliedOwner('updateInvoice', randomUUID());
  }
  tx.set(ref, update, { merge: true });
  return { data, lines, totals, stamp, stateBefore, settledByEdit };
}

/**
 * After the commit: the audit entry and the log line. The audit stays outside
 * the edit's transaction on purpose: `writeAuditEntry` runs its own
 * transaction over the activity-log hash chain head, and a transaction cannot
 * nest another. A failed audit write is logged and the edit stands, as before.
 */
async function finishEdit(
  uid: string,
  invoiceId: string,
  patch: EditPatch,
  edit: Awaited<ReturnType<typeof planEdit>>,
): Promise<z.infer<typeof Result>> {
  const { data, lines, totals, stamp, stateBefore, settledByEdit } = edit;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: invoiceId,
    targetCollection: 'invoices',
    familyId: data.kinfolkId,
    description: `Invoice ${data.invoiceNumber ?? invoiceId} edited`,
    payload: {
      invoiceId,
      fields: Object.keys(patch),
      itemized: lines !== null,
      totalCents: lines !== null ? totals.totalCents : null,
      // #884: the office's record of a bill settled by an edit, which sends no notice.
      stateBefore,
      stateAfter: stamp.status,
      settledByEdit,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'updateInvoice',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'updateInvoice',
    event: 'admin.invoice.updated',
    uid,
    extra: { invoiceId, fields: Object.keys(patch), itemized: lines !== null },
  });

  return validateResponse('updateInvoice', Result, { ok: true, invoiceId, totals });
}

export const updateInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('updateInvoice', updateInvoiceHandler),
);
