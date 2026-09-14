/**
 * stripBookingVisitLocation.ts
 *
 * Deletes the `location` field from every booking visit
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`).
 *
 * THE OPERATOR'S RULING (2026-08-04): "WHY THE FUCK WOULD THE BOOKING NEED AN
 * ADDRESS FIELD!? addresses come from the household data". A booking carried a
 * free-text `location`, 120 characters, and the admin wizard's placeholder for
 * it was literally "Home address". Whatever its intended reading ("back gate",
 * "boarding kennel"), as built it was an address override stored on the
 * booking. The schema, both callables and both wizards lose it in the same
 * commit as this script; this is what happens to the rows already written.
 *
 * STRIPPED, NOT DEPRECATED, and the choice is not a matter of taste here:
 *
 *   - Nothing reads the field. `optimizeRoute.ts`, the Android address chips
 *     and `BookingDetailModal.tsx` all resolve the address LIVE off the
 *     household doc (`serviceAddress` / `homeAddress` / `address`, in that
 *     order). There is therefore no read path to add an "ignore it" branch to,
 *     which is what a deprecation window would normally mean. The window would
 *     be a comment and nothing else.
 *
 *   - A left-behind value is an attractive nuisance with a shelf life. A
 *     household that moves updates its household doc; the stale string on a
 *     2026 visit then contradicts the household's real address, and the next
 *     reader to notice the field has every reason to think it means something.
 *
 *   - Firestore is schemaless. Removing a field from the zod schema stops new
 *     writes; it does not touch a byte already stored. A delete is the only
 *     thing that makes "a booking has no address" true of the data.
 *
 * IDEMPOTENT BY CONSTRUCTION. Only a visit whose stored data actually CONTAINS
 * the `location` key is planned for a write. After one run no document has it,
 * so a second run plans nothing and commits no batch at all.
 *
 * IT DELETES ONE FIELD AND NOTHING ELSE. The update carries exactly
 * `{ location: FieldValue.delete() }`, so nothing else on a visit doc --
 * status, visitProgress, assignment, the session link -- can be touched even by
 * accident. A `set()` was never an option on this collection.
 *
 * NOTHING IS SALVAGED, on purpose. The values are addresses or address-shaped
 * fragments, and there is nowhere correct to move them to: the household
 * already holds the authoritative address, and copying a booking's override
 * onto a household would be exactly the write this ruling forbids, in reverse.
 * The DRY RUN PRINTS EVERY NON-NULL VALUE IT IS ABOUT TO DELETE, with its
 * document path, so the operator reads the full list before anything is
 * removed and can act on any of them by hand first.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order. That precedence is what makes the printed list of
 *                  values-about-to-be-deleted reachable at all.
 *                  FIRESTORE_EMULATOR_HOST does not turn a dry run into a
 *                  writing one; it stands in for credentials only.
 *
 * Runbook: run DRY first, read the non-null values it lists, then re-run with
 * --allow-prod.
 */
import { getApps, initializeApp, FieldValue, getFirestore, type Firestore } from './lib/firebaseAdmin';

/**
 * Visits live at `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`,
 * so a collection group is the only way to reach all of them in one pass. This
 * is the same traversal `batchUpdateBookings.ts` and `getMyBookings.ts` use.
 */
export const VISITS_COLLECTION_GROUP = 'kinCares';

/** The field being removed. Named once so the plan and the write cannot drift. */
export const FIELD = 'location';

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
  // past the loop. This script issues FieldValue.delete(), so the dry run is
  // the ONLY chance to see what it would remove while the data still exists;
  // getting this flag's precedence backwards defeats the entire point of
  // asking for one.
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
      // the table while `--allow-prod` stayed on.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'stripBookingVisitLocation.ts — delete the per-visit `location` field from booking visits',
          '',
          '  npm run strip:visit-location                    # DRY RUN (default)',
          '  npm run strip:visit-location -- --allow-prod    # apply',
          '  npm run strip:visit-location -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run strip:visit-location -- --project <id>  # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still deletes nothing).',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  // --allow-prod implies a real write run, UNLESS --dry-run was also given.
  // `args.allowProd` itself still reports `true` when `--allow-prod` was
  // passed, even though `mode` stays 'dry-run', so an operator who typed
  // `--allow-prod --dry-run` sees exactly what happened rather than a flag
  // that silently vanished.
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

/** What one visit doc currently holds for `location`. */
export type LocationShape =
  /** The key is not on the document. Nothing to do; this is the post-run state. */
  | 'absent'
  /** The key is present and `null`. A write is still needed: `null` is a stored key. */
  | 'null'
  /** The key is present with a real string. The value is printed before deletion. */
  | 'value';

export interface StripPlan {
  shape: LocationShape;
  /** True when this document needs the field deleted. */
  strip: boolean;
  /** The non-null value about to be deleted, so the dry run can print it. Null otherwise. */
  value: string | null;
}

/**
 * The decision for ONE visit. PURE: no Firestore access, so every rule is
 * unit-testable against fixtures.
 *
 * A PRESENT-BUT-NULL key is stripped too, and that is the whole reason this
 * looks at the key rather than at the value. `location: null` is not "no
 * location", it is a stored field whose presence tells the next reader the
 * schema has one. Both callables wrote exactly that on every visit with no
 * place given, so the null rows are the overwhelming majority of the corpus.
 */
export function planStrip(data: Record<string, unknown>): StripPlan {
  if (!Object.prototype.hasOwnProperty.call(data, FIELD)) {
    return { shape: 'absent', strip: false, value: null };
  }
  const raw = data[FIELD];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return { shape: 'value', strip: true, value: raw };
  }
  // Present, but holding nothing a person wrote: null, undefined-stored-as-key,
  // a blank string, or a wrong-typed value. All the same decision, and none of
  // them worth printing as though an operator had typed it.
  return { shape: 'null', strip: true, value: null };
}

export interface Summary {
  scanned: number;
  alreadyClean: number;
  nullStripped: number;
  valueStripped: number;
}

export interface PlannedWrite {
  /** Full document path, so the dry run names something the operator can open. */
  path: string;
  /** The value being deleted, when it was a real string. Null for a stored null. */
  value: string | null;
}

export async function buildPlan(
  db: Firestore,
): Promise<{ summary: Summary; writes: PlannedWrite[] }> {
  const snap = await db.collectionGroup(VISITS_COLLECTION_GROUP).get();
  const summary: Summary = { scanned: 0, alreadyClean: 0, nullStripped: 0, valueStripped: 0 };
  const writes: PlannedWrite[] = [];

  for (const doc of snap.docs) {
    summary.scanned += 1;
    const plan = planStrip(doc.data() as Record<string, unknown>);
    if (!plan.strip) {
      summary.alreadyClean += 1;
      continue;
    }
    if (plan.shape === 'value') summary.valueStripped += 1;
    else summary.nullStripped += 1;
    writes.push({ path: doc.ref.path, value: plan.value });
  }

  return { summary, writes };
}

function report(summary: Summary, writes: PlannedWrite[], mode: Mode): void {
  console.log('');
  console.log(`=== booking visit \`location\` strip (${mode.toUpperCase()}) ===`);
  console.log(`visits scanned               : ${summary.scanned}`);
  console.log(`already clean (untouched)    : ${summary.alreadyClean}`);
  console.log(`stored null -> delete key    : ${summary.nullStripped}`);
  console.log(`real value  -> delete key    : ${summary.valueStripped}`);

  const withValues = writes.filter((w) => w.value !== null);
  if (withValues.length > 0) {
    console.log('');
    console.log('-- every non-null value about to be DELETED, in full. Read this list. --');
    console.log('   Nothing is salvaged anywhere: the household doc already holds the');
    console.log('   authoritative address. Anything here worth keeping is a manual edit');
    console.log('   to the household, made BEFORE the --allow-prod run.');
    for (const w of withValues) console.log(`  ${w.path}  location="${w.value}"`);
  }
  console.log('');
}

/** Applies the plan. Exported so an emulator test can prove the delete lands. */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<void> {
  // One update per document, so this is one op per write. 400 keeps a wide
  // margin under Firestore's 500-op batch limit.
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      // update with FieldValue.delete(), never set(): a visit doc carries
      // status, assignment and the session link, and a bare set() would take
      // all of it with the field.
      batch.update(db.doc(w.path), { [FIELD]: FieldValue.delete() });
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
    throw new Error(
      'a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)',
    );
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
  console.log(`APPLIED: \`location\` deleted from ${writes.length} visit(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
