/**
 * backfillCardInvoicePayments.ts
 *
 * #2276. Writes the missing `invoices/{id}/payments` row for card payments the
 * Stripe webhook took before it wrote one, and reports the invoices it will
 * not touch.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * Until #2276 `billing/stripeWebhook.ts` marked the invoice paid and kept the
 * card money in the ROOT `payments` ledger only. The invoice's own `payments`
 * rows are what `markInvoicePaid`, `recordPayment`, `updateInvoice` and the
 * repair pass add up. So an invoice part paid by hand and then paid off by
 * card reads paid while its rows come to less than its total: the card-paid
 * part can be recorded a second time, and the repair pass in repair mode
 * would reopen it. The webhook now writes the row itself
 * (`functions/src/lib/cardPaymentApply.ts`). This script covers the card
 * payments taken before that.
 *
 * ── WHAT IT WRITES, AND ONLY WHEN THE NUMBERS CLOSE ────────────────────────
 *
 * Per invoice, it takes the card payments in the root ledger that the webhook
 * applied to that invoice and that have no row on it yet. It writes only when
 * ALL of these hold:
 *
 *   - the invoice is marked paid and states nothing owed;
 *   - the rows already on the invoice plus those card payments come to
 *     EXACTLY the invoice total.
 *
 * Then, in one transaction per invoice:
 *
 *   - one `invoices/{id}/payments/stripe_<payment intent>` row per card
 *     payment (the id the webhook now uses, so a re-run, or the webhook
 *     hearing of the same charge again, cannot write a second one);
 *   - the invoice's `paidCents`, `totalCents`, `overpaidCents: 0`,
 *     `paymentStatus: 'PAID'` and its state stamp. `status`, `amountDue` and
 *     `amountDueCents` already say paid with nothing owed and are not changed.
 *     The webhook's fallback flag is cleared, since the rows now close;
 *   - on each root ledger row: which invoice it paid (`appliedInvoiceId`,
 *     `appliedInvoiceNumber`, `appliedCents`, `invoicePaymentId`) and
 *     `cardLedgerBackfilledAt`. Its amount, tip and fee are not touched.
 *
 * IT NEVER MOVES A BALANCE. No invoice is reopened, none is marked paid, no
 * account credit is given or spent, and nothing is refunded.
 *
 * ── WHAT IT ONLY REPORTS ───────────────────────────────────────────────────
 *
 *   would_overpay        the rows plus the card payments come to MORE than
 *                        the total. Either the card paid over the balance (the
 *                        extra is a tip) or the card-paid part was since
 *                        recorded again by hand. A person has to say which.
 *   still_short          they come to LESS than the total. Writing the rows
 *                        would turn an invoice that reads paid into one that
 *                        reads part paid.
 *   not_marked_paid      the invoice is open again (it was edited or repaired
 *                        after the card payment, and its balance was worked
 *                        out without the card money), or it states a balance.
 *                        Lowering what a household owes is a decision, not a
 *                        backfill.
 *   no_total             the invoice states no total to measure against.
 *   invoice_missing      the ledger row names an invoice that does not exist.
 *   amount_unresolved    Stripe gave no amount for the payment.
 *
 * Each reported line prints the invoice, its total, what its rows come to and
 * the card payments, so the owner can settle it by hand.
 *
 * ── CARD PAYMENTS THAT WERE CHARGED AND NEVER RECORDED (#2344) ─────────────
 *
 * A second pass, REPORT ONLY in both modes. Until #2344 the webhook skipped a
 * paid event dated before the last event it had applied to the invoice, and a
 * declined charge counted as one. A payment whose first delivery failed, and
 * whose retry arrived after a decline on a newer checkout, was answered 200
 * and written nowhere: no invoice row, no ledger row, no notice. All it left
 * is its `stripeEvents/{id}` record, with `appliedOutcome:
 * SKIPPED_OUT_OF_ORDER` and a paid event type. The first pass starts from the
 * root ledger and so can never see one. This pass reads `stripeEvents` and
 * prints, for each such record: the Stripe event id, its type and time, the
 * household, the invoice, and how the invoice reads now.
 *
 *   skipped_paid_event:invoice_open     the invoice still asks for money the
 *                                       household's card was charged.
 *   skipped_paid_event:invoice_paid     the invoice has been paid some other
 *                                       way since, so this charge is a second
 *                                       payment that is held nowhere.
 *   skipped_paid_event:invoice_missing  the invoice no longer exists.
 *
 * The record holds no amount and no PaymentIntent (the skip stored neither),
 * so nothing can be written from it. One payment delivers two events
 * (`checkout.session.completed` and `payment_intent.succeeded`) with the same
 * time, so two lines for one invoice at one time are one payment.
 *
 * WHAT TO DO WITH A LINE: open the event in the Stripe dashboard by its id and
 * press Resend. The webhook now decides it like a first delivery: applied to
 * what the invoice still owes, or held for the owner when the invoice is paid.
 * Stripe allows a resend only for some weeks after the event was created;
 * past that, record the payment by hand from the charge in the dashboard.
 * An event recovered by a resend no longer carries the skipped outcome and
 * is not listed again.
 *
 * NOT CARD PAYMENTS THIS SCRIPT CONSIDERS: a ledger row held for the owner's
 * decision or already decided (`needsAdminDecision`, `appliedToInvoice:
 * false`, `adminDecision`), which was never applied by the webhook; and a row
 * the invoice already has (`sourcePaymentId`, or the `stripe_` id).
 *
 * ── MODES ────────────────────────────────────────────────────────────────
 *
 *   default        DRY RUN. Prints every planned write and every reported
 *                  invoice. Writes nothing.
 *   --allow-prod   applies the writes.
 *
 * Run the dry run first and read it. This script has NOT been run against
 * production by the PR that ships it.
 *
 * IDEMPOTENT. A written row is found by its id on the next run and skipped.
 */
import { getApps, initializeApp, getFirestore, FieldValue, type Firestore } from './lib/firebaseAdmin';
import { resolveLedgerAmountCents } from '../functions/src/lib/paymentMoney';
import {
  appliedCentsOf,
  centsToDollars,
  invoiceTotalCentsOf,
  paidCentsFromPayments,
  type PaymentAmount,
} from '../functions/src/lib/invoiceMath';
import { amountDueCentsOf } from '../functions/src/lib/amountDueRule';
import { invoiceMarkedPaid } from '../functions/src/lib/invoicePaidGate';
import { invoiceStateStampOf } from '../functions/src/lib/invoiceStateStamp';
import {
  CARD_APPLY_FALLBACK_FIELD,
  CARD_PAYMENT_METHOD,
  CARD_PAYMENT_RECORDED_BY,
  PAID_EVENT_TYPES,
  SKIPPED_OUT_OF_ORDER,
  cardPaymentRowId,
} from '../functions/src/lib/cardPaymentApply';

export const PAYMENTS_COLLECTION = 'payments';
export const STRIPE_EVENTS_COLLECTION = 'stripeEvents';
export const INVOICES_COLLECTION = 'invoices';
export const BACKFILLED_AT_FIELD = 'cardLedgerBackfilledAt';

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  pageSize: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, pageSize: 300 };
  // An explicit --dry-run always wins, in either flag order: remembered past
  // the loop so `--allow-prod --dry-run` cannot flip back to apply.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // A flag is not a project id: `--project --dry-run` must not swallow the
      // safety flag.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--page-size') {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error('--page-size must be 1..1000');
      args.pageSize = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillCardInvoicePayments.ts: write the missing invoice payment row for old card payments (#2276)',
          '',
          'Usage (from mytribe/functions, which owns the node_modules this resolves against):',
          '  npm run backfill:card-invoice-payments                     # DRY RUN (default)',
          '  npm run backfill:card-invoice-payments -- --allow-prod     # apply',
          '  npm run backfill:card-invoice-payments -- --dry-run        # force dry run, ALWAYS wins',
          '  npm run backfill:card-invoice-payments -- --project <id>   # override project',
          '  npm run backfill:card-invoice-payments -- --page-size <n>  # ledger rows read per page (default 300)',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service account JSON path (required unless on the emulator)',
          '  GCLOUD_PROJECT                  Firebase project id',
          '  FIRESTORE_EMULATOR_HOST         when set, credentials are not required',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

export interface StoredRow {
  id: string;
  data: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Whether a root ledger row is a card payment the webhook APPLIED to an
 * invoice. A row held for the owner's decision, or decided since, was never
 * applied by the webhook: `resolveUnappliedPayment` writes its own invoice row
 * when the owner applies one.
 */
export function isAppliedCardLedgerRow(data: Record<string, unknown>): boolean {
  if (data['paymentMethod'] !== 'stripe') return false;
  if (str(data['stripeEventId']) === '') return false;
  if (str(data['invoiceId']) === '') return false;
  if (data['appliedToInvoice'] === false || data['needsAdminDecision'] === true) return false;
  if (data['adminDecision'] != null) return false;
  const appliedTo = str(data['appliedTo']);
  return appliedTo === '';
}

/** The PaymentIntent a ledger row names, or null. The webhook stores it as the reference. */
export function paymentIntentOf(data: Record<string, unknown>): string | null {
  const ref = str(data['referenceNumber']);
  return ref.startsWith('pi_') ? ref : null;
}

/** When the payment was taken, as the ISO text an invoice row carries, or ''. */
function paidAtIsoOf(data: Record<string, unknown>): string {
  const date = data['date'] as { toDate?: () => Date } | string | undefined;
  if (typeof date === 'string') return date;
  if (date && typeof date.toDate === 'function') {
    const d = date.toDate();
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
}

export type ReportReason =
  | 'would_overpay'
  | 'still_short'
  | 'not_marked_paid'
  | 'no_total'
  | 'invoice_missing'
  | 'amount_unresolved';

export interface PlannedRow {
  /** `invoices/{id}/payments/{rowId}`. */
  rowId: string;
  /** The root `payments/{id}` row the money came in on. */
  ledgerId: string;
  amountCents: number;
  row: Record<string, unknown>;
}

export type InvoicePlan =
  | { action: 'write'; invoiceId: string; rows: PlannedRow[]; invoiceUpdate: Record<string, unknown>; invoiceNumber: string }
  | {
      action: 'report';
      invoiceId: string;
      reason: ReportReason;
      totalCents: number;
      rowsCents: number;
      cardCents: number;
      ledgerIds: string[];
    }
  | { action: 'skip'; invoiceId: string; reason: 'already_recorded' };

/**
 * The decision for one invoice. PURE: the invoice, the rows already on it, and
 * the applied card ledger rows that name it. Run again inside the transaction
 * that writes, on that transaction's own reads.
 */
export function planInvoiceBackfill(
  invoiceId: string,
  invoice: Record<string, unknown> | null,
  existingRows: readonly StoredRow[],
  cardLedgerRows: readonly StoredRow[],
): InvoicePlan {
  const haveIds = new Set(existingRows.map((r) => r.id));
  const haveSources = new Set(existingRows.map((r) => str(r.data['sourcePaymentId'])).filter((s) => s !== ''));

  // One row per card payment. Two ledger rows for one PaymentIntent (both of a
  // charge's events, from before the per-payment claim) are one payment.
  const missing: StoredRow[] = [];
  const seenRowIds = new Set<string>();
  for (const ledger of [...cardLedgerRows].sort((a, b) => a.id.localeCompare(b.id))) {
    const rowId = cardPaymentRowId(paymentIntentOf(ledger.data), ledger.id);
    if (haveIds.has(rowId) || haveSources.has(ledger.id) || seenRowIds.has(rowId)) continue;
    seenRowIds.add(rowId);
    missing.push(ledger);
  }
  if (missing.length === 0) return { action: 'skip', invoiceId, reason: 'already_recorded' };

  const rowsCents = paidCentsFromPayments(existingRows.map((r) => r.data as PaymentAmount));
  const ledgerIds = missing.map((m) => m.id);
  const amounts = missing.map((m) => resolveLedgerAmountCents(m.data));
  const cardCents = amounts.reduce((sum, a) => sum + (a.resolved ? a.amountCents : 0), 0);
  const totalCents = invoice ? invoiceTotalCentsOf(invoice) : 0;
  const report = (reason: ReportReason): InvoicePlan => ({
    action: 'report',
    invoiceId,
    reason,
    totalCents,
    rowsCents,
    cardCents,
    ledgerIds,
  });

  if (invoice === null) return report('invoice_missing');
  if (amounts.some((a) => !a.resolved || a.amountCents <= 0) || missing.some((m) => m.data['amountResolved'] === false)) {
    return report('amount_unresolved');
  }
  if (totalCents <= 0) return report('no_total');
  if (!invoiceMarkedPaid(invoice) || amountDueCentsOf(invoice, rowsCents) > 0) return report('not_marked_paid');
  // #2470: what was paid before the invoice was brought over counts with the
  // rows. It is never a row, so the rows this writes stop short of the total by it.
  const appliedCents = appliedCentsOf(invoice, rowsCents);
  if (appliedCents + cardCents > totalCents) return report('would_overpay');
  if (appliedCents + cardCents < totalCents) return report('still_short');

  const rows: PlannedRow[] = missing.map((ledger, i) => {
    const amountCents = amounts[i]!.amountCents;
    const intent = paymentIntentOf(ledger.data);
    return {
      rowId: cardPaymentRowId(intent, ledger.id),
      ledgerId: ledger.id,
      amountCents,
      row: {
        amount: centsToDollars(amountCents),
        amountCents,
        method: CARD_PAYMENT_METHOD,
        reference: str(ledger.data['referenceNumber']) || null,
        paidAt: paidAtIsoOf(ledger.data),
        recordedBy: CARD_PAYMENT_RECORDED_BY,
        sourcePaymentId: ledger.id,
        stripeEventId: str(ledger.data['stripeEventId']),
        ...(intent ? { stripePaymentIntentId: intent } : {}),
        backfilledBy: 'backfillCardInvoicePayments',
      },
    };
  });

  // #2470: `paidCents` is the rows' sum, the brought-over amount excluded.
  const rowsAfterCents = rowsCents + cardCents;
  const money = {
    paymentStatus: 'PAID',
    totalCents,
    paidCents: rowsAfterCents,
    overpaidCents: 0,
  };
  return {
    action: 'write',
    invoiceId,
    invoiceNumber: str(invoice['invoiceNumber']),
    rows,
    invoiceUpdate: {
      ...money,
      // The state stamp, from the doc as this write leaves it: an invoice
      // whose rows now cover it is paid and frozen like any other.
      ...invoiceStateStampOf({ ...invoice, ...money }, rowsAfterCents),
    },
  };
}

/** How the invoice a skipped paid event names reads now. */
export type SkippedPaidInvoiceState = 'invoice_open' | 'invoice_paid' | 'invoice_missing';

/** One `stripeEvents` record of a paid event the webhook skipped before #2344. */
export interface SkippedPaidEvent {
  eventId: string;
  type: string;
  /** When Stripe created the event, ISO, or '' when the record holds no time. */
  createdIso: string;
  invoiceId: string;
  familyId: string;
  invoiceState: SkippedPaidInvoiceState;
  /** What the invoice states it is owed now, in cents. 0 when it is missing. */
  amountDueCents: number;
  /** What the invoice's payment rows come to now, in cents. */
  rowsCents: number;
}

/**
 * Whether a `stripeEvents` record is a card payment the webhook skipped for its
 * date (#2344). The dispute handler writes the same outcome for its own events,
 * which are not payments, and a skipped declined charge moved no money.
 */
export function isSkippedPaidEvent(data: Record<string, unknown>): boolean {
  return (
    data['appliedOutcome'] === SKIPPED_OUT_OF_ORDER &&
    PAID_EVENT_TYPES.includes(str(data['type'])) &&
    str(data['invoiceId']) !== ''
  );
}

/** PURE: how the invoice reads now, from the invoice and the rows on it. */
export function skippedPaidInvoiceState(
  invoice: Record<string, unknown> | null,
  existingRows: readonly StoredRow[],
): { invoiceState: SkippedPaidInvoiceState; amountDueCents: number; rowsCents: number } {
  const rowsCents = paidCentsFromPayments(existingRows.map((r) => r.data as PaymentAmount));
  if (invoice === null) return { invoiceState: 'invoice_missing', amountDueCents: 0, rowsCents };
  const amountDueCents = Math.max(0, amountDueCentsOf(invoice, rowsCents));
  const paid = invoiceMarkedPaid(invoice) || amountDueCents <= 0;
  return { invoiceState: paid ? 'invoice_paid' : 'invoice_open', amountDueCents, rowsCents };
}

/**
 * The #2344 pass. READS ONLY, in every mode: `stripeEvents` paged by document
 * id, then each named invoice and its rows. It takes no transaction and makes
 * no write.
 */
export async function findSkippedPaidEvents(
  store: Firestore,
  pageSize: number,
): Promise<{ scanned: number; events: SkippedPaidEvent[] }> {
  const found: Array<{ id: string; data: Record<string, unknown> }> = [];
  let scanned = 0;
  let cursor: string | null = null;
  for (;;) {
    let query = store.collection(STRIPE_EVENTS_COLLECTION).orderBy('__name__').limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;
    for (const snap of page.docs) {
      scanned += 1;
      cursor = snap.id;
      const data = snap.data() as Record<string, unknown>;
      if (isSkippedPaidEvent(data)) found.push({ id: snap.id, data });
    }
    if (page.docs.length < pageSize) break;
  }

  const states = new Map<string, ReturnType<typeof skippedPaidInvoiceState>>();
  const events: SkippedPaidEvent[] = [];
  for (const { id, data } of found) {
    const invoiceId = str(data['invoiceId']);
    let state = states.get(invoiceId);
    if (!state) {
      const invRef = store.collection(INVOICES_COLLECTION).doc(invoiceId);
      const invSnap = await invRef.get();
      const rowsSnap = await invRef.collection('payments').get();
      state = skippedPaidInvoiceState(
        invSnap.exists ? ((invSnap.data() ?? {}) as Record<string, unknown>) : null,
        rowsSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
      );
      states.set(invoiceId, state);
    }
    const createdMs = data['eventCreatedMs'];
    events.push({
      eventId: id,
      type: str(data['type']),
      createdIso:
        typeof createdMs === 'number' && Number.isFinite(createdMs) && createdMs > 0
          ? new Date(createdMs).toISOString()
          : '',
      invoiceId,
      familyId: str(data['familyId']),
      ...state,
    });
  }
  events.sort(
    (a, b) =>
      a.invoiceId.localeCompare(b.invoiceId) ||
      a.createdIso.localeCompare(b.createdIso) ||
      a.eventId.localeCompare(b.eventId),
  );
  return { scanned, events };
}

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' && process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillCardInvoicePayments: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (getApps().length === 0) initializeApp({ projectId });
}

export interface RunResult {
  /** Root ledger rows read. */
  scanned: number;
  /** Of those, card payments the webhook applied to an invoice. */
  cardPayments: number;
  invoices: number;
  /** Invoices written (apply) or that would be (dry run). */
  invoicesWritten: number;
  rowsWritten: number;
  alreadyRecorded: number;
  reported: Record<ReportReason, number>;
  reports: Array<Extract<InvoicePlan, { action: 'report' }>>;
  /** #2344: `stripeEvents` records read by the second pass. */
  eventsScanned: number;
  /** #2344: paid events the webhook skipped for their date. Reported, never written. */
  skippedPaidEvents: SkippedPaidEvent[];
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function run(mode: Mode, pageSize: number, db?: Firestore): Promise<RunResult> {
  const store: Firestore = db ?? getFirestore();
  const result: RunResult = {
    scanned: 0,
    cardPayments: 0,
    invoices: 0,
    invoicesWritten: 0,
    rowsWritten: 0,
    alreadyRecorded: 0,
    reported: {
      would_overpay: 0,
      still_short: 0,
      not_marked_paid: 0,
      no_total: 0,
      invoice_missing: 0,
      amount_unresolved: 0,
    },
    reports: [],
    eventsScanned: 0,
    skippedPaidEvents: [],
  };

  // Every root ledger row, paged by document id (present on every doc; `date`
  // is free text on migrated rows). Card payments are grouped by invoice.
  const byInvoice = new Map<string, string[]>();
  let cursor: string | null = null;
  for (;;) {
    let query = store.collection(PAYMENTS_COLLECTION).orderBy('__name__').limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;
    for (const snap of page.docs) {
      result.scanned += 1;
      cursor = snap.id;
      const data = snap.data() as Record<string, unknown>;
      if (!isAppliedCardLedgerRow(data)) continue;
      result.cardPayments += 1;
      const invoiceId = str(data['invoiceId']);
      byInvoice.set(invoiceId, [...(byInvoice.get(invoiceId) ?? []), snap.id]);
    }
    if (page.docs.length < pageSize) break;
  }

  for (const [invoiceId, ledgerIds] of [...byInvoice.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    result.invoices += 1;
    const invRef = store.collection(INVOICES_COLLECTION).doc(invoiceId);
    const ledgerRefs = ledgerIds.map((id) => store.collection(PAYMENTS_COLLECTION).doc(id));

    // One transaction per invoice: the invoice, its rows and the ledger rows
    // are read here and the plan is made from those reads, so a payment that
    // lands meanwhile makes this attempt re-run. A dry run reads the same way
    // and stages nothing.
    const plan = await store.runTransaction(async (tx): Promise<InvoicePlan> => {
      const invSnap = await tx.get(invRef);
      const rowsSnap = await tx.get(invRef.collection('payments'));
      const ledgerSnaps = [];
      for (const ref of ledgerRefs) ledgerSnaps.push(await tx.get(ref));
      const planned = planInvoiceBackfill(
        invoiceId,
        invSnap.exists ? ((invSnap.data() ?? {}) as Record<string, unknown>) : null,
        rowsSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
        ledgerSnaps
          .filter((s) => s.exists)
          .map((s) => ({ id: s.id, data: (s.data() ?? {}) as Record<string, unknown> }))
          .filter((r) => isAppliedCardLedgerRow(r.data)),
      );
      if (planned.action !== 'write' || mode !== 'apply') return planned;
      for (const row of planned.rows) {
        tx.create(invRef.collection('payments').doc(row.rowId), {
          ...row.row,
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.set(
          store.collection(PAYMENTS_COLLECTION).doc(row.ledgerId),
          {
            appliedInvoiceId: invoiceId,
            appliedInvoiceNumber: planned.invoiceNumber,
            appliedCents: row.amountCents,
            invoicePaymentId: row.rowId,
            [BACKFILLED_AT_FIELD]: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      tx.set(
        invRef,
        {
          ...planned.invoiceUpdate,
          [CARD_APPLY_FALLBACK_FIELD]: FieldValue.delete(),
          [BACKFILLED_AT_FIELD]: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return planned;
    });

    if (plan.action === 'skip') {
      result.alreadyRecorded += 1;
      continue;
    }
    if (plan.action === 'report') {
      result.reported[plan.reason] += 1;
      result.reports.push(plan);
      console.log(
        `[report:${plan.reason}] invoices/${invoiceId} total=${usd(plan.totalCents)} rows=${usd(plan.rowsCents)} ` +
          `card=${usd(plan.cardCents)} ledger=${plan.ledgerIds.map((id) => `payments/${id}`).join(',')} (not written)`,
      );
      continue;
    }
    result.invoicesWritten += 1;
    result.rowsWritten += plan.rows.length;
    for (const row of plan.rows) {
      console.log(
        `[${mode === 'apply' ? 'write' : 'plan'}] invoices/${invoiceId}/payments/${row.rowId} ${usd(row.amountCents)} ` +
          `from payments/${row.ledgerId}`,
      );
    }
  }

  // #2344: card payments that were charged and never recorded. Read only, in
  // both modes; the header says what a line means and what to do with it.
  const skipped = await findSkippedPaidEvents(store, pageSize);
  result.eventsScanned = skipped.scanned;
  result.skippedPaidEvents = skipped.events;
  for (const e of skipped.events) {
    console.log(
      `[report:skipped_paid_event:${e.invoiceState}] stripeEvents/${e.eventId} type=${e.type} ` +
        `created=${e.createdIso || 'unknown'} invoices/${e.invoiceId} household=${e.familyId || 'unknown'} ` +
        `owed_now=${usd(e.amountDueCents)} rows=${usd(e.rowsCents)} (charged, not recorded; not written)`,
    );
  }

  return result;
}

function summarise(mode: Mode, r: RunResult): void {
  console.log('\n=== backfillCardInvoicePayments ===');
  console.log(`  mode                 : ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  ledger rows scanned  : ${r.scanned}`);
  console.log(`  applied card payments: ${r.cardPayments}`);
  console.log(`  invoices             : ${r.invoices}`);
  console.log(`  ${mode === 'apply' ? 'invoices written     ' : 'invoices planned     '}: ${r.invoicesWritten}`);
  console.log(`  ${mode === 'apply' ? 'rows written         ' : 'rows planned         '}: ${r.rowsWritten}`);
  console.log(`  already recorded     : ${r.alreadyRecorded}`);
  console.log('  reported, not written:');
  for (const [reason, n] of Object.entries(r.reported)) console.log(`      ${reason.padEnd(18)}: ${n}`);
  console.log(`  payment events scanned: ${r.eventsScanned}`);
  console.log(`  charged, not recorded : ${r.skippedPaidEvents.length} event(s) (#2344; this script never writes them)`);
  const invoices = [...new Set(r.skippedPaidEvents.map((e) => e.invoiceId))].sort();
  if (invoices.length > 0) {
    console.log(`      invoices          : ${invoices.join(', ')}`);
    console.log('      Open each event in the Stripe dashboard and press Resend; the webhook now records it.');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' && process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  console.log(`Mode: ${args.mode}    allowProd=${args.allowProd}    emulator=${usingEmulator}`);

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);

  const result = await run(args.mode, args.pageSize);
  summarise(args.mode, result);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_CARD_INVOICE_PAYMENTS',
      description:
        `invoices=${result.invoicesWritten} rows=${result.rowsWritten} already_recorded=${result.alreadyRecorded} ` +
        `reported=${result.reports.length}`,
      status: 'SUCCESS',
      actorId: 'system:backfillCardInvoicePayments',
      targetId: '',
      targetCollection: INVOICES_COLLECTION,
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: {
        invoicesWritten: result.invoicesWritten,
        rowsWritten: result.rowsWritten,
        alreadyRecorded: result.alreadyRecorded,
        reported: result.reported,
      },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (UNCHAINED: runs outside writeAuditEntry).');
  } else {
    console.log('\nDRY RUN. No writes. Re-run with --allow-prod to commit.');
  }
}

// Only auto-run when invoked directly, not when imported by tests.
const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
