/**
 * sweepKinfolkNotificationStaffNotes.ts
 *
 * Removes the staff-typed `detail.notes` field from notification documents
 * addressed to a HOUSEHOLD, in both `notifications/{id}` (the inbox a kinfolk
 * reads) and `scheduledNotifications/{id}` (the queue a kinfolk can also read,
 * and whose rows become inbox documents later).
 *
 * WHY THERE IS ANYTHING TO SWEEP (issue #442). PR #415 stopped
 * `buildNotificationDetail` writing `detail.notes` onto kinfolk-stream copies:
 * the booking/session `notes` field is internal remarks as often as it is
 * anything a household should read (any operator with the auntie hat can type
 * into it, and `transitionBookingStatus` appends a cancellation reason to it
 * verbatim). That PR changed the WRITER and nothing else. Firestore is
 * schemaless, so every document written between `detail` shipping on 2026-08-04
 * (9f0806c) and #415 deploying still carries the field, and
 * `mytribe/firestore.rules` grants a signed-in kinfolk the whole notification
 * document by `recipientUid` — the card renderer's choices never mattered.
 *
 * THE TWO COLLECTIONS ARE SWEPT IN ONE RUN, QUEUE FIRST, AND THE ORDER IS THE
 * POINT. `promoteQueued.ts` copies `detail` verbatim from a queued row onto the
 * new `notifications/{id}` it creates, and `notificationScheduledSweep` runs
 * every 5 minutes. Clean the inbox first and the very next promotion writes a
 * fresh household-readable copy of a note this script just removed. So:
 *
 *   1. `scheduledNotifications` is planned and applied FIRST. From the moment
 *      that pass finishes, no promotion can carry a staff note forward.
 *   2. `notifications` is planned and applied SECOND, so its scan also catches
 *      anything that promoted while step 1 was still running.
 *
 * A dry run builds both plans and writes nothing; the queue counts it prints
 * are a snapshot of a collection the cron is draining underneath it, so the
 * apply run's queue numbers will differ. That is expected and is not drift:
 * whatever drained became an inbox document, and step 2 sweeps those.
 *
 * WHICH DOCUMENTS. Every row whose stored data contains `detail.notes` AND
 * whose `recipientUid` names a document in `clients/`. `clients/{uid}` is what
 * `streamForRecipient` uses to answer "is this copy on the kinfolk stream", so
 * the sweep and the live redaction agree by construction rather than by a list
 * of keys kept in sync by hand. A `recipientUid` that is NOT in `clients/` is a
 * staff or business copy, where the field is legitimate under operator ruling
 * R5 ("wheres the notes"), and it is left strictly alone — this matters most
 * for `kincare.changed`, which fans one event out to the office AND to the
 * household from the same emitter.
 *
 * SCANNED WHOLE, NOT FILTERED TO EIGHT KEYS. PR #415 derived that eight
 * `kincare.*` keys can populate the field, because only their emitters pass a
 * family id plus a batch/visit/booking id. That derivation is almost certainly
 * right and it is not what this script trusts: it reads every document in both
 * collections and decides per document, so the report tells the operator which
 * keys actually carry a note in the real data instead of restating the
 * prediction back at them. The per-key table is printed for every key found.
 *
 * IT STRIPS A FIELD; IT NEVER DELETES A DOCUMENT. The update carries exactly
 * `{ 'detail.notes': FieldValue.delete() }`, so the card's own content —
 * kinfolkName, kinName, serviceType, bookingDate, bookingTime, requestedBy —
 * and the notification's title, description, read state and target survive
 * untouched. The one variation: when `notes` was the ONLY field in `detail`,
 * the empty `detail` map goes too, because `dispatcher.ts` omits `detail`
 * entirely rather than writing a blank one, and an empty map is a shape no
 * writer in this codebase produces. That is still a field removal on a document
 * that stays exactly where it was.
 *
 * NOTHING PRIVATE IS PRINTED. The dry run must be readable in a terminal that
 * scrolls past other people, so the sample lines carry a REDACTED preview:
 * every letter becomes `x`/`X` and every digit `#`, with punctuation, spacing
 * and length preserved. The operator sees that a row holds
 * `"xxxxxx xxxxxxxx xxxx xxxxxxx, xx xxx xxxxxxx xxxxxxx"` and can tell prose
 * from a phone number from a gate code, without the text itself entering a log.
 * There is no flag to unmask it; read the documents directly if you need the
 * words.
 *
 * IDEMPOTENT BY CONSTRUCTION. Only a document whose stored data actually
 * contains the `notes` key inside `detail` is planned for a write, so a second
 * run plans nothing and commits no batch at all.
 *
 * A ROW THAT VANISHES MID-RUN IS NORMAL, NOT AN ERROR. The queue is being
 * drained by a cron every 5 minutes and a promoted row is deleted, so an
 * `update()` aimed at it can land on a document that no longer exists. Those
 * are counted and reported, never retried and never re-created: a `set(...,
 * { merge: true })` would resurrect a deleted queue row holding nothing but a
 * detail map, and the next sweep would promote that into an empty notification.
 *
 * Modes:
 *   default        DRY RUN. Prints both plans and writes nothing.
 *   --allow-prod   applies, queue first, batched under Firestore's 500-op limit.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order. FIRESTORE_EMULATOR_HOST does not turn a dry run into
 *                  a writing one; it stands in for credentials only.
 *   --samples <n>  redacted sample lines per collection (default 10, 0 = none).
 *   --project <id> project override.
 *
 * RUNBOOK (the operator runs this; it cannot be run from an agent session):
 *
 *   1. npm --prefix mytribe/functions run sweep:kinfolk-staff-notes
 *      Reads only. Read the per-collection totals, the per-key table, and the
 *      redacted samples.
 *   2. Decide from those numbers. If a row's shape suggests something a
 *      household was MEANT to read, open that document by the path printed and
 *      handle it by hand BEFORE step 3 — nothing here is salvaged anywhere.
 *   3. npm --prefix mytribe/functions run sweep:kinfolk-staff-notes -- --allow-prod
 *      Applies queue-first. Needs GOOGLE_APPLICATION_CREDENTIALS.
 *   4. Re-run step 1. A clean second run reports 0 to strip in both
 *      collections; that is the check that the sweep is done.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  getFirestore,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

/** The inbox a kinfolk reads. Written by the trigger path and by promotions. */
export const INBOX_COLLECTION = 'notifications';
/** The queue whose rows `promoteQueued` copies `detail` from, verbatim. */
export const QUEUE_COLLECTION = 'scheduledNotifications';
/**
 * Swept in THIS order, and the order is load-bearing: the queue is the source
 * that refills the inbox. See the header.
 */
export const SWEEP_ORDER = [QUEUE_COLLECTION, INBOX_COLLECTION] as const;
export type SweptCollection = (typeof SWEEP_ORDER)[number];

/** The card-detail map, and the staff-side field being removed from it. */
export const DETAIL_FIELD = 'detail';
export const NOTES_FIELD = 'notes';
/** Dotted path handed to `update()`, which reads a dot as a path segment. */
export const NOTES_FIELD_PATH = `${DETAIL_FIELD}.${NOTES_FIELD}`;

/**
 * A recipient uid that names a document here is on the kinfolk stream. Same
 * question `streamForRecipient(def, 'clients')` answers at dispatch time.
 */
export const KINFOLK_ACCOUNT_COLLECTION = 'clients';

/**
 * The keys PR #415 predicted can carry a note, used ONLY to order the per-key
 * table so the expected ones read first. The sweep itself filters on no key at
 * all; a key here with a zero count and a key not here with a non-zero one are
 * both findings worth seeing.
 */
export const PREDICTED_KEYS: readonly string[] = [
  'kincare.changed',
  'kincare.booking.confirm',
  'kincare.booking.cancel',
  'kincare.unavailable',
  'kincare.auntie.on_my_way',
  'kincare.auntie.arrived',
  'kincare.auntie.departed',
  'kincare.upcoming.reminder',
];

/** Firestore page size for the collection scans. */
const PAGE = 500;
/** Documents per `getAll` when resolving recipients against `clients/`. */
const LOOKUP_CHUNK = 300;
/** Writes per batch, well under Firestore's 500-op limit. */
const WRITE_CHUNK = 400;
/** gRPC status code for NOT_FOUND, which an `update()` on a vanished row gets. */
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
  // An explicit --dry-run always wins, in either flag order. Tracked separately
  // from `args.mode` because the `if (args.allowProd)` below runs once, AFTER
  // the whole argv has been scanned, so `--allow-prod --dry-run` would
  // otherwise silently re-flip to 'apply'. This script issues
  // FieldValue.delete() and the values are not recoverable afterwards, so the
  // dry run is the only chance to look; getting this precedence backwards
  // defeats the reason for having one.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not merely a missing one: `--project` with
      // no id would swallow whatever followed, and the token most likely to
      // follow is `--dry-run`.
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
          'sweepKinfolkNotificationStaffNotes.ts — remove staff `detail.notes` from household copies',
          '',
          '  npm --prefix mytribe/functions run sweep:kinfolk-staff-notes                  # DRY RUN (default)',
          '  npm --prefix mytribe/functions run sweep:kinfolk-staff-notes -- --allow-prod  # apply, queue first',
          '  npm --prefix mytribe/functions run sweep:kinfolk-staff-notes -- --samples 40  # more redacted samples',
          '  npm --prefix mytribe/functions run sweep:kinfolk-staff-notes -- --project <id>',
          '',
          '--dry-run overrides --allow-prod regardless of flag order. Sample previews are',
          'always redacted (letters -> x, digits -> #); there is no flag to unmask them.',
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

/** What one document currently holds at `detail.notes`. */
export type NotesShape =
  /** No `detail` map, or no `notes` key inside it. The post-sweep state. */
  | 'absent'
  /** The key is stored but holds nothing a person typed (null, '', wrong type). */
  | 'blank'
  /** The key holds real text. This is the leak. */
  | 'text';

export type SkipReason =
  /** Nothing stored at `detail.notes`. */
  | 'no-notes'
  /** Stored, but this copy belongs to staff, where the field is legitimate. */
  | 'recipient-not-kinfolk';

export interface RowInput {
  /** Full document path, so every report line names something openable. */
  path: string;
  /** Catalog key, for the per-key table only — never for filtering. */
  key: string;
  recipientUid: string;
  data: Record<string, unknown>;
}

export interface RowPlan {
  strip: boolean;
  /**
   * True when `notes` was the only field in `detail`, so the whole (now empty)
   * map is removed rather than left as a shape no writer produces.
   */
  removeDetail: boolean;
  skipReason: SkipReason | null;
  shape: NotesShape;
  /** Character count of the stored text. 0 for anything but 'text'. */
  length: number;
  /** Redacted preview. Never the words themselves. Null unless shape is 'text'. */
  redacted: string | null;
}

/**
 * Masks a note so its SHAPE survives and its content does not: letters become
 * `x`/`X`, digits `#`, and punctuation, spacing and length are preserved. Long
 * notes are cut with the true length stated, so a 2000-character note cannot
 * take a terminal with it.
 */
export function redactNotes(raw: string, maxLength = 72): string {
  const masked = raw.replace(/\p{Lu}/gu, 'X').replace(/\p{Ll}|\p{Lo}/gu, 'x').replace(/\d/g, '#');
  if (masked.length <= maxLength) return masked;
  return `${masked.slice(0, maxLength)}…(+${masked.length - maxLength} chars)`;
}

/**
 * The decision for ONE document. PURE: no Firestore access, so every rule is
 * pinned against fixtures.
 *
 * `recipientIsKinfolk` is passed in rather than looked up here because the
 * answer is a `clients/{uid}` read that is batched across the whole scan.
 *
 * A PRESENT-BUT-BLANK `notes` is stripped too, and that is why this looks at
 * the key rather than at the value. `notes: ''` is a stored field: it tells the
 * next reader the household's copy of this card has a notes slot, which is the
 * shape #415 removed. Today's writer omits blanks entirely (`present()` in
 * buildNotificationDetail), so leaving them would preserve a shape nothing
 * writes any more.
 */
export function planRow(row: RowInput, recipientIsKinfolk: boolean): RowPlan {
  const clean: RowPlan = {
    strip: false,
    removeDetail: false,
    skipReason: 'no-notes',
    shape: 'absent',
    length: 0,
    redacted: null,
  };

  const detail = row.data[DETAIL_FIELD];
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return clean;
  const map = detail as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(map, NOTES_FIELD)) return clean;

  const raw = map[NOTES_FIELD];
  const isText = typeof raw === 'string' && raw.trim() !== '';
  const shape: NotesShape = isText ? 'text' : 'blank';
  const length = isText ? (raw as string).length : 0;
  const redacted = isText ? redactNotes(raw as string) : null;

  // A staff or business copy. The field is theirs under ruling R5 and the sweep
  // does not touch it — it is still counted, so the report can show how much of
  // the corpus was deliberately left behind.
  if (!recipientIsKinfolk) {
    return { strip: false, removeDetail: false, skipReason: 'recipient-not-kinfolk', shape, length, redacted };
  }

  return {
    strip: true,
    // `notes` alone in the map means the map itself should go: `dispatcher.ts`
    // omits `detail` rather than writing an empty one, so a bare `{}` here
    // would be a shape no writer in this codebase produces.
    removeDetail: Object.keys(map).length === 1,
    skipReason: null,
    shape,
    length,
    redacted,
  };
}

/** One planned write. `removeDetail` decides which field path is deleted. */
export interface PlannedWrite {
  path: string;
  key: string;
  removeDetail: boolean;
}

/**
 * The field path a planned write deletes. Exported so a fixture test can prove
 * the empty-map case removes `detail` and every other case removes only the
 * nested `notes`, without a Firestore anywhere near it.
 */
export function deletedFieldPath(write: PlannedWrite): string {
  return write.removeDetail ? DETAIL_FIELD : NOTES_FIELD_PATH;
}

export interface KeyCounts {
  key: string;
  /** Documents on this key carrying a stored `detail.notes`. */
  carrying: number;
  /** Of those, household copies this run would strip. */
  strip: number;
  /** Of those, staff/business copies deliberately left alone. */
  leftStaff: number;
  /** Of the stripped ones, those holding real text rather than a blank. */
  text: number;
}

export interface CollectionSummary {
  collection: string;
  scanned: number;
  carrying: number;
  strip: number;
  leftStaff: number;
  /** Of `strip`, the documents whose whole `detail` map goes with the field. */
  detailEmptied: number;
  byKey: KeyCounts[];
}

export interface PlannedRow {
  row: RowInput;
  plan: RowPlan;
}

/**
 * Rolls planned rows into the printed report. PURE, so the counting the
 * operator's decision rests on is pinned by fixtures rather than by whatever
 * the collection happened to hold on the day.
 *
 * Keys are ordered by strip count, then by the #415 prediction order, then
 * alphabetically — so the rows that matter lead, and an unpredicted key
 * carrying notes cannot hide at the bottom of an alphabetical list.
 */
export function summarize(
  collection: string,
  scanned: number,
  planned: readonly PlannedRow[],
): CollectionSummary {
  const summary: CollectionSummary = {
    collection,
    scanned,
    carrying: 0,
    strip: 0,
    leftStaff: 0,
    detailEmptied: 0,
    byKey: [],
  };
  const byKey = new Map<string, KeyCounts>();

  for (const { row, plan } of planned) {
    if (plan.shape === 'absent') continue;
    const key = row.key === '' ? '(no key)' : row.key;
    const counts = byKey.get(key) ?? { key, carrying: 0, strip: 0, leftStaff: 0, text: 0 };
    counts.carrying += 1;
    summary.carrying += 1;
    if (plan.strip) {
      counts.strip += 1;
      summary.strip += 1;
      if (plan.shape === 'text') counts.text += 1;
      if (plan.removeDetail) summary.detailEmptied += 1;
    } else {
      counts.leftStaff += 1;
      summary.leftStaff += 1;
    }
    byKey.set(key, counts);
  }

  const rank = (k: string): number => {
    const i = PREDICTED_KEYS.indexOf(k);
    return i === -1 ? PREDICTED_KEYS.length : i;
  };
  summary.byKey = [...byKey.values()].sort(
    (a, b) => b.strip - a.strip || rank(a.key) - rank(b.key) || a.key.localeCompare(b.key),
  );
  return summary;
}

/**
 * Reads every document in a collection, one page at a time.
 *
 * Paged rather than one `.get()` of the whole collection (which is what the
 * older strip scripts here do) because `notifications` is the busiest write
 * target in the system and grows without bound; the cursor is the previous
 * page's last SNAPSHOT, the only cursor form that is exact under `__name__`
 * ordering.
 */
async function* scanCollection(db: Firestore, collection: string): AsyncGenerator<RowInput> {
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(collection).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      yield {
        path: doc.ref.path,
        key: typeof data['key'] === 'string' ? (data['key'] as string) : '',
        recipientUid: typeof data['recipientUid'] === 'string' ? (data['recipientUid'] as string) : '',
        data,
      };
    }
    if (snap.size < PAGE) return;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return;
  }
}

/**
 * Which of these uids name a document in `clients/`. Batched, because the
 * question is asked once per candidate row and a household typically owns many
 * of them.
 */
async function resolveKinfolkUids(db: Firestore, uids: readonly string[]): Promise<Set<string>> {
  const kinfolk = new Set<string>();
  const unique = [...new Set(uids.filter((u) => u !== ''))];
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const slice = unique.slice(i, i + LOOKUP_CHUNK);
    const refs = slice.map((uid) => db.collection(KINFOLK_ACCOUNT_COLLECTION).doc(uid));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) if (snap.exists) kinfolk.add(snap.id);
  }
  return kinfolk;
}

export interface CollectionPlan {
  summary: CollectionSummary;
  writes: PlannedWrite[];
  /** Redacted sample lines, capped by --samples. */
  samples: PlannedRow[];
}

/** Builds the plan for ONE collection. */
export async function buildPlan(
  db: Firestore,
  collection: string,
  sampleLimit: number,
): Promise<CollectionPlan> {
  const candidates: RowInput[] = [];
  let scanned = 0;
  for await (const row of scanCollection(db, collection)) {
    scanned += 1;
    // Cheap pre-filter on the same key `planRow` looks at, so a collection of
    // mostly-clean documents is not held in memory in full.
    const detail = row.data[DETAIL_FIELD];
    if (
      detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      Object.prototype.hasOwnProperty.call(detail, NOTES_FIELD)
    ) {
      candidates.push(row);
    }
  }

  const kinfolkUids = await resolveKinfolkUids(db, candidates.map((c) => c.recipientUid));
  const planned: PlannedRow[] = candidates.map((row) => ({
    row,
    plan: planRow(row, kinfolkUids.has(row.recipientUid)),
  }));

  const writes = planned
    .filter((p) => p.plan.strip)
    .map((p) => ({ path: p.row.path, key: p.row.key, removeDetail: p.plan.removeDetail }));

  // Text first: a blank note tells the operator nothing a count has not already
  // said, and the samples are what the decision is made from.
  const samples = planned
    .filter((p) => p.plan.strip)
    .sort((a, b) => Number(b.plan.shape === 'text') - Number(a.plan.shape === 'text'))
    .slice(0, sampleLimit);

  return { summary: summarize(collection, scanned, planned), writes, samples };
}

export interface ApplyResult {
  /** Documents whose field was removed. */
  updated: number;
  /** Rows that no longer existed — promoted and deleted by the cron mid-run. */
  vanished: number;
}

/**
 * Applies one collection's plan. Exported so an emulator test can prove the
 * nested delete lands without taking the rest of the document with it.
 *
 * A batch is retried document-by-document if it fails, because ONE vanished row
 * fails the whole commit and the other 399 writes in it are real work. A
 * vanished row is counted and skipped, never re-created: `set(..., { merge:
 * true })` on a deleted queue row would resurrect it holding nothing but a
 * detail map, and the scheduled sweep would promote that into an empty
 * notification.
 */
export async function applyPlan(db: Firestore, writes: readonly PlannedWrite[]): Promise<ApplyResult> {
  const result: ApplyResult = { updated: 0, vanished: 0 };
  const payload = (w: PlannedWrite): Record<string, unknown> => ({
    [deletedFieldPath(w)]: FieldValue.delete(),
  });

  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    const batch = db.batch();
    // update(), never set(): a notification carries title, description, read
    // state and target, and a bare set() would take all of it with the field.
    for (const w of chunk) batch.update(db.doc(w.path), payload(w));
    try {
      await batch.commit();
      result.updated += chunk.length;
    } catch {
      for (const w of chunk) {
        try {
          await db.doc(w.path).update(payload(w));
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

function report(plan: CollectionPlan, mode: Mode): void {
  const s = plan.summary;
  console.log('');
  console.log(`=== ${s.collection}: staff \`detail.notes\` on household copies (${mode.toUpperCase()}) ===`);
  console.log(`documents scanned                  : ${s.scanned}`);
  console.log(`carrying a stored detail.notes     : ${s.carrying}`);
  console.log(`household copies -> STRIP          : ${s.strip}`);
  console.log(`  of those, whole empty detail map : ${s.detailEmptied}`);
  console.log(`staff/business copies -> left alone: ${s.leftStaff}`);

  if (s.byKey.length > 0) {
    console.log('');
    console.log('  key                             carrying   strip   left(staff)   real text');
    for (const k of s.byKey) {
      console.log(
        `  ${k.key.padEnd(30)}  ${String(k.carrying).padStart(8)}  ${String(k.strip).padStart(6)}  ${String(k.leftStaff).padStart(11)}  ${String(k.text).padStart(9)}`,
      );
    }
  }

  if (plan.samples.length > 0) {
    console.log('');
    console.log(`-- ${plan.samples.length} of ${s.strip} household copies, REDACTED (letters -> x, digits -> #) --`);
    console.log('   The words are never printed. Open a path below if you need to read one.');
    for (const { row, plan: p } of plan.samples) {
      const preview = p.shape === 'text' ? `"${p.redacted}" (${p.length} chars)` : '(stored but blank)';
      console.log(`  ${row.path}  ${row.key}  ${preview}`);
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

  let stripped = 0;
  let vanished = 0;
  // Queue first, then inbox. Each collection is planned AND applied before the
  // next is even read, so the inbox scan sees whatever the queue promoted while
  // the queue was being cleaned. Reordering these two lines re-opens the leak.
  for (const collection of SWEEP_ORDER) {
    const plan = await buildPlan(db, collection, args.samples);
    report(plan, args.mode);
    if (args.mode === 'apply') {
      const applied = await applyPlan(db, plan.writes);
      stripped += applied.updated;
      vanished += applied.vanished;
      console.log(
        `APPLIED to ${collection}: ${applied.updated} stripped, ${applied.vanished} row(s) already gone.`,
      );
    }
  }

  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    console.log(
      `Apply order is fixed: ${QUEUE_COLLECTION} first, then ${INBOX_COLLECTION}, because promoteQueued`,
    );
    console.log('copies `detail` verbatim and would otherwise refill what was just cleaned.');
    return;
  }
  console.log('');
  console.log(
    `APPLIED: staff notes removed from ${stripped} household notification(s); ${vanished} row(s) vanished mid-run.`,
  );
  console.log('Re-run without --allow-prod to confirm both collections now report 0 to strip.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
