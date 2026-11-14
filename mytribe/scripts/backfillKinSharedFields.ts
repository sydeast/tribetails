/**
 * backfillKinSharedFields.ts (#1907, #1908)
 *
 * Brings every Kin written before the shared Kin fields up to the field table
 * in `functions/src/triggers/kinMirror.ts`, on both copies of each Kin: the
 * household's `families/{fid}/kin/{kinId}` and the admin's flat `kin/{docId}`.
 * The mirror triggers carry each field from the next edit on; this carries what
 * is already there, so a household does not open a blank box, type into it and
 * overwrite what the office had written.
 *
 * PER LINKED PAIR (a flat doc whose `familyKinPath` names a household copy that
 * exists):
 *   1. MEDICATIONS (kin-meds ruling 2026-11-12: one field, and the office's
 *      notes become visible to the household, chosen knowingly). The household
 *      `medications` and the admin `medicationHealthNotes` are joined into one
 *      text, household first, a blank line between, written to both. When one
 *      is blank, or both say the same, the other is the field. The stale
 *      verbatim copy the old mirror left on the flat doc (`medications`) is
 *      deleted. A joined text over 4000 characters (what the portal accepts)
 *      is listed, because the household could not then edit it.
 *   2. THE CARE FACTS THE HOUSEHOLD NOW FILLS (owner ruling 2026-11-11): Stays
 *      as, Routine, Training / commands, Food / brand, Vaccinations are copied
 *      admin -> household where the household copy has none. A household copy
 *      that holds a different value keeps it and is listed.
 *   3. THE CARE BLOCK THE ADMIN NOW EDITS (feeding, walking, allergies,
 *      emergency notes, notes for the Auntie) already sits on the flat doc,
 *      copied by the old mirror. A null there becomes "", which is how every
 *      admin `Kin` model reads "none" (#1370); the same is done for every
 *      shared text field.
 *   4. AGE (#1907). The household's `ageYears` (a number) and the admin's
 *      `age` (text) fill each other where one is blank. Both set and
 *      disagreeing is listed, never guessed. The stale verbatim `ageYears` the
 *      old mirror left on the flat doc is deleted.
 *   5. THE OLD FREE-TEXT VET NOTE (`vetInfo`) is no longer an input on either
 *      side (kin-vet ruling). It is counted and listed, never moved: no clinic
 *      id can be read out of free text without guessing.
 *
 * PER HOUSEHOLD (kin-vet ruling, one store for the household vet): a portal
 * pick kept only as the `vetClinicId` row of `families/{id}.customFields` is
 * moved to `household_data.primaryVetClinicId` when the household's
 * `household_data` carries no vet, and the row is removed. A household whose
 * two copies name different clinics keeps the admin's (the one both apps now
 * read) and is listed; its row is left for a person.
 *
 * NEVER TOUCHED: a flat doc with no link or whose household copy does not exist
 * (counted; the live trigger makes the copy on its next write, and
 * `backfill_kin_adoption.ts` covers the rest), the staff-only fields
 * (officeNotes, reactive, tags), names, photos and status.
 *
 * ECHO-SAFE. Every household-copy write carries the reverse mirror's stamp and
 * every flat write the forward mirror's (`mirrorStamp`), so neither trigger
 * copies it back and no household is told "your pets changed".
 *
 * IDEMPOTENT. A second run plans nothing: every value it writes is the value
 * the next run compares against.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run and beats --allow-prod in either order.
 *   --project <id> overrides the project id.
 */
import { getApps, initializeApp, FieldValue, getFirestore, type Firestore } from './lib/firebaseAdmin';
import {
  AGE_FAMILY_KEY,
  AGE_FLAT_KEY,
  FLAT_NON_NULL_TEXT_FIELDS,
  MEDS_FAMILY_KEY,
  MEDS_FLAT_KEY,
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  formatAgeText,
  mirrorStamp,
  parseAgeYears,
} from '../functions/src/triggers/kinMirror';
import { LEGACY_VET_ROW_KEY } from '../functions/src/lib/vetClinicCatalog';

type Data = Record<string, unknown>;
type Mode = 'dry-run' | 'apply';

/** Marks a key the apply deletes. Turned into `FieldValue.delete()` there. */
export const DELETE = Symbol('delete');
export type PlanValue = unknown | typeof DELETE;

/** The portal's cap on Medications (functions/src/portal/kinWrites.ts). */
export const MEDS_MAX = 4000;

/** Admin-kept care facts the household now fills (#1908, 2026-11-11). */
export const HOUSEHOLD_NOW_FILLS: readonly string[] = ['staysAs', 'routine', 'trainingCommands', 'feedingBrand', 'vaccinations'];

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // An explicit --dry-run always wins, in either flag order.
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
          'backfillKinSharedFields.ts: bring existing Kin up to the shared Kin fields (#1907, #1908)',
          '',
          '  npm run backfill:kin-shared-fields                    # DRY RUN (default)',
          '  npm run backfill:kin-shared-fields -- --allow-prod    # apply',
          '  npm run backfill:kin-shared-fields -- --dry-run       # force dry run, always wins',
          '  npm run backfill:kin-shared-fields -- --project <id>  # override project',
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

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The one Medications text both notes become. PURE. */
export function mergeMedications(household: unknown, office: unknown): string {
  const a = text(household);
  const b = text(office);
  if (a === '') return b;
  if (b === '' || a === b) return a;
  return `${a}\n\n${b}`;
}

export type NoteKind =
  | 'meds-over-cap'
  | 'care-fact-differs'
  | 'age-differs'
  | 'legacy-vet-note'
  | 'household-vet-differs';

export interface Note {
  path: string;
  kind: NoteKind;
  detail: string;
}

export interface PairPlan {
  flatPath: string;
  familyPath: string;
  flatUpdate: Record<string, PlanValue>;
  familyUpdate: Record<string, PlanValue>;
  notes: Note[];
}

/**
 * What one linked Kin needs on each copy. PURE: [flat] and [family] are the two
 * documents as stored.
 */
export function planPair(flatPath: string, flat: Data, familyPath: string, family: Data): PairPlan {
  const flatUpdate: Record<string, PlanValue> = {};
  const familyUpdate: Record<string, PlanValue> = {};
  const notes: Note[] = [];

  // 1. Medications.
  const merged = mergeMedications(family[MEDS_FAMILY_KEY], flat[MEDS_FLAT_KEY]);
  if (merged !== '' && merged !== family[MEDS_FAMILY_KEY]) familyUpdate[MEDS_FAMILY_KEY] = merged;
  if (merged !== '' && merged !== flat[MEDS_FLAT_KEY]) flatUpdate[MEDS_FLAT_KEY] = merged;
  if (Object.prototype.hasOwnProperty.call(flat, MEDS_FAMILY_KEY)) flatUpdate[MEDS_FAMILY_KEY] = DELETE;
  if (merged.length > MEDS_MAX) {
    notes.push({ path: familyPath, kind: 'meds-over-cap', detail: `${merged.length} characters` });
  }

  // 2. The care facts the household now fills.
  for (const k of HOUSEHOLD_NOW_FILLS) {
    const office = text(flat[k]);
    const household = text(family[k]);
    if (office === '') continue;
    if (household === '') familyUpdate[k] = flat[k];
    else if (household !== office) notes.push({ path: familyPath, kind: 'care-fact-differs', detail: k });
  }

  // 3. No null text on the admin copy.
  for (const k of FLAT_NON_NULL_TEXT_FIELDS) {
    if (flat[k] === null && !(k in flatUpdate)) flatUpdate[k] = '';
  }

  // 4. Age.
  const householdAge = parseAgeYears(family[AGE_FAMILY_KEY]);
  const officeText = text(flat[AGE_FLAT_KEY]);
  const officeAge = parseAgeYears(officeText);
  if (householdAge !== null && officeText === '') flatUpdate[AGE_FLAT_KEY] = formatAgeText(householdAge);
  else if (householdAge === null && officeAge !== null) familyUpdate[AGE_FAMILY_KEY] = officeAge;
  else if (householdAge !== null && officeAge !== null && householdAge !== officeAge) {
    notes.push({ path: familyPath, kind: 'age-differs', detail: `household ${householdAge}, admin "${officeText}"` });
  }
  if (Object.prototype.hasOwnProperty.call(flat, AGE_FAMILY_KEY)) flatUpdate[AGE_FAMILY_KEY] = DELETE;

  // 5. The old free-text vet note: counted, never moved.
  const vetNote = text(family['vetInfo']) || text(flat['vetInfo']);
  if (vetNote !== '') notes.push({ path: familyPath, kind: 'legacy-vet-note', detail: vetNote });

  return { flatPath, familyPath, flatUpdate, familyUpdate, notes };
}

export interface HouseholdVetPlan {
  kinfolkId: string;
  /** Set when the vet moves: the `household_data` doc and the clinic id. */
  move: { householdDataPath: string; create: boolean; clinicId: string } | null;
  /** True when the legacy row is removed from `families/{id}.customFields`. */
  dropRow: boolean;
  notes: Note[];
}

/**
 * What one household's vet needs. PURE: [family] is `families/{id}`, and
 * [householdData] its `household_data` doc, with that doc's path (null when the
 * household has none).
 */
export function planHouseholdVet(
  kinfolkId: string,
  family: Data,
  householdData: { path: string; data: Data } | null,
): HouseholdVetPlan {
  const rows = Array.isArray(family['customFields']) ? (family['customFields'] as Data[]) : [];
  const row = rows.find((r) => typeof r === 'object' && r !== null && r['key'] === LEGACY_VET_ROW_KEY);
  const legacy = row ? text(row['value']) : '';
  const plan: HouseholdVetPlan = { kinfolkId, move: null, dropRow: false, notes: [] };
  if (!row) return plan;
  const stored = householdData?.data['primaryVetClinicId'];
  const hasStored = typeof stored === 'string' && stored.trim() !== '';
  if (legacy === '' || (hasStored && text(stored) === legacy)) {
    plan.dropRow = true;
    return plan;
  }
  if (hasStored) {
    plan.notes.push({ path: `families/${kinfolkId}`, kind: 'household-vet-differs', detail: `portal ${legacy}, admin ${text(stored)}` });
    return plan;
  }
  plan.move = {
    householdDataPath: householdData?.path ?? `household_data/${kinfolkId}`,
    create: householdData === null,
    clinicId: legacy,
  };
  plan.dropRow = true;
  return plan;
}

/** Applies a pair plan's updates to in-memory copies. Used by the idempotency test. PURE. */
export function applyUpdate(doc: Data, update: Record<string, PlanValue>): Data {
  const out: Data = { ...doc };
  for (const [k, v] of Object.entries(update)) {
    if (v === DELETE) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function isEmptyPlan(p: PairPlan): boolean {
  return Object.keys(p.flatUpdate).length === 0 && Object.keys(p.familyUpdate).length === 0;
}

export interface Plan {
  pairs: PairPlan[];
  households: HouseholdVetPlan[];
  unlinked: number;
  missingFamilyCopy: number;
  scanned: number;
}

function isFamilyKinPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'families' && parts[2] === 'kin' && parts.every((p) => p !== '');
}

/** Reads everything and plans. Writes nothing. */
export async function buildPlan(db: Firestore): Promise<Plan> {
  const plan: Plan = { pairs: [], households: [], unlinked: 0, missingFamilyCopy: 0, scanned: 0 };
  const flats = await db.collection('kin').get();
  for (const doc of flats.docs) {
    plan.scanned += 1;
    const flat = (doc.data() ?? {}) as Data;
    const familyPath = text(flat['familyKinPath']);
    if (!isFamilyKinPath(familyPath)) {
      plan.unlinked += 1;
      continue;
    }
    const famSnap = await db.doc(familyPath).get();
    if (!famSnap.exists) {
      plan.missingFamilyCopy += 1;
      continue;
    }
    const pair = planPair(`kin/${doc.id}`, flat, familyPath, (famSnap.data() ?? {}) as Data);
    if (!isEmptyPlan(pair) || pair.notes.length > 0) plan.pairs.push(pair);
  }

  const householdData = await db.collection('household_data').get();
  const byKinfolk = new Map<string, { path: string; data: Data }>();
  for (const d of householdData.docs) {
    const data = (d.data() ?? {}) as Data;
    const key = text(data['kinfolkId']) || d.id;
    if (!byKinfolk.has(key)) byKinfolk.set(key, { path: `household_data/${d.id}`, data });
  }
  const families = await db.collection('families').get();
  for (const d of families.docs) {
    const hv = planHouseholdVet(d.id, (d.data() ?? {}) as Data, byKinfolk.get(d.id) ?? null);
    if (hv.move || hv.dropRow || hv.notes.length > 0) plan.households.push(hv);
  }
  return plan;
}

function toFirestore(update: Record<string, PlanValue>): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(update)) out[k] = v === DELETE ? FieldValue.delete() : v;
  return out;
}

/** Applies the plan. Writes only what the plan lists. */
export async function applyPlan(db: Firestore, plan: Plan): Promise<number> {
  type Op = (b: FirebaseFirestore.WriteBatch) => void;
  const ops: Op[] = [];
  for (const p of plan.pairs) {
    if (Object.keys(p.familyUpdate).length > 0) {
      const data = { ...toFirestore(p.familyUpdate), ...mirrorStamp(MIRROR_ORIGIN_FLAT) };
      ops.push((b) => b.set(db.doc(p.familyPath), data, { merge: true }));
    }
    if (Object.keys(p.flatUpdate).length > 0) {
      const data = { ...toFirestore(p.flatUpdate), ...mirrorStamp(MIRROR_ORIGIN_FAMILY) };
      ops.push((b) => b.set(db.doc(p.flatPath), data, { merge: true }));
    }
  }
  for (const h of plan.households) {
    if (h.move) {
      const move = h.move;
      const data: Data = { primaryVetClinicId: move.clinicId, updatedAt: FieldValue.serverTimestamp() };
      if (move.create) Object.assign(data, { kinfolkId: h.kinfolkId, createdAt: FieldValue.serverTimestamp() });
      ops.push((b) => b.set(db.doc(move.householdDataPath), data, { merge: true }));
    }
    if (h.dropRow) {
      const familyRef = db.doc(`families/${h.kinfolkId}`);
      const snap = await familyRef.get();
      const rows = ((snap.data() ?? {})['customFields'] as Data[] | undefined) ?? [];
      const kept = rows.filter((r) => !(typeof r === 'object' && r !== null && r['key'] === LEGACY_VET_ROW_KEY));
      ops.push((b) => b.set(familyRef, { customFields: kept }, { merge: true }));
    }
  }
  const CHUNK = 400;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + CHUNK)) op(batch);
    await batch.commit();
  }
  return ops.length;
}

function report(plan: Plan, mode: Mode): void {
  const notes = [...plan.pairs.flatMap((p) => p.notes), ...plan.households.flatMap((h) => h.notes)];
  const count = (k: NoteKind) => notes.filter((n) => n.kind === k).length;
  console.log('');
  console.log(`=== Kin shared fields backfill (${mode.toUpperCase()}) ===`);
  console.log(`admin kin docs scanned                 : ${plan.scanned}`);
  console.log(`  with no household link (left alone)  : ${plan.unlinked}`);
  console.log(`  linked to a missing copy (left alone): ${plan.missingFamilyCopy}`);
  console.log(`kin pairs to update                    : ${plan.pairs.filter((p) => !isEmptyPlan(p)).length}`);
  console.log(`households whose vet moves             : ${plan.households.filter((h) => h.move).length}`);
  console.log(`old vet notes (free text, not moved)   : ${count('legacy-vet-note')}`);
  for (const p of plan.pairs.filter((x) => !isEmptyPlan(x))) {
    const show = (u: Record<string, PlanValue>) =>
      Object.entries(u).map(([k, v]) => `${k}=${v === DELETE ? '<delete>' : JSON.stringify(v)}`).join(', ');
    console.log(`  ${p.familyPath}  household: {${show(p.familyUpdate)}}  admin ${p.flatPath}: {${show(p.flatUpdate)}}`);
  }
  for (const h of plan.households.filter((x) => x.move)) {
    console.log(`  families/${h.kinfolkId} vet ${h.move!.clinicId} -> ${h.move!.householdDataPath}${h.move!.create ? ' (new doc)' : ''}`);
  }
  if (notes.length > 0) {
    console.log('');
    console.log('-- for a person (nothing is guessed) --');
    for (const n of notes) console.log(`  ${n.path}  ${n.kind}: ${n.detail}`);
  }
  console.log('');
}

/** Plans, reports, and writes only in apply mode. The dry run reads and nothing more. */
export async function run(db: Firestore, mode: Mode): Promise<{ plan: Plan; ops: number }> {
  const plan = await buildPlan(db);
  report(plan, mode);
  if (mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return { plan, ops: 0 };
  }
  const ops = await applyPlan(db, plan);
  console.log(`APPLIED: ${ops} write(s).`);
  return { plan, ops };
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
  const projectId = args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  await run(db, args.mode);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
