import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldPath, type Query } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveInvoiceWriteActor } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';
import {
  TIP_BASES,
  paymentMoneyOf,
  paymentReconciles,
  readTipBasis,
  resolveLedgerAmountCents,
} from '../lib/paymentMoney';

/**
 * THE ROOT `payments` COLLECTION, ACROSS HOUSEHOLDS, IN CENTS THE SERVER
 * RESOLVED. The staff payment browser's read, and the last place a client was
 * still reading this collection's money for itself.
 *
 * WHY THIS IS A SEPARATE CALLABLE FROM `getInvoiceLedger`, and not a widening
 * of it. `getInvoiceLedger` is per-invoice BY CONSTRUCTION: its `Args` is
 * `{ invoiceId }` `.strict()`, its handler opens by reading that invoice and
 * refuses an unknown one, and every list it returns is scoped by that invoice
 * or by the household derived from it. It also refuses, in as many words, the
 * one thing this callable is: an id-less mode "degenerates into an unfiltered
 * scan", which is why a household-less invoice there gets an EMPTY list rather
 * than every unlinked payment in the system. A cross-household list is not a
 * degenerate invoice ledger; it is a different question, and it is bounded
 * differently (below). Two callables, not one with a mode flag.
 *
 * THE DEFECT IT EXISTS TO CLOSE. `stripeWebhook.ts:217-225` writes a row's
 * `amount` in CENTS when the figure came off the Stripe event and in DOLLARS
 * when it fell back to the local invoice, distinguishable only by the sibling
 * `amountSource`. The staff Android app read that field raw through
 * `InvoiceRepository.getPayments()` into a `Payment` model carrying neither
 * `amountCents` nor `amountSource`, so a $137.50 card payment could not be
 * told from $13,750.00 even in principle. The rule that resolves it is
 * `resolveLedgerAmountCents` (`lib/paymentMoney.ts`), it lives on the server,
 * and it stays there: the display ledger, the `amountCents` backfill and this
 * list all call the SAME function, so no two of them can disagree about what a
 * given legacy row is worth.
 *
 * ── BOUNDED, AND IT SAYS SO ───────────────────────────────────────────────
 *
 * ORDERED BY DOCUMENT ID, cursored, never by a date. That is forced, not
 * stylistic, and the two obvious alternatives are both silently wrong on this
 * collection:
 *
 *   `date`      MIXED TYPES. `recordPayment.ts` writes the operator's free
 *               text ("February 17, 2026"); `stripeWebhook.ts` writes
 *               `FieldValue.serverTimestamp()`, a real Timestamp. Firestore
 *               orders by TYPE first, so `orderBy('date')` would sort every
 *               card payment into one block and every hand-recorded payment
 *               into another, in an order that has nothing to do with when
 *               either happened.
 *   `createdAt` PRESENT ONLY ON `recordPayment.ts` ROWS. `orderBy` drops
 *               documents missing the field, so it would silently omit every
 *               Stripe row and every legacy import row — the exact rows this
 *               callable was written for.
 *
 * Document id is on every document by construction. Same reasoning, same
 * words, as `repairInvoicePayments`' full-collection sweep.
 *
 * THE PAGE READS `limit + 1` AND RETURNS `limit`. The extra document is never
 * shown; it is how `truncated` can be a FACT rather than the guess "the page
 * came back full, so there may be more". `truncated` and `nextCursor` are one
 * decision expressed twice and are pinned in a test never to disagree.
 *
 * The failure this deliberately does not reproduce is `getInvoiceLedger`'s
 * `unlinkedKinfolkPayments`, which applies its limit BEFORE an in-memory
 * filter, so a filtered-to-nothing page reports no unattributed money when
 * some exists — and the response has no field that could say the read was
 * bounded. Here the limit IS the page: there is no in-memory filter for it to
 * run ahead of, and the bound is reported.
 *
 * ── THE GATE ──────────────────────────────────────────────────────────────
 *
 * `wrapCallable` + `resolveInvoiceWriteActor`, the ADR-0002 invoice-surface
 * gate, NOT `wrapAdminCallable`. Every other callable that reads or writes
 * this collection uses it (`getInvoiceLedger`, `recordPayment`), and more to
 * the point this callable REPLACES a client read that a sandbox test admin can
 * perform today: `firestore.rules` grants that token `payments/{id}` where
 * `kinfolkId == testTribeId`, and Android's `ScopedFirestore.scopedQuery`
 * applies exactly that clause. `wrapAdminCallable` would refuse a token the
 * rules admit, making the replacement a narrowing rather than a fix. So the
 * sandbox is admitted and SCOPED here instead, with the same equality clause
 * the client used to apply for itself — where it cannot be forgotten.
 *
 * An equality filter plus `orderBy(FieldPath.documentId())` needs no composite
 * index: every single-field index already ends in `__name__`. Worth stating,
 * because the unit suite mocks Firestore and would never surface a missing
 * index.
 *
 * ── WHAT IT DOES NOT CARRY ────────────────────────────────────────────────
 *
 * NO `client`, `address` OR `email`, though the collection stores all three and
 * the Kotlin `Payment` model deserialized them. They are household PII, no
 * surface renders them off this list, and `kinfolkId`/`kinfolkName` already
 * identify whose money a row is. Publishing PII on a wire contract for a screen
 * that does not exist yet is the wrong default; adding a field later is
 * additive and cheap, un-publishing one is not.
 */

/** Page size when the caller names none, and the ceiling on one they do. */
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z
  .object({
    /**
     * Rows to return this page. Omitted reads as `DEFAULT_PAGE` (100); the
     * ceiling is `MAX_PAGE` (500), so one call can never read an unbounded
     * collection.
     */
    limit: z.number().int().min(1).max(MAX_PAGE).optional(),
    /**
     * Document id to resume after, from the previous page's `nextCursor`.
     * `.min(1)`: a blank string is a caller bug, and silently restarting from
     * the top of the collection is how a paging loop turns into an infinite one.
     */
    // No slash. The cursor is a document ID, and ordering by documentId() makes
    // the Admin SDK throw a PLAIN Error on a path-shaped cursor
    // (@google-cloud/firestore reference/query.js validateReference), which
    // wrapCallable maps to `internal` and reports to Sentry. A malformed cursor
    // from an admin client is a caller fault, so say so here and keep it out of
    // the server-fault alerts, matching how the blank case is already handled.
    startAfterId: z.string().min(1).max(200).regex(/^[^/]+$/, 'startAfterId must be a document id, not a path').optional(),
  })
  .strict();

export type ListPaymentsArgs = z.infer<typeof Args>;

/**
 * One row of the ROOT `payments` collection, read as money.
 *
 * A DIFFERENT SCHEMA from `getInvoiceLedger`'s `LedgerPaymentSchema`, on
 * purpose, even though the money fields line up. That list is scoped to one
 * invoice and one household, so it never has to say WHOSE payment a row is;
 * this one crosses households and would be unreadable without it. The registry
 * pins shared types by schema IDENTITY rather than by shape precisely so two
 * types that merely look alike today stay two types.
 */
const PaymentRowSchema = z
  .object({
    paymentId: z.string().min(1),
    /** The household this money came from. `''` on a legacy import row that names none. */
    kinfolkId: z.string(),
    /** As stored on the row, NOT joined from the `kinfolk` doc. `''` on every webhook row. */
    kinfolkName: z.string(),
    /**
     * The whole sum collected from the client, the GROSS tip included,
     * resolved from the row's own storage convention by
     * `resolveLedgerAmountCents`. Integer cents on every row, whichever of the
     * four conventions the row was written under.
     */
    amountCents: CentsSchema,
    /**
     * FALSE when the row's units could not be honestly determined — a Stripe
     * event the webhook itself gave up on, or an `amount` that is not a usable
     * number. `amountCents` is 0 on such a row, and 0 IS NOT A CLAIM THAT
     * NOTHING WAS COLLECTED: it is the floor `CentsSchema` allows. A client
     * that renders `$0.00` without reading this flag is stating a fact nobody
     * checked.
     *
     * 29a resolved the same rows for the web ledger but could not ship this
     * flag: adding a field to `getInvoiceLedger`'s response meant regenerating
     * three client artifacts, outside that task's backend-only scope, so it
     * settled for a warn log and recorded the gap ("an unresolved row still
     * renders as $0.00 in the admin UI with no on-screen flag"). This contract
     * is new, so the flag costs nothing here. The warn log stays too.
     */
    amountResolved: z.boolean(),
    /** Gratuity, recorded separately by the legacy shape. Integer cents here. */
    tipCents: CentsSchema,
    /** The processor's cut. Zero on a row written before the field existed, which is NOT evidence there was no fee. */
    feeCents: CentsSchema,
    /** Which convention `tipCents` follows: `'gross'`, or `'unknown'` on a legacy row whose fee was dropped. */
    tipBasis: z.enum(TIP_BASES),
    /** Can `amount = applied + tipGross + unapplied` be CHECKED on this row? False on an unknown-basis tip. */
    reconciles: z.boolean(),
    /** Sum of this payment's per-invoice applications. Zero on a display-only row. */
    appliedCents: CentsSchema,
    /** Left on account: amount less applied less the gross tip. SIGNED, never clamped. */
    unappliedCents: SignedCentsSchema,
    /** What the operator banks: amount less fee. */
    proceedsCents: CentsSchema,
    /** Whether the leftover was moved into the household's account credit for a FUTURE invoice. */
    autoApply: z.boolean(),
    /** The invoice this row was LINKED to for display. `''` on a standalone payment. */
    invoiceId: z.string(),
    /** The human-facing number behind `invoiceId`. `''` when unknown. */
    invoiceNumber: z.string(),
    /**
     * WHICH INVOICE'S BALANCE this payment actually moved. One payment applies
     * to one invoice (operator ruling, 2026-08-04). `''` on a display-only row
     * that touched no balance, and it can name a DIFFERENT invoice from
     * `invoiceId` above — saying so is the point.
     */
    appliedInvoiceId: z.string(),
    appliedInvoiceNumber: z.string(),
    method: z.string(),
    reference: z.string(),
    /**
     * FREE TEXT, and `''` on every Stripe row. `stripeWebhook.ts` writes a
     * Timestamp into this field and `recordPayment.ts` writes a string; only
     * strings are reported, exactly as `getInvoiceLedger` reports them, so the
     * two readers of this collection cannot render the same field differently.
     * Surfacing the webhook's timestamp is a follow-up on both readers at once,
     * not a divergence introduced here.
     */
    date: z.string(),
    /**
     * STAFF ONLY, and it stays that way: this callable is admin-gated and no
     * kinfolk-facing surface reads the root `payments` collection at all. These
     * are the operator's private notes about a household.
     */
    notes: z.string(),
    /** The admin uid that recorded it. Null on a webhook row and on every row predating the field. */
    recordedBy: z.string().nullable(),
  })
  .strict();

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS types
 * below.
 *
 * NO `ok` FIELD, matching `getInvoiceLedger` and `listUninvoicedSessions`, the
 * other pure reads on this surface: it answers with data or it throws.
 */
export const Result = z
  .object({
    /** This page, in DOCUMENT ID order. See the header for why not by date. */
    payments: z.array(PaymentRowSchema),
    /**
     * True when the collection holds at least one more row after this page.
     * A FACT, established by reading one document more than was returned, not
     * the inference "the page came back full".
     */
    truncated: z.boolean(),
    /** Pass back as `startAfterId` for the next page. Null iff `truncated` is false. */
    nextCursor: z.string().nullable(),
    /**
     * How many rows ON THIS PAGE carry `amountResolved: false`. Redundant with
     * the per-row flags and deliberately so: a caller that renders a total, or
     * a banner, needs the count without walking the list, and a caller that
     * never looks at either is at least visible in the logs.
     */
    unresolvedAmountCount: z.number().int().min(0),
  })
  .strict();

export type ListPaymentsResult = z.infer<typeof Result>;

/** Reads a string field, tolerating the junk a `cast`-not-validated doc can carry. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Reads a string field as nullable: absent, null, blank and non-string all read as null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Dollars-as-float to integer cents, rounded ONCE. Non-numbers read as 0. */
function dollarsToCents(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v * 100)) : 0;
}

/**
 * An integer-cents field, falling back to its dollar twin.
 *
 * FOR `tipCents`/`feeCents`/`appliedCents` ONLY, the same scoping
 * `getInvoiceLedger` documents: `stripeWebhook.ts` never wrote a tip, fee or
 * applied amount on either branch of `amountSource`, so those three carry none
 * of the unit ambiguity `amount` does. `amount` itself goes through
 * `resolveLedgerAmountCents`, never this.
 */
function centsOr(cents: unknown, dollars: unknown): number {
  if (typeof cents === 'number' && Number.isInteger(cents) && cents >= 0) return cents;
  return dollarsToCents(dollars);
}

export async function listPaymentsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const actor = resolveInvoiceWriteActor(req, 'listPayments');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listPayments validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const limit = args.limit ?? DEFAULT_PAGE;

  // THE SANDBOX CLAUSE. A test admin is hard-restricted by `firestore.rules` to
  // `kinfolkId == testTribeId`, and rules cannot filter a list query, so
  // whoever builds the query has to apply the constraint. Android used to apply
  // it client-side; applying it here is what makes it unforgeable, and the same
  // move `recordPayment` made with `scopedKinfolkId` on the write side. Staff
  // are never scoped — the rules already grant them the whole collection.
  const base: Query = actor.testMode.active
    ? db().collection('payments').where('kinfolkId', '==', actor.testMode.testTribeId)
    : db().collection('payments');

  let query = base.orderBy(FieldPath.documentId());
  if (args.startAfterId !== undefined) query = query.startAfter(args.startAfterId);
  // ONE MORE THAN WE WILL RETURN. The extra row is never projected; it is the
  // difference between reporting truncation as a fact and guessing it from a
  // full page.
  const snap = await query.limit(limit + 1).get();

  const truncated = snap.docs.length > limit;
  const page = truncated ? snap.docs.slice(0, limit) : snap.docs;

  // How many rows on this page could not honestly be resolved to an amount.
  // Counted across the page so ONE warn log reports the read, not one line per
  // row — the same shape `getInvoiceLedger` and `stripeWebhook` already use.
  let unresolvedAmountCount = 0;

  const payments = page.map((d) => {
    const raw = d.data() as Record<string, unknown>;
    // CENTS WIN OVER DOLLARS, but `amount`'s dollars-vs-cents reading also
    // depends on `amountSource`. One function owns that rule; the display
    // ledger and the backfill call the same one.
    const amountResult = resolveLedgerAmountCents({
      amount: raw['amount'],
      amountCents: raw['amountCents'],
      amountSource: raw['amountSource'],
    });
    if (!amountResult.resolved) unresolvedAmountCount += 1;
    const amountCents = amountResult.amountCents;
    const tipCents = centsOr(raw['tipCents'], raw['tip']);
    const feeCents = centsOr(raw['feeCents'], raw['fee']);
    const tipBasis = readTipBasis(raw['tipBasis']);
    const appliedCents = centsOr(raw['appliedCents'], raw['applied']);
    const money = paymentMoneyOf({ amountCents, tipCents, feeCents, appliedCents, tipBasis });
    return {
      paymentId: d.id,
      kinfolkId: str(raw['kinfolkId']),
      kinfolkName: str(raw['kinfolkName']),
      amountCents: money.amountCents,
      amountResolved: amountResult.resolved,
      tipCents: money.tipCents,
      feeCents: money.feeCents,
      tipBasis,
      reconciles: paymentReconciles({ tipCents, tipBasis }),
      appliedCents: money.appliedCents,
      unappliedCents: money.unappliedCents,
      proceedsCents: money.proceedsCents,
      autoApply: raw['autoApply'] === true,
      invoiceId: str(raw['invoiceId']),
      invoiceNumber: str(raw['invoiceNumber']),
      appliedInvoiceId: str(raw['appliedInvoiceId']),
      appliedInvoiceNumber: str(raw['appliedInvoiceNumber']),
      method: str(raw['paymentMethod']),
      reference: str(raw['referenceNumber']),
      date: str(raw['date']),
      notes: str(raw['notes']),
      recordedBy: strOrNull(raw['recordedBy']),
    };
  });

  // Fail-loud (money code standing rule): a row this reader could not
  // interpret is 0 on the wire, and 0 that nobody flagged is indistinguishable
  // from a payment of nothing. The row carries `amountResolved: false` and the
  // read says so out loud here as well, so it is findable without a client.
  if (unresolvedAmountCount > 0) {
    logEvent({
      severity: 'warn',
      function: 'listPayments',
      event: 'payments.amount.unresolved',
      uid: actor.uid,
      extra: { unresolvedAmountCount, returned: payments.length },
    });
  }

  const nextCursor = truncated ? (page[page.length - 1]?.id ?? null) : null;

  logEvent({
    severity: 'info',
    function: 'listPayments',
    event: 'admin.payments.listRead',
    uid: actor.uid,
    extra: {
      returned: payments.length,
      limit,
      truncated,
      resumed: args.startAfterId !== undefined,
      unresolvedAmountCount,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('listPayments', Result, {
    payments,
    truncated,
    nextCursor,
    unresolvedAmountCount,
  });
}

export const listPayments = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped test
  // admin, same as its invoice-surface siblings, and the scoping clause on the
  // query above is the other half of that gate. See the header.
  wrapCallable('listPayments', listPaymentsHandler),
);
