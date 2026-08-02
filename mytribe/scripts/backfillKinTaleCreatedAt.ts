/**
 * backfillKinTaleCreatedAt.ts
 *
 * Punchlist F7. `kin_care_reports.createdAt` holds TWO INCOMPATIBLE FORMATS,
 * verified against production on 2026-08-01 (92 documents):
 *
 *   83 rows  "September 3, 2025 2:02pm"    free text, written by
 *                                          auntieos-admin/migrate_visit_logs_to_kin_care_reports.py
 *                                          from `visit_logs.submitted`
 *    9 rows  "2025-12-02T19:00:00.000Z"    ISO, what every live writer stamps
 *
 * Firestore orders strings by UTF-8 byte, so letters beat digits ('S' is 0x53,
 * '2' is 0x32). Every legacy row therefore sorts ABOVE every ISO row in a
 * `createdAt desc` query, and the legacy block orders ITSELF ALPHABETICALLY BY
 * MONTH NAME. The first page of that query in production really does read
 * September, September, September, October, November, March. The KinTales list
 * is not slightly mis-sorted, it is sorted by nothing.
 *
 * THE OPERATOR'S RULING (2026-08-01). Every KinTale in the system today is a
 * historical visit report imported from the previous system. `createdAt` means
 * "created in AuntieOS". Legacy rows are redated to their date added, which is
 * already stored on every one of them as `_migratedAt`.
 *
 * WHAT IT WRITES, and only this:
 *   - `createdAt`           the row's own `_migratedAt`, normalized to the
 *                           millisecond ISO form the other 9 rows already use
 *                           so that lexical order equals chronological order
 *                           across the WHOLE collection. ('...39Z' sorts AFTER
 *                           '...39.000Z' because 'Z' is 0x5A and '.' is 0x2E,
 *                           so mixing the two forms would reintroduce a smaller
 *                           copy of the bug this script exists to remove.)
 *   - `_legacySubmittedAt`  the free-text submit stamp rendered sortable, and
 *                           ONLY where it matches one exact grammar. See below.
 *
 * WHAT IT NEVER TOUCHES: `visitDate`, `sentAt`, `arrivedAt`, `departedAt`.
 * The reasoning is in the PR body and is summarized under _legacySubmittedAt.
 *
 * WHY `_legacySubmittedAt` EXISTS. Redating solves the sort but flattens it:
 * all 83 legacy rows share one ingest instant, so `createdAt desc` leaves them
 * in an arbitrary tie order and their true sequence becomes unreadable by any
 * query. The obvious repair, parsing `visitDate` from that same free text, was
 * measured against the live data and REJECTED: on 18 of the 83 rows the stored
 * `arrivedAt` clock time is LATER in the day than the submit clock time
 * (legacy_72 submits "August 29, 2025 8:06am" and records an arrival at
 * 6:19pm), so the visit demonstrably began on the PREVIOUS calendar day. That
 * text is a SUBMIT stamp, not a visit date, and writing it into `visitDate` in
 * the canonical `YYYY-MM-DD` shape would launder a known-wrong date into a form
 * indistinguishable from a real one, on a care record, 18 times.
 *
 * So the same value is written where it is true instead: a field that says
 * "submitted", carrying no claim about when the visit happened. Nothing can be
 * wrong about it, and `_legacySubmittedAt desc` restores the real sequence.
 *
 * ITS TIMEZONE, stated plainly because the field name ends in `Z`. The source
 * text records no zone, so none can be recovered. Each stamp is rendered as if
 * the wall clock were UTC, which is the convention this corpus already
 * accepted (`cleanup_prod_data_pass1.py#normalize_iso_zulu`: "Treats naive
 * local timestamps as Zulu"). For ORDERING that is exact rather than
 * approximate: every stamp shifts by the same unknown offset, and a constant
 * offset cannot change the relative order of anything. Sort by this field;
 * do not read it as an instant.
 *
 * IDEMPOTENT BY CONSTRUCTION. Only a `createdAt` that is neither an ISO instant
 * nor even date-shaped is eligible. After one run every touched row holds an
 * ISO instant, so a second run classifies it as already-done and plans no write
 * at all. `_legacySubmittedAt` is written only where absent.
 *
 * IT NEVER GUESSES. A legacy row whose `_migratedAt` is missing or unparseable
 * is SKIPPED and reported by id, never redated to "now" or to any neighbour's
 * value. That is not a theoretical branch: `KinCareRepository.updateKinCareReport`
 * documents that a bare `set()` on this collection deletes exactly
 * `_migratedFrom`/`_migratedAt`, which is why it now writes with merge().
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Runbook: run DRY first, read the plan and the refusals, then re-run with
 * --allow-prod. The PR that ships this script ran the DRY side against
 * production only; the real write is a runbook step for the operator.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export const REPORTS_COLLECTION = 'kin_care_reports';

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
          'backfillKinTaleCreatedAt.ts — redate legacy kin_care_reports.createdAt to their ingest stamp (punchlist F7)',
          '',
          '  npm run backfill:kintale-createdat                    # DRY RUN (default)',
          '  npm run backfill:kintale-createdat -- --allow-prod    # apply',
          '  npm run backfill:kintale-createdat -- --project <id>  # override project',
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

/** A full ISO-8601 instant, the shape every live writer stamps. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Anything that at least STARTS with an ISO calendar date, so it already sorts with the digits. */
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}/;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * The ONE grammar the legacy corpus uses: "September 3, 2025 2:02pm".
 * All 83 production rows match it exactly. Minutes are optional because
 * `arrivedAt`/`departedAt` on the same rows use the bare-hour form ("4pm"),
 * so the corpus demonstrably produces it.
 *
 * Deliberately anchored and deliberately narrow. A full English month name and
 * a four-digit year cannot be ambiguous the way `03/09/2025` is, which is the
 * only reason parsing this text is defensible at all. Anything that does not
 * match is REFUSED and reported, never coerced by `new Date()`, whose
 * behaviour on unrecognized text is implementation-defined.
 */
const LEGACY_STAMP =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4}) (\d{1,2})(?::(\d{2}))?(am|pm)$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * "September 3, 2025 2:02pm" -> "2025-09-03T14:02:00.000Z", or null if the
 * text is not exactly this grammar or names a day that does not exist.
 *
 * Built through `Date.UTC`, never through the local-time `Date` constructor, so
 * the output does not depend on the timezone of whoever runs the script.
 */
export function parseLegacyStamp(raw: string): string | null {
  const m = LEGACY_STAMP.exec(str(raw));
  if (m === null) return null;
  const monthIndex = MONTHS.indexOf(m[1] as (typeof MONTHS)[number]);
  if (monthIndex < 0) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const rawHour = Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  // 12am is hour 0, 12pm is hour 12; every other pm hour is +12.
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  const hour = (rawHour % 12) + (m[6] === 'pm' ? 12 : 0);
  const d = new Date(Date.UTC(year, monthIndex, day, hour, minute, 0, 0));
  // Rejects "February 30, 2026", which Date.UTC would silently roll into March.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString();
}

/**
 * Re-renders an ISO instant in the canonical millisecond form
 * ("2026-05-16T20:36:39Z" -> "2026-05-16T20:36:39.000Z"), or null if the text
 * is not an ISO instant at all. One form across the collection is what makes
 * lexical order and chronological order the same thing.
 */
export function normalizeIsoInstant(raw: string): string | null {
  const trimmed = str(raw);
  if (!ISO_INSTANT.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export type CreatedAtShape = 'legacy' | 'iso' | 'date-shaped' | 'missing';

/** What `createdAt` currently is. Only `'legacy'` is ever rewritten. */
export function classifyCreatedAt(raw: unknown): CreatedAtShape {
  const trimmed = str(raw);
  if (trimmed === '') return 'missing';
  if (ISO_INSTANT.test(trimmed)) return 'iso';
  if (DATE_SHAPED.test(trimmed)) return 'date-shaped';
  return 'legacy';
}

export type SkipReason =
  /** `createdAt` is absent or blank. Nothing to redate, and no date is invented. */
  | 'no-created-at'
  /** Legacy free text, but no usable `_migratedAt`. Refused rather than guessed. */
  | 'no-ingest-stamp';

export interface RedatePlan {
  shape: CreatedAtShape;
  /** Fields to merge onto the report. Empty means nothing to do. */
  update: Record<string, string>;
  /** Set when a legacy row could NOT be redated. Reported, never guessed at. */
  skip: SkipReason | null;
  /** True when the legacy stamp did not match the grammar, so no `_legacySubmittedAt` was derived. */
  unparsedStamp: boolean;
}

/**
 * The decision for ONE report. PURE: no Firestore access, so every rule is
 * unit-testable against fixtures.
 */
export function planRedate(data: Record<string, unknown>): RedatePlan {
  const shape = classifyCreatedAt(data['createdAt']);
  const plan: RedatePlan = { shape, update: {}, skip: null, unparsedStamp: false };

  // Already ISO, or at least already date-shaped: leave it entirely alone. This
  // single branch is the whole idempotency guarantee.
  if (shape === 'iso' || shape === 'date-shaped') return plan;
  if (shape === 'missing') {
    plan.skip = 'no-created-at';
    return plan;
  }

  const ingest = normalizeIsoInstant(str(data['_migratedAt']));
  if (ingest === null) {
    // No ingest stamp means no answer. "Now" would be a lie and a neighbour's
    // value would be a guess, so the row is left exactly as it is and named in
    // the report for a person to look at.
    plan.skip = 'no-ingest-stamp';
    return plan;
  }
  plan.update['createdAt'] = ingest;

  const submitted = parseLegacyStamp(str(data['createdAt']));
  if (submitted === null) {
    plan.unparsedStamp = true;
  } else if (str(data['_legacySubmittedAt']) === '') {
    plan.update['_legacySubmittedAt'] = submitted;
  }

  return plan;
}

export interface Refusal {
  reportId: string;
  reason: SkipReason | 'unparsed-stamp';
  createdAt: string;
}

export interface Summary {
  scanned: number;
  alreadyIso: number;
  dateShaped: number;
  legacy: number;
  toRedate: number;
  sequenceStampsWritten: number;
  refusals: Refusal[];
}

export interface PlannedWrite {
  reportId: string;
  update: Record<string, string>;
  /** The value being replaced. Carried only so the dry run can print the before/after. */
  previousCreatedAt: string;
}

export async function buildPlan(
  db: Firestore,
): Promise<{ summary: Summary; writes: PlannedWrite[] }> {
  const snap = await db.collection(REPORTS_COLLECTION).get();
  const summary: Summary = {
    scanned: 0,
    alreadyIso: 0,
    dateShaped: 0,
    legacy: 0,
    toRedate: 0,
    sequenceStampsWritten: 0,
    refusals: [],
  };
  const writes: PlannedWrite[] = [];

  for (const doc of snap.docs) {
    summary.scanned += 1;
    const data = doc.data() as Record<string, unknown>;
    const previousCreatedAt = str(data['createdAt']);
    const plan = planRedate(data);

    if (plan.shape === 'iso') summary.alreadyIso += 1;
    if (plan.shape === 'date-shaped') summary.dateShaped += 1;
    if (plan.shape === 'legacy') summary.legacy += 1;

    if (plan.skip !== null) {
      summary.refusals.push({ reportId: doc.id, reason: plan.skip, createdAt: previousCreatedAt });
      continue;
    }
    if (plan.unparsedStamp) {
      summary.refusals.push({
        reportId: doc.id,
        reason: 'unparsed-stamp',
        createdAt: previousCreatedAt,
      });
    }
    if (Object.keys(plan.update).length === 0) continue;

    summary.toRedate += 1;
    if (plan.update['_legacySubmittedAt'] !== undefined) summary.sequenceStampsWritten += 1;
    writes.push({ reportId: doc.id, update: plan.update, previousCreatedAt });
  }

  return { summary, writes };
}

function report(summary: Summary, writes: PlannedWrite[], mode: Mode): void {
  console.log('');
  console.log(`=== F7 KinTale createdAt redate (${mode.toUpperCase()}) ===`);
  console.log(`reports scanned              : ${summary.scanned}`);
  console.log(`already ISO (untouched)      : ${summary.alreadyIso}`);
  console.log(`date-shaped (untouched)      : ${summary.dateShaped}`);
  console.log(`legacy free-text createdAt   : ${summary.legacy}`);
  console.log(`to redate                    : ${summary.toRedate}`);
  console.log(`_legacySubmittedAt to write  : ${summary.sequenceStampsWritten}`);
  console.log(`refused (left untouched)     : ${summary.refusals.length}`);

  if (writes.length > 0) {
    console.log('');
    console.log('-- planned writes --');
    for (const w of writes) {
      console.log(
        `  ${REPORTS_COLLECTION}/${w.reportId}  createdAt: "${w.previousCreatedAt}" -> "${w.update['createdAt']}"`,
      );
      const seq = w.update['_legacySubmittedAt'];
      if (seq !== undefined) {
        console.log(`  ${' '.repeat(REPORTS_COLLECTION.length + 1)}${' '.repeat(w.reportId.length)}  _legacySubmittedAt: "${seq}"`);
      }
    }
  }

  if (summary.refusals.length > 0) {
    console.log('');
    console.log('-- REFUSED. Left exactly as they are; nothing was guessed. --');
    console.log('   no-created-at   : no createdAt to redate.');
    console.log('   no-ingest-stamp : legacy text but no usable _migratedAt. Needs a person.');
    console.log('   unparsed-stamp  : redated, but the free text did not match the one');
    console.log('                     known grammar, so no _legacySubmittedAt was derived.');
    for (const r of summary.refusals) {
      console.log(`  ${r.reportId}  ${r.reason}  createdAt="${r.createdAt}"`);
    }
  }
  console.log('');
}

/** Applies the plan. Exported so the emulator test can prove the write lands. */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<void> {
  // One merge per document, so this is one op per write. 400 keeps a wide
  // margin under Firestore's 500-op batch limit.
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      // merge, never set: this collection carries pipeline state
      // (`reconcileStatus` and friends) that no model here declares, and a bare
      // set() would delete it. Same reasoning as
      // KinCareRepository.updateKinCareReport.
      batch.set(db.collection(REPORTS_COLLECTION).doc(w.reportId), w.update, { merge: true });
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
  console.log(`APPLIED: ${writes.length} report(s) redated.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
