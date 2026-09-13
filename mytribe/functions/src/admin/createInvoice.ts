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
import { INVOICE_NUMBER_COUNTER_PATH, mintInvoiceNumberInTransaction } from '../lib/invoiceNumber';
import { InvoiceIdempotencyKeyArg, assertSameCaller } from '../lib/moneyIdempotency';
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
  /**
   * #825: mint one per SUBMISSION, not per press, and this call becomes safe to
   * retry. It becomes the id of the `invoices/{key}` document, so a second
   * attempt at one invoice finds the first attempt's document.
   *
   * A REPLAY HERE COSTS TWO THINGS, not one. The household gets billed twice,
   * and the sequence in `counters/invoiceNumber` is advanced twice — so even
   * after the duplicate invoice is deleted, the numbering says an invoice was
   * issued that nobody can produce. Nothing can put a consumed number back,
   * which is why the number is now drawn inside the same transaction that
   * creates the document: a replay never reaches the counter at all.
   *
   * OPTIONAL. Omitted, the document gets a server-minted auto id and there is
   * no dedupe, exactly as before.
   */
  idempotencyKey: InvoiceIdempotencyKeyArg,
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
  const uid = req.auth!.uid;

  // ── THE FAST PATH (#825) ────────────────────────────────────────────────
  //
  // Answered before anything else runs, including the reads that price the
  // terms and freeze the payment options: a retry of a stored invoice must not
  // re-do work whose result it is going to throw away, and above all it must
  // not reach `mintInvoiceNumber`, which spends a number it cannot give back.
  // It also must not re-enqueue `invoice.new`: the household was told about
  // this invoice on the first attempt.
  if (args.idempotencyKey !== undefined) {
    const existing = await db().collection('invoices').doc(args.idempotencyKey).get();
    if (existing.exists) {
      const stored = (existing.data() ?? {}) as Record<string, unknown>;
      assertSameCaller(stored, uid, 'createdBy');
      logEvent({
        severity: 'info',
        function: 'createInvoice',
        event: 'admin.invoice.created.replay',
        extra: { invoiceId: args.idempotencyKey, invoiceNumber: stored['invoiceNumber'] },
      });
      return validateResponse('createInvoice', Result, { ok: true, invoiceId: args.idempotencyKey });
    }
  }

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
  const ref =
    args.idempotencyKey !== undefined
      ? firestore.collection('invoices').doc(args.idempotencyKey)
      : firestore.collection('invoices').doc();
  const docBase = {
    kinfolkName: args.kinfolkName,
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

  // ── ONE TRANSACTION: THE DEDUPE, THE NUMBER, THE DOCUMENT (#825) ────────
  //
  // THE NUMBER IS ASSIGNED WHEN NOBODY SAID (#408). A caller that sends one
  // keeps it; the composer stopped asking, so most invoices arrive without.
  //
  // It is now drawn INSIDE the transaction that writes the invoice, so the
  // sequence value and the document it belongs to move together. Minting first
  // and writing afterwards meant a call that turned out to be a replay had
  // already spent a number on an invoice it was not going to write, and a
  // consumed sequence value cannot be returned: the numbering would say two
  // invoices were issued where one was, permanently.
  const counterRef = firestore.doc(INVOICE_NUMBER_COUNTER_PATH);
  const written = await firestore.runTransaction(async (tx) => {
    // Every read before every write, Firestore's rule and the guard's order.
    if (args.idempotencyKey !== undefined) {
      const existing = await tx.get(ref);
      if (existing.exists) {
        const stored = (existing.data() ?? {}) as Record<string, unknown>;
        assertSameCaller(stored, uid, 'createdBy');
        return null;
      }
    }
    const invoiceNumber =
      (args.invoiceNumber ?? '').trim() === ''
        ? await mintInvoiceNumberInTransaction(tx, counterRef, args.date)
        : args.invoiceNumber!.trim();
    const doc = { ...docBase, invoiceNumber };
    // The state stamp (ADR-0002), IN THE SAME WRITE as the money it describes.
    // Spread AFTER the caller's fields: it canonicalizes `status` to the
    // classifier's reading of this very doc (a caller's 'sent' or '' stores as
    // 'open'), which is the vocabulary all three clients' own classifiers
    // already resolve these fields to. paidCents is 0 by construction: a
    // payment cannot be recorded against an invoice before it exists.
    const full = {
      ...doc,
      ...invoiceStateStampOf(doc, 0),
      ...payMethodSnapshot,
      // WHO ISSUED IT. Additive, and the field the idempotency guard above
      // refuses a cross-caller collision on: a key that lands on somebody
      // else's invoice is a guessed or replayed id, and answering with their
      // document would be a disclosure rather than a dedupe.
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // `create` when there is a key, so two attempts reaching the write together
    // are refereed by the server rather than by the read above.
    if (args.idempotencyKey !== undefined) tx.create(ref, full);
    else tx.set(ref, full);
    return invoiceNumber;
  });

  if (written === null) {
    logEvent({
      severity: 'info',
      function: 'createInvoice',
      event: 'admin.invoice.created.replay',
      extra: { invoiceId: ref.id, raced: true },
    });
    return validateResponse('createInvoice', Result, { ok: true, invoiceId: ref.id });
  }
  const invoiceNumber = written;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_INVOICE_CREATED,
    severity: 'info', actorRole: 'AUNTIE', actorUid: req.auth!.uid, familyId: args.familyId,
    payload: {
      invoiceId: ref.id,
      invoiceNumber,
      itemized: args.lineItems !== undefined,
      lineCount: args.lineItems?.length ?? 0,
      // Which submission this invoice belongs to, so the trail can tell a
      // second invoice from a second attempt at one (#825).
      idempotencyKey: args.idempotencyKey ?? null,
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
