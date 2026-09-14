/**
 * repairBlockedTimeSlotShape.ts
 *
 * Makes every already-written `booking_time_slots` document readable by the
 * Android app again.
 *
 * ── WHAT IS WRONG IN PRODUCTION ───────────────────────────────────────────
 *
 * `createBlockedTimeSlot.ts` - the callable behind the web admin's "Block time"
 * dialog - wrote two values the readers of this collection cannot take:
 *
 *   syncState: 'LOCAL'                     not one of the five values the
 *                                          Android enum declares (LOCAL_ONLY,
 *                                          SYNCED, OVERRIDDEN, DISMISSED,
 *                                          FAILED), and not what the sibling
 *                                          server writer uses ('SYNCED').
 *   createdAt: serverTimestamp()           a Firestore Timestamp in a field both
 *                                          client models declare as a String.
 *
 * Android decodes these documents with
 * `snapshot.toObjects(BookingTimeSlot::class.java)`, and Firestore's
 * `CustomClassMapper` THROWS on either one:
 *
 *     Could not deserialize object. Could not find enum value of
 *     com.tribetails.auntieos.data.model.TimeSlotSyncState for value "LOCAL"
 *     (found in field 'syncState')
 *
 *     Could not deserialize object. Failed to convert value of type
 *     com.google.firebase.Timestamp to String (found in field 'createdAt')
 *
 * `toObjects` converts the WHOLE snapshot, so ONE such document takes the
 * phone's entire busy overlay down with it - every other slot in the collection
 * included - and turns every availability read into a failure. That is why this
 * repair is not cosmetic and not deferrable: the code fix stops NEW documents
 * being written that way, and does nothing at all for the ones already stored.
 * Firestore keeps what it was given.
 *
 * ── WHAT IT WRITES, AND ONLY THIS ─────────────────────────────────────────
 *
 *   `syncState`   `'LOCAL'` -> `'LOCAL_ONLY'`, and no other rewrite.
 *   `createdAt`   a Timestamp -> the SAME INSTANT as a millisecond ISO string,
 *                 the shape `syncGoogleCalendarBusyEvents` already writes.
 *   `updatedAt`   the same conversion. Not on either client model, so it breaks
 *                 nothing today; converted anyway so the collection carries one
 *                 time format rather than two, and so the next person to declare
 *                 `updatedAt: String` on a model does not walk into this again.
 *
 * Nothing else is touched. The update carries exactly those keys, never a
 * `set()`, so `createdBy`, the window times and the importer's dedup key cannot
 * be altered even by accident - which is the same lesson the client-side half of
 * this fix is about.
 *
 * ── ROWS IT REFUSES ───────────────────────────────────────────────────────
 *
 * A `syncState` that is neither valid nor the known-bad `'LOCAL'` is SKIPPED and
 * reported by document id. There is no evidence in this repository about what
 * such a value was meant to be, and mapping it to `LOCAL_ONLY` would launder an
 * unknown into a value that looks deliberate. Android's decoder refuses to guess
 * at an out-of-vocabulary enum; this refuses for the same reason. The dry run
 * prints every one so the operator can decide by hand.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 *
 * Only a document that actually holds a wrong value is planned for a write.
 * After one run none does, so a second run plans nothing and commits no batch.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order. FIRESTORE_EMULATOR_HOST does not turn a dry run into
 *                  a writing one; it stands in for credentials only.
 *
 * Runbook: run DRY first, read the count and the refusals, then re-run with
 * --allow-prod. The real write is an operator step, never an agent's.
 */
import { getApps, initializeApp, getFirestore, Timestamp, type Firestore } from './lib/firebaseAdmin';

export const SLOTS_COLLECTION = 'booking_time_slots';

/**
 * The vocabulary, copied by hand from
 * `auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/model/ServiceModels.kt`
 * (`enum class TimeSlotSyncState`). A test asserts the list, so a fifth-and-a-half
 * value added on one side and not the other shows up as a failing assertion
 * rather than as a document this script quietly rewrites.
 */
export const VALID_SYNC_STATES = new Set([
  'LOCAL_ONLY',
  'SYNCED',
  'OVERRIDDEN',
  'DISMISSED',
  'FAILED',
]);

/**
 * The one wrong value this script knows how to repair, and what it becomes.
 * A literal pair rather than a fuzzy match: `'LOCAL'` is the exact string
 * `createBlockedTimeSlot.ts` wrote, recoverable from the source history, and
 * `LOCAL_ONLY` is what that handler always meant - it creates a slot that has
 * never been near a calendar sync.
 */
export const KNOWN_BAD_SYNC_STATE = 'LOCAL';
export const KNOWN_BAD_SYNC_STATE_BECOMES = 'LOCAL_ONLY';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked separately
  // from `args.mode` because the unconditional `if (args.allowProd) …` below
  // runs once, AFTER the whole argv has been scanned - so `--allow-prod
  // --dry-run` would silently re-flip mode to 'apply' if this flag's own
  // presence weren't remembered past the loop.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'repairBlockedTimeSlotShape.ts - make stored booking_time_slots decodable on Android again',
          '',
          '  npm run repair:blocked-slots                    # DRY RUN (default)',
          '  npm run repair:blocked-slots -- --allow-prod    # apply',
          '  npm run repair:blocked-slots -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run repair:blocked-slots -- --project <id>  # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still writes nothing).',
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

export type SkipReason =
  /** Every value on this document is already something Android can decode. */
  | 'already-decodable'
  /** A `syncState` this script does not recognise. Reported, never guessed at. */
  | 'unknown-sync-state';

export interface RepairPlan {
  /** Fields to merge onto the slot. Empty means nothing to do. */
  update: Record<string, string>;
  skip: SkipReason | null;
  /** The unrecognised value, so the dry run can print it. Null otherwise. */
  unknownSyncState: string | null;
}

/**
 * A stored `createdAt`/`updatedAt` as the SAME instant in millisecond ISO, or
 * null when it is already a string (or is missing, or is some third thing this
 * script has no business rewriting).
 *
 * Timestamp only. A raw `{ _seconds, _nanoseconds }` shape is deliberately NOT
 * handled: the admin SDK hands back real `Timestamp` instances, so anything else
 * arriving here would mean an assumption of this script is wrong, and it should
 * be looked at rather than converted.
 */
export function isoFromStoredStamp(raw: unknown): string | null {
  if (raw instanceof Timestamp) return raw.toDate().toISOString();
  return null;
}

/**
 * The decision for ONE slot. PURE: no Firestore access, so every rule is
 * unit-testable against fixtures.
 */
export function planRepair(data: Record<string, unknown>): RepairPlan {
  const plan: RepairPlan = { update: {}, skip: null, unknownSyncState: null };

  const rawState = data['syncState'];
  if (typeof rawState === 'string' && !VALID_SYNC_STATES.has(rawState)) {
    if (rawState === KNOWN_BAD_SYNC_STATE) {
      plan.update['syncState'] = KNOWN_BAD_SYNC_STATE_BECOMES;
    } else {
      // Refused outright, and the stamps are left alone too: a document with an
      // unexplained value in one field is one an operator should look at whole,
      // not one this script half-rewrites.
      return { update: {}, skip: 'unknown-sync-state', unknownSyncState: rawState };
    }
  }

  for (const field of ['createdAt', 'updatedAt'] as const) {
    const iso = isoFromStoredStamp(data[field]);
    if (iso !== null) plan.update[field] = iso;
  }

  if (Object.keys(plan.update).length === 0) plan.skip = 'already-decodable';
  return plan;
}

export interface Summary {
  scanned: number;
  alreadyDecodable: number;
  syncStateRepaired: number;
  stampsRepaired: number;
  refused: number;
}

export interface PlannedWrite {
  /** Document id, so the dry run names something the operator can open. */
  id: string;
  update: Record<string, string>;
}

export interface Refusal {
  id: string;
  syncState: string;
}

export async function buildPlan(
  db: Firestore,
): Promise<{ summary: Summary; writes: PlannedWrite[]; refusals: Refusal[] }> {
  const snap = await db.collection(SLOTS_COLLECTION).get();
  const summary: Summary = {
    scanned: 0,
    alreadyDecodable: 0,
    syncStateRepaired: 0,
    stampsRepaired: 0,
    refused: 0,
  };
  const writes: PlannedWrite[] = [];
  const refusals: Refusal[] = [];

  for (const doc of snap.docs) {
    summary.scanned += 1;
    const plan = planRepair(doc.data() as Record<string, unknown>);
    if (plan.skip === 'unknown-sync-state') {
      summary.refused += 1;
      refusals.push({ id: doc.id, syncState: plan.unknownSyncState ?? '' });
      continue;
    }
    if (Object.keys(plan.update).length === 0) {
      summary.alreadyDecodable += 1;
      continue;
    }
    if (plan.update['syncState'] !== undefined) summary.syncStateRepaired += 1;
    if (plan.update['createdAt'] !== undefined || plan.update['updatedAt'] !== undefined) {
      summary.stampsRepaired += 1;
    }
    writes.push({ id: doc.id, update: plan.update });
  }

  return { summary, writes, refusals };
}

function report(
  summary: Summary,
  writes: PlannedWrite[],
  refusals: Refusal[],
  mode: Mode,
): void {
  console.log('');
  console.log(`=== booking_time_slots decode repair (${mode.toUpperCase()}) ===`);
  console.log(`slots scanned                  : ${summary.scanned}`);
  console.log(`already decodable (untouched)  : ${summary.alreadyDecodable}`);
  console.log(`syncState 'LOCAL' -> LOCAL_ONLY: ${summary.syncStateRepaired}`);
  console.log(`Timestamp stamp  -> ISO string : ${summary.stampsRepaired}`);
  console.log(`refused (unknown syncState)    : ${summary.refused}`);

  if (refusals.length > 0) {
    console.log('');
    console.log('-- REFUSED. Nothing is written to these. Decide each by hand. --');
    console.log('   A syncState outside the five-value vocabulary that is also not the');
    console.log("   known-bad 'LOCAL'. Android cannot decode them either, so each one");
    console.log('   still breaks the whole-collection read until an operator resolves it.');
    for (const r of refusals) console.log(`  ${SLOTS_COLLECTION}/${r.id}  syncState="${r.syncState}"`);
  }
  console.log('');
}

/**
 * Applies the plan. Exported rather than private so an emulator test can be
 * pointed at it later; there is no such test today, and the unit tests above
 * cover `planRepair` only. What is NOT taken on trust is the write mode, which
 * is the thing that could still lose data, and it is pinned by the comment
 * below plus the shape of `PlannedWrite` itself: this function has no path that
 * can reach a `set()`, because it is only ever handed a field map.
 */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<void> {
  // One update per document, so this is one op per write. 400 keeps a wide
  // margin under Firestore's 500-op batch limit.
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      // update(), never set(): these documents carry `createdBy`, the window
      // times and the Google importer's dedup key, and a set() would take all of
      // it along with the three fields being fixed. That is the exact defect the
      // client half of this change removes; the repair does not get to reproduce
      // it.
      batch.update(db.collection(SLOTS_COLLECTION).doc(w.id), w.update);
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

  const { summary, writes, refusals } = await buildPlan(db);
  report(summary, writes, refusals, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  await applyPlan(db, writes);
  console.log(`APPLIED: ${writes.length} slot(s) repaired.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
