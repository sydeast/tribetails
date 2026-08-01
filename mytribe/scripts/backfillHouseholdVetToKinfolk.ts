/**
 * backfillHouseholdVetToKinfolk.ts
 *
 * One-shot migration for punchlist A2: the household vet was authored in TWO
 * independent stores that could not agree.
 *
 *   `kinfolk/{id}`          vetClinicName / vetClinicPhone / vetClinicAddress
 *                           + vetClinicId, and the same four for
 *                           emergencyVetClinic*. Picked from the shared
 *                           `vet_clinics` catalog, so it carries the clinic id.
 *   `household_data/{id}`   primaryVetName / Phone / Address / Hours and
 *                           emergencyVetName / Phone / Address. FREE TEXT, with
 *                           no tie to the catalog at all.
 *
 * KINFOLK WINS, and the reason is repairability rather than seniority. Only the
 * catalog-linked copy can be CORRECTED: `updateVetClinic` fixes a wrong clinic
 * phone number once and fans it out to every linked household. Free text on
 * `household_data` inherits nothing, so leaving it authoritative would have
 * meant the number a sitter reads under pressure was the one copy in the whole
 * product that no correction could ever reach.
 *
 * WHAT THIS SCRIPT DOES: fills the GAPS on `kinfolk` from the free text, and
 * only the gaps.
 *
 *   household_data.primaryVetName    -> kinfolk.vetClinicName
 *   household_data.primaryVetPhone   -> kinfolk.vetClinicPhone
 *   household_data.primaryVetAddress -> kinfolk.vetClinicAddress
 *   household_data.emergencyVetName    -> kinfolk.emergencyVetClinicName
 *   household_data.emergencyVetPhone   -> kinfolk.emergencyVetClinicPhone
 *   household_data.emergencyVetAddress -> kinfolk.emergencyVetClinicAddress
 *
 * WHAT IT NEVER DOES, and each of these is deliberate:
 *
 *  - It never OVERWRITES a value already on `kinfolk`. A populated kinfolk field
 *    was chosen from the catalog; the free text is the older, unlinked copy. A
 *    field where both are populated AND they differ is reported as a CONFLICT
 *    for the operator to resolve by hand, never silently resolved. Picking a
 *    winner automatically is exactly how a household ends up dialling the wrong
 *    number with nothing recording that a choice was ever made.
 *
 *  - It never invents a `vetClinicId`. Free text cannot be matched to a catalog
 *    row without guessing, and a wrong id is worse than no id: it would enrol
 *    the household in another clinic's fan-out and rewrite its vet with a
 *    different practice's details. Migrated households stay UNLINKED, exactly as
 *    they are today, and both clients label them so. Linking them is an operator
 *    action in the picker, not something a script should decide.
 *
 *  - It never deletes the `household_data` free text. The fields stay on the
 *    doc and both clients still SHOW anything left in them, under a banner
 *    naming them superseded. Clearing them would destroy the evidence a
 *    conflict was ever there, and it is not needed: nothing writes them any
 *    more, and nothing reads them as authoritative.
 *
 *  - It never writes `primaryVetHours` anywhere. HOURS MOVED TO THE CLINIC
 *    (`vet_clinics.hours`), because they are a property of the practice: every
 *    household using Riverside shares Riverside's hours, so storing them per
 *    household recorded one clinic's hours N times and corrected them zero
 *    times. Writing a household's note onto the shared catalog row would let one
 *    household's stale hours become the truth for every other household on that
 *    clinic, so the script REPORTS them (`hoursToCurate`) and leaves the
 *    operator to set them per clinic in the vet clinics manager.
 *
 * Modes:
 *   default        DRY RUN. Prints every planned write and the summary. Writes
 *                  nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Safety:
 *   - Dry-run by default; refuses to write unless --allow-prod is passed OR
 *     FIRESTORE_EMULATOR_HOST is set (same contract as the other backfills).
 *   - IDEMPOTENT: a household whose kinfolk fields are already populated plans
 *     nothing, so a second run reports zero writes.
 *   - Touches ONLY the six vet fields listed above. `updatedAt` is left alone,
 *     so nothing that sorts or diffs on it sees a phantom edit.
 *
 * Runbook: run DRY first, read the plan and the conflicts, then re-run with
 * --allow-prod. This script has NOT been run against production as part of the
 * PR that ships it; it is a runbook step.
 */

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillHouseholdVetToKinfolk.ts — move household_data free-text vet onto the kinfolk record (punchlist A2)',
          '',
          'Usage (from mytribe/functions, which owns the node_modules this resolves against):',
          '  npm run backfill:household-vet                    # DRY RUN (default)',
          '  npm run backfill:household-vet -- --allow-prod    # apply',
          '  npm run backfill:household-vet -- --project <id>  # override project',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service account JSON path (or ADC)',
          '  GCLOUD_PROJECT                  Firebase project id',
          '  FIRESTORE_EMULATOR_HOST         when set, --allow-prod not required',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (args.allowProd) args.mode = 'apply';
  return args;
}

/** The six migrated fields, as (household_data key -> kinfolk key). */
export const VET_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ['primaryVetName', 'vetClinicName'],
  ['primaryVetPhone', 'vetClinicPhone'],
  ['primaryVetAddress', 'vetClinicAddress'],
  ['emergencyVetName', 'emergencyVetClinicName'],
  ['emergencyVetPhone', 'emergencyVetClinicPhone'],
  ['emergencyVetAddress', 'emergencyVetClinicAddress'],
];

/** A field where BOTH stores hold a value and they disagree. Operator resolves. */
export interface VetConflict {
  kinfolkId: string;
  /** The `kinfolk` field name. */
  field: string;
  /** What the canonical record says, and keeps saying. */
  kinfolkValue: string;
  /** The superseded free text, left on `household_data` untouched. */
  householdValue: string;
}

export interface VetPlan {
  /** The exact fields to merge onto `kinfolk/{kinfolkId}`. Empty means nothing to do. */
  update: Record<string, string>;
  conflicts: VetConflict[];
  /**
   * A `primaryVetHours` value with nowhere to land. Hours belong to the CLINIC,
   * and one household's note must not become every household's truth, so these
   * are reported for the operator to curate in the vet clinics manager.
   */
  hoursToCurate: string | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The decision for ONE household. PURE: no Firestore access, so the whole rule
 * is unit-testable against fixtures
 * (mytribe/scripts/test/backfillHouseholdVetToKinfolk.test.ts).
 */
export function planVetMigration(
  kinfolkId: string,
  kinfolk: Record<string, unknown>,
  household: Record<string, unknown> | null,
): VetPlan {
  const plan: VetPlan = { update: {}, conflicts: [], hoursToCurate: null };
  if (household === null) return plan;

  for (const [fromKey, toKey] of VET_FIELD_MAP) {
    const free = str(household[fromKey]);
    const canonical = str(kinfolk[toKey]);
    if (free === '') continue;

    if (canonical === '') {
      // The gap case, and the only case that writes.
      plan.update[toKey] = free;
      continue;
    }
    if (canonical.toLowerCase() !== free.toLowerCase()) {
      // Both populated and disagreeing. The canonical record is left exactly as
      // it is; a script has no basis for deciding which vet is the real one.
      plan.conflicts.push({
        kinfolkId,
        field: toKey,
        kinfolkValue: canonical,
        householdValue: free,
      });
    }
    // Both populated and equal: nothing to do, and not a conflict.
  }

  const hours = str(household['primaryVetHours']);
  if (hours !== '') plan.hoursToCurate = hours;

  return plan;
}

export interface Summary {
  scanned: number;
  householdsWithFreeText: number;
  planned: number;
  fieldsWritten: number;
  conflicts: VetConflict[];
  hours: Array<{ kinfolkId: string; hours: string }>;
}

/** Reads every household and plans the migration. No writes happen here. */
export async function buildPlan(db: Firestore): Promise<{
  summary: Summary;
  writes: Array<{ kinfolkId: string; update: Record<string, string> }>;
}> {
  const kinfolkSnap = await db.collection('kinfolk').get();
  const summary: Summary = {
    scanned: 0,
    householdsWithFreeText: 0,
    planned: 0,
    fieldsWritten: 0,
    conflicts: [],
    hours: [],
  };
  const writes: Array<{ kinfolkId: string; update: Record<string, string> }> = [];

  for (const doc of kinfolkSnap.docs) {
    summary.scanned += 1;
    // `household_data` is keyed one doc per kinfolk, by kinfolk id.
    const hdSnap = await db.collection('household_data').doc(doc.id).get();
    const household = hdSnap.exists ? (hdSnap.data() as Record<string, unknown>) : null;

    const plan = planVetMigration(doc.id, doc.data() as Record<string, unknown>, household);
    const touchedAnything =
      Object.keys(plan.update).length > 0 ||
      plan.conflicts.length > 0 ||
      plan.hoursToCurate !== null;
    if (touchedAnything) summary.householdsWithFreeText += 1;

    if (Object.keys(plan.update).length > 0) {
      summary.planned += 1;
      summary.fieldsWritten += Object.keys(plan.update).length;
      writes.push({ kinfolkId: doc.id, update: plan.update });
    }
    summary.conflicts.push(...plan.conflicts);
    if (plan.hoursToCurate !== null) {
      summary.hours.push({ kinfolkId: doc.id, hours: plan.hoursToCurate });
    }
  }

  return { summary, writes };
}

function report(
  summary: Summary,
  writes: Array<{ kinfolkId: string; update: Record<string, string> }>,
  mode: Mode,
): void {
  console.log('');
  console.log(`=== A2 household vet migration (${mode.toUpperCase()}) ===`);
  console.log(`kinfolk scanned                : ${summary.scanned}`);
  console.log(`households with legacy vet text: ${summary.householdsWithFreeText}`);
  console.log(`households to write            : ${summary.planned}`);
  console.log(`fields to write                : ${summary.fieldsWritten}`);
  console.log(`conflicts (manual)             : ${summary.conflicts.length}`);
  console.log(`hours to curate on clinics     : ${summary.hours.length}`);

  if (writes.length > 0) {
    console.log('');
    console.log('-- planned writes (kinfolk gap filled from household free text) --');
    for (const w of writes) {
      for (const [k, v] of Object.entries(w.update)) {
        console.log(`  kinfolk/${w.kinfolkId}  ${k}: "" -> "${v}"`);
      }
    }
  }

  if (summary.conflicts.length > 0) {
    console.log('');
    console.log('-- CONFLICTS: both stores populated and disagreeing. NOT written. --');
    console.log('   The kinfolk value stands. Resolve these by hand.');
    for (const c of summary.conflicts) {
      console.log(
        `  kinfolk/${c.kinfolkId}  ${c.field}: kinfolk="${c.kinfolkValue}" vs household="${c.householdValue}"`,
      );
    }
  }

  if (summary.hours.length > 0) {
    console.log('');
    console.log('-- HOURS: no household field to land in. Set these on the CLINIC. --');
    console.log('   Hours belong to the practice, so one household s note must not');
    console.log('   become every household s truth. Curate in the vet clinics manager.');
    for (const h of summary.hours) {
      console.log(`  kinfolk/${h.kinfolkId}  primaryVetHours="${h.hours}"`);
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
    throw new Error('a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)');
  }

  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) {
    initializeApp(projectId ? { projectId } : {});
  }
  const db = getFirestore();

  const { summary, writes } = await buildPlan(db);
  report(summary, writes, args.mode);

  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }

  // Batched under Firestore's 500-op limit.
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      batch.set(db.collection('kinfolk').doc(w.kinfolkId), w.update, { merge: true });
    }
    await batch.commit();
  }
  console.log(`APPLIED: ${writes.length} household(s) updated.`);
}

// Only run when invoked directly, so the test can import the pure planner.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
