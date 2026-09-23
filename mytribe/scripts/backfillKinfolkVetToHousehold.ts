/**
 * backfillKinfolkVetToHousehold.ts
 *
 * Punchlist A2's migration, in the direction the operator ruled on 2026-08-01:
 * "vet info lives on household data, it can be seen on the kin profile"
 * (page-specs 04-kinfolk-profile.md item 3).
 *
 *   FROM  kinfolk/{id}          vetClinicId + vetClinicName/Phone/Address, and
 *                               the same four again for emergencyVetClinic*.
 *   TO    household_data/{id}   primaryVetClinicId / emergencyVetClinicId, the
 *                               canonical catalog link, with the free-text
 *                               fields kept only as the unlinked fallback.
 *
 * An earlier revision of this script ran the other way. It was written against
 * my own reading that `kinfolk` should win, which the operator overruled; the
 * objection behind it (free text nobody can correct is the emergency number)
 * is answered instead by household_data being catalog-LINKED rather than free
 * text.
 *
 * WHAT IT WRITES, and only this:
 *   - `primaryVetClinicId`   from kinfolk.vetClinicId, when the household has
 *                            none. This is the valuable part: it carries the
 *                            CATALOG LINK across, so the household inherits a
 *                            vet that the clinic manager can correct.
 *   - `emergencyVetClinicId` likewise from kinfolk.emergencyVetClinicId.
 *   - the legacy free-text fields, ONLY for an unlinked kinfolk vet (strings
 *     with no id, which is every household written before the picker) and ONLY
 *     where household_data has nothing. No id can be invented from a name
 *     without guessing, and a wrong id is worse than none: it would enrol the
 *     household in another clinic's record and show a different practice's
 *     phone number.
 *
 * THE DELETE, and why an omission would not do (trap 1). Android's
 * `updateKinfolk` writes with `SetOptions.merge()`, whose own comment notes
 * that every MODELLED field still ships. The corollary is that a field the
 * model no longer declares is simply never written, so the stored value
 * SURVIVES untouched. Removing the eight fields from the Kotlin data class
 * therefore closes the write path but leaves a fully populated second copy on
 * every existing document, which still looks authoritative to the next reader
 * and to any query. So this script deletes them explicitly with
 * `FieldValue.delete()`. That is the difference between a migration that works
 * and one that only looks like it did, and it is asserted end to end in
 * `scripts/test/backfillKinfolkVetToHousehold.test.ts` against a real emulator
 * document rather than reasoned about.
 *
 * WHAT IT NEVER DOES:
 *   - It never overwrites a household_data value that is already set. A
 *     household that has already chosen a vet has made the more recent
 *     decision.
 *   - It never resolves a disagreement. Where both sides are populated and
 *     differ, the household's value stands and the conflict is REPORTED for a
 *     person, because picking a winner automatically is how a household ends
 *     up dialling the wrong number with nothing recording that a choice was
 *     made.
 *   - It never writes hours. Hours moved to `vet_clinics.hours`: they belong to
 *     the practice, so one household's note must not become every household's
 *     truth. Any `primaryVetHours` still on a record is reported for curation.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Runbook: run DRY first, read the plan and the conflicts, then re-run with
 * --allow-prod. This script has NOT been run against production as part of the
 * PR that ships it; it is a runbook step.
 *
 * STATUS (docs/RUNBOOK.md, "Scripts and the data re-upload"): post-import
 * check. The scan reads every `kinfolk` document by field presence, not by
 * write date, so run the dry run again after the household/kin re-upload.
 */
import { getApps, initializeApp, getFirestore, FieldValue, type Firestore } from './lib/firebaseAdmin';
type Mode = 'dry-run' | 'apply';
export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}
export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked
  // separately from `args.mode` (rather than setting `args.mode = 'dry-run'`
  // inline the moment `--dry-run` is seen) because the unconditional
  // `if (args.allowProd) args.mode = 'apply'` below runs once, AFTER the
  // whole argv has been scanned — so `--allow-prod --dry-run` would silently
  // re-flip mode to 'apply' if this flag's own presence weren't remembered
  // past the loop. This is the one flag whose entire purpose is proving a run
  // is safe before it moves vet records and DELETES the eight retired kinfolk
  // fields; getting its precedence backwards defeats that purpose.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`, which would take the safety flag off
      // the table while `--allow-prod` stayed on. This script has no numeric
      // flag to fall back on, so this branch is the only place that can say it.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillKinfolkVetToHousehold.ts — move the vet off kinfolk onto household_data (punchlist A2)',
          '',
          '  npm run backfill:household-vet                    # DRY RUN (default)',
          '  npm run backfill:household-vet -- --allow-prod    # apply',
          '  npm run backfill:household-vet -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run backfill:household-vet -- --project <id>  # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still does not write).',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  // `explicitDryRun` wins regardless of flag order — see the comment on its
  // declaration above. `args.allowProd` is deliberately NOT cleared when it
  // loses: the flag was genuinely passed, `report()` prints the resolved mode,
  // and main()'s belt-and-braces apply guard reads `allowProd` directly. A
  // parser that lied about which flags it saw would make that guard's failure
  // message unreadable.
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}
/** The eight kinfolk fields this migration retires. Deleted, never merely ignored. */
export const RETIRED_KINFOLK_VET_FIELDS = [
  'vetClinicId',
  'vetClinicName',
  'vetClinicPhone',
  'vetClinicAddress',
  'emergencyVetClinicId',
  'emergencyVetClinicName',
  'emergencyVetClinicPhone',
  'emergencyVetClinicAddress',
] as const;
export interface VetConflict {
  kinfolkId: string;
  field: string;
  householdValue: string;
  kinfolkValue: string;
}
export interface VetPlan {
  /** Fields to merge onto `household_data`. Empty means nothing to carry across. */
  householdUpdate: Record<string, string>;
  /** True when the kinfolk doc still carries any retired field, so it needs clearing. */
  clearKinfolk: boolean;
  conflicts: VetConflict[];
  hoursToCurate: string | null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
/**
 * The decision for ONE household. PURE: no Firestore access, so the whole rule
 * is unit-testable against fixtures.
 */
export function planVetMigration(
  kinfolkId: string,
  kinfolk: Record<string, unknown>,
  household: Record<string, unknown> | null,
): VetPlan {
  const plan: VetPlan = {
    householdUpdate: {},
    clearKinfolk: false,
    conflicts: [],
    hoursToCurate: null,
  };
  const hh = household ?? {};
  plan.clearKinfolk = RETIRED_KINFOLK_VET_FIELDS.some((f) => kinfolk[f] !== undefined);
  const slots = [
    { kId: 'vetClinicId', hId: 'primaryVetClinicId', kName: 'vetClinicName', kPhone: 'vetClinicPhone', kAddr: 'vetClinicAddress', hName: 'primaryVetName', hPhone: 'primaryVetPhone', hAddr: 'primaryVetAddress' },
    { kId: 'emergencyVetClinicId', hId: 'emergencyVetClinicId', kName: 'emergencyVetClinicName', kPhone: 'emergencyVetClinicPhone', kAddr: 'emergencyVetClinicAddress', hName: 'emergencyVetName', hPhone: 'emergencyVetPhone', hAddr: 'emergencyVetAddress' },
  ] as const;
  for (const slot of slots) {
    const kId = str(kinfolk[slot.kId]);
    const hId = str(hh[slot.hId]);
    if (kId !== '') {
      // The catalog link. The valuable case: the household inherits a vet the
      // clinic manager can correct.
      if (hId === '') plan.householdUpdate[slot.hId] = kId;
      else if (hId !== kId) {
        plan.conflicts.push({
          kinfolkId,
          field: slot.hId,
          householdValue: hId,
          kinfolkValue: kId,
        });
      }
      continue;
    }
    // Unlinked kinfolk vet: carry the strings, since no id can be invented from
    // a name without guessing, and a wrong id is worse than none.
    if (hId !== '') continue; // The household is already linked; it wins.
    for (const [kKey, hKey] of [
      [slot.kName, slot.hName],
      [slot.kPhone, slot.hPhone],
      [slot.kAddr, slot.hAddr],
    ] as const) {
      const kVal = str(kinfolk[kKey]);
      const hVal = str(hh[hKey]);
      if (kVal === '') continue;
      if (hVal === '') plan.householdUpdate[hKey] = kVal;
      else if (hVal.toLowerCase() !== kVal.toLowerCase()) {
        plan.conflicts.push({ kinfolkId, field: hKey, householdValue: hVal, kinfolkValue: kVal });
      }
    }
  }
  const hours = str(hh['primaryVetHours']);
  if (hours !== '') plan.hoursToCurate = hours;
  return plan;
}
export interface Summary {
  scanned: number;
  householdsUpdated: number;
  fieldsWritten: number;
  kinfolkCleared: number;
  conflicts: VetConflict[];
  hours: Array<{ kinfolkId: string; hours: string }>;
}
export interface PlannedWrite {
  kinfolkId: string;
  /** `household_data` document id, or null when the record must be created. */
  householdDocId: string | null;
  householdUpdate: Record<string, string>;
  clearKinfolk: boolean;
}
export async function buildPlan(
  db: Firestore,
): Promise<{ summary: Summary; writes: PlannedWrite[] }> {
  const kinfolkSnap = await db.collection('kinfolk').get();
  const summary: Summary = {
    scanned: 0,
    householdsUpdated: 0,
    fieldsWritten: 0,
    kinfolkCleared: 0,
    conflicts: [],
    hours: [],
  };
  const writes: PlannedWrite[] = [];
  for (const doc of kinfolkSnap.docs) {
    summary.scanned += 1;
    const hhSnap = await db
      .collection('household_data')
      .where('kinfolkId', '==', doc.id)
      .limit(1)
      .get();
    const hhDoc = hhSnap.docs[0] ?? null;
    const household = hhDoc ? (hhDoc.data() as Record<string, unknown>) : null;
    const plan = planVetMigration(doc.id, doc.data() as Record<string, unknown>, household);
    const fields = Object.keys(plan.householdUpdate).length;
    if (fields > 0) {
      summary.householdsUpdated += 1;
      summary.fieldsWritten += fields;
    }
    if (plan.clearKinfolk) summary.kinfolkCleared += 1;
    summary.conflicts.push(...plan.conflicts);
    if (plan.hoursToCurate !== null) {
      summary.hours.push({ kinfolkId: doc.id, hours: plan.hoursToCurate });
    }
    if (fields > 0 || plan.clearKinfolk) {
      writes.push({
        kinfolkId: doc.id,
        householdDocId: hhDoc?.id ?? null,
        householdUpdate: plan.householdUpdate,
        clearKinfolk: plan.clearKinfolk,
      });
    }
  }
  return { summary, writes };
}
function report(summary: Summary, writes: PlannedWrite[], mode: Mode): void {
  console.log('');
  console.log(`=== A2 vet migration, kinfolk -> household_data (${mode.toUpperCase()}) ===`);
  console.log(`kinfolk scanned            : ${summary.scanned}`);
  console.log(`households to update       : ${summary.householdsUpdated}`);
  console.log(`household fields to write  : ${summary.fieldsWritten}`);
  console.log(`kinfolk docs to CLEAR      : ${summary.kinfolkCleared}`);
  console.log(`conflicts (manual)         : ${summary.conflicts.length}`);
  console.log(`hours to curate on clinics : ${summary.hours.length}`);
  if (writes.length > 0) {
    console.log('');
    console.log('-- planned writes --');
    for (const w of writes) {
      for (const [k, v] of Object.entries(w.householdUpdate)) {
        const where = w.householdDocId ?? `(new record for ${w.kinfolkId})`;
        console.log(`  household_data/${where}  ${k}: "" -> "${v}"`);
      }
      if (w.clearKinfolk) {
        console.log(`  kinfolk/${w.kinfolkId}  DELETE ${RETIRED_KINFOLK_VET_FIELDS.length} retired vet fields`);
      }
    }
  }
  if (summary.conflicts.length > 0) {
    console.log('');
    console.log('-- CONFLICTS: both sides populated and disagreeing. NOT written. --');
    console.log('   The household_data value stands. Resolve these by hand.');
    for (const c of summary.conflicts) {
      console.log(
        `  ${c.kinfolkId}  ${c.field}: household="${c.householdValue}" vs kinfolk="${c.kinfolkValue}"`,
      );
    }
  }
  if (summary.hours.length > 0) {
    console.log('');
    console.log('-- HOURS: belong to the CLINIC, so one household s note must not --');
    console.log('   become every household s truth. Curate in the vet clinics manager.');
    for (const h of summary.hours) {
      console.log(`  ${h.kinfolkId}  primaryVetHours="${h.hours}"`);
    }
  }
  console.log('');
}
/** Applies the plan. Exported so the emulator test can prove the delete lands. */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      if (Object.keys(w.householdUpdate).length > 0) {
        const ref =
          w.householdDocId !== null
            ? db.collection('household_data').doc(w.householdDocId)
            : db.collection('household_data').doc();
        batch.set(ref, { kinfolkId: w.kinfolkId, ...w.householdUpdate }, { merge: true });
      }
      if (w.clearKinfolk) {
        // THE DELETE. An omission in the model is not enough: merge() leaves an
        // undeclared field untouched, so the old copy would survive and still
        // read as authoritative. See the header.
        const clear: Record<string, FirebaseFirestore.FieldValue> = {};
        for (const f of RETIRED_KINFOLK_VET_FIELDS) clear[f] = FieldValue.delete();
        batch.update(db.collection('kinfolk').doc(w.kinfolkId), clear);
      }
    }
    await batch.commit();
  }
}
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  // Belt and braces, and deliberately kept. `parseArgs` only ever sets
  // mode='apply' under `allowProd`, so this is unreachable today (it was
  // equally unreachable before --dry-run gained its precedence — that fix
  // narrowed when mode becomes 'apply' and so cannot weaken this). It stands
  // as a second, independent assertion of the same invariant at the last
  // moment before any write, which is exactly where a script that migrates
  // and DELETES production fields wants one.
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
  const { summary, writes } = await buildPlan(db);
  report(summary, writes, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  await applyPlan(db, writes);
  console.log(`APPLIED: ${writes.length} household(s) migrated and cleared.`);
}
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
