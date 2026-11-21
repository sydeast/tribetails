/**
 * backfillBroughtOverPaid.ts
 *
 * #2470: STAMPS `broughtOverPaidCents` ON INVOICES ALREADY LOADED FROM THE OLD
 * SYSTEM, the field the importer now writes on every invoice it brings over.
 *
 * The old system's invoices arrive with their total and their stated balance
 * (`amountDue`), and their earlier payments are not rows in
 * `invoices/{id}/payments`: the importer puts them in the root `payments`
 * collection with no invoice reference. So every payment path read such an
 * invoice as unpaid, and $10 recorded on a $40 invoice stating $25 left $30
 * owed. The app now counts `broughtOverPaidCents` as applied everywhere
 * (`functions/src/lib/invoiceMath.ts#appliedCentsOf`), and this script gives
 * the field to invoices loaded before the importer wrote it.
 *
 * THE ONLY SOURCE IS TOTAL MINUS STATED BALANCE, AND ONLY WHILE NOTHING HAS
 * MOVED. Once any payment row exists, a payment path has rewritten the stated
 * balance as total minus the rows, so the difference is then the rows and not
 * what the old system collected. So an invoice is stamped only when:
 *
 *   - it was brought over (it carries the old system's `paymentsHistory`
 *     field, which nothing in this codebase writes),
 *   - it has no payment rows,
 *   - it has no `broughtOverPaidCents` yet,
 *   - it states a balance, and 0 <= stated < total.
 *
 * Everything else is left exactly as it is. The shapes a person should look
 * at (rows already present, a balance above the total, a credit, no total) are
 * listed by id with their figures.
 *
 * WHAT IT WRITES: `broughtOverPaidCents` and nothing else. Not `paidCents`
 * (every payment path rewrites that from the rows, and the field must survive
 * the first payment), not the stated balance, not the state stamp (the stated
 * balance already says what is owed, so the stamp does not change), and not
 * `updatedAt`: recording a fact about the import is not an edit of the bill.
 *
 * IDEMPOTENT. A stamped invoice is `already_stamped` on the next run.
 *
 * IT DOES NOT RUN ITSELF. Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Runbook: run the dry run, read the plan and the listed invoices, then the
 * lead or operator re-runs with --allow-prod. The PR that ships this script
 * ran neither side against any project.
 */
import { getApps, initializeApp, getFirestore, FieldValue, type Firestore } from './lib/firebaseAdmin';
import { BROUGHT_OVER_PAID_FIELD, broughtOverPaidCentsOf, invoiceTotalCentsOf } from '../functions/src/lib/invoiceMath';
import { statedAmountDueCents } from '../functions/src/lib/amountDueRule';

export const INVOICES_COLLECTION = 'invoices';

/** The old system's free-text payment record. Its presence marks an invoice brought over. */
export const IMPORT_MARKER_FIELD = 'paymentsHistory';

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  pageSize: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, pageSize: 300 };
  // An explicit --dry-run wins in either flag order, as in backfillInvoiceDateIso.ts.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
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
          'backfillBroughtOverPaid.ts: stamp broughtOverPaidCents on invoices brought over from the old system',
          '',
          'Usage (from mytribe/functions):',
          '  npm run backfill:brought-over-paid                     # DRY RUN (default)',
          '  npm run backfill:brought-over-paid -- --allow-prod     # apply',
          '  npm run backfill:brought-over-paid -- --dry-run        # force dry-run, ALWAYS wins',
          '  npm run backfill:brought-over-paid -- --project <id>   # override project',
          '  npm run backfill:brought-over-paid -- --page-size <n>  # invoices read per page (default 300)',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service account JSON path (or ADC)',
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

/** What one invoice is. Only `stamp` is ever written. */
export type Verdict =
  /** Brought over, no rows, 0 <= stated < total. Stamped with total minus stated. */
  | 'stamp'
  /** Already carries the field. The idempotency branch. */
  | 'already_stamped'
  /** Not brought over from the old system. Left alone. */
  | 'not_brought_over'
  /** States no balance. The importer never stamps these either. */
  | 'no_stated_balance'
  /** Stated balance equals the total: nothing was paid before the move. */
  | 'nothing_paid'
  /** Has payment rows, so total minus stated is no longer what was paid. LISTED. */
  | 'has_payment_rows'
  /** States more than its total. LISTED. */
  | 'stated_above_total'
  /** States a negative balance (a credit). LISTED. */
  | 'credit'
  /** No positive total to measure against. LISTED. */
  | 'no_total';

export const LISTED_VERDICTS: readonly Verdict[] = ['has_payment_rows', 'stated_above_total', 'credit', 'no_total'];

export interface InvoicePlan {
  verdict: Verdict;
  totalCents: number;
  statedCents: number | null;
  /** The figure to write. Set only when `verdict === 'stamp'`. */
  broughtOverPaidCents: number | null;
}

/** The decision for ONE invoice. PURE: no Firestore access. */
export function planInvoice(data: Record<string, unknown>, paymentRowCount: number): InvoicePlan {
  const totalCents = invoiceTotalCentsOf(data);
  const statedCents = statedAmountDueCents(data);
  const plan = (verdict: Verdict, cents: number | null = null): InvoicePlan => ({
    verdict,
    totalCents,
    statedCents,
    broughtOverPaidCents: cents,
  });
  if (broughtOverPaidCentsOf(data) > 0) return plan('already_stamped');
  if (!(IMPORT_MARKER_FIELD in data)) return plan('not_brought_over');
  if (statedCents === null) return plan('no_stated_balance');
  if (totalCents <= 0) return plan('no_total');
  if (statedCents < 0) return plan('credit');
  if (statedCents > totalCents) return plan('stated_above_total');
  if (statedCents === totalCents) return plan('nothing_paid');
  if (paymentRowCount > 0) return plan('has_payment_rows');
  return plan('stamp', totalCents - statedCents);
}

export interface Listed {
  invoiceId: string;
  verdict: Verdict;
  totalCents: number;
  statedCents: number | null;
  paymentRowCount: number;
}

export interface RunResult {
  scanned: number;
  stamped: number;
  byVerdict: Record<Verdict, number>;
  listed: Listed[];
}

const WRITES_PER_BATCH = 400;

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' && process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillBroughtOverPaid: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (getApps().length === 0) initializeApp({ projectId });
}

export function emptyResult(): RunResult {
  return {
    scanned: 0,
    stamped: 0,
    byVerdict: {
      stamp: 0,
      already_stamped: 0,
      not_brought_over: 0,
      no_stated_balance: 0,
      nothing_paid: 0,
      has_payment_rows: 0,
      stated_above_total: 0,
      credit: 0,
      no_total: 0,
    },
    listed: [],
  };
}

export async function run(mode: Mode, pageSize: number, db?: Firestore): Promise<RunResult> {
  const store: Firestore = db ?? getFirestore();
  const result = emptyResult();

  let batch = store.batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    if (mode === 'apply') await batch.commit();
    batch = store.batch();
    batchSize = 0;
  };

  // Paged by document id, present on every doc.
  let cursor: string | null = null;
  for (;;) {
    let query = store.collection(INVOICES_COLLECTION).orderBy('__name__').limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;

    for (const docSnap of page.docs) {
      result.scanned += 1;
      cursor = docSnap.id;
      const data = docSnap.data() as Record<string, unknown>;
      // Rows are read only for an invoice brought over, the only kind that can be stamped.
      const rowCount =
        IMPORT_MARKER_FIELD in data && broughtOverPaidCentsOf(data) === 0
          ? (await docSnap.ref.collection('payments').limit(1).get()).size
          : 0;
      const plan = planInvoice(data, rowCount);
      result.byVerdict[plan.verdict] += 1;
      if (LISTED_VERDICTS.includes(plan.verdict)) {
        result.listed.push({
          invoiceId: docSnap.id,
          verdict: plan.verdict,
          totalCents: plan.totalCents,
          statedCents: plan.statedCents,
          paymentRowCount: rowCount,
        });
      }
      if (plan.verdict !== 'stamp' || plan.broughtOverPaidCents === null) continue;

      result.stamped += 1;
      console.log(
        `[stamp] ${INVOICES_COLLECTION}/${docSnap.id} ${BROUGHT_OVER_PAID_FIELD}: ${plan.broughtOverPaidCents} ` +
          `(total ${plan.totalCents}, stated ${plan.statedCents})`,
      );
      batch.set(docSnap.ref, { [BROUGHT_OVER_PAID_FIELD]: plan.broughtOverPaidCents }, { merge: true });
      batchSize += 1;
      if (batchSize >= WRITES_PER_BATCH) await flush();
    }

    if (page.docs.length < pageSize) break;
  }
  await flush();
  return result;
}

function summarise(mode: Mode, r: RunResult): void {
  console.log('\n=== backfillBroughtOverPaid ===');
  console.log(`  mode      : ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  scanned   : ${r.scanned} invoice(s)`);
  console.log(`  ${mode === 'apply' ? 'stamped' : 'planned'}   : ${r.stamped} invoice(s)`);
  for (const [verdict, n] of Object.entries(r.byVerdict)) {
    console.log(`      ${verdict.padEnd(20)} : ${n}`);
  }
  if (r.listed.length > 0) {
    console.log('\n  LEFT AS THEY ARE, for a person to look at:');
    console.log('    has_payment_rows   : a payment was recorded after the move, so total minus');
    console.log('                         stated is no longer what the old system collected.');
    console.log('    stated_above_total : asks for more than its total.');
    console.log('    credit             : states a negative balance.');
    console.log('    no_total           : no total to measure against.');
    for (const l of r.listed) {
      console.log(
        `      ${INVOICES_COLLECTION}/${l.invoiceId}  ${l.verdict}  total=${l.totalCents}  stated=${l.statedCents}  rows=${l.paymentRowCount}`,
      );
    }
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
    await getFirestore().collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_BROUGHT_OVER_PAID',
      description: `stamped=${result.stamped} scanned=${result.scanned} listed=${result.listed.length}`,
      status: 'SUCCESS',
      actorId: 'system:backfillBroughtOverPaid',
      targetId: '',
      targetCollection: INVOICES_COLLECTION,
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { result },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (UNCHAINED: runs outside writeAuditEntry).');
  } else {
    console.log('\nDRY-RUN. No writes. Re-run with --allow-prod to commit.');
  }
}

const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
