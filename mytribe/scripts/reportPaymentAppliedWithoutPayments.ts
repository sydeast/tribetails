/**
 * reportPaymentAppliedWithoutPayments.ts
 *
 * READ-ONLY. Answers the #884 question: has any household been told "Payment
 * applied" about an invoice that has no payment recorded against it at all?
 *
 * Before #884 the invoice trigger (`onInvoicesWrite`) announced a payment
 * whenever a write left `amountDue <= 0` on a doc that was not a draft or
 * cancelled, and a created doc counted as a change. So a $0 comped invoice, an
 * amount-less quote, an unlabeled credit, and an edit that lowered the total all
 * sent `invoice.payment.applied` with no payment behind it. The fix stops new
 * ones. This script reads what was already delivered and says.
 *
 * WHAT IT READS.
 *   - `notifications` where `key == 'invoice.payment.applied'`, reduced to the
 *     invoice each is about (the stored target, or `data.invoiceId` on documents
 *     written before targets were stamped), exactly as the #832 report derives it.
 *   - For each distinct invoice: whether ANY payment row names it, in either
 *     place one is written:
 *       invoices/{id}/payments       the settlement rows (markInvoicePaid,
 *                                    recordPayment's apply, the credit draw)
 *       payments where invoiceId==id the root ledger (recordPayment, the Stripe
 *                                    webhook's `payments/{eventId}`)
 *   - The invoice doc itself, for its current state (`invoiceStateOf`) and its
 *     `paidCents`, so a reader can tell a $0 invoice from a legacy bill paid
 *     before payment rows were recorded.
 *
 * WHAT IS REPORTED. Invoices with at least one delivered notice and no payment
 * row in either place. Legacy invoices marked paid by hand before any row was
 * written appear too; the state and `paidCents` columns are there to tell them
 * apart. It does not decide which were harmful.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, batch or
 * transaction call, and `reportPaymentAppliedWithoutPayments.test.ts` greps it.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *
 * NOTHING PRIVATE IS PRINTED. Invoice ids, notification paths, uids, identities,
 * states, cents and times. No `data`, no titles, no names.
 *
 * Usage (the operator runs the prod form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:payment-applied-without-payments -- --project <id> --allow-prod
 *   npm --prefix mytribe/functions run report:payment-applied-without-payments -- --project <id> --allow-prod --samples 100
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 *
 * STATUS (docs/RUNBOOK.md, "Scripts and the data re-upload"): post-import
 * check. Run once the invoice and payment re-upload is done, to catch an
 * import that marked an invoice paid without carrying its payment rows over.
 */
// The single firebase-admin import point (#846), as in the #832 report.
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';
import { PAYMENT_APPLIED_KEY, rowOf, type NotificationRow } from './reportDuplicateNotifications';
import { invoiceStateOf, type InvoiceState } from '../functions/src/lib/invoiceEditPolicy';

const PAGE = 500;

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, samples: 50 };
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
          'reportPaymentAppliedWithoutPayments.ts: READ-ONLY list of invoice.payment.applied notifications',
          'about invoices that have no payment row (#884)',
          '',
          '  npm --prefix mytribe/functions run report:payment-applied-without-payments -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Prints ids, paths, uids, states, cents and times only.',
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
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-884' };
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

/** What is known about one invoice, read without writing. */
export interface InvoiceFacts {
  exists: boolean;
  state: InvoiceState | null;
  paidCents: number | null;
  hasPaymentRow: boolean;
}

export interface UnbackedInvoice {
  invoiceId: string;
  state: InvoiceState | 'missing';
  paidCents: number | null;
  /** Every delivered notice about it, oldest first. */
  notices: Array<{ path: string; recipientUid: string; identity: string; atMs: number | null }>;
}

/**
 * Pure: the delivered `invoice.payment.applied` rows whose invoice has no
 * payment row, grouped by invoice. Rows about no invoice are skipped.
 */
export function findUnbacked(rows: readonly NotificationRow[], facts: ReadonlyMap<string, InvoiceFacts>): UnbackedInvoice[] {
  const groups = new Map<string, NotificationRow[]>();
  for (const row of rows) {
    if (row.collection !== 'notifications' || row.key !== PAYMENT_APPLIED_KEY || row.invoiceId === '') continue;
    const list = groups.get(row.invoiceId);
    if (list) list.push(row);
    else groups.set(row.invoiceId, [row]);
  }
  const out: UnbackedInvoice[] = [];
  for (const [invoiceId, list] of groups) {
    const f = facts.get(invoiceId);
    if (!f || f.hasPaymentRow) continue;
    const notices = [...list]
      .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
      .map((r) => ({ path: r.path, recipientUid: r.recipientUid, identity: r.identity, atMs: r.atMs }));
    out.push({ invoiceId, state: f.exists && f.state ? f.state : 'missing', paidCents: f.paidCents, notices });
  }
  return out.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
}

async function scanNotices(db: Firestore): Promise<NotificationRow[]> {
  const rows: NotificationRow[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('notifications').where('key', '==', PAYMENT_APPLIED_KEY).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) rows.push(rowOf(doc.ref.path, 'notifications', doc.data() as Record<string, unknown>));
    if (snap.size < PAGE) return rows;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return rows;
  }
}

async function factsFor(db: Firestore, invoiceId: string): Promise<InvoiceFacts> {
  const invoiceDoc = db.collection('invoices').doc(invoiceId);
  const [snap, sub, root] = await Promise.all([
    invoiceDoc.get(),
    invoiceDoc.collection('payments').limit(1).get(),
    db.collection('payments').where('invoiceId', '==', invoiceId).limit(1).get(),
  ]);
  const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  const paid = data?.['paidCents'];
  return {
    exists: snap.exists,
    state: data ? invoiceStateOf(data) : null,
    paidCents: typeof paid === 'number' && Number.isFinite(paid) ? paid : null,
    hasPaymentRow: !sub.empty || !root.empty,
  };
}

export interface Report {
  scannedNotices: number;
  invoicesChecked: number;
  unbacked: UnbackedInvoice[];
  /** Distinct recipients of an unbacked notice. Households and office copies alike. */
  recipients: number;
}

/** Reads the notices, then the invoices and payment rows they name. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const rows = await scanNotices(db);
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId).filter((id) => id !== ''))];
  const facts = new Map<string, InvoiceFacts>();
  for (const id of invoiceIds) facts.set(id, await factsFor(db, id));
  const unbacked = findUnbacked(rows, facts);
  return {
    scannedNotices: rows.length,
    invoicesChecked: invoiceIds.length,
    unbacked,
    recipients: new Set(unbacked.flatMap((u) => u.notices.map((n) => n.recipientUid))).size,
  };
}

function printReport(r: Report, samples: number): void {
  console.log('READ-ONLY #884 report: invoice.payment.applied about invoices with no payment row. Nothing was written.');
  console.log(`Scanned: ${r.scannedNotices} notification(s) about ${r.invoicesChecked} invoice(s).`);
  if (r.unbacked.length === 0) {
    console.log('NO PAYMENT ROW: none found.');
    return;
  }
  const notices = r.unbacked.reduce((n, u) => n + u.notices.length, 0);
  console.log(
    `NO PAYMENT ROW: ${r.unbacked.length} invoice(s), ${notices} notification(s), ${r.recipients} recipient(s) (households and office copies).`,
  );
  const byState = new Map<string, number>();
  for (const u of r.unbacked) byState.set(u.state, (byState.get(u.state) ?? 0) + 1);
  console.log(`By current invoice state: ${[...byState.entries()].map(([s, n]) => `${s} ${n}`).join(', ')}`);
  console.log(`First ${Math.min(samples, r.unbacked.length)} of ${r.unbacked.length}:`);
  for (const u of r.unbacked.slice(0, samples)) {
    console.log(`  invoice=${u.invoiceId}  state=${u.state}  paidCents=${u.paidCents ?? 'none'}`);
    for (const n of u.notices) {
      const at = n.atMs === null ? 'no time' : new Date(n.atMs).toISOString();
      console.log(`      ${at}  ${n.path}  recipient=${n.recipientUid}  ${n.identity}`);
    }
  }
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
