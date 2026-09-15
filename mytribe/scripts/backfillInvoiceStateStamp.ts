/**
 * backfillInvoiceStateStamp.ts
 *
 * One-shot backfill of the Invoice State Stamp (ADR-0002) onto every existing
 * `invoices/{id}` doc: `status` (the classifier's canonical 8-state value,
 * lowercase) and `editScope` ('all' | 'metadataOnly' | 'none').
 *
 * From this change's PR on, every money-touching callable persists the stamp
 * in the same write that moves the money, so every invoice written AFTER
 * deploy is current. This script covers the docs written BEFORE it, which
 * carry free-text status in whatever spelling their writer used ('QUOTE',
 * 'Paid', 'sent', '') and no editScope at all. Clients cannot rely on the
 * stored state until both populations are stamped.
 *
 * THE STAMP IS DERIVED, NEVER INVENTED. Per doc it reads the classifier's
 * fields plus the `payments` SUBCOLLECTION (the only place that can answer
 * "how much has come in": the amountDue scalar was zeroed by the
 * pre-2026-07-25 partial-payment write), and computes the exact same
 * `invoiceStateStampOf` every callable now computes. No money field changes:
 * the write set is exactly { status, editScope }, and `updatedAt` is left
 * alone so nothing that sorts or diffs on it sees a phantom edit.
 *
 * Modes:
 *   default        — DRY RUN. Prints every planned stamp (before -> after) and
 *                    the summary counts. Writes nothing.
 *   --allow-prod   — applies the stamps, batched under Firestore's 500-op
 *                    batch limit.
 *
 * Safety:
 *   - Dry-run by default; refuses to write unless --allow-prod is passed. An
 *     explicit --dry-run beats --allow-prod in either flag order.
 *     FIRESTORE_EMULATOR_HOST does NOT relieve that: it only stands in for
 *     credentials, so an emulator run without --allow-prod is still a dry run
 *     that writes nothing, to the emulator or anywhere else.
 *   - Real writes require GOOGLE_APPLICATION_CREDENTIALS (fail-loud).
 *   - IDEMPOTENT: a doc whose stored status/editScope already equal the
 *     derived stamp is skipped (`stamp_current`), so the second run reports
 *     zero planned writes. The stamp itself is a classifier fixpoint
 *     (asserted in functions/test/invoiceStateStamp.test.ts), which is what
 *     makes that skip check sound.
 *   - THE PAYMENT GUARD (`would_assert_payment`, #884). invoiceStateOf reads a
 *     missing `amountDue` as 0, so a doc with a `total`, no numeric `amountDue`
 *     and no payment rows classifies paid although nothing was paid. A paid/none
 *     stamp on it would block every payment path and every edit, while unstamped
 *     the portal shows it open. This script refuses those docs and lists them for
 *     the operator, until #902 rules on a missing amountDue.
 *   - THE NOTIFICATION GUARD (`would_notify_household`). It asks
 *     `onInvoicesWrite`'s own decision, `invoiceWriteNoticeKey`, whether the
 *     trigger would send anything for the stamp write, so it follows whatever the
 *     trigger does: a backfill must never text a household about a payment that
 *     happened months ago. With today's classifier a stamp write never changes
 *     what the trigger reads, so it refuses nothing; the unit test proves it
 *     refuses a stamp that would. Refused docs are listed for the operator.
 *
 * Runbook: run DRY first, read the plan, then re-run with --allow-prod.
 * This script has NOT been run against production as part of the PR that
 * ships it; it is a runbook step.
 */

// The MODULAR admin API, not `import * as admin from 'firebase-admin'`: the
// installed firebase-admin ^14 no longer exports the legacy namespace
// (`admin.firestore` is undefined at runtime), so the older scripts' pattern
// throws the moment it is called. Verified against the emulator.
//
// Imported from './lib/firebaseAdmin' (issue #846), not directly from
// 'firebase-admin/app' / 'firebase-admin/firestore': that module guards
// against a stray firebase-admin copy resolving ahead of this project's, and
// guarantees Timestamp/FieldValue come from the same instance as the
// Firestore client this script writes through.
import { getApps, initializeApp, getFirestore, FieldValue, type Firestore } from './lib/firebaseAdmin';
import {
  invoiceStateStampOf,
  invoiceStampIsCurrent,
  type InvoiceStateStamp,
} from '../functions/src/lib/invoiceStateStamp';
import { paidCentsFromPayments, type PaymentAmount } from '../functions/src/lib/invoiceMath';
import { invoiceWriteNoticeKey } from '../functions/src/triggers/onInvoicesWrite';

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
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked
  // separately from `args.mode` (rather than setting `args.mode = 'dry-run'`
  // inline the moment `--dry-run` is seen) because the unconditional
  // `if (args.allowProd) args.mode = 'apply'` below runs once, AFTER the
  // whole argv has been scanned — so `--allow-prod --dry-run` would silently
  // re-flip mode to 'apply' if this flag's own presence weren't remembered
  // past the loop. This is the one flag whose entire purpose is proving a
  // run is safe before it rewrites live invoice state; getting its precedence
  // backwards defeats that purpose.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`, which would take the safety flag off
      // the table while `--allow-prod` stayed on. `--page-size` gets this free
      // via Number()/NaN; this branch has to say it.
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
          'backfillInvoiceStateStamp.ts — stamp status/editScope (ADR-0002) onto existing invoices',
          '',
          'Usage (from mytribe/functions, which owns the node_modules this resolves against):',
          '  npm run backfill:invoice-state                     # DRY RUN (default)',
          '  npm run backfill:invoice-state -- --allow-prod     # apply',
          '  npm run backfill:invoice-state -- --dry-run        # force dry-run, ALWAYS wins',
          '  npm run backfill:invoice-state -- --project <id>   # override project',
          '  npm run backfill:invoice-state -- --page-size <n>  # invoices read per page (default 300)',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still does not write).',
          '',
          '(Direct invocation needs NODE_PATH=node_modules ahead of ts-node: mytribe/scripts',
          ' has no node_modules of its own, and firebase-admin resolves at runtime from the',
          ' functions install.)',
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
  // `explicitDryRun` wins regardless of flag order — see the comment on its
  // declaration above. `args.allowProd` itself still reports `true` when
  // `--allow-prod` was passed, even though `mode` stays 'dry-run': the
  // startup log line prints both, so an operator who typed
  // `--allow-prod --dry-run` sees exactly what happened rather than a flag
  // that silently vanished.
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

/** Why a scanned invoice is not being stamped. Reported, never silent. */
export type StampSkipReason = 'stamp_current' | 'would_assert_payment' | 'would_notify_household';

export type StampDecision =
  | {
      action: 'stamp';
      /** The EXACT field set merged onto the doc. Nothing else changes. */
      update: InvoiceStateStamp;
      /** What the doc said before, for the printed plan. */
      before: { status: unknown; editScope: unknown };
    }
  | { action: 'skip'; reason: StampSkipReason };

/**
 * THE NOTIFICATION GUARD: would `onInvoicesWrite` send anything for this stamp
 * write? It asks the trigger's own decision, `invoiceWriteNoticeKey`, both of
 * its notices and the owner stand-down included, so it follows whatever the
 * trigger does. With the classifier's stamp it never fires today (a stamp write
 * does not change what the trigger reads); it is kept as a real check so a later
 * change to either side cannot make a backfill text a household.
 */
export function wouldNotifyHousehold(doc: Record<string, unknown>, stamp: InvoiceStateStamp): boolean {
  return invoiceWriteNoticeKey(doc, { ...doc, ...stamp }) !== null;
}

/**
 * #884 second review: A PAID STAMP NOTHING BUT A MISSING amountDue SUPPORTS.
 * invoiceStateOf reads a missing `amountDue` as 0, so `{ status: 'sent',
 * total: 40 }` classifies paid with nothing paid. Stamped paid/none, the bill
 * could not be collected by any path (`alreadySettledRefusal` blocks
 * markInvoicePaid, the credit draw and payInvoice; scope none blocks
 * updateInvoice; repairInvoicePayments skips it), while unstamped the portal
 * shows it open. Refused, with no payment row to back the reading, until #902
 * rules on a missing amountDue.
 */
export function wouldAssertPayment(
  doc: Record<string, unknown>,
  stamp: InvoiceStateStamp,
  paidCents: number,
): boolean {
  return stamp.status === 'paid' && typeof doc.amountDue !== 'number' && paidCents === 0;
}

/**
 * The decision for one invoice. PURE: no Firestore access, so the whole rule,
 * including both guards, is unit-testable against fixtures
 * (mytribe/scripts/test/backfillInvoiceStateStamp.test.ts). `stampOf` is the
 * classifier's stamp; a test passes another one to prove the notification guard
 * refuses a write the trigger would announce.
 */
export function planStamp(
  doc: Record<string, unknown>,
  payments: readonly PaymentAmount[],
  stampOf: (doc: Record<string, unknown>, paidCents: number) => InvoiceStateStamp = invoiceStateStampOf,
): StampDecision {
  const paidCents = paidCentsFromPayments(payments);
  const stamp = stampOf(doc, paidCents);

  if (invoiceStampIsCurrent(doc, stamp)) {
    return { action: 'skip', reason: 'stamp_current' };
  }

  if (wouldAssertPayment(doc, stamp, paidCents)) {
    return { action: 'skip', reason: 'would_assert_payment' };
  }

  // The notification guard (see the header).
  if (wouldNotifyHousehold(doc, stamp)) {
    return { action: 'skip', reason: 'would_notify_household' };
  }

  return {
    action: 'stamp',
    update: stamp,
    before: { status: doc.status, editScope: doc.editScope },
  };
}

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillInvoiceStateStamp: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (getApps().length === 0) initializeApp({ projectId });
}

interface RunResult {
  scanned: number;
  stamped: number;
  skipped: Record<StampSkipReason, number>;
  /** Planned stamps counted by resulting state, so the plan is reviewable at a glance. */
  byState: Record<string, number>;
  /** Docs the notification guard refused, for the operator to handle by hand. */
  needsOperator: string[];
}

/** Firestore caps a WriteBatch at 500 ops; stay comfortably under it. */
const WRITES_PER_BATCH = 400;

export async function run(mode: Mode, pageSize: number): Promise<RunResult> {
  const db: Firestore = getFirestore();
  const result: RunResult = {
    scanned: 0,
    stamped: 0,
    skipped: { stamp_current: 0, would_assert_payment: 0, would_notify_household: 0 },
    byState: {},
    needsOperator: [],
  };

  let batch = db.batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    if (mode === 'apply') await batch.commit();
    batch = db.batch();
    batchSize = 0;
  };

  // Paged by document id: present on every doc by construction, which is the
  // one thing a completeness sweep needs (`date`/`createdAt` are absent or
  // free-text on part of this collection, and ordering by either drops rows —
  // the same trap admin/repairInvoicePayments.ts documents).
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

      const paymentsSnap = await docSnap.ref.collection('payments').get();
      const payments = paymentsSnap.docs.map((p) => p.data() as PaymentAmount);

      const decision = planStamp(data, payments);
      if (decision.action === 'skip') {
        result.skipped[decision.reason] += 1;
        if (decision.reason === 'would_notify_household') {
          result.needsOperator.push(docSnap.id);
          console.log(
            `[skip:would_notify_household] invoices/${docSnap.id} status=${JSON.stringify(data.status ?? null)} — stamping 'paid' here would fire invoice.payment.applied at the household; handle by hand`,
          );
        } else if (decision.reason === 'would_assert_payment') {
          result.needsOperator.push(docSnap.id);
          console.log(
            `[skip:would_assert_payment] invoices/${docSnap.id} status=${JSON.stringify(data.status ?? null)}: no amountDue and no payment rows, so a 'paid' stamp would mark an owed bill paid; left for #902`,
          );
        }
        continue;
      }

      result.stamped += 1;
      result.byState[decision.update.status] = (result.byState[decision.update.status] ?? 0) + 1;
      console.log(
        `[stamp] invoices/${docSnap.id} status ${JSON.stringify(decision.before.status ?? null)} -> '${decision.update.status}'  editScope ${JSON.stringify(decision.before.editScope ?? null)} -> '${decision.update.editScope}'`,
      );

      // Merge of EXACTLY the two stamp fields. No updatedAt: this is a
      // derivation being materialized, not an edit.
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
  console.log('\n=== backfillInvoiceStateStamp ===');
  console.log(`  mode    : ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  scanned : ${r.scanned}`);
  console.log(`  ${mode === 'apply' ? 'stamped' : 'planned'} : ${r.stamped}`);
  for (const [state, n] of Object.entries(r.byState).sort()) {
    console.log(`      ${state}: ${n}`);
  }
  console.log('  skipped :');
  console.log(`      stamp_current: ${r.skipped.stamp_current}`);
  console.log(`      would_assert_payment: ${r.skipped.would_assert_payment}`);
  console.log(`      would_notify_household: ${r.skipped.would_notify_household}`);
  if (r.needsOperator.length > 0) {
    console.log('  NEEDS OPERATOR (a guard refused these):');
    for (const id of r.needsOperator) console.log(`      invoices/${id}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  console.log(`Mode: ${args.mode}    allowProd=${args.allowProd}    emulator=${usingEmulator}`);

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);

  const result = await run(args.mode, args.pageSize);
  summarise(args.mode, result);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_INVOICE_STATE_STAMP',
      description: `stamped=${result.stamped} scanned=${result.scanned} skipped_current=${result.skipped.stamp_current} needs_operator=${result.needsOperator.length} would_assert_payment=${result.skipped.would_assert_payment} would_notify_household=${result.skipped.would_notify_household}`,
      status: 'SUCCESS',
      actorId: 'system:backfillInvoiceStateStamp',
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
