/**
 * backfillStripePaymentAmountCents.ts
 *
 * Task 29a. Stamps `amountCents` onto historical ROOT `payments/{id}` rows
 * that predate it, using the SAME rule `getInvoiceLedger.ts`'s display ledger
 * now reads them with.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * `billing/stripeWebhook.ts` wrote a `payments/{eventId}` doc with a field
 * named `amount` whose UNIT DEPENDED ON WHERE THE VALUE CAME FROM:
 *
 *   amountSource: 'stripe-event'    amount is Stripe's own amount_paid /
 *                                   amount_received — ALREADY INTEGER CENTS.
 *   amountSource: 'local-invoice'   amount is this app's own amountDue/total
 *                                   fallback — a DOLLAR float.
 *   amountSource: 'unresolved'      neither resolved. amount is null.
 *
 * The reader treated every `amount` as dollars. A $137.50 Stripe payment
 * stored `amount: 13750` (cents) and rendered as $13,750.00 — a 100x
 * overstatement. PR29 (2026-08-06) fixed the write path forward: every row
 * written since carries an explicit, correct `amountCents`. This script
 * covers the rows written before that.
 *
 * ── THE RULE IS SHARED, NOT REINVENTED ────────────────────────────────────
 *
 * `resolveLedgerAmountCents` (functions/src/lib/paymentMoney.ts) is the exact
 * function `getInvoiceLedger.ts` now calls per row to render the display
 * ledger. This script calls the same function, so the figure an operator
 * sees on screen today and the figure permanently stamped by this backfill
 * can never disagree.
 *
 * ── WHAT IT WRITES, AND ONLY THIS ──────────────────────────────────────────
 *
 *   `amountCents`   the resolved integer cents, merged onto the row.
 *
 * It NEVER touches `amount` itself (the historical float/int stays exactly
 * as recorded — this is payment code, and payment code is not "cleaned up"),
 * NEVER touches the `invoices/{id}/payments` SUBCOLLECTION (the settlement
 * authority; task 29a's blast-radius pass found the buggy field never
 * reaches it — see the task report), and NEVER moves money. No refund, no
 * account-balance write, no invoice re-settlement: an operator ruling
 * (2026-08-06) is that account balance is the only destination for money
 * owed back, and this script does not decide that anything is owed back —
 * it corrects a DISPLAY figure's units.
 *
 * ── FAIL LOUD, NEVER GUESSED ────────────────────────────────────────────────
 *
 * A row whose amount cannot be honestly interpreted — `amountSource:
 * 'unresolved'`, or any shape `resolveLedgerAmountCents` reports unresolved —
 * is counted under `unresolved` and left exactly as it is. It is NOT stamped
 * with 0, or with any other number: `amountCents` absent is already the
 * correct "unknown" representation for a row nothing here ever claimed a
 * figure for, and stamping a guessed 0 would make an unresolved row
 * indistinguishable from a verified $0 payment forever.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────────────
 *
 * A row that already carries a valid, non-negative integer `amountCents` is
 * skipped (`already_correct`) — never re-derived, never re-scaled. Every row
 * this script stamps satisfies that check the moment the stamp lands, so a
 * second run over the same data reports zero writes. This is the property a
 * re-runnable MONEY migration cannot afford to get wrong: a non-idempotent
 * version of this exact script would turn a 100x bug into a 10,000x one on
 * its second run.
 *
 * ── MODES ────────────────────────────────────────────────────────────────
 *
 *   default        DRY RUN. Prints every planned stamp and the summary
 *                  counts. Writes nothing.
 *   --allow-prod   applies the stamps, batched under Firestore's 500-op
 *                  batch limit.
 *
 * Runbook: run DRY first, read the plan (especially the unresolved list —
 * those need a person, not a re-run), then re-run with --allow-prod. This
 * script has NOT been run against production as part of the PR that ships
 * it: cloud commands run from an operator's own environment, not from here,
 * so the real row counts (how many Stripe rows are actually affected) are
 * UNKNOWN until the operator runs the dry run and reads its output.
 *
 * EXPECT `planned` TO BE LARGER THAN "THE STRIPE 100X ROWS." This scans the
 * whole `payments` collection, so every legacy row with only a float
 * `amount` and no `amountCents` at all — every `recordPayment.ts` row
 * written before it started writing `amountCents` alongside `amount`, and
 * any `local-invoice`-sourced Stripe row — also gets stamped, at the exact
 * dollars-to-cents value `getInvoiceLedger.ts` already renders for it today.
 * That is correct and harmless (same rule, same number, just made permanent),
 * but it means most of the planned stamps are ordinary legacy-dollar rows,
 * not 100x fixes. The `stripe-event` lines in the printed plan are the ones
 * that were actually wrong on screen; a large total `planned` count by
 * itself is not evidence of anything unusual.
 */

// The MODULAR admin API, matching every other script in this directory: the
// installed firebase-admin no longer exports the legacy namespace at
// runtime, so `import * as admin from 'firebase-admin'` throws the moment
// it's called.
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { resolveLedgerAmountCents } from '../functions/src/lib/paymentMoney';

export const PAYMENTS_COLLECTION = 'payments';

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  /** Payment rows read per page. Also bounds memory; writes batch at 400. */
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
  // run is safe before it touches money; getting its precedence backwards
  // defeats that purpose.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v) throw new Error('--project requires a value');
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
          'backfillStripePaymentAmountCents.ts — stamp amountCents (task 29a) onto historical ROOT payments/{id} rows',
          '',
          'Usage (from mytribe/functions, which owns the node_modules this resolves against):',
          '  npm run backfill:stripe-payment-cents                     # DRY RUN (default)',
          '  npm run backfill:stripe-payment-cents -- --allow-prod     # apply',
          '  npm run backfill:stripe-payment-cents -- --dry-run        # force dry-run, ALWAYS wins',
          '  npm run backfill:stripe-payment-cents -- --project <id>   # override project',
          '  npm run backfill:stripe-payment-cents -- --page-size <n>  # rows read per page (default 300)',
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
          '  FIRESTORE_EMULATOR_HOST         when set, --allow-prod not required',
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

/** Why a scanned row is not being stamped. Reported, never silent. */
export type StampSkipReason = 'already_correct' | 'unresolved';

export type StampDecision =
  | {
      action: 'stamp';
      amountCents: number;
      /** What the row's `amountCents` said before (usually `null`, absent). */
      before: unknown;
    }
  | { action: 'skip'; reason: StampSkipReason };

/**
 * The decision for one `payments/{id}` row. PURE: no Firestore access, so
 * the whole rule — including idempotency — is unit-testable against
 * fixtures (mytribe/scripts/test/backfillStripePaymentAmountCents.test.ts).
 *
 * Calls the exact function `getInvoiceLedger.ts` reads a row with, so this
 * script can never stamp a number the display ledger disagrees with.
 */
export function planAmountCentsStamp(doc: Record<string, unknown>): StampDecision {
  const existing = doc['amountCents'];
  if (typeof existing === 'number' && Number.isInteger(existing) && existing >= 0) {
    // IDEMPOTENCY: a row already carrying a valid amountCents — because a
    // prior run of this script stamped it, or because PR29's forward fix
    // wrote it directly — is left untouched. Re-deriving it here would risk
    // disagreeing with the number already in front of an operator.
    return { action: 'skip', reason: 'already_correct' };
  }

  const resolved = resolveLedgerAmountCents({
    amount: doc['amount'],
    amountCents: doc['amountCents'],
    amountSource: doc['amountSource'],
  });
  if (!resolved.resolved) {
    return { action: 'skip', reason: 'unresolved' };
  }

  return { action: 'stamp', amountCents: resolved.amountCents, before: existing ?? null };
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
      'backfillStripePaymentAmountCents: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (getApps().length === 0) initializeApp({ projectId });
}

interface RunResult {
  scanned: number;
  stamped: number;
  skipped: Record<StampSkipReason, number>;
  /** Rows the unresolved branch refused, for the operator to read by hand. */
  unresolvedIds: string[];
}

/** Firestore caps a WriteBatch at 500 ops; stay comfortably under it. */
const WRITES_PER_BATCH = 400;

export async function run(mode: Mode, pageSize: number, db?: Firestore): Promise<RunResult> {
  const store: Firestore = db ?? getFirestore();
  const result: RunResult = {
    scanned: 0,
    stamped: 0,
    skipped: { already_correct: 0, unresolved: 0 },
    unresolvedIds: [],
  };

  let batch = store.batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    if (mode === 'apply') await batch.commit();
    batch = store.batch();
    batchSize = 0;
  };

  // Paged by document id: present on every doc by construction. `date` is a
  // Firestore server timestamp on the rows this script cares about but a
  // free-text field on legacy migration rows, so ordering by it would drop
  // the very rows this backfill exists for — the same trap
  // backfillInvoiceStateStamp.ts documents.
  let cursor: string | null = null;
  for (;;) {
    let query = store.collection(PAYMENTS_COLLECTION).orderBy('__name__').limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;

    for (const docSnap of page.docs) {
      result.scanned += 1;
      cursor = docSnap.id;
      const data = docSnap.data() as Record<string, unknown>;

      const decision = planAmountCentsStamp(data);
      if (decision.action === 'skip') {
        result.skipped[decision.reason] += 1;
        if (decision.reason === 'unresolved') {
          result.unresolvedIds.push(docSnap.id);
          console.log(
            `[skip:unresolved] payments/${docSnap.id} amountSource=${JSON.stringify(data['amountSource'] ?? null)} amount=${JSON.stringify(data['amount'] ?? null)} — cannot be honestly interpreted, left as-is`,
          );
        }
        continue;
      }

      result.stamped += 1;
      console.log(
        `[stamp] payments/${docSnap.id} amountCents ${JSON.stringify(decision.before)} -> ${decision.amountCents}`,
      );

      // Merge of EXACTLY amountCents. `amount` and every other field on the
      // row are left exactly as recorded.
      batch.set(docSnap.ref, { amountCents: decision.amountCents }, { merge: true });
      batchSize += 1;
      if (batchSize >= WRITES_PER_BATCH) await flush();
    }

    if (page.docs.length < pageSize) break;
  }
  await flush();

  return result;
}

function summarise(mode: Mode, r: RunResult): void {
  console.log('\n=== backfillStripePaymentAmountCents ===');
  console.log(`  mode        : ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  scanned     : ${r.scanned}`);
  console.log(`  ${mode === 'apply' ? 'stamped' : 'planned'}     : ${r.stamped}`);
  console.log('  skipped     :');
  console.log(`      already_correct : ${r.skipped.already_correct}`);
  console.log(`      unresolved      : ${r.skipped.unresolved}`);
  if (r.unresolvedIds.length > 0) {
    console.log('\n  UNRESOLVED (could not be honestly interpreted — needs a person, not a re-run):');
    for (const id of r.unresolvedIds) console.log(`      payments/${id}`);
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
      actionType: 'BACKFILL_STRIPE_PAYMENT_AMOUNT_CENTS',
      description: `stamped=${result.stamped} scanned=${result.scanned} already_correct=${result.skipped.already_correct} unresolved=${result.skipped.unresolved}`,
      status: 'SUCCESS',
      actorId: 'system:backfillStripePaymentAmountCents',
      targetId: '',
      targetCollection: PAYMENTS_COLLECTION,
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { result },
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
