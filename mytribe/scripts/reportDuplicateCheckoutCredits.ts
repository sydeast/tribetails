/**
 * reportDuplicateCheckoutCredits.ts
 *
 * READ-ONLY. Answers the docket Q5 question: which card payments did the
 * Stripe webhook's old duplicate-checkout branch put on a household's account
 * balance by itself?
 *
 * Until the 2026-09-27 ruling ("Invoices shouldn't allow payment once marked as
 * paid"), `billing/stripeWebhook.ts` handled a card charge that landed on an
 * invoice already settled (a second tab, a stale checkout round, a bill marked
 * paid by hand) by adding the WHOLE charge to `families/{id}.accountBalanceCents`.
 * The ruling says account credit happens only when the admin enters an amount
 * (#988). The webhook now records such a charge as an unapplied payment for the
 * admin instead. This script lists the ones credited before that.
 *
 * WHAT IT READS.
 *   - `payments` where `appliedTo == 'accountCredit'`. That value was written
 *     by that branch and by nothing else, so it selects exactly its rows. Each
 *     row's `amountCents` is what was credited (the branch credited the Stripe
 *     amount in full, or nothing when it had none).
 *   - For each household, `families/{id}.accountBalanceCents` as it stands now.
 *   - For each invoice, its current `status`, so the operator can see the bill
 *     the charge landed on.
 * It does not decide what anyone is owed or change anything. Credit already
 * spent cannot be taken back cleanly, and there are no refunds, ever.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, batch or
 * transaction call, and `test/reportDuplicateCheckoutCredits.test.ts` greps it.
 * There is no apply mode.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *     `--allow-prod` here confirms which database is READ; nothing is written.
 *
 * WHAT IS PRINTED. Ids (payment, Stripe event, household, invoice), cents,
 * reasons and times. No names, emails, addresses, notes or references.
 *
 * Usage (the operator runs the prod form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:duplicate-checkout-credits -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846), as in the other reports.
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';

const PAGE = 500;

/** The marker the old branch wrote. See the header. */
export const OLD_BRANCH_MARKER = 'accountCredit';

export interface Args {
  projectId: string | null;
  allowProd: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false };
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
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportDuplicateCheckoutCredits.ts: READ-ONLY list of card payments the Stripe webhook',
          'credited to a household account balance by itself (docket Q5)',
          '',
          '  npm --prefix mytribe/functions run report:duplicate-checkout-credits -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Prints ids, cents, reasons and times only.',
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
 * Which database this run reads, or a refusal. Decided before anything connects.
 * `env` is passed in so the unit test can drive every branch.
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
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-q5' };
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

type Data = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function cents(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** A Firestore Timestamp, a Date, an ISO string or ms, as ms. Null when unreadable. */
export function msOf(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toMillis?: () => number };
  return typeof maybe.toMillis === 'function' ? maybe.toMillis() : null;
}

/** Pure: is this `payments` row one the old branch wrote? Rechecks the query's equality. */
export function matchesFilter(d: Data): boolean {
  return d['appliedTo'] === OLD_BRANCH_MARKER && d['appliedToInvoice'] === false;
}

export interface Finding {
  paymentId: string;
  stripeEventId: string;
  kinfolkId: string;
  invoiceId: string;
  atMs: number | null;
  /** What the branch credited. Null when Stripe reported no amount, and then nothing was credited. */
  creditedCents: number | null;
  duplicateCheckoutReason: string;
  duplicateOfPaymentIntentId: string;
}

/** Pure: one matching row reduced to what is printed. */
export function findingOf(id: string, d: Data): Finding {
  const amount = cents(d['amountCents']);
  return {
    paymentId: id,
    stripeEventId: str(d['stripeEventId']),
    kinfolkId: str(d['kinfolkId']),
    invoiceId: str(d['invoiceId']),
    atMs: msOf(d['date']),
    creditedCents: d['amountResolved'] === true && amount !== null && amount > 0 ? amount : null,
    duplicateCheckoutReason: str(d['duplicateCheckoutReason']),
    duplicateOfPaymentIntentId: str(d['duplicateOfPaymentIntentId']),
  };
}

export interface Report {
  scanned: number;
  findings: Finding[];
  /** `families/{id}.accountBalanceCents` now; null when the doc or the field is absent. */
  balances: Map<string, number | null>;
  /** `invoices/{id}.status` now; '' when absent, null when the invoice is gone. */
  invoiceStatus: Map<string, string | null>;
}

async function scanMarked(db: Firestore): Promise<{ scanned: number; findings: Finding[] }> {
  const findings: Finding[] = [];
  let scanned = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('payments').where('appliedTo', '==', OLD_BRANCH_MARKER).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) {
      scanned += 1;
      const d = (doc.data() ?? {}) as Data;
      if (matchesFilter(d)) findings.push(findingOf(doc.id, d));
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) break;
  }
  return { scanned, findings };
}

/** Reads the matching rows, then the households and invoices they name. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const { scanned, findings } = await scanMarked(db);
  // Built from entry lists rather than `Map#set`, so the no-write grep in the
  // test can stay a plain substring check over this whole file.
  const balanceEntries: Array<[string, number | null]> = [];
  for (const kinfolkId of new Set(findings.map((f) => f.kinfolkId).filter((id) => id !== ''))) {
    const snap = await db.collection('families').doc(kinfolkId).get();
    balanceEntries.push([kinfolkId, snap.exists ? cents((snap.data() ?? {})['accountBalanceCents']) : null]);
  }
  const statusEntries: Array<[string, string | null]> = [];
  for (const invoiceId of new Set(findings.map((f) => f.invoiceId).filter((id) => id !== ''))) {
    const snap = await db.collection('invoices').doc(invoiceId).get();
    statusEntries.push([invoiceId, snap.exists ? str((snap.data() ?? {})['status']) : null]);
  }
  findings.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  return { scanned, findings, balances: new Map(balanceEntries), invoiceStatus: new Map(statusEntries) };
}

function iso(ms: number | null): string {
  return ms === null ? 'no time' : new Date(ms).toISOString();
}

/** Pure: the total credited, in cents, over rows that credited anything. */
export function totalCreditedCents(findings: Finding[]): number {
  return findings.reduce((n, f) => n + (f.creditedCents ?? 0), 0);
}

function printReport(r: Report): void {
  console.log('READ-ONLY docket Q5 report: card payments the Stripe webhook credited to an account by itself. Nothing was written.');
  console.log(`Scanned: ${r.scanned} payments row(s) marked appliedTo=${OLD_BRANCH_MARKER}.`);
  if (r.findings.length === 0) {
    console.log('MATCHING ROWS: none found.');
    return;
  }
  console.log(
    `MATCHING ROWS: ${r.findings.length}, ${new Set(r.findings.map((f) => f.kinfolkId)).size} household(s), ` +
      `credited in cents: ${totalCreditedCents(r.findings)}.`,
  );
  for (const f of r.findings) {
    console.log(
      `  payment=${f.paymentId}  stripeEvent=${f.stripeEventId || '(none)'}  at=${iso(f.atMs)}  household=${f.kinfolkId || '(none)'}  invoice=${f.invoiceId || '(none)'}`,
    );
    const status = r.invoiceStatus.get(f.invoiceId);
    console.log(
      `      creditedCents=${f.creditedCents === null ? 'none (no Stripe amount, nothing credited)' : f.creditedCents}  ` +
        `reason=${f.duplicateCheckoutReason || '(none)'}  duplicateOf=${f.duplicateOfPaymentIntentId || '(none)'}  ` +
        `invoice status now=${status === undefined || status === null ? 'invoice not found' : status || '(none)'}`,
    );
    const balance = r.balances.get(f.kinfolkId);
    console.log(`      household accountBalanceCents now=${balance === undefined || balance === null ? 'none' : balance}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  console.log(describeTarget(target));
  if (getApps().length === 0) initializeApp({ projectId: target.projectId });
  printReport(await buildReport(getFirestore()));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
