/**
 * backfillInvoiceAmountDue.ts
 *
 * One-shot backfill of `amountDue` onto the migrated invoices that never had one
 * (#902): documents carrying a positive `total` and no balance field at all.
 *
 * WHY WRITE IT DOWN AT ALL, WHEN THE RULE DERIVES IT. #902 makes every reader
 * ask one rule (`functions/src/lib/amountDueRule.ts`), so these documents are
 * read correctly from the day it deploys, backfill or not. The backfill is what
 * makes them ordinary: a stored balance is what the admin ledger sums, what a
 * Firestore query can filter on, and what the next person reading the collection
 * sees without knowing the rule exists. A derivation that has to be remembered is
 * the condition this issue is about.
 *
 * ── WHAT IT WRITES, AND NOTHING ELSE ──────────────────────────────────────
 *
 *   amountDue       the rule's answer, in dollars (the collection's legacy field)
 *   amountDueCents  the same figure as the integer truth
 *   status          the state stamp, ADR-0002
 *   editScope       the state stamp, ADR-0002
 *
 * The stamp goes in the SAME write, because that is ADR-0002's whole contract: a
 * stamp written second opens a window in which the money has moved and the stored
 * state still describes the old money, and a crash inside it persists the lie.
 *
 * THE ORIGINAL TIMESTAMPS SURVIVE. There is no `updatedAt`, no `createdAt`, no
 * `date` and no server timestamp anywhere in the write set, and the unit test
 * asserts the exact key set. These are MIGRATED records: they carry the dates of
 * the system this one replaced, and those dates are real information about when
 * the work was done and the bill was sent. Stamping today's date on them to
 * record that a derived field was materialized would destroy history to note a
 * housekeeping write. Nothing sorts, ages, chases or reports on a field this
 * script touches, so nothing needs to know it ran; the `activity_log` entry is
 * the record that it did.
 *
 * ── WHAT IT REFUSES ───────────────────────────────────────────────────────
 *
 *   states_balance        the document already states a balance, in either field.
 *                         Out of scope by definition: the rule never overrides
 *                         one, and `amountDue: 0` on a part-collected bill is the
 *                         pre-2026-07-25 corruption that `repairInvoicePayments`
 *                         owns.
 *   no_total              it states no money at all. There is nothing to derive
 *                         from, and writing `amountDue: 0` would assert that a
 *                         document nobody has priced is settled.
 *   would_notify_household  the write would move the classifier in a way
 *                         `onInvoicesWrite` announces as `invoice.payment.applied`.
 *                         It asks the trigger's own decision, `invoiceWriteNoticeKey`,
 *                         rather than a copy of it. This is a real refusal here,
 *                         not the dormant one the state-stamp backfill carries: a
 *                         legacy bill whose payment rows cover its total settles
 *                         to a zero balance, which is an open-to-paid transition,
 *                         and a backfill must never text a household about a
 *                         payment that happened months ago. Listed for the operator.
 *   would_draw_credit     the write would turn a document the auto-apply trigger
 *                         ignores into one it collects on, and a backfill must
 *                         not be the event that spends a household's account
 *                         credit. Unreachable by construction (a document in
 *                         scope is already collectable, or already refused by its
 *                         status), and checked anyway.
 *
 * ── NO REFUNDS, AND NO MINTED CREDITS ─────────────────────────────────────
 *
 * A legacy bill whose payment rows exceed its total derives a balance of ZERO,
 * never a negative one. A negative `amountDue` is this codebase's credit signal,
 * and a backfill that created credits out of arithmetic would be issuing a
 * financial instrument nobody approved. Per the standing operator ruling there
 * are no refunds: that overdraw belongs on the household's account balance, moved
 * there deliberately. `reportLegacyAmountDue.ts` counts those documents, and this
 * script's notification guard refuses them anyway, so they reach the operator
 * twice and are changed by neither.
 *
 * Modes:
 *   default        — DRY RUN. Prints every planned write and the summary counts.
 *   --allow-prod   — applies, batched under Firestore's 500-op batch limit.
 *
 * Safety:
 *   - Dry-run by default; an explicit `--dry-run` beats `--allow-prod` in either
 *     flag order. FIRESTORE_EMULATOR_HOST does not relieve that.
 *   - Real writes require GOOGLE_APPLICATION_CREDENTIALS (fail-loud).
 *   - IDEMPOTENT by construction: the first run gives every document in scope a
 *     stated balance, and a document that states one is out of scope. The second
 *     run plans nothing.
 *
 * Runbook: run `reportLegacyAmountDue` first to see the population, then this DRY,
 * read the plan, then re-run with --allow-prod. It has NOT been run against
 * production as part of the PR that ships it; it is a runbook step.
 */
// The single firebase-admin import point (#846), as in every other backfill here.
import { getApps, initializeApp, getFirestore, FieldValue, type Firestore } from './lib/firebaseAdmin';
import {
  amountDueCentsOf,
  legacyOverpaidCentsOf,
  statesNoBalance,
  type AmountDueDoc,
} from '../functions/src/lib/amountDueRule';
import { invoiceTotalCentsOf, paidCentsFromPayments, centsToDollars, type PaymentAmount } from '../functions/src/lib/invoiceMath';
import { invoiceStateStampOf, type InvoiceStateStamp } from '../functions/src/lib/invoiceStateStamp';
import { invoiceWriteNoticeKey } from '../functions/src/triggers/onInvoicesWrite';
import { collectableForAutoApply } from '../functions/src/lib/invoiceCollectable';

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  /** Invoices read per page. Also bounds memory; writes batch at 400. */
  pageSize: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, pageSize: 300 };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order, and is tracked
  // separately from `args.mode` because the `if (args.allowProd)` below runs once
  // after the whole argv is scanned. Same reasoning, at length, in
  // backfillInvoiceStateStamp.ts.
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
          'backfillInvoiceAmountDue.ts — write amountDue on migrated invoices that never had one (#902)',
          '',
          'Usage (from mytribe/functions, which owns the node_modules this resolves against):',
          '  npm run backfill:invoice-amount-due                     # DRY RUN (default)',
          '  npm run backfill:invoice-amount-due -- --allow-prod     # apply',
          '  npm run backfill:invoice-amount-due -- --dry-run        # force dry-run, ALWAYS wins',
          '  npm run backfill:invoice-amount-due -- --project <id>   # override project',
          '  npm run backfill:invoice-amount-due -- --page-size <n>  # invoices read per page (default 300)',
          '',
          'Run `npm run report:legacy-amount-due` first to see the population.',
          'It writes amountDue, amountDueCents and the ADR-0002 state stamp, and NOTHING else:',
          'no updatedAt and no server timestamp, so migrated records keep their original dates.',
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

/** Why a scanned invoice is not being written. Reported, never silent. */
export type SkipReason = 'states_balance' | 'no_total' | 'would_notify_household' | 'would_draw_credit';

/** The EXACT field set merged onto the document. Nothing else changes. See the header. */
export interface AmountDueUpdate extends InvoiceStateStamp {
  amountDue: number;
  amountDueCents: number;
}

export type BackfillDecision =
  | { action: 'write'; update: AmountDueUpdate; overpaidCents: number }
  | { action: 'skip'; reason: SkipReason };

/**
 * The decision for one invoice. PURE: no Firestore access, so the whole rule and
 * both guards are unit-testable against fixtures.
 *
 * `payments` is the invoice's own subcollection, the only field that can say how
 * much has been collected. A caller with none passes an empty list, which the
 * rule reads exactly as it reads "no rows".
 */
export function planAmountDue(doc: Record<string, unknown>, payments: readonly PaymentAmount[]): BackfillDecision {
  if (!statesNoBalance(doc as AmountDueDoc)) return { action: 'skip', reason: 'states_balance' };
  if (invoiceTotalCentsOf(doc as AmountDueDoc) <= 0) return { action: 'skip', reason: 'no_total' };

  const paidCents = paidCentsFromPayments(payments);
  const amountDueCents = amountDueCentsOf(doc as AmountDueDoc, paidCents);
  const amountDue = centsToDollars(amountDueCents);
  // The post-write document, which is what the stamp must describe (ADR-0002)
  // and what both guards must be asked about.
  const withBalance = { ...doc, amountDue, amountDueCents };
  const stamp = invoiceStateStampOf(withBalance, paidCents);
  const after = { ...withBalance, ...stamp };

  // THE NOTIFICATION GUARD: it asks the trigger's own decision rather than a
  // copy of it, so it follows whatever the trigger does. Unlike the state-stamp
  // backfill's, this one really fires: writing a zero balance on a legacy bill
  // its rows already covered IS an open-to-paid transition.
  if (invoiceWriteNoticeKey(doc, after) !== null) return { action: 'skip', reason: 'would_notify_household' };

  // THE CREDIT GUARD: the auto-apply trigger fires when a document that was not
  // collectable becomes collectable, and a backfill must not be the event that
  // spends a household's account credit.
  if (!collectableForAutoApply(doc) && collectableForAutoApply(after)) {
    return { action: 'skip', reason: 'would_draw_credit' };
  }

  return {
    action: 'write',
    update: { amountDue, amountDueCents, ...stamp },
    overpaidCents: legacyOverpaidCentsOf(doc as AmountDueDoc, paidCents),
  };
}

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' && process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillInvoiceAmountDue: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (getApps().length === 0) initializeApp({ projectId });
}

export interface RunResult {
  scanned: number;
  written: number;
  skipped: Record<SkipReason, number>;
  /** Planned writes counted by the state each one stamps, so the plan reads at a glance. */
  byState: Record<string, number>;
  /** Documents a guard refused, for the operator to handle by hand. */
  needsOperator: string[];
  /** Of the writes planned, how many sit on a bill whose rows exceed its total. */
  overdrawn: number;
}

/** Firestore caps a WriteBatch at 500 ops; stay comfortably under it. */
const WRITES_PER_BATCH = 400;

export async function run(mode: Mode, pageSize: number): Promise<RunResult> {
  const db: Firestore = getFirestore();
  const result: RunResult = {
    scanned: 0,
    written: 0,
    skipped: { states_balance: 0, no_total: 0, would_notify_household: 0, would_draw_credit: 0 },
    byState: {},
    needsOperator: [],
    overdrawn: 0,
  };

  let batch = db.batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    if (mode === 'apply') await batch.commit();
    batch = db.batch();
    batchSize = 0;
  };

  // Paged by document id: present on every doc by construction, the one thing a
  // completeness sweep needs. Ordering by `date`/`createdAt` drops rows on this
  // collection — the trap repairInvoicePayments.ts documents.
  let cursor: string | null = null;
  for (;;) {
    let query = db.collection('invoices').orderBy('__name__').limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;

    for (const docSnap of page.docs) {
      result.scanned += 1;
      cursor = docSnap.id;
      const data = docSnap.data() as Record<string, unknown>;

      // Only the documents in scope pay for the subcollection read.
      if (!statesNoBalance(data as AmountDueDoc) || invoiceTotalCentsOf(data as AmountDueDoc) <= 0) {
        const decision = planAmountDue(data, []);
        if (decision.action === 'skip') result.skipped[decision.reason] += 1;
        continue;
      }

      const paymentsSnap = await docSnap.ref.collection('payments').get();
      const payments = paymentsSnap.docs.map((p) => p.data() as PaymentAmount);
      const decision = planAmountDue(data, payments);

      if (decision.action === 'skip') {
        result.skipped[decision.reason] += 1;
        result.needsOperator.push(docSnap.id);
        console.log(
          `[skip:${decision.reason}] invoices/${docSnap.id} status=${JSON.stringify(data.status ?? null)} — writing its derived balance would ${
            decision.reason === 'would_notify_household'
              ? 'tell the household about a payment made long ago'
              : 'make the auto-apply trigger spend account credit'
          }; handle by hand`,
        );
        continue;
      }

      result.written += 1;
      result.byState[decision.update.status] = (result.byState[decision.update.status] ?? 0) + 1;
      if (decision.overpaidCents > 0) result.overdrawn += 1;
      console.log(
        `[write] invoices/${docSnap.id} status ${JSON.stringify(data.status ?? null)} -> '${decision.update.status}'  amountDue (none) -> ${decision.update.amountDue}  editScope -> '${decision.update.editScope}'`,
      );

      // Merge of EXACTLY the four fields. No updatedAt and no server timestamp:
      // these records carry the original system's dates and keep them.
      batch.set(docSnap.ref, decision.update, { merge: true });
      batchSize += 1;
      if (batchSize >= WRITES_PER_BATCH) await flush();
    }

    if (page.docs.length < pageSize) break;
  }
  await flush();

  return result;
}

function summarise(mode: Mode, r: RunResult): void {
  console.log('\n=== backfillInvoiceAmountDue (#902) ===');
  console.log(`  mode    : ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  scanned : ${r.scanned}`);
  console.log(`  ${mode === 'apply' ? 'written' : 'planned'} : ${r.written}`);
  for (const [state, n] of Object.entries(r.byState).sort()) console.log(`      ${state}: ${n}`);
  console.log('  skipped :');
  console.log(`      states_balance: ${r.skipped.states_balance}`);
  console.log(`      no_total: ${r.skipped.no_total}`);
  console.log(`      would_notify_household: ${r.skipped.would_notify_household}`);
  console.log(`      would_draw_credit: ${r.skipped.would_draw_credit}`);
  if (r.overdrawn > 0) {
    console.log(
      `\n  ${r.overdrawn} of the planned writes sit on a bill whose payment rows exceed its total.` +
        '\n  Each gets a ZERO balance, never a negative one: this script mints no credits.' +
        '\n  There are no refunds, so that money belongs on the household account balance,' +
        '\n  moved there by hand after the run.',
    );
  }
  if (r.needsOperator.length > 0) {
    console.log('  NEEDS OPERATOR (a guard refused these):');
    for (const id of r.needsOperator) console.log(`      invoices/${id}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' && process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  console.log(`Mode: ${args.mode}    allowProd=${args.allowProd}    emulator=${usingEmulator}`);

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  console.log(`Project: ${projectId}`);
  initAdmin(projectId);

  const result = await run(args.mode, args.pageSize);
  summarise(args.mode, result);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_INVOICE_AMOUNT_DUE',
      description: `written=${result.written} scanned=${result.scanned} needs_operator=${result.needsOperator.length} overdrawn=${result.overdrawn}`,
      status: 'SUCCESS',
      actorId: 'system:backfillInvoiceAmountDue',
      targetId: '',
      targetCollection: 'invoices',
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { result: { ...result, needsOperator: result.needsOperator } },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (UNCHAINED — runs outside writeAuditEntry).');
  } else {
    console.log('\nDRY-RUN. No writes. Re-run with --allow-prod to commit.');
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
