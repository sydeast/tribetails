/**
 * backfillGeneratedDraftCreatedOn.ts
 *
 * Stamps `createdOn` on the `generated_drafts/{id}` documents the generator
 * callable wrote without it (issue #1629).
 *
 * WHY. Every admin client reads this collection ordered by `createdOn`: the web
 * `GENERATED_DRAFTS_QUERY` (Home's "KinTales pending", KinTales > Drafts) and
 * Android's `getGeneratedDrafts`. Firestore drops a document that lacks the
 * orderBy field, and `auntieos-admin/web/functions/generate.js` stamped only
 * `generated_at` until #1629. Every draft it wrote is therefore invisible on
 * those surfaces. The generator now writes both; this script repairs the ones
 * already written.
 *
 * WHAT IT WRITES. Exactly `{ createdOn: <generated_at as ISO> }` on a document
 * whose `createdOn` is absent or blank and whose `generated_at` reads as a
 * date. Nothing else moves. A document that already has `createdOn` is left
 * alone, and so is one with neither stamp (reported, never dated by guess), so
 * a second run plans nothing.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run and beats --allow-prod in either order.
 *   --samples <n>  sample document lines (default 10, 0 = none).
 *   --project <id> project override.
 *
 * RUNBOOK (the operator runs this; it cannot be run from an agent session):
 *   1. npm --prefix mytribe/functions run backfill:generated-draft-created-on
 *      Reads only. Note the TO UPDATE count.
 *   2. npm --prefix mytribe/functions run backfill:generated-draft-created-on -- --allow-prod
 *      Applies. Needs GOOGLE_APPLICATION_CREDENTIALS.
 *   3. Re-run step 1. A clean second run reports 0 to update.
 *
 * STATUS. Production is wiped and re-uploaded before go-live, so this only
 * matters for drafts written before that reload. After it, the generator's own
 * `createdOn` covers every new draft.
 */
import {
  getApps,
  initializeApp,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from './lib/firebaseAdmin';

export const COLLECTION = 'generated_drafts';
export const FIELD = 'createdOn';
export const SOURCE_FIELD = 'generated_at';

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
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--samples') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--samples requires a value');
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
      i += 1;
    } else {
      throw new Error(`unknown argument '${String(a)}'`);
    }
  }
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

/** Reads a Firestore Timestamp, an ISO string or a millis number as an ISO date, or null. */
export function isoOf(value: unknown): string | null {
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

export type RowState = 'has-created-on' | 'to-stamp' | 'undatable';

export interface RowPlan {
  state: RowState;
  /** The value an apply run writes, when state is `to-stamp`. */
  createdOn: string | null;
}

/** What this script does to one document. Pure. */
export function planRow(data: Record<string, unknown>): RowPlan {
  const current = data[FIELD];
  if (current !== undefined && current !== null && !(typeof current === 'string' && current.trim() === '')) {
    return { state: 'has-created-on', createdOn: null };
  }
  const iso = isoOf(data[SOURCE_FIELD]);
  if (iso === null) return { state: 'undatable', createdOn: null };
  return { state: 'to-stamp', createdOn: iso };
}

export interface PlannedWrite {
  path: string;
  createdOn: string;
}

export interface Summary {
  scanned: number;
  hasCreatedOn: number;
  toStamp: number;
  undatable: number;
}

export interface BackfillPlan {
  summary: Summary;
  writes: PlannedWrite[];
  undatablePaths: string[];
}

/** Rolls rows into the plan. Pure, so the counts the operator reads are pinned by fixtures. */
export function planRows(rows: ReadonlyArray<{ path: string; data: Record<string, unknown> }>): BackfillPlan {
  const plan: BackfillPlan = {
    summary: { scanned: rows.length, hasCreatedOn: 0, toStamp: 0, undatable: 0 },
    writes: [],
    undatablePaths: [],
  };
  for (const row of rows) {
    const p = planRow(row.data);
    if (p.state === 'has-created-on') plan.summary.hasCreatedOn += 1;
    else if (p.state === 'undatable') {
      plan.summary.undatable += 1;
      plan.undatablePaths.push(row.path);
    } else if (p.createdOn !== null) {
      plan.summary.toStamp += 1;
      plan.writes.push({ path: row.path, createdOn: p.createdOn });
    }
  }
  return plan;
}

async function scan(db: Firestore): Promise<Array<{ path: string; data: Record<string, unknown> }>> {
  const rows: Array<{ path: string; data: Record<string, unknown> }> = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(COLLECTION).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) rows.push({ path: doc.ref.path, data: doc.data() as Record<string, unknown> });
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) break;
  }
  return rows;
}

export interface ApplyResult {
  updated: number;
  vanished: number;
}

/** Applies the plan with update(), never set(): only `createdOn` moves. */
export async function applyPlan(db: Firestore, writes: readonly PlannedWrite[]): Promise<ApplyResult> {
  const result: ApplyResult = { updated: 0, vanished: 0 };
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    const batch = db.batch();
    for (const w of chunk) batch.update(db.doc(w.path), { [FIELD]: w.createdOn });
    try {
      await batch.commit();
      result.updated += chunk.length;
    } catch {
      for (const w of chunk) {
        try {
          await db.doc(w.path).update({ [FIELD]: w.createdOn });
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (args.mode === 'apply' && !emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error('a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)');
  }
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  const plan = planRows(await scan(db));
  const s = plan.summary;
  console.log('');
  console.log(`=== generated_drafts createdOn backfill (${args.mode.toUpperCase()}) ===`);
  console.log(`drafts scanned                         : ${s.scanned}`);
  console.log(`already carry createdOn                : ${s.hasCreatedOn}`);
  console.log(`no createdOn and no readable generated_at, LEFT ALONE : ${s.undatable}`);
  console.log(`TO UPDATE -> createdOn = generated_at  : ${s.toStamp}`);
  for (const w of plan.writes.slice(0, args.samples)) console.log(`  ${w.path}  createdOn=${w.createdOn}`);
  for (const p of plan.undatablePaths.slice(0, args.samples)) console.log(`  undatable: ${p}`);
  console.log('');
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  const applied = await applyPlan(db, plan.writes);
  console.log(`APPLIED: ${applied.updated} draft(s) stamped with createdOn; ${applied.vanished} already gone.`);
  console.log('Re-run without --allow-prod to confirm 0 to update.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
