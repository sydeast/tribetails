/**
 * reportDesktopDirectPayments.ts
 *
 * READ-ONLY. Answers the #881 question: which `payments` rows were written by
 * the desktop console's old Record Payment path, so the operator can reconcile
 * the invoices they belong to?
 *
 * Until #881 the desktop dialog wrote `payments` rows directly over REST
 * (`FirestoreClient.recordPayment`), never through the `recordPayment` callable.
 * So each such row names an invoice, but the invoice was never moved, the
 * account balance was never touched, no audit entry was written and no
 * confirmation went out. #881 routes the dialog through the callable; this
 * script lists the rows already written the old way.
 *
 * WHAT MAKES A ROW A CANDIDATE. All of these at once:
 *   - it names an invoice (`invoiceId` is not blank);
 *   - it is not a Stripe row (no `stripeEventId`);
 *   - it carries no `recordedBy`, which the callable stamps on every row it
 *     writes and the direct REST write never did;
 *   - no `activity_log` entry with actionType BILLING_PAYMENT_RECORDED names it
 *     as its target, which the callable writes for every payment;
 *   - the invoice it names is still open (`invoiceStateOf` says 'open').
 *
 * WHAT IT CANNOT TELL. Android's direct write before W2-1 and the data
 * re-upload also produced rows with no `recordedBy` and no audit entry. Those
 * are listed too if their invoice is still open; the columns printed (doc id
 * shape, method, date, whether the row has `createdAt` or `tipBasis`) are there
 * so the operator can tell them apart. It decides nothing and fixes nothing.
 * Imported rows keep their original dates, so the `date` column is the
 * payment's own date, not when the row was written.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, batch or
 * transaction call, and `reportDesktopDirectPayments.test.ts` greps it. There
 * is no write mode and no `--allow-prod` flag; passing one is refused, so a
 * command copied from a backfill cannot be mistaken for one that writes.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator.
 *   - Not set: reads the production project named by `--project`, which is
 *     required (no fallback to ambient gcloud settings), so the project read is
 *     always the one typed on the command line.
 *
 * NOTHING PRIVATE IS PRINTED. Payment ids, invoice ids, household ids, dollar
 * amounts, method, date and invoice state. No names, notes, emails or addresses.
 *
 * Usage (the operator runs this; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:desktop-direct-payments -- --project <id>
 *   npm --prefix mytribe/functions run report:desktop-direct-payments -- --project <id> --samples 200
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846).
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';
import { invoiceStateOf, type InvoiceState } from '../functions/src/lib/invoiceEditPolicy';

const PAGE = 500;
/** The audit event the `recordPayment` callable writes for every payment (lib/auditEvents.ts). */
export const PAYMENT_RECORDED_EVENT = 'BILLING_PAYMENT_RECORDED';

export interface Args {
  projectId: string | null;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, samples: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === '--project') args.projectId = value();
    else if (a === '--samples') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
    } else if (a === '--allow-prod' || a === '--apply' || a === '--write') {
      throw new Error(`${a} is refused: this report only reads and has no write mode. Drop the flag.`);
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportDesktopDirectPayments.ts: READ-ONLY list of payments rows written by the desktop',
          "console's old direct Record Payment write whose invoice is still open (#881)",
          '',
          '  npm --prefix mytribe/functions run report:desktop-direct-payments -- --project <id>',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator. Writes nothing.',
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

/** Which database this run reads, or a refusal. `env` is passed in so the unit test can drive every branch. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  if (host) return { kind: 'emulator', host, projectId: args.projectId ?? 'demo-report-881' };
  if (!args.projectId) {
    throw new Error('no FIRESTORE_EMULATOR_HOST, so this would read PRODUCTION: name the project with --project <id>.');
  }
  return { kind: 'production', projectId: args.projectId };
}

export function describeTarget(t: Target): string {
  return t.kind === 'emulator'
    ? `Target: EMULATOR ${t.host}, project ${t.projectId}`
    : `Target: PRODUCTION, project ${t.projectId} (read-only)`;
}

/** The fields of a root `payments` row this report reads. */
export interface PaymentRow {
  id: string;
  invoiceId: string;
  kinfolkId: string;
  amount: number | null;
  tip: number | null;
  paymentMethod: string;
  date: string;
  hasRecordedBy: boolean;
  hasStripeEventId: boolean;
  hasCreatedAt: boolean;
  hasTipBasis: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function paymentRowOf(id: string, data: Record<string, unknown>): PaymentRow {
  return {
    id,
    invoiceId: str(data['invoiceId']).trim(),
    kinfolkId: str(data['kinfolkId']),
    amount: num(data['amount']),
    tip: num(data['tip']),
    paymentMethod: str(data['paymentMethod']),
    date: str(data['date']),
    hasRecordedBy: str(data['recordedBy']) !== '',
    hasStripeEventId: str(data['stripeEventId']) !== '',
    hasCreatedAt: data['createdAt'] !== undefined && data['createdAt'] !== null,
    hasTipBasis: str(data['tipBasis']) !== '',
  };
}

/** Pure: could this row have come from the old desktop direct write? Says nothing yet about its invoice. */
export function looksLikeDirectWrite(row: PaymentRow, auditedPaymentIds: ReadonlySet<string>): boolean {
  return row.invoiceId !== '' && !row.hasStripeEventId && !row.hasRecordedBy && !auditedPaymentIds.has(row.id);
}

export interface Candidate {
  row: PaymentRow;
  invoiceState: InvoiceState | 'missing';
}

/**
 * Pure: the rows that look like the direct write AND whose invoice is still
 * open. `invoiceStates` maps invoice id to its current state, or 'missing'.
 */
export function findCandidates(
  rows: readonly PaymentRow[],
  auditedPaymentIds: ReadonlySet<string>,
  invoiceStates: ReadonlyMap<string, InvoiceState | 'missing'>,
): { open: Candidate[]; notOpen: Candidate[] } {
  const open: Candidate[] = [];
  const notOpen: Candidate[] = [];
  for (const row of rows) {
    if (!looksLikeDirectWrite(row, auditedPaymentIds)) continue;
    const invoiceState = invoiceStates.get(row.invoiceId) ?? 'missing';
    (invoiceState === 'open' ? open : notOpen).push({ row, invoiceState });
  }
  const byId = (a: Candidate, b: Candidate) =>
    a.row.invoiceId.localeCompare(b.row.invoiceId) || a.row.id.localeCompare(b.row.id);
  return { open: open.sort(byId), notOpen: notOpen.sort(byId) };
}

async function scanPayments(db: Firestore): Promise<PaymentRow[]> {
  const rows: PaymentRow[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('payments').orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) rows.push(paymentRowOf(doc.id, doc.data() as Record<string, unknown>));
    if (snap.size < PAGE) return rows;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return rows;
  }
}

async function scanAuditedPaymentIds(db: Firestore): Promise<Set<string>> {
  // An array, not a Set: the read-only test greps this file for the add call.
  const ids: string[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db
      .collection('activity_log')
      .where('actionType', '==', PAYMENT_RECORDED_EVENT)
      .orderBy('__name__')
      .limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const payload = (data['payload'] ?? {}) as Record<string, unknown>;
      for (const v of [data['targetId'], data['targetUid'], payload['paymentId']]) {
        if (typeof v === 'string' && v !== '') ids.push(v);
      }
    }
    if (snap.size < PAGE) return new Set(ids);
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return new Set(ids);
  }
}

async function invoiceStateFor(db: Firestore, invoiceId: string): Promise<InvoiceState | 'missing'> {
  const snap = await db.collection('invoices').doc(invoiceId).get();
  if (!snap.exists) return 'missing';
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const paid = num(data['paidCents']);
  return invoiceStateOf(data, paid);
}

export interface Report {
  scannedPayments: number;
  auditedPayments: number;
  open: Candidate[];
  notOpen: Candidate[];
}

/** Reads payments, the payment audit entries, then each named invoice. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const [rows, audited] = await Promise.all([scanPayments(db), scanAuditedPaymentIds(db)]);
  const invoiceIds = [
    ...new Set(rows.filter((r) => looksLikeDirectWrite(r, audited)).map((r) => r.invoiceId)),
  ];
  const states = new Map<string, InvoiceState | 'missing'>();
  for (const id of invoiceIds) states.set(id, await invoiceStateFor(db, id));
  const { open, notOpen } = findCandidates(rows, audited, states);
  return { scannedPayments: rows.length, auditedPayments: audited.size, open, notOpen };
}

function line(c: Candidate): string {
  const r = c.row;
  const markers = [r.hasCreatedAt ? 'createdAt' : null, r.hasTipBasis ? 'tipBasis' : null].filter(Boolean);
  return (
    `  payment=${r.id}  invoice=${r.invoiceId}  state=${c.invoiceState}  household=${r.kinfolkId || 'none'}  ` +
    `amount=${r.amount ?? 'none'}  tip=${r.tip ?? 'none'}  method=${r.paymentMethod || 'none'}  date=${r.date || 'none'}` +
    (markers.length > 0 ? `  has=${markers.join(',')}` : '')
  );
}

function printReport(r: Report, samples: number): void {
  console.log('READ-ONLY #881 report: payments rows with no recordedBy and no audit entry. Nothing was written.');
  console.log(`Scanned: ${r.scannedPayments} payments row(s); ${r.auditedPayments} payment(s) have a ${PAYMENT_RECORDED_EVENT} entry.`);
  if (r.open.length === 0) {
    console.log('INVOICE STILL OPEN: none found.');
  } else {
    console.log(`INVOICE STILL OPEN: ${r.open.length} row(s). First ${Math.min(samples, r.open.length)}:`);
    for (const c of r.open.slice(0, samples)) console.log(line(c));
  }
  const byState = new Map<string, number>();
  for (const c of r.notOpen) byState.set(c.invoiceState, (byState.get(c.invoiceState) ?? 0) + 1);
  console.log(
    `Same markers, invoice not open (not listed): ${r.notOpen.length}` +
      (byState.size > 0 ? ` (${[...byState.entries()].map(([s, n]) => `${s} ${n}`).join(', ')})` : ''),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  console.log(describeTarget(target));
  if (getApps().length === 0) initializeApp({ projectId: target.projectId });
  const report = await buildReport(getFirestore());
  printReport(report, args.samples);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
