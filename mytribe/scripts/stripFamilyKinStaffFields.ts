/**
 * stripFamilyKinStaffFields.ts (#1335)
 *
 * Deletes the staff-only pet fields (officeNotes, reactive, routine,
 * trainingCommands, feedingBrand, vaccinations, medicationHealthNotes, tags:
 * functions/src/lib/kinStaffFields.ts) from every FAMILY kin doc,
 * `families/{fid}/kin/{kinId}`.
 *
 * WHY. Every active household member can read that document with the client
 * SDK, and a Firestore rule gates a document, never a field. Until #1335 the
 * flat -> family mirror (`onFlatKinWrite`) copied these fields onto it, so a
 * household could read the office's notes about its own pet. The mirror no
 * longer writes them; this removes the copies already written.
 *
 * NOTHING IS MOVED, because nothing needs to be. The family copies were only
 * ever mirrored FROM the flat `kin/{docId}` doc, which stays the canonical,
 * staff-only home of every one of these fields, and every admin client (web,
 * Android, desktop console) and the Python reconcile job read them there. No
 * reader of the family copy exists.
 *
 * THE FLAT DOC IS NEVER TOUCHED. `collectionGroup('kin')` also matches the
 * top-level flat collection, so every doc is filtered to the exact
 * `families/{fid}/kin/{kinId}` shape before it is planned. The emulator test
 * seeds a flat doc carrying the same fields and asserts it is unchanged.
 *
 * DIVERGENCE IS REPORTED, NEVER REPAIRED. For each doc it strips, the dry run
 * looks up the flat doc (by `legacyKinId`) and lists, per field, whether the
 * flat copy is missing or holds a different value. That is the only case in
 * which a delete loses something; the operator reads it before applying and can
 * copy a value onto the flat doc by hand in the admin. The script never writes
 * to the flat doc.
 *
 * IT DELETES THESE KEYS AND NOTHING ELSE. Each update carries exactly
 * `{ <key>: FieldValue.delete() }` for the keys present, never a set(). The
 * delete re-fires `onFamilyKinWrite`. When the family doc is linked to a flat
 * doc, the trigger skips it: no parent-visible field changed, so it neither
 * re-mirrors nor notifies the household. A family doc with NO flat doc (listed
 * as `no-flat-doc` in the dry run) takes the trigger's normal create path, so
 * the apply also creates a flat mirror for that pet from its portal fields.
 *
 * IDEMPOTENT. Only a doc that still carries one of the keys is planned, so a
 * second run plans nothing and commits no batch.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run and beats --allow-prod in either order.
 *   --project <id> overrides the project id.
 */
import { getApps, initializeApp, FieldValue, getFirestore, type Firestore } from './lib/firebaseAdmin';
import { STAFF_ONLY_KIN_FIELDS } from '../functions/src/lib/kinStaffFields';

export const KIN_COLLECTION_GROUP = 'kin';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // An explicit --dry-run always wins, in either flag order, so it is
  // remembered past the loop rather than applied inline.
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
          'stripFamilyKinStaffFields.ts: delete staff-only pet fields from families/{fid}/kin/{kinId}',
          '',
          '  npm run strip:family-kin-staff-fields                    # DRY RUN (default)',
          '  npm run strip:family-kin-staff-fields -- --allow-prod    # apply',
          '  npm run strip:family-kin-staff-fields -- --dry-run       # force dry run, always wins',
          '  npm run strip:family-kin-staff-fields -- --project <id>  # override project',
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

/** True only for `families/{fid}/kin/{kinId}`; the flat `kin/{docId}` is never planned. */
export function isFamilyKinPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'families' && parts[2] === 'kin';
}

/** The staff-only keys this doc carries, in list order. PURE. */
export function staffKeysPresent(data: Record<string, unknown>): string[] {
  return STAFF_ONLY_KIN_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(data, k));
}

export type FlatComparison = 'same' | 'flat-missing-field' | 'flat-differs' | 'no-flat-doc';

/**
 * How the family copy of one key compares with the canonical flat copy. PURE.
 * `null` and an absent key on the family side are both "nothing to lose".
 */
export function compareWithFlat(
  key: string,
  familyData: Record<string, unknown>,
  flatData: Record<string, unknown> | null,
): FlatComparison {
  if (flatData === null) return 'no-flat-doc';
  const familyValue = familyData[key];
  if (familyValue === null || familyValue === undefined) return 'same';
  if (!Object.prototype.hasOwnProperty.call(flatData, key)) return 'flat-missing-field';
  return JSON.stringify(flatData[key]) === JSON.stringify(familyValue) ? 'same' : 'flat-differs';
}

export interface PlannedWrite {
  path: string;
  keys: string[];
}

export interface Divergence {
  path: string;
  key: string;
  comparison: Exclude<FlatComparison, 'same'>;
  familyValue: unknown;
}

export interface Summary {
  scanned: number;
  flatSkipped: number;
  alreadyClean: number;
  toStrip: number;
  keysToDelete: number;
}

/**
 * The canonical flat doc for a family pet: `kin/{legacyKinId}` when the link is
 * stamped, else the flat doc whose `familyKinPath` names this one (the same two
 * keys `onFamilyKinWrite.findFlatMirror` adopts by). Read only.
 */
async function findFlatDoc(
  db: Firestore,
  familyPath: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const legacyKinId = typeof data['legacyKinId'] === 'string' ? data['legacyKinId'] : '';
  if (legacyKinId) {
    const snap = await db.collection('kin').doc(legacyKinId).get();
    if (snap.exists) return (snap.data() ?? {}) as Record<string, unknown>;
  }
  const byPath = await db.collection('kin').where('familyKinPath', '==', familyPath).limit(1).get();
  return byPath.empty ? null : ((byPath.docs[0].data() ?? {}) as Record<string, unknown>);
}

export async function buildPlan(
  db: Firestore,
): Promise<{ summary: Summary; writes: PlannedWrite[]; divergences: Divergence[] }> {
  const snap = await db.collectionGroup(KIN_COLLECTION_GROUP).get();
  const summary: Summary = { scanned: 0, flatSkipped: 0, alreadyClean: 0, toStrip: 0, keysToDelete: 0 };
  const writes: PlannedWrite[] = [];
  const divergences: Divergence[] = [];

  for (const doc of snap.docs) {
    summary.scanned += 1;
    if (!isFamilyKinPath(doc.ref.path)) {
      summary.flatSkipped += 1;
      continue;
    }
    const data = doc.data() as Record<string, unknown>;
    const keys = staffKeysPresent(data);
    if (keys.length === 0) {
      summary.alreadyClean += 1;
      continue;
    }
    summary.toStrip += 1;
    summary.keysToDelete += keys.length;
    writes.push({ path: doc.ref.path, keys });

    const flatData = await findFlatDoc(db, doc.ref.path, data);
    for (const key of keys) {
      const comparison = compareWithFlat(key, data, flatData);
      if (comparison !== 'same') {
        divergences.push({ path: doc.ref.path, key, comparison, familyValue: data[key] });
      }
    }
  }
  return { summary, writes, divergences };
}

function report(summary: Summary, writes: PlannedWrite[], divergences: Divergence[], mode: Mode): void {
  console.log('');
  console.log(`=== family kin staff-only field strip (${mode.toUpperCase()}) ===`);
  console.log(`fields stripped              : ${STAFF_ONLY_KIN_FIELDS.join(', ')}`);
  console.log(`kin docs scanned             : ${summary.scanned}`);
  console.log(`flat kin docs (never touched): ${summary.flatSkipped}`);
  console.log(`family docs already clean    : ${summary.alreadyClean}`);
  console.log(`family docs to strip         : ${summary.toStrip}`);
  console.log(`keys to delete               : ${summary.keysToDelete}`);
  if (writes.length > 0) {
    console.log('');
    console.log('-- docs to strip --');
    for (const w of writes) console.log(`  ${w.path}  [${w.keys.join(', ')}]`);
  }
  if (divergences.length > 0) {
    console.log('');
    console.log('-- values the flat (staff) doc does NOT hold. A delete loses these. --');
    console.log('   Copy any worth keeping onto the pet in the admin BEFORE the --allow-prod run.');
    for (const d of divergences) {
      console.log(`  ${d.path}  ${d.key} (${d.comparison}) = ${JSON.stringify(d.familyValue)}`);
    }
  }
  console.log('');
}

/** Applies the plan. Exported so the emulator test can prove the delete lands. */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<void> {
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      if (!isFamilyKinPath(w.path)) throw new Error(`refusing to write outside families/*/kin: ${w.path}`);
      const update: Record<string, unknown> = {};
      for (const k of w.keys) update[k] = FieldValue.delete();
      batch.update(db.doc(w.path), update);
    }
    await batch.commit();
  }
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

  const { summary, writes, divergences } = await buildPlan(db);
  report(summary, writes, divergences, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  await applyPlan(db, writes);
  console.log(`APPLIED: staff-only fields deleted from ${writes.length} family kin doc(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
