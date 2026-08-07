import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import {
  paidCentsFromPayments,
  invoiceTotalCentsOf,
  settleInvoice,
  type PaymentAmount,
} from '../lib/invoiceMath';
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
 * The two halves of an invoice nothing outside the server can currently see:
 * WHAT WAS PAID against it, and WHICH VISITS it bills. Read only; writes
 * nothing, stamps nothing, and never touches the classifier.
 *
 * WHY THIS HAS TO BE A CALLABLE, and is not an omission in some client:
 * `invoices/{id}/payments` is the money authority (`markInvoicePaid` writes it
 * in the same batch as the balance, and `repairInvoicePayments` reconciles
 * against it), and `firestore.rules` carries NO rule for that subcollection.
 * The parent `/invoices/{invoiceId}` match does not extend to it, and the file
 * has no catch-all, so every client read of it is denied, an Auntie's included.
 * There was no way to render it from a client, which is why no client did.
 *
 * THREE LISTS, AND THEY ARE NOT INTERCHANGEABLE. Money on this surface lives in
 * two collections with two different jobs, and a panel that merged them would
 * either double-count a payment or hide one:
 *
 *   `payments`        the `invoices/{id}/payments` SUBCOLLECTION. THE AUTHORITY.
 *                     `paidCents` is their sum and the invoice's balance is
 *                     derived from it. Written only by `markInvoicePaid`.
 *   `ledgerPayments`  rows in the ROOT `payments` collection naming this invoice.
 *                     The DISPLAY ledger (`recordPayment`, `stripeWebhook.ts`,
 *                     the historical `match_payments_to_invoices.py`). The
 *                     settlement arithmetic never reads these, so they are
 *                     reported separately and counted in NOTHING here.
 *   `sessions`        the visits the invoice claims, resolved from its own
 *                     `sessionIds`.
 *
 * A card payment taken through Stripe lands ONLY in the root ledger, so a panel
 * showing the subcollection alone would tell an operator that a paid invoice has
 * no payments. That is why both ship, labelled, rather than one.
 *
 * THE LINK IS CHECKED IN BOTH DIRECTIONS. `linkInvoiceSessions` writes the
 * invoice's `sessionIds` and each session's `invoiceId` in one transaction, but
 * Android's pre-ADR-0002 loop wrote them separately and logged-and-continued on
 * a failure, so a half-written link is a shape real data can carry.
 * `missingSessionIds` is the invoice naming a session that does not exist;
 * `orphanSessionIds` is a session naming this invoice that the invoice does not
 * claim back. Both are REPORTED, never repaired: which side is right is an
 * operator's call, and a silent fix to a billing attribution is how the
 * disagreement stops being visible.
 *
 * GATE: `resolveInvoiceWriteActor`, despite the name. It is the ADR-0002
 * invoice-surface gate (staff unscoped, a sandbox test admin scoped to their
 * `testTribeId`), built for the write funnel because that is what needed it
 * first; a read of the same documents admits exactly the same two callers, and
 * `wrapAdminCallable` would lock the sandbox out of its own invoice detail.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z
  .object({
    invoiceId: z.string().min(1).max(200),
  })
  .strict();

export type GetInvoiceLedgerArgs = z.infer<typeof Args>;

/**
 * Page caps. `sessionIds` is capped at 200 by `linkInvoiceSessions` itself, so
 * the session cap is the same number rather than a smaller one that would
 * silently hide a legally-linked visit. The ledger cap is generous next to any
 * real invoice's payment count and bounded so one call cannot read an unbounded
 * collection.
 */
const MAX_SESSIONS = 200;
const MAX_LEDGER_ROWS = 100;

/**
 * One row of `invoices/{id}/payments`.
 *
 * `amountCents` is INTEGER CENTS, derived the same way the settlement is
 * (`paidCentsFromPayments`): the stored `amountCents` when it is there, and the
 * legacy float `amount` rounded once when it is not. Every payment written
 * before 2026-07-25 carries only the dollars, and re-deriving them anywhere else
 * would let this panel disagree with the balance beside it.
 *
 * `method` / `reference` / `paidAt` / `recordedBy` are `.nullable()` rather than
 * optional: `markInvoicePaid` writes an explicit `null` when the operator left
 * the field blank, and an absent key would let a client print "null" or, worse,
 * quietly read a missing signature as an empty one.
 */
const InvoicePaymentSchema = z
  .object({
    paymentId: z.string().min(1),
    amountCents: CentsSchema,
    method: z.string().nullable(),
    reference: z.string().nullable(),
    /** ISO-8601 STRING as stored, never a Timestamp. Null when the row carries none. */
    paidAt: z.string().nullable(),
    /** The admin uid that recorded it. Null on a row written before the field existed. */
    recordedBy: z.string().nullable(),
    /**
     * The ROOT `payments` row this settlement came in on, when the apply was
     * done by `recordPayment` (`lib/paymentApply.ts`). Null on a row
     * `markInvoicePaid` wrote and on every row predating the field.
     *
     * One Venmo transfer produces TWO rows: the display record in the root
     * ledger and the settlement here. Without this link they read as two
     * payments, and the tip and fee that only the root row carries cannot be
     * put next to the settlement they belong to.
     */
    sourcePaymentId: z.string().nullable(),
  })
  .strict();

/**
 * One row of the ROOT `payments` collection naming this invoice.
 *
 * A DIFFERENT SHAPE from the subcollection above, and deliberately not
 * flattened into it. This collection is the legacy display ledger: dollars as
 * floats, a free-text `date`, a separate `tip`, and field names that do not
 * match (`paymentMethod` / `referenceNumber`, not `method` / `reference`).
 * Projecting one onto the other would suggest the two lists are the same kind
 * of record, and the whole point of shipping both is that they are not.
 */
const LedgerPaymentSchema = z
  .object({
    paymentId: z.string().min(1),
    /** The whole sum collected from the client, the GROSS tip included. */
    amountCents: CentsSchema,
    /** Gratuity, recorded separately by the legacy shape. Integer cents here. */
    tipCents: CentsSchema,
    /**
     * THE PROCESSOR'S CUT, and the field whose absence made invoice #1029
     * unreadable: Amount $137.50, Applied $127.50, Tip $7.29, and $2.71 that
     * nothing on the record accounted for.
     *
     * Zero on every row written before it existed. Zero is NOT evidence there
     * was no fee, which is what `tipBasis` below exists to say.
     */
    feeCents: CentsSchema,
    /**
     * Which convention `tipCents` follows: `'gross'` (what the client tipped,
     * with `feeCents` recorded beside it) or `'unknown'` (a legacy row whose
     * fee was dropped, so whether its tip is gross or net cannot be known and
     * must not be guessed). See `lib/paymentMoney.ts`.
     */
    tipBasis: z.enum(TIP_BASES),
    /**
     * Can `amount = applied + tipGross + unapplied` be CHECKED on this row?
     * False on a legacy row carrying a tip of unrecorded basis. The panel says
     * so rather than printing figures that do not add up.
     */
    reconciles: z.boolean(),
    /** Sum of this payment's per-invoice applications. Zero on a display-only row. */
    appliedCents: CentsSchema,
    /** Left on account: amount less applied less the gross tip. SIGNED, never clamped. */
    unappliedCents: SignedCentsSchema,
    /** What the operator banks: amount less fee. */
    proceedsCents: CentsSchema,
    /**
     * Whether the leftover was moved into the household's account credit
     * (`families/{id}.accountBalanceCents`) to go against a FUTURE invoice.
     */
    autoApply: z.boolean(),
    /**
     * WHICH INVOICE this payment was applied to. One payment applies to one
     * invoice (operator ruling, 2026-08-04), so this is a field and not an
     * allocation table. `''` on a display-only row that touched no balance.
     *
     * It is the "Applied to #n" column on the operator's Payment History, and
     * usually names the invoice being viewed; it can name a DIFFERENT one when
     * a payment linked here for display was applied elsewhere, and saying so is
     * the point.
     */
    appliedInvoiceId: z.string(),
    /** The human-facing number behind `appliedInvoiceId`. `''` when unknown. */
    appliedInvoiceNumber: z.string(),
    method: z.string(),
    reference: z.string(),
    /** FREE TEXT on this collection, like every legacy billing date. Not parsed. */
    date: z.string(),
    /**
     * STAFF ONLY, and it stays that way. This callable is admin-gated
     * (`resolveInvoiceWriteActor`) and no kinfolk-facing surface reads the root
     * `payments` collection at all: the portal builds invoices from
     * `portal/getMyInvoices.ts` and the PDF from the invoice doc. These are the
     * operator's private notes about a household.
     */
    notes: z.string(),
    recordedBy: z.string().nullable(),
  })
  .strict();

/**
 * One visit this invoice bills.
 *
 * `durationMinutes` is `.nullable()`, never defaulted to 0: a session with no
 * recorded duration is not a zero-minute visit, and on a billing panel that
 * difference is the difference between "not recorded" and "we billed for
 * nothing".
 *
 * `linkedBack` is the session's half of the link. False means the session's own
 * `invoiceId` does not point here, which is the broken-link shape described in
 * the header.
 */
const InvoiceSessionSchema = z
  .object({
    sessionId: z.string().min(1),
    serviceType: z.string(),
    /** Raw stored status. Casing is unenforced on this collection; not normalized here. */
    status: z.string(),
    /** ISO-8601 STRING on `kin_care_sessions`, never a Timestamp. */
    startTime: z.string(),
    completedAt: z.string().nullable(),
    durationMinutes: z.number().nullable(),
    linkedBack: z.boolean(),
  })
  .strict();

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS types below.
 *
 * NO `ok` FIELD, matching `listUninvoicedSessions`, the other pure read on this
 * surface: it answers with data or it throws, and there is no partial success
 * for it to report.
 */
export const Result = z
  .object({
    invoiceId: z.string().min(1),
    /** The subcollection, newest first. THE AUTHORITY: `paidCents` is their sum. */
    payments: z.array(InvoicePaymentSchema),
    /** Sum of `payments` above, the same arithmetic the balance is derived from. */
    paidCents: CentsSchema,
    /** What the invoice is worth, in cents, as the classifier reads it. */
    totalCents: CentsSchema,
    /** What is still owed. Clamped at 0, like every balance on this surface. */
    amountDueCents: CentsSchema,
    /** ROOT `payments` rows naming this invoice. Counted in NOTHING above. */
    ledgerPayments: z.array(LedgerPaymentSchema),
    /** The visits the invoice claims, newest first. */
    sessions: z.array(InvoiceSessionSchema),
    /** Ids on the invoice with no `kin_care_sessions` doc behind them. */
    missingSessionIds: z.array(z.string()),
    /** Sessions pointing AT this invoice that the invoice does not claim back. */
    orphanSessionIds: z.array(z.string()),
    /** True when the invoice names more than `MAX_SESSIONS` visits and the list is a page. */
    truncated: z.boolean(),
  })
  .strict();

export type GetInvoiceLedgerResult = z.infer<typeof Result>;

/** Reads a string field, tolerating the junk a `cast`-not-validated doc can carry. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Reads a string field as nullable: absent, null and non-string all read as null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Dollars-as-float to integer cents, rounded ONCE. Non-numbers read as 0. */
function dollarsToCents(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v * 100)) : 0;
}

/** The stored `tipBasis` key, named once so the reader cannot drift from the writer. */
const TIP_BASIS_KEY = 'tipBasis';

/**
 * An integer-cents field, falling back to its dollar twin.
 *
 * The cents field is the truth wherever it exists, exactly as
 * `paidCentsFromPayments` prefers `amountCents` over `amount` on the
 * subcollection. Every root payment row written before today carries only the
 * float, and rounding it once here is the same treatment those rows already got.
 *
 * FOR `tipCents`/`feeCents`/`appliedCents` ONLY. `stripeWebhook.ts` never
 * wrote a tip, fee or applied amount, on either branch of `amountSource`, so
 * those three fields are dollars-or-absent on every row that reaches this
 * function and carry none of the unit ambiguity `amount` does. `amount`
 * itself is resolved by `resolveLedgerAmountCents` below, NOT by this
 * function — see that function's doc for why.
 */
function centsOr(cents: unknown, dollars: unknown): number {
  if (typeof cents === 'number' && Number.isInteger(cents) && cents >= 0) return cents;
  return dollarsToCents(dollars);
}


export async function getInvoiceLedgerHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const actor = resolveInvoiceWriteActor(req, 'getInvoiceLedger');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getInvoiceLedger validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const invRef = db().collection('invoices').doc(args.invoiceId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) {
    throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  }
  const invoice = (invSnap.data() ?? {}) as Record<string, unknown>;
  if (!testOwnsDoc(actor.testMode, str(invoice['kinfolkId']))) {
    throw new HttpsError('permission-denied', 'This invoice is outside your test sandbox.');
  }

  // THE AUTHORITY. Same read `markInvoicePaid` performs before it decides
  // whether a payment settles anything, so the figures below are the ones the
  // invoice's stored balance was computed from rather than a second opinion.
  const paymentsSnap = await invRef.collection('payments').get();
  const paymentDocs = paymentsSnap.docs.map((d) => ({ id: d.id, data: d.data() as PaymentAmount }));
  const paidCents = paidCentsFromPayments(paymentDocs.map((p) => p.data));
  const totalCents = invoiceTotalCentsOf(invoice);
  const settlement = settleInvoice(totalCents, paidCents);

  const payments = paymentDocs
    .map(({ id, data }) => {
      const raw = data as unknown as Record<string, unknown>;
      return {
        paymentId: id,
        // paidCentsFromPayments' rule, per row, so the list and its sum agree.
        amountCents: paidCentsFromPayments([data]),
        method: strOrNull(raw['method']),
        reference: strOrNull(raw['reference']),
        paidAt: strOrNull(raw['paidAt']),
        recordedBy: strOrNull(raw['recordedBy']),
        sourcePaymentId: strOrNull(raw['sourcePaymentId']),
      };
    })
    // Newest first, by the stored ISO string. A row with no `paidAt` sorts last
    // rather than being dropped: it is still money that came in.
    .sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''));

  // THE DISPLAY LEDGER. `where('invoiceId','==',...)` is safe here in a way it
  // is not in listUninvoicedSessions: there the question was "which sessions
  // name NO invoice", and equality skips docs missing the field. Here the
  // question is "which rows name THIS invoice", and a row missing the field is
  // genuinely not one of them.
  const ledgerSnap = await db()
    .collection('payments')
    .where('invoiceId', '==', args.invoiceId)
    .limit(MAX_LEDGER_ROWS)
    .get();
  // How many rows this invoice's display ledger could not honestly resolve
  // an `amount` for (see `resolveLedgerAmountCents`). Counted across the
  // whole page so ONE warn log reports the invoice, not one log line per row.
  let unresolvedLedgerAmounts = 0;
  const ledgerPayments = ledgerSnap.docs
    .map((d) => {
      const raw = d.data() as Record<string, unknown>;
      // CENTS WIN OVER DOLLARS, same precedence `paidCentsFromPayments` uses
      // on the subcollection — but `amount`'s DOLLARS-VS-CENTS reading also
      // depends on `amountSource` (the 100x defect: a `stripe-event` row's
      // `amount` is already cents, not dollars). `resolveLedgerAmountCents`
      // is the one place that rule lives; the backfill script uses the same
      // function so the two cannot disagree.
      const amountResult = resolveLedgerAmountCents({
        amount: raw['amount'],
        amountCents: raw['amountCents'],
        amountSource: raw['amountSource'],
      });
      if (!amountResult.resolved) unresolvedLedgerAmounts += 1;
      const amountCents = amountResult.amountCents;
      const tipCents = centsOr(raw['tipCents'], raw['tip']);
      const feeCents = centsOr(raw['feeCents'], raw['fee']);
      const tipBasis = readTipBasis(raw[TIP_BASIS_KEY]);
      const appliedCents = centsOr(raw['appliedCents'], raw['applied']);
      const money = paymentMoneyOf({ amountCents, tipCents, feeCents, appliedCents, tipBasis });
      return {
        paymentId: d.id,
        amountCents: money.amountCents,
        tipCents: money.tipCents,
        feeCents: money.feeCents,
        tipBasis,
        reconciles: paymentReconciles({ tipCents, tipBasis }),
        appliedCents: money.appliedCents,
        unappliedCents: money.unappliedCents,
        proceedsCents: money.proceedsCents,
        autoApply: raw['autoApply'] === true,
        appliedInvoiceId: str(raw['appliedInvoiceId']),
        appliedInvoiceNumber: str(raw['appliedInvoiceNumber']),
        method: str(raw['paymentMethod']),
        reference: str(raw['referenceNumber']),
        date: str(raw['date']),
        notes: str(raw['notes']),
        recordedBy: strOrNull(raw['recordedBy']),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // Fail-loud (money code standing rule): a row this reader could not
  // honestly interpret rendered as $0.00 and nothing said why. That is no
  // longer silent — an operator or on-call reading logs for this invoice can
  // find it, even though the response itself has nowhere non-breaking to
  // carry a per-row flag (see the report for why a schema field was ruled out).
  if (unresolvedLedgerAmounts > 0) {
    logEvent({
      severity: 'warn',
      function: 'getInvoiceLedger',
      event: 'ledger.amount.unresolved',
      uid: actor.uid,
      extra: { invoiceId: args.invoiceId, unresolvedLedgerAmounts },
    });
  }

  const storedIds = Array.isArray(invoice['sessionIds'])
    ? (invoice['sessionIds'] as unknown[]).filter((s): s is string => typeof s === 'string' && s !== '')
    : [];
  const claimed = Array.from(new Set(storedIds));
  const truncated = claimed.length > MAX_SESSIONS;
  const page = claimed.slice(0, MAX_SESSIONS);

  const sessionSnaps =
    page.length > 0
      ? await db().getAll(...page.map((id) => db().collection('kin_care_sessions').doc(id)))
      : [];

  const missingSessionIds: string[] = [];
  const sessions = sessionSnaps
    .map((snap, i) => {
      const sid = page[i]!;
      if (!snap.exists) {
        missingSessionIds.push(sid);
        return null;
      }
      const raw = (snap.data() ?? {}) as Record<string, unknown>;
      const duration = raw['serviceDurationMinutes'];
      return {
        sessionId: sid,
        serviceType: str(raw['serviceType']),
        status: str(raw['status']),
        startTime: str(raw['startTime']),
        completedAt: strOrNull(raw['completedAt']),
        durationMinutes:
          typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
        linkedBack: str(raw['invoiceId']) === args.invoiceId,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    // Newest first, by the ISO `startTime`. A session with a blank one sorts
    // last; it is the shape `listUninvoicedSessions` reports as `unplaceable`.
    .sort((a, b) => b.startTime.localeCompare(a.startTime));

  // The reverse direction. A session can name this invoice while the invoice
  // does not name it back, which is real money attributed to a bill that does
  // not show it.
  const claimedSet = new Set(claimed);
  const backlinkSnap = await db()
    .collection('kin_care_sessions')
    .where('invoiceId', '==', args.invoiceId)
    .limit(MAX_SESSIONS)
    .get();
  const orphanSessionIds = backlinkSnap.docs
    .map((d) => d.id)
    .filter((id) => !claimedSet.has(id));

  logEvent({
    severity: 'info',
    function: 'getInvoiceLedger',
    event: 'admin.invoice.ledgerRead',
    uid: actor.uid,
    extra: {
      invoiceId: args.invoiceId,
      paymentCount: payments.length,
      ledgerCount: ledgerPayments.length,
      sessionCount: sessions.length,
      missingCount: missingSessionIds.length,
      orphanCount: orphanSessionIds.length,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('getInvoiceLedger', Result, {
    invoiceId: args.invoiceId,
    payments,
    paidCents,
    totalCents: settlement.totalCents,
    amountDueCents: settlement.amountDueCents,
    ledgerPayments,
    sessions,
    missingSessionIds,
    orphanSessionIds,
    truncated,
  });
}

export const getInvoiceLedger = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped test
  // admin, same as its W2-1 write siblings. resolveInvoiceWriteActor at the top
  // of the handler is the whole gate.
  wrapCallable('getInvoiceLedger', getInvoiceLedgerHandler),
);
