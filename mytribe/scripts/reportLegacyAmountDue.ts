/**
 * reportLegacyAmountDue.ts
 *
 * READ-ONLY. Answers #902's first question: how many invoices carry a `total`
 * and no `amountDue` at all, and what does each of them currently say it is?
 *
 * WHY THE COUNT MATTERS. Two readers used to disagree about exactly this shape.
 * `invoiceStateOf` read the missing balance as zero and called the document
 * paid; `collectableForAutoApply` read it as "no stated balance, go and look"
 * and drew account credit against the same document. #902 makes both ask one
 * rule (`functions/src/lib/amountDueRule.ts`). This report says how much of
 * production that rule is about to speak for, BEFORE the backfill writes
 * anything, and it is the number the operator reads to decide whether the
 * backfill is a formality or an event.
 *
 * WHAT IT READS.
 *   - Every `invoices/{id}`, paged by document id.
 *   - For each document that states NO balance: its `payments` subcollection,
 *     and the root `payments` collection by `invoiceId` (where the Stripe
 *     webhook and `recordPayment` write theirs). An ordinary invoice costs no
 *     extra read.
 *
 * WHAT IT REPORTS, per stored `status` spelling, exactly as stored:
 *   total_no_amount_due  documents with a positive total and no stated balance
 *   rule_owed            of those, the ones the rule says still owe something
 *   rule_settled         of those, the ones the rule settles at zero
 *   with_payment_rows    of those, the ones carrying at least one payment row
 *   overdrawn            of those, the ones whose rows exceed their total
 *
 * THE OVERDRAWN COUNT IS A REPORT, NOT A PLAN. Per the standing operator ruling
 * there are no refunds: money collected beyond a legacy bill belongs on the
 * household's account balance, put there deliberately by an operator. Nothing
 * here and nothing in the backfill acts on one; they are counted so they can be
 * looked at.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, add, batch or
 * transaction call, and reportLegacyAmountDue.test.ts greps it. So there is no
 * apply mode: every run is the dry run.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *
 * NOTHING PRIVATE IS PRINTED. Invoice ids, stored status spellings and counts.
 * No uids, no household or kinfolk ids, no names, NO AMOUNTS of any kind, and no
 * message content. Amounts are deliberately absent rather than aggregated: a
 * group of one would be one household's bill.
 *
 * Usage (the operator runs the prod form; an agent session cannot):
 *
 *   npm --prefix mytribe/functions run report:legacy-amount-due -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846), as in the #832, #871 and #884
// reports.
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import {
  amountDueCentsOf,
  legacyOverpaidCentsOf,
  statesNoBalance,
  type AmountDueDoc,
} from '../functions/src/lib/amountDueRule';
import { invoiceTotalCentsOf, paidCentsFromPayments, type PaymentAmount } from '../functions/src/lib/invoiceMath';

const PAGE = 300;

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  /** How many invoice ids to list per status group. Ids only; never amounts. */
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, samples: 25 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === '--project') args.projectId = value();
    else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--samples') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportLegacyAmountDue.ts: READ-ONLY count of invoices with a total and no amountDue (#902),',
          'grouped by their stored status, with what the shared rule would say about each group.',
          '',
          '  npm --prefix mytribe/functions run report:legacy-amount-due -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Prints ids, stored status spellings and counts only — never an amount.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export type Target =
  | { kind: 'emulator'; host: string; projectId: string }
  | { kind: 'production'; projectId: string };

/**
 * Which database this run reads, or a refusal. `env` is passed in so the unit
 * test drives every branch without touching `process.env`. Same shape and same
 * reasoning as `reportOverdueNoticesForNonBills.ts`.
 */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const projectId = args.projectId ?? env['GCLOUD_PROJECT'] ?? env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (host) {
    if (args.allowProd) {
      throw new Error(
        `refusing --allow-prod while FIRESTORE_EMULATOR_HOST=${host} is set: this run would read the emulator, not production. Unset it to read production.`,
      );
    }
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-902' };
  }
  if (!args.allowProd) {
    throw new Error('no FIRESTORE_EMULATOR_HOST, so this would read PRODUCTION: pass --allow-prod to confirm.');
  }
  if (!projectId) throw new Error('reading production needs --project <id>.');
  return { kind: 'production', projectId };
}

export function describeTarget(t: Target): string {
  return t.kind === 'emulator'
    ? `Target: EMULATOR ${t.host}, project ${t.projectId}`
    : `Target: PRODUCTION, project ${t.projectId}`;
}

/** The stored spelling, verbatim, or `(none)` when the field is absent or not a string. */
export function storedStatusOf(doc: { status?: unknown }): string {
  const raw = doc.status;
  if (typeof raw !== 'string') return '(none)';
  const s = raw.trim();
  return s === '' ? '(empty)' : s;
}

export interface StatusGroup {
  invoices: number;
  ruleOwed: number;
  ruleSettled: number;
  withPaymentRows: number;
  overdrawn: number;
  /** Capped list of invoice ids, for the operator to open. Ids only. */
  sampleIds: string[];
}

export interface ReportResult {
  scanned: number;
  /** Documents with a positive total and no stated balance at all. */
  legacy: number;
  byStatus: Record<string, StatusGroup>;
}

function emptyGroup(): StatusGroup {
  return { invoices: 0, ruleOwed: 0, ruleSettled: 0, withPaymentRows: 0, overdrawn: 0, sampleIds: [] };
}

/**
 * Is this the shape #902 is about? A positive total and NO stated balance.
 *
 * A non-positive total is excluded on purpose: a document with neither a balance
 * nor a total states no money at all, the rule reads it as owing nothing, and
 * counting it here would bury the population that matters in rows nobody can act
 * on. A NEGATIVE total is already a credit to every classifier and is not a
 * legacy bill.
 */
export function isLegacyShape(doc: AmountDueDoc): boolean {
  return statesNoBalance(doc) && invoiceTotalCentsOf(doc) > 0;
}

/**
 * Folds one legacy-shaped invoice into its status group. PURE, so the whole
 * counting rule is unit-testable against fixtures without an emulator.
 */
export function tally(
  result: ReportResult,
  id: string,
  doc: AmountDueDoc,
  paidCents: number,
  hasRows: boolean,
  samples: number,
): void {
  const key = storedStatusOf(doc);
  const group = (result.byStatus[key] ??= emptyGroup());
  group.invoices += 1;
  result.legacy += 1;
  if (amountDueCentsOf(doc, paidCents) > 0) group.ruleOwed += 1;
  else group.ruleSettled += 1;
  if (hasRows) group.withPaymentRows += 1;
  if (legacyOverpaidCentsOf(doc, paidCents) > 0) group.overdrawn += 1;
  if (group.sampleIds.length < samples) group.sampleIds.push(id);
}

export async function run(samples: number): Promise<ReportResult> {
  const db: Firestore = getFirestore();
  const result: ReportResult = { scanned: 0, legacy: 0, byStatus: {} };

  // Paged by document id, present on every doc by construction: the one thing a
  // completeness sweep needs. `date`/`createdAt` are absent or free-text on part
  // of this collection and ordering by either drops rows — the trap
  // `admin/repairInvoicePayments.ts` and the state-stamp backfill both document.
  let cursor: string | null = null;
  for (;;) {
    let query = db.collection('invoices').orderBy('__name__').limit(PAGE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;

    for (const docSnap of page.docs) {
      result.scanned += 1;
      cursor = docSnap.id;
      const doc = docSnap.data() as AmountDueDoc;
      if (!isLegacyShape(doc)) continue;

      const ownRows = await docSnap.ref.collection('payments').get();
      const rootRows = await db.collection('payments').where('invoiceId', '==', docSnap.id).get();
      // The invoice's OWN subcollection is the settlement figure (the same read
      // `paidCentsFromPayments` is documented for). The root ledger is counted
      // only as evidence that money came in, never summed into the balance: the
      // two collections are not guaranteed to be disjoint records of the same
      // payment, and double-counting would understate what is owed.
      const paidCents = paidCentsFromPayments(ownRows.docs.map((d) => d.data() as PaymentAmount));
      tally(result, docSnap.id, doc, paidCents, ownRows.size > 0 || rootRows.size > 0, samples);
    }

    if (page.docs.length < PAGE) break;
  }

  return result;
}

function summarise(r: ReportResult): void {
  console.log('\n=== reportLegacyAmountDue (#902) ===');
  console.log(`  invoices scanned            : ${r.scanned}`);
  console.log(`  total and no amountDue      : ${r.legacy}`);
  if (r.legacy === 0) {
    console.log('\n  Nothing to backfill: every invoice states its own balance.');
    return;
  }
  console.log('\n  By stored status (spelled exactly as stored):');
  for (const [status, g] of Object.entries(r.byStatus).sort()) {
    console.log(`    ${status}`);
    console.log(`      invoices          : ${g.invoices}`);
    console.log(`      rule says owed    : ${g.ruleOwed}`);
    console.log(`      rule says settled : ${g.ruleSettled}`);
    console.log(`      with payment rows : ${g.withPaymentRows}`);
    console.log(`      overdrawn         : ${g.overdrawn}`);
    console.log(`      ids               : ${g.sampleIds.join(' ') || '(none)'}`);
  }
  const overdrawn = Object.values(r.byStatus).reduce((n, g) => n + g.overdrawn, 0);
  if (overdrawn > 0) {
    console.log(
      `\n  ${overdrawn} invoice(s) hold payments beyond their total. There are no refunds:` +
        '\n  that money belongs on the household account balance, moved there by hand.' +
        '\n  The backfill writes a zero balance on them and mints nothing.',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  // THE TARGET IS THE FIRST THING PRINTED, before a single read, so an operator
  // who typed the wrong flag sees it while the run is still worth cancelling.
  console.log(describeTarget(target));

  if (getApps().length === 0) initializeApp({ projectId: target.projectId });

  const result = await run(args.samples);
  summarise(result);
  console.log('\nREAD-ONLY. Nothing was written.');
}

// Only auto-run when invoked directly, not when imported by tests.
const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
