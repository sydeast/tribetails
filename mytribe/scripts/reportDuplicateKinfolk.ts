/**
 * reportDuplicateKinfolk.ts
 *
 * READ-ONLY. Answers one question for issue #890: did Add Kinfolk already make
 * the same household twice?
 *
 * Before #890, admin web and the desktop console lost a created household's id
 * when its Emergency Contact failed to save and the operator left the screen, so
 * the next Add made a second household. The fix stops new duplicates (the
 * clients keep the pending household, and the createKinfolk callable hands back
 * the existing one). It cannot say whether old ones happened. This reads what is
 * stored and says.
 *
 * IT WRITES NOTHING. The file has no set, update, delete, create, add, batch or
 * transaction call, and `test/reportDuplicateKinfolk.test.ts` greps this source
 * to keep it that way.
 *
 * WHAT COUNTS. Two or more `kinfolk` documents with the same primary phone or the
 * same primary email (the callable's own rule, `lib/kinfolkDuplicate.ts`), created
 * within the window of each other (10 minutes by default). A household matched to
 * one by phone and to another by email is one group.
 *
 * WHEN A HOUSEHOLD WAS CREATED. Households made before the callable carry no
 * `createdAt`, so the Firestore document create time is used for them. That time
 * is when the document came into existence, which for an Add is the Add.
 * `createdByUid` is printed when present; the old direct writes never stored it,
 * so this report cannot restrict itself to one operator the way the callable does.
 *
 * NOTHING PRIVATE IS PRINTED. Document ids, times, the kind of match and uids.
 * No names, phones or emails.
 *
 * TARGET. The target is printed before anything is read. Against production the
 * run needs --allow-prod. With FIRESTORE_EMULATOR_HOST set, --allow-prod is
 * refused, so a command meant for production cannot quietly read an emulator.
 *
 * Usage (the operator runs the production form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project <id>
 *   npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project <id> --window-minutes 30
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846). This script only reads, but it
// reads prod, and a stray copy is the same hazard for a report as for a write.
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';
import { KINFOLK_DUPLICATE_WINDOW_MS, duplicateMatch, type DuplicateMatch } from '../functions/src/lib/kinfolkDuplicate';

const PAGE = 500;
const MIN = 60_000;

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  windowMs: number;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, windowMs: KINFOLK_DUPLICATE_WINDOW_MS, samples: 50 };
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
    else if (a === '--window-minutes') {
      const v = value();
      if (!/^\d+$/.test(v) || Number(v) === 0) throw new Error(`--window-minutes must be a positive whole number, got '${v}'`);
      args.windowMs = Number(v) * MIN;
    } else if (a === '--samples') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportDuplicateKinfolk.ts: READ-ONLY report of households Add Kinfolk made twice (#890)',
          '',
          '  npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project <id>',
          '  npm --prefix mytribe/functions run report:duplicate-kinfolk -- --allow-prod --project <id> --window-minutes 30',
          '',
          'Writes nothing. Prints document ids, times, the kind of match and uids only.',
          '--allow-prod is required for production and refused when FIRESTORE_EMULATOR_HOST is set.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export type Target = { kind: 'emulator'; host: string; projectId: string | null } | { kind: 'production'; projectId: string | null };

/** Where this run reads, or a refusal. Decided before firebase-admin is initialised. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const projectId = args.projectId ?? env['GCLOUD_PROJECT'] ?? env['GOOGLE_CLOUD_PROJECT'] ?? null;
  const host = env['FIRESTORE_EMULATOR_HOST'];
  if (host) {
    if (args.allowProd) {
      throw new Error(`refusing --allow-prod: FIRESTORE_EMULATOR_HOST is set (${host}), so this run would read the emulator, not production. Unset it, or drop --allow-prod.`);
    }
    return { kind: 'emulator', host, projectId };
  }
  if (!args.allowProd) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set, so this run would read PRODUCTION. pass --allow-prod to confirm.');
  }
  return { kind: 'production', projectId };
}

export function describeTarget(t: Target): string {
  const project = t.projectId ?? '(from credentials)';
  return t.kind === 'emulator' ? `Target: EMULATOR ${t.host}, project ${project}` : `Target: PRODUCTION, project ${project}`;
}

/** One stored household, reduced to what the duplicate test reads. */
export interface KinfolkRow {
  id: string;
  atMs: number | null;
  atSource: 'createdAt' | 'createTime' | 'none';
  phoneNumber: unknown;
  email: unknown;
  createdByUid: string | null;
}

function millisOf(v: unknown): number | null {
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function rowOf(id: string, raw: Record<string, unknown>, createTimeMs: number | null): KinfolkRow {
  const createdAt = millisOf(raw['createdAt']);
  const uid = raw['createdByUid'];
  return {
    id,
    atMs: createdAt ?? createTimeMs,
    atSource: createdAt !== null ? 'createdAt' : createTimeMs !== null ? 'createTime' : 'none',
    phoneNumber: raw['phoneNumber'],
    email: raw['email'],
    createdByUid: typeof uid === 'string' && uid !== '' ? uid : null,
  };
}

export interface DuplicateCluster {
  match: DuplicateMatch;
  /** Every household in the group, oldest first. */
  households: Array<{ id: string; atMs: number; atSource: KinfolkRow['atSource']; createdByUid: string | null }>;
  /** The smallest gap between two matching households in the group (ms). */
  closestGapMs: number;
}

/**
 * Pure: joins every pair of households that match and were created within
 * [windowMs] of each other (inclusive), and returns each connected group, closest
 * first. A household with no time is skipped: nothing can say when it was made.
 */
export function findDuplicateKinfolk(rows: readonly KinfolkRow[], windowMs: number): DuplicateCluster[] {
  const timed = rows.filter((r): r is KinfolkRow & { atMs: number } => r.atMs !== null).sort((a, b) => a.atMs - b.atMs);
  const parent = timed.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edges: Array<{ i: number; j: number; match: DuplicateMatch; gap: number }> = [];

  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const gap = timed[j].atMs - timed[i].atMs;
      if (gap > windowMs) break; // sorted by time, so nothing later is closer
      const match = duplicateMatch(timed[i], timed[j]);
      if (match === null) continue;
      edges.push({ i, j, match, gap });
      parent[find(i)] = find(j);
    }
  }

  // Plain objects and arrays rather than Map/Set: the read-only test greps this
  // file for `.set(` / `.add(`, and a collection method must not look like a write.
  const groups: Record<number, { members: number[]; phone: boolean; email: boolean; closest: number }> = {};
  for (const e of edges) {
    const root = find(e.i);
    const g = groups[root] ?? { members: [], phone: false, email: false, closest: Number.POSITIVE_INFINITY };
    for (const m of [e.i, e.j]) if (!g.members.includes(m)) g.members.push(m);
    if (e.match !== 'email') g.phone = true;
    if (e.match !== 'phone') g.email = true;
    g.closest = Math.min(g.closest, e.gap);
    groups[root] = g;
  }

  return Object.values(groups)
    .map((g) => ({
      match: (g.phone && g.email ? 'phone and email' : g.phone ? 'phone' : 'email') as DuplicateMatch,
      households: [...g.members]
        .sort((a, b) => a - b)
        .map((i) => ({ id: timed[i].id, atMs: timed[i].atMs, atSource: timed[i].atSource, createdByUid: timed[i].createdByUid })),
      closestGapMs: g.closest,
    }))
    .sort((a, b) => a.closestGapMs - b.closestGapMs || a.households[0].id.localeCompare(b.households[0].id));
}

export interface Report {
  scanned: number;
  withoutCreatedAt: number;
  clusters: DuplicateCluster[];
}

/** Reads every `kinfolk` document, a page at a time. Writes nothing. */
export async function buildReport(db: Firestore, windowMs: number): Promise<Report> {
  const rows: KinfolkRow[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('kinfolk').orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) {
      rows.push(rowOf(doc.id, doc.data() as Record<string, unknown>, doc.createTime ? doc.createTime.toMillis() : null));
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) break;
  }
  return {
    scanned: rows.length,
    withoutCreatedAt: rows.filter((r) => r.atSource !== 'createdAt').length,
    clusters: findDuplicateKinfolk(rows, windowMs),
  };
}

function printReport(r: Report, samples: number, windowMs: number): void {
  console.log('READ-ONLY duplicate household report (#890). Nothing was written.');
  console.log(`Window: ${windowMs / MIN} min. Match: same primary phone or same primary email.`);
  console.log(`Scanned: ${r.scanned} household(s); ${r.withoutCreatedAt} have no createdAt and were timed by their document create time.`);
  console.log('');
  if (r.clusters.length === 0) {
    console.log('DUPLICATE HOUSEHOLDS: none found.');
    return;
  }
  const extra = r.clusters.reduce((n, c) => n + c.households.length - 1, 0);
  console.log(`DUPLICATE HOUSEHOLDS: ${r.clusters.length} group(s), ${extra} extra household(s).`);
  console.log('');
  console.log(`Closest ${Math.min(samples, r.clusters.length)} of ${r.clusters.length}:`);
  for (const c of r.clusters.slice(0, samples)) {
    console.log(`  same ${c.match}, closest gap ${Math.round(c.closestGapMs / 1000)}s`);
    for (const h of c.households) {
      console.log(`      ${new Date(h.atMs).toISOString()} (${h.atSource})  kinfolk/${h.id}  createdByUid=${h.createdByUid ?? 'unknown'}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  console.log(describeTarget(target));
  if (getApps().length === 0) initializeApp(target.projectId ? { projectId: target.projectId } : {});
  const report = await buildReport(getFirestore(), args.windowMs);
  printReport(report, args.samples, args.windowMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
