import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  repairPlanFor,
  isRepairPlan,
  type RepairFinding,
  type RepairSkipReason,
  type RepairInvoiceDoc,
} from '../lib/invoicePaymentRepair';
import type { PaymentAmount } from '../lib/invoiceMath';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';

/**
 * The operator's tool for the invoices the pre-2026-07-25 partial-payment write
 * already wrecked. Fixing the callable does NOT fix them: a doc that was written
 * `status: 'paid', amountDue: 0` against a half-collected bill keeps saying so
 * until something rewrites it, and nothing else will.
 *
 * TWO MODES, AND `detect` IS THE DEFAULT ON PURPOSE. `detect` reads and reports
 * and writes nothing at all, so the operator can see exactly which invoices this
 * would touch and what each would become before any money-facing field changes.
 * `repair` must be asked for by name. A tool that mutates a billing collection
 * on its default setting is one misclick from an unreviewed mass write.
 *
 * WHY A CALLABLE RATHER THAN A SCRIPT. It runs under the same admin gate as
 * every other write here (`wrapAdminCallable`), it writes an audit entry, and it
 * needs no service-account key on a laptop. A one-off script would need
 * credentials handed around to do a job the deployed backend can already do
 * safely.
 *
 * PAGING IS EXPLICIT AND CALLER-DRIVEN. One page per invocation, with a cursor
 * returned. Firestore has no way to ask "which invoices disagree with their own
 * payments subcollection", so this reads invoices and their subcollections, and
 * an unbounded self-driving loop over a billing collection is not something that
 * should run inside one request. The operator pages until `nextCursor` is null.
 *
 * THE FIRESTORE TRAPS THIS QUERY AVOIDS, all of which fail SILENTLY:
 *
 *   NO SERVER-SIDE `status` FILTER. `where('status','==','paid')` looks like the
 *   obvious query and is wrong twice over. Status casing is unenforced across
 *   this collection, so a doc stored `Paid` is invisible to it, and Firestore
 *   equality SKIPS documents that lack the field entirely. Both failures return
 *   fewer rows with no error. Corruption is detected by arithmetic instead
 *   (`lib/invoicePaymentRepair.ts`), which cannot miss a row for a spelling.
 *
 *   NO `where('amountDue','==',0)` EITHER, for the same skips-missing-field
 *   reason, and because the corrupt shape is a DISAGREEMENT between two places,
 *   not a value in one of them.
 *
 *   ORDERED BY DOCUMENT ID, not by `date` or `createdAt`. `date` is opaque
 *   free text and `createdAt` is a real Timestamp on some docs and absent on
 *   others; ordering a full-collection sweep by either drops rows. Document id
 *   is present on every document by construction, which is the one thing a
 *   completeness sweep needs.
 */

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  /**
   * `detect` reports without writing (the default). `repair` applies the fixes.
   * Never inferred: the destructive mode is always named by the caller.
   */
  mode: z.enum(['detect', 'repair']).default('detect'),
  /** Invoices to read this page. */
  limit: z.number().int().min(1).max(500).default(200),
  /** Document id to resume after, from the previous page's `nextCursor`. */
  startAfterId: z.string().min(1).max(200).optional(),
});

/**
 * One reported invoice. Mirrors `lib/invoicePaymentRepair.ts#RepairFinding`,
 * which is the producer; `tsc` proves the two agree, because the handler's
 * return type is inferred from this schema and the findings it assembles are
 * `RepairFinding[]`.
 *
 * The sign constraints are the FINDING's guarantees, not the collection's:
 * `repairPlanFor` only emits a finding for a part-paid invoice with a real
 * total, so `correctAmountDueCents` is non-negative and `understatedCents` is
 * strictly positive. `claimedAmountDueCents` is the only signed field: it is
 * whatever the corrupt doc claims, and a negative claim is exactly the kind of
 * doc this pass exists to find.
 */
const RepairFindingSchema = z
  .object({
    invoiceId: z.string().min(1),
    /** Null when the doc carries no readable invoice number. */
    invoiceNumber: z.string().nullable(),
    /** Null on a legacy row with no household stamped on it. */
    kinfolkId: z.string().nullable(),
    totalCents: CentsSchema,
    /** Summed from the `payments` subcollection. */
    paidCents: CentsSchema,
    /** What the doc currently claims is owed. Signed: a corrupt doc may claim anything. */
    claimedAmountDueCents: SignedCentsSchema,
    /** What the recorded payments say is owed. */
    correctAmountDueCents: CentsSchema,
    /** correctAmountDueCents - claimedAmountDueCents. Positive by construction. */
    understatedCents: z.number().int().positive(),
    /** The doc's current status, VERBATIM, not the classified one. */
    status: z.string(),
  })
  .strict();

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS type
 * below.
 *
 * `mode` is echoed because it decides what the rest of the response MEANS: the
 * same `findings` list is a report in `detect` and a record of writes in
 * `repair`, and an operator reading a paginated sweep has to be able to tell
 * which run they are looking at.
 *
 * `skipped` is a zod record over the five reasons, which requires ALL FIVE
 * KEYS. That is deliberate: `emptySkipTally()` seeds every reason at 0 so a
 * detect run that found nothing still says WHY, and a partial tally would let
 * "no invoice hit this reason" and "this reason was dropped from the report"
 * look identical.
 */
export const Result = z
  .object({
    ok: OkSchema,
    mode: z.enum(['detect', 'repair']),
    /** Invoices read this page. */
    scanned: z.number().int().min(0),
    /** Every invoice found in the corrupt state, with the before and after figures. */
    findings: z.array(RepairFindingSchema),
    /** How many were actually written. Always 0 in `detect` mode. */
    repaired: z.number().int().min(0),
    /** Why the untouched invoices were untouched, counted by reason. */
    skipped: z.record(
      z.enum([
        'no_payments',
        'payments_cover_total',
        'no_total',
        'balance_already_correct',
        'would_lower_balance',
      ]),
      z.number().int().min(0),
    ),
    /** Pass back as `startAfterId` for the next page, or null when the sweep is complete. */
    nextCursor: z.string().nullable(),
  })
  .strict();

export type RepairInvoicePaymentsResult = z.infer<typeof Result>;

function emptySkipTally(): Record<RepairSkipReason, number> {
  return {
    no_payments: 0,
    payments_cover_total: 0,
    no_total: 0,
    balance_already_correct: 0,
    would_lower_balance: 0,
  };
}

export async function repairInvoicePaymentsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'repairInvoicePayments validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const firestore = db();
  let query = firestore.collection('invoices').orderBy('__name__').limit(args.limit);
  if (args.startAfterId !== undefined) query = query.startAfter(args.startAfterId);
  const snap = await query.get();

  const findings: RepairFinding[] = [];
  const skipped = emptySkipTally();
  let repaired = 0;
  let lastId: string | null = null;

  for (const doc of snap.docs) {
    lastId = doc.id;
    const data = doc.data() as RepairInvoiceDoc;

    const paymentsSnap = await doc.ref.collection('payments').get();
    const payments = paymentsSnap.docs.map((p) => p.data() as PaymentAmount);

    const outcome = repairPlanFor(doc.id, data, payments);
    if (!isRepairPlan(outcome)) {
      skipped[outcome.skipped] += 1;
      continue;
    }

    findings.push(outcome.finding);

    if (args.mode === 'repair') {
      await doc.ref.set(outcome.update, { merge: true });
      repaired += 1;
      logEvent({
        severity: 'info',
        function: 'repairInvoicePayments',
        event: 'admin.invoice.partial.repaired',
        uid,
        extra: {
          invoiceId: outcome.finding.invoiceId,
          restoredCents: outcome.finding.correctAmountDueCents,
          understatedCents: outcome.finding.understatedCents,
        },
      });
    }
  }

  // A short page means the collection is exhausted. Reporting the cursor as null
  // is what tells the operator to stop, rather than leaving them to guess.
  const nextCursor = snap.docs.length < args.limit ? null : lastId;

  // Audited in BOTH modes. A read-only sweep across every household's billing is
  // itself worth a record of who ran it and what it saw.
  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_UPDATED,
    severity: findings.length > 0 ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'invoices',
    description:
      args.mode === 'repair'
        ? `Partial-payment repair pass restored the balance on ${repaired} invoice(s)`
        : `Partial-payment detection pass found ${findings.length} invoice(s) understating their balance`,
    payload: {
      mode: args.mode,
      scanned: snap.docs.length,
      found: findings.length,
      repaired,
      invoiceIds: findings.map((f) => f.invoiceId),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'repairInvoicePayments',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'repairInvoicePayments',
    event: 'admin.invoice.repair.pass',
    uid,
    extra: { mode: args.mode, scanned: snap.docs.length, found: findings.length, repaired },
  });

  return validateResponse('repairInvoicePayments', Result, {
    ok: true,
    mode: args.mode,
    scanned: snap.docs.length,
    findings,
    repaired,
    skipped,
    nextCursor,
  });
}

export const repairInvoicePayments = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('repairInvoicePayments', repairInvoicePaymentsHandler),
);
