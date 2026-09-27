/**
 * reportAutoApplyDoubleCredit.ts
 *
 * READ-ONLY. Answers the #977 question: has any household been given account
 * credit for invoice money that `markInvoicePaid` had already put on the
 * invoice?
 *
 * Admin web (Mark paid) and admin Android (Record payment) record a payment in
 * two calls: `markInvoicePaid` settles the invoice, then `recordPayment` writes
 * the root `payments` row with `invoiceId` as a display link and no `apply`.
 * Before #977, that second call treated the whole payment (less the tip) as
 * unapplied, so with "Automatically apply any unapplied amount" ticked it also
 * added the invoice money to `families/{id}.accountBalanceCents`. The fix stops
 * new ones. This script lists the rows that could carry one.
 *
 * WHAT IT READS.
 *   - `payments` where `autoApply == true`, filtered here to rows with no
 *     `appliedInvoiceId` (this call applied nothing itself), a non-blank
 *     `invoiceId` (linked to an invoice, so the two-step flow) and
 *     `creditedToAccountCents > 0` (credit was actually given).
 *   - For each row's invoice, the `invoices/{id}/payments` settlement rows, so
 *     the operator can see which one the payment settled with and for how much.
 *   - For each household, `families/{id}.accountBalanceCents` as it stands now.
 *
 * WHICH ROWS ARE THE DEFECT. The filter above also matches a correct credit
 * written after the fix: $200 paid on a $127.50 invoice with a $10 tip credits
 * a real $62.50. Each row is therefore labelled:
 *   - `pre-fix`:  no `settledByInvoicePaymentId` stored. The credit was
 *                 computed as amount - tip, so it includes the invoice money.
 *                 On these rows `creditedToAccountCents == amountCents -
 *                 tipCents` and `appliedCents == 0`.
 *   - `post-fix`: `settledByInvoicePaymentId` stored. The credit is the real
 *                 leftover, read against that settlement row.
 * It does not decide what anyone is owed or repair anything. A repair needs an
 * operator ruling (no refunds, ever; account balance is the only destination
 * for money owed back, and credit already spent cannot be taken back cleanly).
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, batch or
 * transaction call, and `test/reportAutoApplyDoubleCredit.test.ts` greps it.
 * There is no apply mode.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *     `--allow-prod` here confirms which database is READ; nothing is written.
 *
 * WHAT IS PRINTED. Ids (payment, household, invoice, settlement row), cents and
 * times. No names, emails, addresses, notes or references.
 *
 * Usage (the operator runs the prod form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:autoapply-double-credit -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846), as in the other reports.
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';

const PAGE = 500;

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
          'reportAutoApplyDoubleCredit.ts: READ-ONLY list of auto-applied payments linked to an invoice',
          'that credited the household account (#977)',
          '',
          '  npm --prefix mytribe/functions run report:autoapply-double-credit -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Prints ids, cents and times only.',
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
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-977' };
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

/**
 * Pure: does this `payments` row match the #977 filter? `autoApply` is already
 * the query's equality; it is checked again so the function stands alone.
 */
export function matchesFilter(d: Data): boolean {
  return (
    d['autoApply'] === true &&
    str(d['appliedInvoiceId']) === '' &&
    str(d['invoiceId']) !== '' &&
    (cents(d['creditedToAccountCents']) ?? 0) > 0
  );
}

export type Era = 'pre-fix' | 'post-fix';

/** Pure: see the header. A stored settlement id is what the #977 fix writes. */
export function eraOf(d: Data): Era {
  return str(d['settledByInvoicePaymentId']) !== '' ? 'post-fix' : 'pre-fix';
}

export interface SettlementRow {
  id: string;
  amountCents: number | null;
  createdAtMs: number | null;
}

export interface Finding {
  paymentId: string;
  era: Era;
  kinfolkId: string;
  invoiceId: string;
  createdAtMs: number | null;
  amountCents: number | null;
  tipCents: number | null;
  appliedCents: number | null;
  unappliedCents: number | null;
  creditedToAccountCents: number;
  settledByInvoicePaymentId: string;
}

/** Pure: one matching row reduced to what is printed. */
export function findingOf(id: string, d: Data): Finding {
  return {
    paymentId: id,
    era: eraOf(d),
    kinfolkId: str(d['kinfolkId']),
    invoiceId: str(d['invoiceId']),
    createdAtMs: msOf(d['createdAt']),
    amountCents: cents(d['amountCents']),
    tipCents: cents(d['tipCents']),
    appliedCents: cents(d['appliedCents']),
    unappliedCents: cents(d['unappliedCents']),
    creditedToAccountCents: cents(d['creditedToAccountCents']) ?? 0,
    settledByInvoicePaymentId: str(d['settledByInvoicePaymentId']),
  };
}

export interface Report {
  scanned: number;
  findings: Finding[];
  /** `families/{id}.accountBalanceCents` now; null when the doc or the field is absent. */
  balances: Map<string, number | null>;
  /** Every settlement row on each finding's invoice, oldest first. */
  settlements: Map<string, SettlementRow[]>;
}

async function scanAutoApplied(db: Firestore): Promise<{ scanned: number; findings: Finding[] }> {
  const findings: Finding[] = [];
  let scanned = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('payments').where('autoApply', '==', true).orderBy('__name__').limit(PAGE);
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
  const { scanned, findings } = await scanAutoApplied(db);
  // Built from entry lists rather than `Map#set`, so the no-write grep in the
  // test can stay a plain substring check over this whole file.
  const balanceEntries: Array<[string, number | null]> = [];
  for (const kinfolkId of new Set(findings.map((f) => f.kinfolkId).filter((id) => id !== ''))) {
    const snap = await db.collection('families').doc(kinfolkId).get();
    balanceEntries.push([kinfolkId, snap.exists ? cents((snap.data() ?? {})['accountBalanceCents']) : null]);
  }
  const settlementEntries: Array<[string, SettlementRow[]]> = [];
  for (const invoiceId of new Set(findings.map((f) => f.invoiceId))) {
    const snap = await db.collection('invoices').doc(invoiceId).collection('payments').get();
    const rows = snap.docs.map((doc) => {
      const d = (doc.data() ?? {}) as Data;
      const c = cents(d['amountCents']);
      const dollars = typeof d['amount'] === 'number' && Number.isFinite(d['amount']) ? Math.round(d['amount'] * 100) : null;
      return { id: doc.id, amountCents: c ?? dollars, createdAtMs: msOf(d['createdAt']) };
    });
    settlementEntries.push([invoiceId, rows.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))]);
  }
  findings.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  return { scanned, findings, balances: new Map(balanceEntries), settlements: new Map(settlementEntries) };
}

function iso(ms: number | null): string {
  return ms === null ? 'no time' : new Date(ms).toISOString();
}

function orNone(n: number | null): string {
  return n === null ? 'none' : String(n);
}

function printReport(r: Report): void {
  console.log('READ-ONLY #977 report: auto-applied payments linked to an invoice that credited the account. Nothing was written.');
  console.log(`Scanned: ${r.scanned} payments row(s) with autoApply true.`);
  if (r.findings.length === 0) {
    console.log('MATCHING ROWS: none found.');
    return;
  }
  const pre = r.findings.filter((f) => f.era === 'pre-fix');
  console.log(
    `MATCHING ROWS: ${r.findings.length} (${pre.length} pre-fix, ${r.findings.length - pre.length} post-fix), ` +
      `${new Set(r.findings.map((f) => f.kinfolkId)).size} household(s).`,
  );
  console.log(
    `Pre-fix credit given, in cents: ${pre.reduce((n, f) => n + f.creditedToAccountCents, 0)}. ` +
      'Part of each is the invoice money; the settlement rows below show how much.',
  );
  for (const f of r.findings) {
    console.log(
      `  [${f.era}] payment=${f.paymentId}  at=${iso(f.createdAtMs)}  household=${f.kinfolkId || '(none)'}  invoice=${f.invoiceId}`,
    );
    console.log(
      `      amountCents=${orNone(f.amountCents)}  tipCents=${orNone(f.tipCents)}  appliedCents=${orNone(f.appliedCents)}  ` +
        `unappliedCents=${orNone(f.unappliedCents)}  creditedToAccountCents=${f.creditedToAccountCents}  ` +
        `settledBy=${f.settledByInvoicePaymentId || '(none)'}`,
    );
    const balance = r.balances.get(f.kinfolkId);
    console.log(`      household accountBalanceCents now=${balance === undefined || balance === null ? 'none' : balance}`);
    for (const s of r.settlements.get(f.invoiceId) ?? []) {
      console.log(`      settlement ${s.id}  amountCents=${orNone(s.amountCents)}  at=${iso(s.createdAtMs)}`);
    }
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
