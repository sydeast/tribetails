/**
 * reportOverAppliedInvoices.ts
 *
 * READ-ONLY. Answers the #982 question: which invoices have more money applied
 * to them than they total, and which payments put it there?
 *
 * Admin Android used to send `markInvoicePaid` the WHOLE transaction (Amount
 * plus tip, or the Payment amount box) where admin web sends only the applied
 * part. So on Android the tip, and any leftover, went onto the invoice as an
 * overpayment: the invoice's paid total went above its total, and the tip was
 * counted as invoice money. The Android fix stops new ones. This script lists
 * the invoices that could carry one, so the operator can see them.
 *
 * WHAT IT READS.
 *   - Every `invoices/{id}`, paged by document id.
 *   - Each invoice's `payments` subcollection (the settlement rows
 *     `markInvoicePaid` writes), summed with the server's own
 *     `paidCentsFromPayments`, against `invoiceTotalCentsOf`. Both come from
 *     `functions/src/lib/invoiceMath.ts`, so this report and the invoice's own
 *     settlement cannot disagree about a row.
 *   - For each invoice over its total, the root `payments` rows linked to it by
 *     `invoiceId` (the ledger rows `recordPayment` writes), so the tip and fee
 *     sit beside the settlement they came with.
 *
 * THE HINT, AND ONLY A HINT. A root row with a tip whose `amountCents` equals a
 * settlement row's `amountCents` is marked `settlement=whole-transaction`: the
 * shape the Android defect leaves (the settlement took the tip too). Ledger rows
 * written before #981 do not store which settlement they came with, so this is
 * a match on figures, not a link. An overpayment can also be genuine (a
 * household paid twice). The report says which invoices to look at; it decides
 * nothing.
 *
 * IT REPAIRS NOTHING AND WRITES NOTHING. The source contains no set, update,
 * delete, add, batch or transaction call, and
 * `test/reportOverAppliedInvoices.test.ts` greps it. There is no apply mode.
 * What a household is owed back needs an operator ruling: no refunds, ever, and
 * the household's account balance is the only place money owed back can go.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *     `--allow-prod` here confirms which database is READ; nothing is written.
 *
 * WHAT IS PRINTED. Ids (invoice, household, settlement row, ledger row), cents,
 * stored states and times. No names, emails, addresses, notes or references.
 *
 * Usage (the operator runs the prod form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:over-applied-invoices -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846), as in the other reports.
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import { invoiceTotalCentsOf, paidCentsFromPayments, type PaymentAmount } from '../functions/src/lib/invoiceMath';

const PAGE = 300;

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
          'reportOverAppliedInvoices.ts: READ-ONLY list of invoices whose applied payments exceed their total,',
          'with their settlement rows and linked ledger rows (#982)',
          '',
          '  npm --prefix mytribe/functions run report:over-applied-invoices -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Prints ids, cents, states and times only.',
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
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-982' };
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

/** One `invoices/{id}/payments` row: what `markInvoicePaid` applied. */
export interface SettlementRow {
  id: string;
  /** Through `paidCentsFromPayments`, the rule the invoice was settled with. */
  amountCents: number;
  createdAtMs: number | null;
}

export function settlementRowOf(id: string, d: Data): SettlementRow {
  return {
    id,
    amountCents: paidCentsFromPayments([d as PaymentAmount]),
    createdAtMs: msOf(d['createdAt'] ?? d['paidAt']),
  };
}

/** One root `payments` row linked to the invoice: the whole transaction. */
export interface LedgerRow {
  id: string;
  amountCents: number | null;
  tipCents: number | null;
  feeCents: number | null;
  appliedCents: number | null;
  unappliedCents: number | null;
  creditedToAccountCents: number | null;
  settledByInvoicePaymentId: string;
  createdAtMs: number | null;
}

export function ledgerRowOf(id: string, d: Data): LedgerRow {
  const dollarsAsCents =
    typeof d['amount'] === 'number' && Number.isFinite(d['amount']) ? Math.round((d['amount'] as number) * 100) : null;
  const tipDollarsAsCents =
    typeof d['tip'] === 'number' && Number.isFinite(d['tip']) ? Math.round((d['tip'] as number) * 100) : null;
  return {
    id,
    amountCents: cents(d['amountCents']) ?? dollarsAsCents,
    tipCents: cents(d['tipCents']) ?? tipDollarsAsCents,
    feeCents: cents(d['feeCents']),
    appliedCents: cents(d['appliedCents']),
    unappliedCents: cents(d['unappliedCents']),
    creditedToAccountCents: cents(d['creditedToAccountCents']),
    settledByInvoicePaymentId: str(d['settledByInvoicePaymentId']),
    createdAtMs: msOf(d['createdAt']),
  };
}

/**
 * Pure: the settlement row this ledger row most likely came with when the
 * settlement took the WHOLE transaction (the Android #982 shape), or null.
 * A stored `settledByInvoicePaymentId` is used when present; otherwise the
 * match is on figures. Only a row with a tip is matched: without a tip the
 * whole transaction and the applied part can be the same honest figure.
 */
export function wholeTransactionSettlement(ledger: LedgerRow, settlements: SettlementRow[]): string | null {
  if (ledger.amountCents === null || (ledger.tipCents ?? 0) <= 0) return null;
  const candidates =
    ledger.settledByInvoicePaymentId !== ''
      ? settlements.filter((s) => s.id === ledger.settledByInvoicePaymentId)
      : settlements;
  return candidates.find((s) => s.amountCents === ledger.amountCents)?.id ?? null;
}

export interface Finding {
  invoiceId: string;
  kinfolkId: string;
  storedState: string;
  totalCents: number;
  paidCents: number;
  overCents: number;
  settlements: SettlementRow[];
  ledger: LedgerRow[];
}

/**
 * Pure: is this invoice over its total? Returns the finding without its ledger
 * rows (read afterwards, only for matches), or null.
 */
export function overApplied(invoiceId: string, invoice: Data, settlements: SettlementRow[]): Finding | null {
  const totalCents = invoiceTotalCentsOf(invoice as { totalCents?: unknown; total?: unknown });
  const paidCents = settlements.reduce((n, s) => n + s.amountCents, 0);
  if (paidCents <= totalCents) return null;
  return {
    invoiceId,
    kinfolkId: str(invoice['kinfolkId']),
    storedState: str(invoice['state']) || str(invoice['status']) || '(none)',
    totalCents,
    paidCents,
    overCents: paidCents - totalCents,
    settlements: [...settlements].sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)),
    ledger: [],
  };
}

export interface Report {
  scanned: number;
  findings: Finding[];
}

/** Reads every invoice and its settlement rows, then the ledger rows of the matches. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const findings: Finding[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  // Paged by document id, present on every doc by construction. `date` and
  // `createdAt` are absent or free-text on part of this collection, and
  // ordering by either drops rows.
  for (;;) {
    let q = db.collection('invoices').orderBy('__name__').limit(PAGE);
    if (cursor !== null) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.docs.length === 0) break;
    for (const inv of page.docs) {
      scanned += 1;
      cursor = inv.id;
      const rows = await inv.ref.collection('payments').get();
      if (rows.empty) continue;
      const settlements = rows.docs.map((r) => settlementRowOf(r.id, (r.data() ?? {}) as Data));
      const finding = overApplied(inv.id, (inv.data() ?? {}) as Data, settlements);
      if (!finding) continue;
      const ledger = await db.collection('payments').where('invoiceId', '==', inv.id).get();
      findings.push({
        ...finding,
        ledger: ledger.docs
          .map((r) => ledgerRowOf(r.id, (r.data() ?? {}) as Data))
          .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)),
      });
    }
    if (page.docs.length < PAGE) break;
  }
  return { scanned, findings };
}

function iso(ms: number | null): string {
  return ms === null ? 'no time' : new Date(ms).toISOString();
}

function orNone(n: number | null): string {
  return n === null ? 'none' : String(n);
}

function printReport(r: Report): void {
  console.log('READ-ONLY #982 report: invoices whose applied payments exceed their total. Nothing was written.');
  console.log(`Scanned: ${r.scanned} invoice(s).`);
  if (r.findings.length === 0) {
    console.log('OVER-APPLIED INVOICES: none found.');
    return;
  }
  const hinted = r.findings.filter((f) => f.ledger.some((l) => wholeTransactionSettlement(l, f.settlements) !== null));
  console.log(
    `OVER-APPLIED INVOICES: ${r.findings.length}, ${new Set(r.findings.map((f) => f.kinfolkId)).size} household(s), ` +
      `${r.findings.reduce((n, f) => n + f.overCents, 0)} cents over in all. ` +
      `${hinted.length} have a settlement equal to a whole transaction with a tip (the Android shape).`,
  );
  for (const f of r.findings) {
    console.log(
      `  invoice=${f.invoiceId}  household=${f.kinfolkId || '(none)'}  state=${f.storedState}  ` +
        `totalCents=${f.totalCents}  paidCents=${f.paidCents}  overCents=${f.overCents}`,
    );
    for (const s of f.settlements) {
      console.log(`      settlement ${s.id}  amountCents=${s.amountCents}  at=${iso(s.createdAtMs)}`);
    }
    if (f.ledger.length === 0) console.log('      ledger rows: none linked to this invoice');
    for (const l of f.ledger) {
      const whole = wholeTransactionSettlement(l, f.settlements);
      console.log(
        `      ledger ${l.id}  amountCents=${orNone(l.amountCents)}  tipCents=${orNone(l.tipCents)}  ` +
          `feeCents=${orNone(l.feeCents)}  appliedCents=${orNone(l.appliedCents)}  ` +
          `unappliedCents=${orNone(l.unappliedCents)}  creditedToAccountCents=${orNone(l.creditedToAccountCents)}  ` +
          `settledBy=${l.settledByInvoicePaymentId || '(none)'}  at=${iso(l.createdAtMs)}` +
          (whole ? `  settlement=whole-transaction(${whole})` : ''),
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  // THE TARGET IS THE FIRST THING PRINTED, before a single read.
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
