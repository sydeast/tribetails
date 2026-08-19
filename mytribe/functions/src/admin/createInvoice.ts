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
import { InvoiceDayArg } from '../lib/invoiceDay';
import { InvoiceTermsCodeArg } from '../lib/invoiceTerms';
import { resolveStructuredTerms, serviceDaysForSessions } from '../lib/invoiceCreateFields';
import { mintInvoiceNumber } from '../lib/invoiceNumber';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { payMethodSnapshotForIssue } from '../lib/payMethodSnapshot';
import { validateResponse } from '../lib/callableResponse';
import { OkSchema } from '../lib/invoiceResponseSchema';

/**
 * Server-mints the invoice doc id so the id is authoritative (the composer does
 * not have to invent one). Writes to the canonical FLAT top-level `invoices`
 * collection, stamping `kinfolkId` so the portal's getMyInvoices can see it.
 *
 * `lineItems` IS PURELY ADDITIVE. Every payload that validated before this
 * change still validates and still behaves identically: omit the field and the
 * caller's `total` / `amountDue` are stored verbatim, exactly as they always
 * were, and none of the cents fields are written at all. That matters because
 * the Android composer, every existing test and any un-migrated client still
 * send the legacy 13-key shape.
 *
 * WHEN LINE ITEMS ARE PRESENT, THE SERVER OWNS THE MONEY. Every figure is
 * recomputed from the lines through `lib/invoiceMath.ts`, and the cents fields
 * plus the legacy dollar projection are written from that ONE computation, the
 * same rule `updateInvoice` enforces. `updateInvoice` can state that simply by
 * having no `total` field in its request at all; this callable cannot, because
 * `total` and `amountDue` are REQUIRED by the legacy shape and removing them
 * would break every existing caller.
 *
 * SO A DISAGREEMENT IS REFUSED, NOT SILENTLY OVERWRITTEN. A caller that
 * itemizes an invoice and also asserts a total that is not the sum of those
 * items has a bug, and quietly substituting the server's number would hide that
 * bug while changing what a household is billed. The refusal names BOTH
 * figures. The admin composer derives its total through the MIRRORED
 * `invoiceMath` module, whose fixture table is asserted identical in both trees,
 * so an honest client cannot round its way into this error.
 *
 * `paidCents` is 0 by construction here: an invoice cannot have a payment
 * recorded against it before it exists, so `amountDueCents` equals `totalCents`
 * on creation. It is passed explicitly rather than assumed, so the reader can
 * see which of the four figures is being asserted and which is derived.
 */
const LineItem = z.object({
  description: z.string().min(1).max(200),
  qty: z.number().positive().max(999),
  unitCents: z.number().int().min(0).max(10_000_000),
  discountCents: z.number().int().min(0).optional(),
  /**
   * The visit this line bills for, when it was drawn from one (#408).
   *
   * A BINDING, NOT A LABEL. A bound line is not independently editable in the
   * composer: the money on it comes from the visit, so correcting the money
   * means correcting the visit and letting the invoice follow. Storing the id
   * is what lets every surface offer the route back to that visit, and what
   * lets the household's copy show the day the work was done.
   *
   * Optional, because a line typed by hand has no visit behind it, and every
   * legacy caller sends none.
   */
  sessionId: z.string().max(200).optional(),
});

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  familyId: z.string().min(1),
  kinfolkName: z.string().default(''),
  /**
   * OPTIONAL SINCE #408: omit it, or send a blank, and the server assigns the
   * next number in the sequence (`lib/invoiceNumber.ts`). The composer no
   * longer asks the operator to invent one. Still accepted, because the Android
   * composer sends one and because an operator who needs a specific number must
   * be able to say so.
   */
  invoiceNumber: z.string().max(60).optional(),
  client: z.string().default(''),
  address: z.string().default(''),
  // A DAY, not free text. The admin list range-queries and orders on `date`, and
  // Firestore compares it as a string, so a letter-leading value like
  // "Feb 12, 2026" outranks every ISO date and lands inside every window.
  // See lib/invoiceDay.ts; `updateInvoice` has enforced the same shape since W2-1.
  date: InvoiceDayArg,
  terms: z.string().default(''),
  dueDate: InvoiceDayArg,
  /**
   * Structured payment terms (#408). When present, the SERVER writes `terms` as
   * the rule in words and works `dueDate` out from it, refusing a `dueDate`
   * that disagrees. Absent, `terms` and `dueDate` are stored verbatim, exactly
   * as they always were.
   */
  termsCode: InvoiceTermsCodeArg.optional(),
  discount: z.string().default(''),
  total: z.number().nonnegative(),
  amountDue: z.number().nonnegative(),
  status: z.string().default(''),
  sessionIds: z.array(z.string()).default([]),
  /** Optional itemization. Omitted by every legacy caller; see the header. */
  lineItems: z.array(LineItem).max(100).optional(),
  /** Whole-invoice reduction, integer cents. Only meaningful alongside `lineItems`. */
  invoiceDiscountCents: z.number().int().min(0).optional(),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1). Exported for the same reason `Args`
 * is: the contract guard freezes it, and decision 2 generates the clients'
 * types from it. `.strict()`, so an added field is reported rather than
 * absorbed. Three deployed clients read this.
 */
export const Result = z
  .object({
    ok: OkSchema,
    /** The SERVER-minted doc id; the composer never invents one. */
    invoiceId: z.string().min(1),
  })
  .strict();

/** "$36.00" / "-$12.50" from an integer count of cents, for the refusal message. */
function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Dollars as sent by the caller, for a refusal that has to name their figure too. */
function usdFromDollars(dollars: number): string {
  const sign = dollars < 0 ? '-' : '';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

export async function createInvoiceHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  const args = Args.parse(req.data);

  // The itemized fields, or nothing at all. An un-itemized invoice must not
  // pick up a `lineItems: []` or a `totalCents: 0`: "nobody itemized this" and
  // "this was itemized as worth nothing" are different claims, and the whole
  // `updateInvoice` un-itemized guard turns on being able to tell them apart.
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

    // Name both numbers. "Total does not match the line items" without the two
    // figures leaves the caller guessing which one to change.
    if (args.total !== derivedTotal) {
      throw new HttpsError(
        'failed-precondition',
        `The total sent (${usdFromDollars(args.total)}) is not the sum of the line items (${usd(totals.totalCents)}). The line items decide the total, so send that figure or correct the items.`,
        { code: 'invoice_total_mismatch' },
      );
    }
    if (args.amountDue !== derivedAmountDue) {
      throw new HttpsError(
        'failed-precondition',
        `The amount due sent (${usdFromDollars(args.amountDue)}) is not the line-item total (${usd(totals.amountDueCents)}). A new invoice has no payments recorded against it, so the two are the same figure.`,
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

  const firestore = db();
  // TERMS, AND THE DUE DATE THEY DECIDE (#408). Structured terms make the
  // server the authority on when this invoice is due, resolved from the visits
  // it is actually linking, not from anything the caller asserts. Without a
  // `termsCode` both fields are stored verbatim, exactly as they always were.
  let termsFields: Record<string, unknown> = { terms: args.terms, dueDate: args.dueDate };
  if (args.termsCode !== undefined) {
    const serviceDates = await serviceDaysForSessions(firestore, args.sessionIds);
    const outcome = resolveStructuredTerms({
      termsCode: args.termsCode,
      date: args.date,
      dueDate: args.dueDate,
      serviceDates,
      // The UTC day. It decides nothing that is written here (the resolver only
      // uses it to report a due date already in the past, which is the
      // client's to say out loud), so a zone offset cannot move a stored date.
      now: new Date().toISOString().slice(0, 10),
    });
    if (!outcome.ok) {
      throw new HttpsError('failed-precondition', outcome.message, { code: outcome.code });
    }
    termsFields = outcome.fields;
  }
  // THE NUMBER IS ASSIGNED WHEN NOBODY SAID (#408). A caller that sends one
  // keeps it; the composer stopped asking, so most invoices arrive without.
  const invoiceNumber =
    (args.invoiceNumber ?? '').trim() === ''
      ? await mintInvoiceNumber(firestore, args.date)
      : args.invoiceNumber!.trim();
  const ref = firestore.collection('invoices').doc();
  const doc = {
    kinfolkName: args.kinfolkName,
    invoiceNumber,
    client: args.client,
    address: args.address,
    date: args.date,
    ...termsFields,
    discount: args.discount,
    total: args.total,
    amountDue: args.amountDue,
    status: args.status,
    sessionIds: args.sessionIds,
    kinfolkId: args.familyId,
    _id: ref.id,
    ...money,
  };
  // The payment options live at the moment this invoice is issued, frozen onto
  // it (issue #409). Turning a method off later stops offering it on NEW
  // invoices; this bill keeps the answer the household was given. Fail-soft:
  // an unreadable settings doc yields no snapshot and the portal falls back to
  // live settings, which is what every invoice did before this shipped.
  const payMethodSnapshot = await payMethodSnapshotForIssue('createInvoice');
  // The state stamp (ADR-0002), IN THE SAME WRITE as the money it describes.
  // Spread AFTER the caller's fields: it canonicalizes `status` to the
  // classifier's reading of this very doc (a caller's 'sent' or '' stores as
  // 'open'), which is the vocabulary all three clients' own classifiers
  // already resolve these fields to. paidCents is 0 by construction: a payment
  // cannot be recorded against an invoice before it exists.
  await ref.set({
    ...doc,
    ...invoiceStateStampOf(doc, 0),
    ...payMethodSnapshot,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: {
      invoiceId: ref.id,
      invoiceNumber,
      itemized: args.lineItems !== undefined,
      lineCount: args.lineItems?.length ?? 0,
    },
  });

  const recipientUid = await resolveKinfolkUid(args.familyId);
  try {
    await enqueueNotification({
      key: 'invoice.new',
      recipientUid: recipientUid ?? '',
      data: { kinfolkId: args.familyId, invoiceId: ref.id },
      targetType: 'invoice',
      targetId: ref.id,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'createInvoice',
      event: 'notification.dispatch.failed',
      extra: { familyId: args.familyId, invoiceId: ref.id, key: 'invoice.new', err: (err as Error)?.message },
    });
  }

  return validateResponse('createInvoice', Result, { ok: true, invoiceId: ref.id });
}

export const createInvoice = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createInvoice', createInvoiceHandler),
);
