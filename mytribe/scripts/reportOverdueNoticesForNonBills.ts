/**
 * reportOverdueNoticesForNonBills.ts
 *
 * READ-ONLY. Answers the #871 question: has any household been chased about an
 * invoice that was not a live bill when the notice went out?
 *
 * Before #871 the overdue and reminder crons, and the reminder button, checked
 * only a `paid` label, `paymentStatus: 'PAID'` or `amountDue <= 0`. A cancelled
 * invoice, an unaccepted quote, a draft or a credit with a balance and a due date
 * in range could be sent `invoice.overdue` or `invoice.reminder`. The fix stops
 * new ones. This script reads what was already sent and says.
 *
 * WHAT IT READS.
 *   - `notifications` and `scheduledNotifications` where `key` is
 *     `invoice.overdue` or `invoice.reminder`, reduced to the invoice each is
 *     about (the #832 report's `rowOf`).
 *   - For each distinct invoice: the invoice doc and its `payments` subcollection.
 *   - Separately, every invoice carrying `overdueNotifiedAtMs` or
 *     `reminderNotifiedAtMs`, joined to its current state (the issue's count).
 *
 * WHAT IS FLAGGED, per notice, judged AT THE NOTICE'S OWN TIME where the data
 * allows it:
 *   paid_at_send          `paidAt` at or before the notice, or payment rows
 *                         created at or before it covering the total.
 *   unaccepted_quote      still labelled quote now and never accepted, or
 *                         accepted only after the notice (`quoteDecidedAt`).
 *   cancelled             cancelled NOW. No writer stamps when an invoice was
 *                         cancelled, so this cannot be dated; said as such.
 *   archived_at_send      `archivedAt` at or before the notice.
 *   other_not_open_now    draft, credit, redeemed or zero now. Current state only.
 *   missing               the invoice doc no longer exists.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, batch or
 * transaction call, and reportOverdueNoticesForNonBills.test.ts greps it. So
 * there is no apply mode: every run is the dry run.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *
 * NOTHING PRIVATE IS PRINTED. Invoice ids, notification document paths, keys,
 * states, flags and counts. No uids, no names, no amounts, no message content.
 *
 * Usage (the operator runs the prod form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:overdue-notices-non-bills -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 *
 * STATUS (docs/RUNBOOK.md, "Scripts and the data re-upload"): post-import
 * check. Run after the invoice re-upload and after the household
 * notification gate reopens, to confirm none of the re-uploaded invoices'
 * newly-overdue notices went to a household about a bill that was never live.
 */
// The single firebase-admin import point (#846), as in the #832 and #884 reports.
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';
import { rowOf, type NotificationRow, type ScannedCollection } from './reportDuplicateNotifications';
import { invoiceStateOf, quoteAcceptanceOf, type InvoiceState } from '../functions/src/lib/invoiceEditPolicy';
import { invoiceTotalCentsOf, paidCentsFromPayments } from '../functions/src/lib/invoiceMath';

const PAGE = 500;

export const CHASE_KEYS = ['invoice.overdue', 'invoice.reminder'] as const;
export type ChaseKey = (typeof CHASE_KEYS)[number];

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
          'reportOverdueNoticesForNonBills.ts: READ-ONLY list of invoice.overdue and invoice.reminder',
          'notifications about invoices that were not a live bill when they went out (#871)',
          '',
          '  npm --prefix mytribe/functions run report:overdue-notices-non-bills -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Prints ids, paths, keys, states, flags and counts only.',
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

/** Which database this run reads, or a refusal. `env` is passed in so the unit test drives every branch. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const projectId = args.projectId ?? env['GCLOUD_PROJECT'] ?? env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (host) {
    if (args.allowProd) {
      throw new Error(
        `refusing --allow-prod while FIRESTORE_EMULATOR_HOST=${host} is set: this run would read the emulator, not production. Unset it to read production.`,
      );
    }
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-871' };
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

/** Millis from a Timestamp, a number, or an ISO string; null otherwise. */
export function millisOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** What is known about one invoice, read without writing. */
export interface InvoiceFacts {
  exists: boolean;
  state: InvoiceState | null;
  quoteLabelled: boolean;
  accepted: boolean;
  quoteDecidedAtMs: number | null;
  paidAtMs: number | null;
  archivedAtMs: number | null;
  totalCents: number;
  /** Each payment row's creation time (null when unstamped) and cents. */
  payments: Array<{ atMs: number | null; cents: number }>;
}

export const MISSING: InvoiceFacts = {
  exists: false,
  state: null,
  quoteLabelled: false,
  accepted: false,
  quoteDecidedAtMs: null,
  paidAtMs: null,
  archivedAtMs: null,
  totalCents: 0,
  payments: [],
};

/** Pure: the facts from a raw invoice doc and its payment rows. */
export function factsOf(doc: Record<string, unknown> | null, paymentRows: ReadonlyArray<Record<string, unknown>>): InvoiceFacts {
  if (!doc) return MISSING;
  const label = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  return {
    exists: true,
    state: invoiceStateOf(doc),
    quoteLabelled: label(doc['status']) === 'quote' || label(doc['invoiceStatus']) === 'quote',
    accepted: quoteAcceptanceOf(doc) === 'accepted',
    quoteDecidedAtMs: millisOf(doc['quoteDecidedAt']),
    paidAtMs: millisOf(doc['paidAt']),
    archivedAtMs: doc['archivedAt'] === null || doc['archivedAt'] === undefined ? null : millisOf(doc['archivedAt']),
    totalCents: invoiceTotalCentsOf(doc),
    payments: paymentRows.map((p) => ({
      atMs: millisOf(p['createdAt']) ?? millisOf(p['paidAt']),
      cents: paidCentsFromPayments([p as { amount?: number; amountCents?: number }]),
    })),
  };
}

export type Flag =
  | 'paid_at_send'
  | 'unaccepted_quote'
  | 'cancelled'
  | 'archived_at_send'
  | 'other_not_open_now'
  | 'missing';

/**
 * Pure: why this notice should not have gone out, judged at [atMs] where the
 * data can be dated. Empty when nothing says it was wrong.
 */
export function flagsFor(atMs: number | null, f: InvoiceFacts): Flag[] {
  if (!f.exists) return ['missing'];
  const flags: Flag[] = [];
  const before = (ms: number | null) => ms !== null && atMs !== null && ms <= atMs;

  const paidRowsCents = f.payments.filter((p) => before(p.atMs)).reduce((n, p) => n + p.cents, 0);
  if (before(f.paidAtMs) || (f.totalCents > 0 && paidRowsCents >= f.totalCents)) flags.push('paid_at_send');

  const acceptedAfter = f.accepted && f.quoteDecidedAtMs !== null && atMs !== null && f.quoteDecidedAtMs > atMs;
  if ((f.quoteLabelled && !f.accepted) || acceptedAfter) flags.push('unaccepted_quote');

  if (f.state === 'cancelled') flags.push('cancelled');
  if (before(f.archivedAtMs)) flags.push('archived_at_send');
  if (f.state === 'draft' || f.state === 'credit' || f.state === 'redeemed' || f.state === 'zero') {
    flags.push('other_not_open_now');
  }
  return flags;
}

export interface FlaggedNotice {
  path: string;
  key: string;
  invoiceId: string;
  state: InvoiceState | 'missing';
  flags: Flag[];
}

/** Pure: every chase notice with at least one flag, sorted by invoice then path. */
export function findFlagged(rows: readonly NotificationRow[], facts: ReadonlyMap<string, InvoiceFacts>): FlaggedNotice[] {
  const out: FlaggedNotice[] = [];
  for (const row of rows) {
    if (!(CHASE_KEYS as readonly string[]).includes(row.key) || row.invoiceId === '') continue;
    const f = facts.get(row.invoiceId) ?? MISSING;
    const flags = flagsFor(row.atMs, f);
    if (flags.length === 0) continue;
    out.push({ path: row.path, key: row.key, invoiceId: row.invoiceId, state: f.state ?? 'missing', flags });
  }
  return out.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId) || a.path.localeCompare(b.path));
}

/** Pure: counts by key and flag. A notice with two flags counts under both. */
export function countFlags(flagged: readonly FlaggedNotice[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of flagged) {
    for (const flag of n.flags) counts[`${n.key} ${flag}`] = (counts[`${n.key} ${flag}`] ?? 0) + 1;
  }
  return counts;
}

async function scanNotices(db: Firestore): Promise<NotificationRow[]> {
  const rows: NotificationRow[] = [];
  const collections: ScannedCollection[] = ['notifications', 'scheduledNotifications'];
  for (const collection of collections) {
    for (const key of CHASE_KEYS) {
      let cursor: QueryDocumentSnapshot | null = null;
      for (;;) {
        let q = db.collection(collection).where('key', '==', key).orderBy('__name__').limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        for (const doc of snap.docs) rows.push(rowOf(doc.ref.path, collection, doc.data() as Record<string, unknown>));
        if (snap.size < PAGE) break;
        cursor = snap.docs[snap.size - 1] ?? null;
        if (!cursor) break;
      }
    }
  }
  return rows;
}

async function readFacts(db: Firestore, invoiceId: string): Promise<InvoiceFacts> {
  const ref = db.collection('invoices').doc(invoiceId);
  const [snap, payments] = await Promise.all([ref.get(), ref.collection('payments').get()]);
  return factsOf(
    snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
    payments.docs.map((d) => d.data() as Record<string, unknown>),
  );
}

export interface StampedNotOpen {
  invoiceId: string;
  state: InvoiceState;
  stamps: Array<'overdueNotifiedAtMs' | 'reminderNotifiedAtMs'>;
}

async function scanStamped(db: Firestore): Promise<StampedNotOpen[]> {
  const byId = new Map<string, StampedNotOpen>();
  for (const field of ['overdueNotifiedAtMs', 'reminderNotifiedAtMs'] as const) {
    let cursor: QueryDocumentSnapshot | null = null;
    for (;;) {
      let q = db.collection('invoices').where(field, '>', 0).orderBy(field).limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      for (const doc of snap.docs) {
        const state = invoiceStateOf(doc.data() as Record<string, unknown>);
        if (state === 'open') continue;
        const entry = byId.get(doc.id) ?? { invoiceId: doc.id, state, stamps: [] };
        entry.stamps.push(field);
        byId.set(doc.id, entry);
      }
      if (snap.size < PAGE) break;
      cursor = snap.docs[snap.size - 1] ?? null;
      if (!cursor) break;
    }
  }
  return [...byId.values()].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
}

export interface Report {
  scannedNotices: number;
  invoicesChecked: number;
  flagged: FlaggedNotice[];
  counts: Record<string, number>;
  stampedNotOpen: StampedNotOpen[];
}

/** Reads the notices, the invoices and payment rows they name, and the stamped invoices. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const rows = await scanNotices(db);
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId).filter((id) => id !== ''))].sort();
  const facts = new Map<string, InvoiceFacts>();
  for (const id of invoiceIds) facts.set(id, await readFacts(db, id));
  const flagged = findFlagged(rows, facts);
  return {
    scannedNotices: rows.length,
    invoicesChecked: invoiceIds.length,
    flagged,
    counts: countFlags(flagged),
    stampedNotOpen: await scanStamped(db),
  };
}

function printReport(r: Report, samples: number): void {
  console.log('READ-ONLY #871 report: overdue notices and reminders about invoices that were not a live bill. Nothing was written.');
  console.log(`Scanned: ${r.scannedNotices} notification(s) about ${r.invoicesChecked} invoice(s).`);
  if (r.flagged.length === 0) {
    console.log('FLAGGED NOTICES: none found.');
  } else {
    const invoices = new Set(r.flagged.map((f) => f.invoiceId)).size;
    console.log(`FLAGGED NOTICES: ${r.flagged.length} notification(s) about ${invoices} invoice(s).`);
    for (const [k, n] of Object.entries(r.counts).sort()) console.log(`  ${k}: ${n}`);
    console.log('  (cancelled and other_not_open_now read the CURRENT state; no writer dates those changes.)');
    console.log(`First ${Math.min(samples, r.flagged.length)} of ${r.flagged.length}:`);
    for (const f of r.flagged.slice(0, samples)) {
      console.log(`  invoice=${f.invoiceId}  state=${f.state}  ${f.key}  ${f.path}  ${f.flags.join(',')}`);
    }
  }
  if (r.stampedNotOpen.length === 0) {
    console.log('STAMPED BUT NOT OPEN NOW: none found.');
  } else {
    const byState = new Map<string, number>();
    for (const s of r.stampedNotOpen) byState.set(s.state, (byState.get(s.state) ?? 0) + 1);
    console.log(
      `STAMPED BUT NOT OPEN NOW: ${r.stampedNotOpen.length} invoice(s). By state: ${[...byState.entries()].map(([s, n]) => `${s} ${n}`).join(', ')}`,
    );
    for (const s of r.stampedNotOpen.slice(0, samples)) {
      console.log(`  invoice=${s.invoiceId}  state=${s.state}  ${s.stamps.join(',')}`);
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
