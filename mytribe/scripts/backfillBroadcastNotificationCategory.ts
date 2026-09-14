/**
 * backfillBroadcastNotificationCategory.ts
 *
 * Repoints `category` on the `notifications/{id}` documents earlier broadcasts
 * wrote, from the invented `broadcast` to the catalog category the
 * `broadcast.message` row actually carries (`messages`).
 *
 * WHAT IS OUT THERE (issue #443). Before PR #424, `admin/broadcastMessage.ts`
 * wrote each in-app broadcast with `key: 'broadcast.message'` and
 * `category: 'broadcast'`, and NEITHER existed in `notifications/catalog.ts`.
 * #424 gave the key a real catalog row (kinfolk audience, `messages` category,
 * the outbound twin of `message.received`) and made new writes carry
 * `def.category`. It deliberately left the documents already written alone.
 *
 * WHY A DEAD CATEGORY MATTERS. Every surface that groups, filters or reports by
 * category is built from the catalog: the notification gate
 * (`getNotificationCatalog.ts` groups by `def.category`), per-category
 * preferences (`prefs.ts` reads `def.category` and its legacy aliases), and any
 * "what did we send" view. A row filed under a bucket no catalog knows is not
 * merely mislabelled — it is absent from all of them, which is the same
 * blindness issue #396 was filed about.
 *
 * THE KEY IS ALREADY RIGHT; ONLY THE CATEGORY IS WRONG. `broadcast.message` is
 * the catalog key today, written verbatim by the callable before and after
 * #424, so nothing here touches `key`. One field moves, and only on documents
 * that disagree with the catalog.
 *
 * THE DECISION THIS SCRIPT EXISTS TO SUPPORT. Issue #443 allows two answers:
 * backfill the rows so they join the catalog-driven surfaces, or decide the
 * broadcasts are old enough to leave. Its actual complaint is that nobody has
 * decided. So the DRY RUN is the deliverable: it reports how many documents
 * carry the dead category, what other categories are out there under this key,
 * and how old the affected rows are (oldest and newest `createdAt`), which is
 * exactly the input the "old enough to leave" half of the decision needs. The
 * apply run is one flag away once that call is made.
 *
 * NOTHING IS DELETED AND NOTHING ELSE IS TOUCHED. The update carries exactly
 * `{ category: 'messages' }` on a document that already exists, so the
 * operator's own words in `title`/`description`/`body`, the recipient, the read
 * state, the `broadcast: true` marker and the target all survive. A `set()` was
 * never an option here.
 *
 * WHAT IT WILL NOT DO. It will not invent a category for a row whose `key` is
 * not `broadcast.message`, and it will not "fix" a broadcast row that already
 * carries a real catalog category — including one an operator or a later
 * migration set by hand to something other than `messages`. Those are reported
 * under `foreign category` and left alone, because a value somebody chose is
 * not the same thing as the placeholder #424 replaced.
 *
 * IDEMPOTENT BY CONSTRUCTION. Only a document whose stored `category` differs
 * from the catalog's is planned for a write, so a second run plans nothing and
 * commits no batch at all.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order. FIRESTORE_EMULATOR_HOST does not turn a dry run into
 *                  a writing one; it stands in for credentials only.
 *   --samples <n>  sample document lines (default 10, 0 = none).
 *   --project <id> project override.
 *
 * RUNBOOK (the operator runs this; it cannot be run from an agent session):
 *
 *   1. npm --prefix mytribe/functions run backfill:broadcast-category
 *      Reads only. Note the count, the date range, and any `foreign category`
 *      rows.
 *   2. Decide from those numbers. Backfilling makes the rows visible to the
 *      gate, to per-category preferences and to every catalog-driven report;
 *      leaving them is a legitimate answer for a small enough, old enough set,
 *      but it has to be said out loud on #443 rather than defaulted into.
 *   3. npm --prefix mytribe/functions run backfill:broadcast-category -- --allow-prod
 *      Applies. Needs GOOGLE_APPLICATION_CREDENTIALS.
 *   4. Re-run step 1. A clean second run reports 0 to update.
 */
import {
  getApps,
  initializeApp,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from './lib/firebaseAdmin';

/** The inbox collection broadcasts write into. */
export const NOTIFICATIONS_COLLECTION = 'notifications';

/**
 * The catalog key broadcasts have always been stamped with — before #424 when
 * no row existed for it, and after #424 when one did. Unchanged by this script.
 */
export const BROADCAST_KEY = 'broadcast.message';

/**
 * The category the `broadcast.message` catalog row carries. Hard-coded rather
 * than imported from `notifications/catalog.ts`: these scripts compile under
 * their own tsconfig outside `mytribe/functions`, and a migration should record
 * the value it was reasoned about and written for, not silently retarget itself
 * if the catalog row is re-categorised later. `catalogBroadcastCategoryDrift`
 * in the test suite fails if the two ever disagree.
 */
export const CATALOG_CATEGORY = 'messages';

/** The placeholder #424 replaced. Present in no catalog, then or now. */
export const DEAD_CATEGORY = 'broadcast';

/** The one field this migration writes. */
export const FIELD = 'category';

const PAGE = 500;
const WRITE_CHUNK = 400;
/** gRPC NOT_FOUND, for a document deleted between the plan and the write. */
const NOT_FOUND = 5;

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, samples: 10 };
  // An explicit --dry-run always wins, in either flag order, and is tracked
  // separately because the `if (args.allowProd)` below runs after the whole
  // argv has been scanned.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // A valueless --project would otherwise swallow the next token, and the
      // token most likely to follow is --dry-run.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--samples') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--samples requires a value');
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillBroadcastNotificationCategory.ts — join old broadcasts to the catalog',
          '',
          '  npm --prefix mytribe/functions run backfill:broadcast-category                  # DRY RUN (default)',
          '  npm --prefix mytribe/functions run backfill:broadcast-category -- --allow-prod  # apply',
          '  npm --prefix mytribe/functions run backfill:broadcast-category -- --samples 40',
          '  npm --prefix mytribe/functions run backfill:broadcast-category -- --project <id>',
          '',
          '--dry-run overrides --allow-prod regardless of flag order.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

/** What one broadcast notification currently says about its category. */
export type CategoryState =
  /** `category: 'broadcast'`, the placeholder in no catalog. The backfill's target. */
  | 'dead'
  /** No `category` field at all, or a blank one. Also joined to the catalog. */
  | 'missing'
  /** Already `messages`. Nothing to do; this is the post-run state. */
  | 'catalog'
  /** Some other non-blank value somebody chose. Reported and left alone. */
  | 'foreign';

export interface RowInput {
  path: string;
  key: string;
  data: Record<string, unknown>;
}

export interface RowPlan {
  update: boolean;
  state: CategoryState;
  /** The stored value, for the report. Null when the field was absent. */
  current: string | null;
}

/**
 * The decision for ONE document. PURE: no Firestore access, so every rule is
 * pinned against fixtures.
 *
 * A MISSING `category` is backfilled as well as a dead one. Both are the same
 * fact from a reader's point of view — the row belongs to no catalog bucket, so
 * no catalog-driven surface can see it — and `dispatcher.ts` writes the field
 * on every notification it creates, so an absent one is not a shape any writer
 * intends.
 */
export function planRow(row: RowInput): RowPlan {
  if (row.key !== BROADCAST_KEY) {
    // Not a broadcast. There is no version of this migration that guesses a
    // category for some other key.
    return { update: false, state: 'foreign', current: null };
  }
  const raw = row.data[FIELD];
  const current = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (current === null) return { update: true, state: 'missing', current: null };
  if (current === DEAD_CATEGORY) return { update: true, state: 'dead', current };
  if (current === CATALOG_CATEGORY) return { update: false, state: 'catalog', current };
  // Somebody's choice, not #424's placeholder. Reported, never overwritten.
  return { update: false, state: 'foreign', current };
}

export interface PlannedWrite {
  path: string;
  /** What the row said before, so the report and any audit can name it. */
  from: string | null;
}

export interface Summary {
  /** Every document in the collection. */
  scanned: number;
  /** Documents whose key is `broadcast.message`. */
  broadcasts: number;
  /** Of those, ones carrying the dead `broadcast` category. */
  dead: number;
  /** Of those, ones carrying no category at all. */
  missing: number;
  /** Of those, ones already on the catalog category. */
  catalog: number;
  /** Of those, ones carrying some other value, left alone. */
  foreign: number;
  /** dead + missing: what an apply run would write. */
  toUpdate: number;
  /** Foreign values seen, with counts, so nothing is left unexplained. */
  foreignValues: Array<{ value: string; count: number }>;
  /** ISO createdAt range of the documents to update. Null when there are none. */
  oldest: string | null;
  newest: string | null;
}

export interface PlannedRow {
  row: RowInput;
  plan: RowPlan;
}

/** Reads a Firestore Timestamp, an ISO string or a millis number as an ISO date. */
export function createdAtIso(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Rolls planned rows into the report the #443 decision is made from. PURE, so
 * the counts the operator reads are pinned by fixtures rather than by whatever
 * the collection happened to hold on the day.
 */
export function summarize(scanned: number, planned: readonly PlannedRow[]): Summary {
  const summary: Summary = {
    scanned,
    broadcasts: 0,
    dead: 0,
    missing: 0,
    catalog: 0,
    foreign: 0,
    toUpdate: 0,
    foreignValues: [],
    oldest: null,
    newest: null,
  };
  const foreign = new Map<string, number>();

  for (const { row, plan } of planned) {
    if (row.key !== BROADCAST_KEY) continue;
    summary.broadcasts += 1;
    if (plan.state === 'dead') summary.dead += 1;
    else if (plan.state === 'missing') summary.missing += 1;
    else if (plan.state === 'catalog') summary.catalog += 1;
    else {
      summary.foreign += 1;
      const value = plan.current ?? '(unreadable)';
      foreign.set(value, (foreign.get(value) ?? 0) + 1);
    }
    if (!plan.update) continue;
    summary.toUpdate += 1;
    // The age range covers exactly the rows an apply run would touch, because
    // "are these old enough to leave" is a question about those rows and not
    // about the collection.
    const iso = createdAtIso(row.data['createdAt']);
    if (iso) {
      if (!summary.oldest || iso < summary.oldest) summary.oldest = iso;
      if (!summary.newest || iso > summary.newest) summary.newest = iso;
    }
  }

  summary.foreignValues = [...foreign.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return summary;
}

/** Reads every document in the collection, one page at a time. */
async function* scanNotifications(db: Firestore): AsyncGenerator<RowInput> {
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(NOTIFICATIONS_COLLECTION).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      yield {
        path: doc.ref.path,
        key: typeof data['key'] === 'string' ? (data['key'] as string) : '',
        data,
      };
    }
    if (snap.size < PAGE) return;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return;
  }
}

export interface BackfillPlan {
  summary: Summary;
  writes: PlannedWrite[];
  samples: PlannedRow[];
}

/**
 * Builds the plan.
 *
 * The whole collection is read rather than queried on `key`, for one reason
 * that matters to the report: a `where('key','==',...)` pass could only count
 * documents that already agree with the current key, and could never say how
 * many broadcasts carry a category value nobody predicted. The scan is a
 * one-off operator run, not a request path.
 */
export async function buildPlan(db: Firestore, sampleLimit: number): Promise<BackfillPlan> {
  const planned: PlannedRow[] = [];
  let scanned = 0;
  for await (const row of scanNotifications(db)) {
    scanned += 1;
    if (row.key !== BROADCAST_KEY) continue;
    planned.push({ row, plan: planRow(row) });
  }

  const writes = planned
    .filter((p) => p.plan.update)
    .map((p) => ({ path: p.row.path, from: p.plan.current }));
  const samples = planned.filter((p) => p.plan.update).slice(0, sampleLimit);

  return { summary: summarize(scanned, planned), writes, samples };
}

export interface ApplyResult {
  updated: number;
  /** Documents deleted between the plan and the write. */
  vanished: number;
}

/**
 * Applies the plan. Exported so an emulator test can prove the update moves one
 * field and leaves the operator's own broadcast copy alone.
 *
 * A failed batch is retried document-by-document so that one vanished row does
 * not discard the other 399 real writes in it.
 */
export async function applyPlan(db: Firestore, writes: readonly PlannedWrite[]): Promise<ApplyResult> {
  const result: ApplyResult = { updated: 0, vanished: 0 };
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    const batch = db.batch();
    // update(), never set(): the document carries the operator's own subject and
    // body, the recipient, the read state and the broadcast marker.
    for (const w of chunk) batch.update(db.doc(w.path), { [FIELD]: CATALOG_CATEGORY });
    try {
      await batch.commit();
      result.updated += chunk.length;
    } catch {
      for (const w of chunk) {
        try {
          await db.doc(w.path).update({ [FIELD]: CATALOG_CATEGORY });
          result.updated += 1;
        } catch (err) {
          if ((err as { code?: number }).code === NOT_FOUND) {
            result.vanished += 1;
            continue;
          }
          throw err;
        }
      }
    }
  }
  return result;
}

function report(plan: BackfillPlan, mode: Mode): void {
  const s = plan.summary;
  console.log('');
  console.log(`=== broadcast notification category backfill (${mode.toUpperCase()}) ===`);
  console.log(`notifications scanned                    : ${s.scanned}`);
  console.log(`key == '${BROADCAST_KEY}'                : ${s.broadcasts}`);
  console.log(`  category '${DEAD_CATEGORY}' (in no catalog)   : ${s.dead}`);
  console.log(`  category absent                        : ${s.missing}`);
  console.log(`  already '${CATALOG_CATEGORY}'                 : ${s.catalog}`);
  console.log(`  some other value, LEFT ALONE           : ${s.foreign}`);
  console.log(`TO UPDATE -> category '${CATALOG_CATEGORY}'     : ${s.toUpdate}`);
  console.log(
    `oldest / newest affected                 : ${s.oldest ?? '(none)'} / ${s.newest ?? '(none)'}`,
  );

  if (s.foreignValues.length > 0) {
    console.log('');
    console.log('-- values this run refuses to overwrite, because somebody chose them --');
    for (const f of s.foreignValues) console.log(`  category="${f.value}"  ${f.count} document(s)`);
  }

  if (plan.samples.length > 0) {
    console.log('');
    console.log(`-- ${plan.samples.length} of ${s.toUpdate} documents to update --`);
    console.log('   Subject lines are not printed; open a path if you need to read one.');
    for (const { row, plan: p } of plan.samples) {
      const from = p.current === null ? '(absent)' : `'${p.current}'`;
      console.log(
        `  ${row.path}  ${from} -> '${CATALOG_CATEGORY}'  createdAt=${createdAtIso(row.data['createdAt']) ?? '(none)'}`,
      );
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (args.mode === 'apply' && !args.allowProd && !emulator) {
    throw new Error('refusing to write without --allow-prod (or FIRESTORE_EMULATOR_HOST)');
  }
  if (args.mode === 'apply' && !emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error(
      'a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)',
    );
  }
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  const plan = await buildPlan(db, args.samples);
  report(plan, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    console.log('Post the TO UPDATE count and the date range on issue #443 either way:');
    console.log('leaving these rows behind is a legitimate answer, but it has to be a decision.');
    return;
  }
  const applied = await applyPlan(db, plan.writes);
  console.log(
    `APPLIED: ${applied.updated} broadcast notification(s) moved to category '${CATALOG_CATEGORY}'; ${applied.vanished} row(s) already gone.`,
  );
  console.log('Re-run without --allow-prod to confirm the collection now reports 0 to update.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
