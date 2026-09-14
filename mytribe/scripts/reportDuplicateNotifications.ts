/**
 * reportDuplicateNotifications.ts
 *
 * READ-ONLY. Answers one question for issue #832: has any household ALREADY
 * been sent the same notification twice?
 *
 * Before #832 nothing stopped it. `sendInvoiceReminder` never read the stamp it
 * wrote, `postInvoiceEvent` re-enqueued on every call, and the dispatcher wrote
 * an auto-id document with no duplicate check. The fix stops new duplicates; it
 * cannot say whether old ones happened. This script reads what is already stored
 * and says.
 *
 * IT WRITES NOTHING. There is no --allow-prod flag because there is nothing to
 * allow: the file contains no set, update, delete, batch or transaction call,
 * and `reportDuplicateNotifications.test.ts` greps this source to keep it that
 * way.
 *
 * WHAT COUNTS AS A DUPLICATE. Two documents in the same collection with the same
 * `key`, the same `recipientUid`, and the same identity, created closer together
 * than the window for that key:
 *
 *   - identity is exactly what the dispatcher now dedupes on (`dedupeIdentityOf`
 *     in functions/src/notifications/dispatcher.ts): the target plus any
 *     per-event id in `data` (messageId, commentId, paymentId, ...). So two
 *     DIFFERENT messages to one household are never reported; two copies of one
 *     are. Documents written before `targetType`/`targetId` were stamped get
 *     their target derived from `data` the same way the dispatcher derives it.
 *   - the window is the dispatcher's NOTIFICATION_DEDUPE_WINDOW_MS (5 minutes),
 *     except `invoice.reminder`, which uses the reminder callable's 24 hours: two
 *     reminders about one invoice in a day is the harm the issue names, however
 *     far apart they landed. `--window-minutes` overrides both.
 *   - `notifications` (what was delivered) and `scheduledNotifications` (what is
 *     queued) are grouped SEPARATELY. A queued row is deleted when it is promoted
 *     into `notifications`, so one reminder can briefly exist in both; pairing
 *     across the two would report that as a duplicate when it is one send.
 *
 * WHO IS A HOUSEHOLD. A `recipientUid` that names a document in `clients/`, the
 * same test `streamForRecipient` uses. Staff copies are reported too, separately,
 * because a duplicate to the office is still a duplicate, but the headline number
 * is households.
 *
 * NOTHING PRIVATE IS PRINTED. Output is keys, document paths, uids and times.
 * No `data`, no `detail`, no titles.
 *
 * Usage (the operator runs this against prod; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id>
 *   npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id> --samples 50
 *   npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id> --window-minutes 60
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  NOTIFICATION_DEDUPE_WINDOW_MS,
  dedupeIdentityOf,
  resolveTargetRef,
} from '../functions/src/notifications/dispatcher';
import type { NotificationTargetType } from '../functions/src/notifications/types';

export const SCANNED_COLLECTIONS = ['notifications', 'scheduledNotifications'] as const;
export type ScannedCollection = (typeof SCANNED_COLLECTIONS)[number];

/**
 * The reminder callable's window. Restated rather than imported, because
 * importing `admin/sendInvoiceReminder.ts` would register a Cloud Function at
 * load time; the unit test pins the two numbers equal.
 */
export const INVOICE_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

const PAGE = 500;
const LOOKUP_CHUNK = 100;

export interface Args {
  projectId: string | null;
  samples: number;
  windowMs: number | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, samples: 20, windowMs: null };
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
    } else if (a === '--window-minutes') {
      const v = value();
      if (!/^\d+$/.test(v) || Number(v) === 0) throw new Error(`--window-minutes must be a positive whole number, got '${v}'`);
      args.windowMs = Number(v) * 60 * 1000;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportDuplicateNotifications.ts: READ-ONLY report of notifications delivered twice (#832)',
          '',
          '  npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id>',
          '  npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id> --samples 50',
          '  npm --prefix mytribe/functions run report:duplicate-notifications -- --project <id> --window-minutes 60',
          '',
          'Writes nothing. Prints keys, paths, uids and times only.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

/** One stored notification, reduced to what the duplicate test reads. */
export interface NotificationRow {
  path: string;
  collection: ScannedCollection;
  key: string;
  recipientUid: string;
  identity: string;
  /** When it was written (ms epoch), or null when no time is stored. */
  atMs: number | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function millisOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Builds the row from a raw stored document, deriving what old documents lack. */
export function rowOf(path: string, collection: ScannedCollection, raw: Record<string, unknown>): NotificationRow {
  const data = (raw['data'] && typeof raw['data'] === 'object' ? raw['data'] : {}) as Record<string, unknown>;
  const key = str(raw['key']);
  const target = resolveTargetRef({
    key,
    data,
    targetType: (str(raw['targetType']) || undefined) as NotificationTargetType | undefined,
    targetId: str(raw['targetId']) || undefined,
  });
  return {
    path,
    collection,
    key,
    recipientUid: str(raw['recipientUid']),
    identity: dedupeIdentityOf({ key, data }, target),
    atMs: millisOf(raw['createdAt']) ?? millisOf(raw['fireAtMs']),
  };
}

export function windowMsFor(key: string, override: number | null): number {
  if (override !== null) return override;
  return key === 'invoice.reminder' ? INVOICE_REMINDER_WINDOW_MS : NOTIFICATION_DEDUPE_WINDOW_MS;
}

export interface DuplicateGroup {
  collection: ScannedCollection;
  key: string;
  identity: string;
  recipientUid: string;
  /** Every copy, oldest first. */
  rows: Array<{ path: string; atMs: number }>;
  /** The smallest gap between two consecutive copies (ms). */
  closestGapMs: number;
  /** How many copies landed inside the window of the one before them. */
  extraCopies: number;
}

/**
 * Pure: groups rows and keeps the groups where at least one copy landed inside
 * the window of the copy before it. Rows with no identity, no recipient, no key
 * or no time are skipped, because nothing can say two of them are the same send.
 */
export function findDuplicates(rows: readonly NotificationRow[], windowOverrideMs: number | null): DuplicateGroup[] {
  const groups = new Map<string, NotificationRow[]>();
  for (const row of rows) {
    if (row.identity === '' || row.recipientUid === '' || row.key === '' || row.atMs === null) continue;
    const id = [row.collection, row.key, row.identity, row.recipientUid].join(' ');
    const list = groups.get(id);
    if (list) list.push(row);
    else groups.set(id, [row]);
  }
  const out: DuplicateGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.atMs as number) - (b.atMs as number));
    const windowMs = windowMsFor(sorted[0].key, windowOverrideMs);
    let closest = Number.POSITIVE_INFINITY;
    let extra = 0;
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = (sorted[i].atMs as number) - (sorted[i - 1].atMs as number);
      closest = Math.min(closest, gap);
      if (gap < windowMs) extra += 1;
    }
    if (extra === 0) continue;
    out.push({
      collection: sorted[0].collection,
      key: sorted[0].key,
      identity: sorted[0].identity,
      recipientUid: sorted[0].recipientUid,
      rows: sorted.map((r) => ({ path: r.path, atMs: r.atMs as number })),
      closestGapMs: closest,
      extraCopies: extra,
    });
  }
  return out.sort((a, b) => a.closestGapMs - b.closestGapMs);
}

export interface Report {
  scanned: Record<ScannedCollection, number>;
  groups: Array<DuplicateGroup & { household: boolean }>;
  householdGroups: number;
  householdsAffected: number;
  staffGroups: number;
  extraHouseholdCopies: number;
  byKey: Array<{ key: string; groups: number; extraCopies: number; households: number }>;
}

async function scan(db: Firestore, collection: ScannedCollection): Promise<NotificationRow[]> {
  const rows: NotificationRow[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(collection).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) rows.push(rowOf(doc.ref.path, collection, doc.data() as Record<string, unknown>));
    if (snap.size < PAGE) return rows;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return rows;
  }
}

async function householdUids(db: Firestore, uids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(uids.filter((u) => u !== ''))];
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const refs = unique.slice(i, i + LOOKUP_CHUNK).map((uid) => db.collection('clients').doc(uid));
    for (const snap of await db.getAll(...refs)) if (snap.exists) found.add(snap.id);
  }
  return found;
}

/** Reads both collections and the `clients/` docs it needs. Writes nothing. */
export async function buildReport(db: Firestore, windowOverrideMs: number | null): Promise<Report> {
  const scanned = { notifications: 0, scheduledNotifications: 0 } as Record<ScannedCollection, number>;
  const all: NotificationRow[] = [];
  for (const collection of SCANNED_COLLECTIONS) {
    const rows = await scan(db, collection);
    scanned[collection] = rows.length;
    all.push(...rows);
  }
  const dupes = findDuplicates(all, windowOverrideMs);
  const households = await householdUids(db, dupes.map((g) => g.recipientUid));
  const groups = dupes.map((g) => ({ ...g, household: households.has(g.recipientUid) }));

  const byKeyMap = new Map<string, { groups: number; extraCopies: number; households: Set<string> }>();
  for (const g of groups) {
    const e = byKeyMap.get(g.key) ?? { groups: 0, extraCopies: 0, households: new Set<string>() };
    e.groups += 1;
    e.extraCopies += g.extraCopies;
    if (g.household) e.households.add(g.recipientUid);
    byKeyMap.set(g.key, e);
  }
  const householdOnly = groups.filter((g) => g.household);
  return {
    scanned,
    groups,
    householdGroups: householdOnly.length,
    householdsAffected: new Set(householdOnly.map((g) => g.recipientUid)).size,
    staffGroups: groups.length - householdOnly.length,
    extraHouseholdCopies: householdOnly.reduce((n, g) => n + g.extraCopies, 0),
    byKey: [...byKeyMap.entries()]
      .map(([key, e]) => ({ key, groups: e.groups, extraCopies: e.extraCopies, households: e.households.size }))
      .sort((a, b) => b.extraCopies - a.extraCopies || a.key.localeCompare(b.key)),
  };
}

function printReport(r: Report, samples: number, windowOverrideMs: number | null): void {
  const windowLine =
    windowOverrideMs !== null
      ? `${windowOverrideMs / 60000} min for every key (--window-minutes)`
      : `${NOTIFICATION_DEDUPE_WINDOW_MS / 60000} min, invoice.reminder ${INVOICE_REMINDER_WINDOW_MS / 3600000} h`;
  console.log('READ-ONLY duplicate notification report (#832). Nothing was written.');
  console.log(`Window: ${windowLine}`);
  console.log(`Scanned: notifications ${r.scanned.notifications}, scheduledNotifications ${r.scanned.scheduledNotifications}`);
  console.log('');
  if (r.householdGroups === 0) {
    console.log('HOUSEHOLDS DOUBLE-NOTIFIED: none found.');
  } else {
    console.log(
      `HOUSEHOLDS DOUBLE-NOTIFIED: ${r.householdsAffected} household(s), ${r.householdGroups} notification(s) sent more than once, ${r.extraHouseholdCopies} extra cop(ies).`,
    );
  }
  console.log(`Staff/office duplicates: ${r.staffGroups} notification(s).`);
  if (r.byKey.length > 0) {
    console.log('');
    console.log('By key (groups / extra copies / households):');
    for (const k of r.byKey) console.log(`  ${k.key}  ${k.groups} / ${k.extraCopies} / ${k.households}`);
    console.log('');
    console.log(`Closest ${Math.min(samples, r.groups.length)} of ${r.groups.length}:`);
    for (const g of r.groups.slice(0, samples)) {
      console.log(
        `  ${g.household ? 'HOUSEHOLD' : 'staff    '}  ${g.key}  recipient=${g.recipientUid}  ${g.identity}  closest gap ${Math.round(g.closestGapMs / 1000)}s`,
      );
      for (const row of g.rows) console.log(`      ${new Date(row.atMs).toISOString()}  ${row.path}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const report = await buildReport(getFirestore(), args.windowMs);
  printReport(report, args.samples, args.windowMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
