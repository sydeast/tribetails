/**
 * repairCrossedKinLinks.ts (#1912)
 *
 * Finds every household Kin that the old mirror tied to ANOTHER Kin's admin
 * record, and has the deployed mirror put each pair right.
 *
 * WHY. Until #1912 the family -> flat mirror (`onFamilyKinWrite`) matched a new
 * household Kin to any admin record (`kin/{id}`) of the same household and name.
 * A Kin added in the portal under the name of an archived Kin was tied to the
 * archived Kin's record: admin never listed it, its delete and removal request
 * were answered from the archived Kin's history. The fixed mirror repairs such a
 * pair the next time either Kin is saved, a removal request is sent or answered,
 * or the record is archived or restored (`functions/src/lib/kinLink.ts`). A pair
 * nobody touches again stays crossed, and the office cannot touch it: admin does
 * not list the new Kin at all. This script is that touch.
 *
 * WHAT IT FINDS. Each family doc `families/{fid}/kin/{kinId}` is read through
 * `resolveKinLink`, the same check the mirror makes. A Kin is planned only when
 * that check says `crossed`: the record its link names belongs to an older Kin
 * of the household, or is an archived record the office held alone. Healthy
 * links, Kin with no record yet, and links into another household are counted
 * and left alone. One Kin per crossed record is planned: the repair of a record
 * moves every Kin that wrongly claims it at once.
 *
 * WHAT IT WRITES. Exactly `{ updatedAt: <server time> }` on each planned family
 * doc, and nothing else. That write fires the deployed `onFamilyKinWrite`, whose
 * mirror runs the repair (`healKinLink`): the Kin gets an admin record of its
 * own, the older Kin's record gets its own facts and link back and keeps its
 * status and every staff field, and a waiting removal request follows the Kin
 * it was sent for. No parent-visible field changes, so the household is not
 * notified. The script never writes a flat doc and never deletes anything.
 *
 * RUN IT ONLY AFTER #1912 IS DEPLOYED. The repair is the deployed mirror's; the
 * mirror from before #1912 would take the touch as an ordinary save and change
 * nothing.
 *
 * IDEMPOTENT. A repaired Kin reads as linked, so a second run plans nothing.
 * Run the dry run again after an apply to confirm.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run and beats --allow-prod in either order.
 *   --project <id> overrides the project id.
 */
import { getApps, initializeApp, FieldValue, getFirestore, type Firestore } from './lib/firebaseAdmin';
import { isFamilyKinPath } from '../functions/src/lib/kinArchive';
import { resolveKinLink } from '../functions/src/lib/kinLink';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
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
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'repairCrossedKinLinks.ts: have the mirror give each crossed household Kin its own admin record (#1912)',
          '',
          '  npm run repair:crossed-kin-links                    # DRY RUN (default)',
          '  npm run repair:crossed-kin-links -- --allow-prod    # apply (only after #1912 is deployed)',
          '  npm run repair:crossed-kin-links -- --dry-run       # force dry run, always wins',
          '  npm run repair:crossed-kin-links -- --project <id>  # override project',
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

export interface CrossedKin {
  /** `families/{fid}/kin/{kinId}`: the doc the apply touches. */
  path: string;
  kinfolkId: string;
  kinId: string;
  /** The admin record it is wrongly tied to. */
  flatId: string;
  /** The Kin that keeps that record, or null when the office held it alone. */
  ownerKinId: string | null;
}

export interface Summary {
  scanned: number;
  flatSkipped: number;
  linked: number;
  noRecord: number;
  foreign: number;
  crossed: number;
}

/** Reads every family Kin and lists the crossed ones, one per admin record. Read only. */
export async function buildPlan(db: Firestore): Promise<{ summary: Summary; crossed: CrossedKin[] }> {
  const snap = await db.collectionGroup('kin').get();
  const summary: Summary = { scanned: 0, flatSkipped: 0, linked: 0, noRecord: 0, foreign: 0, crossed: 0 };
  const crossed: CrossedKin[] = [];
  const planned = new Set<string>();

  for (const doc of snap.docs) {
    summary.scanned += 1;
    const path = doc.ref.path;
    if (!isFamilyKinPath(path)) {
      summary.flatSkipped += 1;
      continue;
    }
    const [, kinfolkId, , kinId] = path.split('/');
    const link = await resolveKinLink(kinfolkId, kinId, (doc.data() ?? {}) as Record<string, unknown>);
    if (link.state === 'linked') summary.linked += 1;
    else if (link.state === 'none') summary.noRecord += 1;
    else if (link.state === 'foreign') summary.foreign += 1;
    else {
      summary.crossed += 1;
      const key = `${kinfolkId}/${link.flatId}`;
      if (planned.has(key)) continue;
      planned.add(key);
      crossed.push({ path, kinfolkId, kinId, flatId: link.flatId, ownerKinId: link.ownerKinId });
    }
  }
  return { summary, crossed };
}

function report(summary: Summary, crossed: CrossedKin[], mode: Mode): void {
  console.log('');
  console.log(`=== crossed household Kin links (#1912, ${mode.toUpperCase()}) ===`);
  console.log(`kin docs scanned                    : ${summary.scanned}`);
  console.log(`flat kin docs (never touched)       : ${summary.flatSkipped}`);
  console.log(`family Kin on their own record      : ${summary.linked}`);
  console.log(`family Kin with no record yet       : ${summary.noRecord}`);
  console.log(`family Kin linked outside household : ${summary.foreign}`);
  console.log(`family Kin on another Kin's record  : ${summary.crossed}`);
  console.log(`family docs to touch                : ${crossed.length}`);
  if (crossed.length > 0) {
    console.log('');
    console.log('-- docs to touch (record it is tied to; Kin that keeps that record) --');
    for (const c of crossed) {
      console.log(`  ${c.path}  -> kin/${c.flatId}  (kept by ${c.ownerKinId ?? 'no household Kin'})`);
    }
  }
  console.log('');
}

/**
 * Touches each planned family doc so the deployed mirror repairs it, and
 * returns how many were touched. A Kin deleted since the plan was read is
 * skipped, so it neither comes back nor fails the rest of its batch; update(),
 * never set(), covers a delete that lands between the read and the write.
 * Exported for the tests.
 */
export async function applyPlan(db: Firestore, crossed: CrossedKin[]): Promise<number> {
  for (const c of crossed) {
    if (!isFamilyKinPath(c.path)) throw new Error(`refusing to write outside families/*/kin: ${c.path}`);
  }
  const CHUNK = 400;
  let touched = 0;
  for (let i = 0; i < crossed.length; i += CHUNK) {
    const batch = db.batch();
    let inBatch = 0;
    for (const c of crossed.slice(i, i + CHUNK)) {
      const ref = db.doc(c.path);
      if (!(await ref.get()).exists) continue;
      batch.update(ref, { updatedAt: FieldValue.serverTimestamp() });
      inBatch += 1;
    }
    if (inBatch > 0) await batch.commit();
    touched += inBatch;
  }
  return touched;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (args.mode === 'apply' && !args.allowProd && !emulator) {
    throw new Error('refusing to write without --allow-prod (or FIRESTORE_EMULATOR_HOST)');
  }
  if (args.mode === 'apply' && !emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error('a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)');
  }
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  const { summary, crossed } = await buildPlan(db);
  report(summary, crossed, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply (only after #1912 is deployed).');
    return;
  }
  const touched = await applyPlan(db, crossed);
  console.log(`APPLIED: ${touched} of ${crossed.length} family Kin doc(s) touched (any others were deleted since the plan was read). Re-run the dry run to confirm none remain.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
