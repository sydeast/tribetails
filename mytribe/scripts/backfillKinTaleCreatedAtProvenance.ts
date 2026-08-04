/**
 * backfillKinTaleCreatedAtProvenance.ts
 *
 * Gives every imported KinTale back the date it was actually written, and marks
 * the ones whose date cannot be recovered.
 *
 * THE OPERATOR'S RULING, 2026-08-04, verbatim:
 *
 *   "createdAt is incorrect when we migrated historical data. the old data's
 *    actual createdAt should be its original creation as in from the old system
 *    not the date that it was migrated (this is going to be true for almost all
 *    historical data: invoices, kintales, media, comments)"
 *
 * The field shape and the reasoning behind it live in `createdAtProvenance.ts`,
 * which is also where the reversal of the 2026-08-01 ruling is recorded. Read
 * that first. This file is only the `kin_care_reports` half of it.
 *
 * ── WHAT IS WRONG IN PRODUCTION ───────────────────────────────────────────
 *
 * 83 of the 92 `kin_care_reports` (verified 2026-08-01) are historical visit
 * reports imported from the previous system by
 * `auntieos-admin/migrate_visit_logs_to_kin_care_reports.py` in May 2026. Their
 * `createdAt` is wrong in one of two ways depending on whether the operator has
 * run the now-deleted F7 redate:
 *
 *   BEFORE F7   `createdAt` is the raw legacy free text, "September 3, 2025
 *               2:02pm". Firestore orders strings by UTF-8 byte, so letters beat
 *               digits and every legacy row sorts ABOVE every ISO row in
 *               `createdAt desc`, with the legacy block ordered among itself
 *               ALPHABETICALLY BY MONTH NAME. This is the state the operator is
 *               describing: last year's tales sitting at the top of the list.
 *
 *   AFTER F7    `createdAt` is the ingest stamp, one identical instant on all 83
 *               rows. Sortable, and a lie about all 83.
 *
 * THIS SCRIPT CONVERGES BOTH STATES onto the same answer, and there is a test
 * that asserts exactly that, because which state production is in is not
 * knowable from this repository. There is no runbook entry for the F7 write and
 * no record of it having been run, but "no record" is not "did not happen".
 *
 * ── WHERE THE ORIGINAL INSTANT COMES FROM ─────────────────────────────────
 *
 * Three lanes, tried in order, all reading the SAME underlying value, the
 * legacy `visit_logs.submitted` stamp. Three lanes rather than one because the
 * value landed in different fields depending on which pass wrote the row:
 *
 *   1. `_legacySubmittedAt`   The parsed ISO form, written by the migration at
 *                             `migrate_visit_logs_to_kin_care_reports.py:180`
 *                             and by the F7 script. The normal lane.
 *   2. `createdAt`            The raw free text, on a row imported before
 *                             `_legacySubmittedAt` existed and not yet redated.
 *   3. `visitDate` / `sentAt` Both hold `first_nonblank(submitted, arrival,
 *                             departure)` (`:128,144,154`), so they carry the
 *                             submit stamp whenever there was one.
 *
 * LANE 3 IS SAFE ONLY BECAUSE THE GRAMMAR IS ANCHORED AND NARROW. When
 * `submitted` was blank those fields fall back to a bare clock time with no date
 * at all ("8:37pm"), and `LEGACY_STAMP` requires a full English month name and a
 * four-digit year, so it REFUSES that rather than inventing a day for it. The
 * lane can therefore only ever return a real submit stamp or nothing. Nothing
 * here goes near `new Date()` on free text, whose behaviour on unrecognized
 * input is implementation-defined.
 *
 * ── WHAT IT WRITES, AND ONLY THIS ─────────────────────────────────────────
 *
 *   `createdAt`           the recovered original instant, or, where none can be
 *                         recovered, the row's own `_migratedAt` left in place
 *                         and normalized. Always canonical millisecond ISO, so
 *                         lexical order equals chronological order across the
 *                         whole collection.
 *   `createdAtSource`     `'original'` or `'import'`, saying which of those two
 *                         the `createdAt` above actually is. This is the field
 *                         that stops "imported that day" and "created that day"
 *                         from being the same bytes.
 *   `_legacySubmittedAt`  the recovered original, and ONLY where the field is
 *                         currently blank, so a value already in production is
 *                         never overwritten.
 *
 * WHAT IT NEVER TOUCHES: `visitDate`, `sentAt`, `arrivedAt`, `departedAt`. That
 * boundary is inherited from the deleted F7 script and its reasoning still
 * holds: measured against the live corpus, 18 of the 83 rows record an
 * `arrivedAt` clock time LATER in the day than the submit stamp (legacy_72
 * submits "August 29, 2025 8:06am" and records an arrival at 6:19pm), so the
 * visit demonstrably began on the PREVIOUS calendar day. The text is a SUBMIT
 * stamp, not a visit date. Writing it into `visitDate` would launder a
 * known-wrong date into a form indistinguishable from a real one, on a care
 * record, 18 times. It is written where it is true and nowhere else.
 *
 * ── ROWS IT REFUSES ───────────────────────────────────────────────────────
 *
 * A row with no recoverable original AND no usable `_migratedAt` is SKIPPED
 * entirely and reported by id. Not redated to `now`, not given a neighbour's
 * value, not marked. Nothing is written to it at all, because every value
 * available to write would be invented.
 *
 * ── SCOPE, STATED SO THE SILENCE IS NOT READ AS COVERAGE ──────────────────
 *
 * `kin_care_reports` ONLY. The operator's ruling named invoices, media and
 * comments too. What the investigation found:
 *
 *   media_files    NOT MIGRATED. No importer has ever existed, and the previous
 *                  system's media fields are verified empty in prod. Every
 *                  `uploadedAt` is a genuine ingest instant. Nothing to repair.
 *   comments       NOT MIGRATED. Written only by two callables, with client
 *                  writes denied by `firestore.rules:288-290`. Nothing to repair.
 *   invoices       MIGRATED, and NOT repaired here. Their `createdAt` came from
 *                  an ad-hoc backfill on 2026-07-20 whose script was never
 *                  committed, so the value it used is unknowable from this
 *                  repository. The original invoice date does survive in the
 *                  free-text `date` field, which is the only recovery lane
 *                  available and is being changed on branch `fix/invoicedate`
 *                  as this ships. Repairing invoices against a field whose
 *                  contents are being redefined underneath would be building on
 *                  sand. It is a follow-up, and the PR body says so.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 *
 * A row that already carries a `createdAtSource` is left completely alone. That
 * single branch is the whole guarantee: after one run every touched row has one,
 * so a second run plans nothing at all.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Runbook: run DRY first, read the plan and the refusals, then re-run with
 * --allow-prod. The real write is an operator step, never an agent's.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  CREATED_AT_SOURCE_FIELD,
  canonicalInstant,
  resolveMigratedCreatedAt,
  type CreatedAtSource,
} from './createdAtProvenance';

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
          'backfillKinTaleCreatedAtProvenance.ts: restore the ORIGINAL creation instant on imported KinTales',
          '',
          '  npm run backfill:kintale-provenance                    # DRY RUN (default)',
          '  npm run backfill:kintale-provenance -- --allow-prod    # apply',
          '  npm run backfill:kintale-provenance -- --project <id>  # override project',
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
 * The ONE grammar the legacy corpus uses: "September 3, 2025 2:02pm". All 83
 * production rows match it exactly. Minutes are optional because the sibling
 * `arrivedAt`/`departedAt` fields on the same rows use the bare-hour form
 * ("4pm"), so the corpus demonstrably produces it.
 *
 * Deliberately anchored and deliberately narrow. A full English month name with
 * a four-digit year cannot be ambiguous the way `03/09/2025` is, which is the
 * only reason parsing this text is defensible at all. It is also what makes the
 * `visitDate`/`sentAt` recovery lane safe: those fields fall back to a bare
 * clock time when `submitted` was blank, and this refuses a bare clock time.
 */
const LEGACY_STAMP =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4}) (\d{1,2})(?::(\d{2}))?(am|pm)$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * "September 3, 2025 2:02pm" -> "2025-09-03T14:02:00.000Z", or null if the text
 * is not exactly this grammar or names a day that does not exist.
 *
 * Built through `Date.UTC`, never through the local-time `Date` constructor, so
 * the output does not depend on the timezone of whoever runs the script.
 *
 * ITS ZONE, stated plainly because the output ends in `Z`. The source records no
 * zone, so none can be recovered. The wall clock is rendered as if it were UTC,
 * the convention this corpus already accepted
 * (`cleanup_prod_data_pass1.py#normalize_iso_zulu`). Every stamp shifts by the
 * same unknown offset, so the ORDER this value carries is exact even though the
 * instant is approximate. That caveat is what `createdAtSource: 'original'`
 * documents on the stored row.
 */
export function parseLegacyStamp(raw: unknown): string | null {
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
 * Was this row imported from the previous system?
 *
 * POSITIVE ENUMERATION, never "it does not look modern". Each marker is written
 * by a known line of the migration: `_migratedFrom` and `_migratedAt` at
 * `migrate_visit_logs_to_kin_care_reports.py:182-183`, and the two `sentVia`
 * markers at `:155` (`legacy_orphan` from Pass 1, `legacy_visit_logs` after
 * `cleanup_prod_data_pass2.py` renamed the reconciled ones). Any one of them is
 * enough, because Pass 2 rewrote `sentVia` on rows whose `_migratedFrom` it left
 * untouched, and a bare `set()` from an old Android client could historically
 * strip `_migratedFrom`/`_migratedAt` while leaving `sentVia` in place
 * (`KinCareRepository.updateKinCareReport`).
 */
export function isMigratedRow(data: Record<string, unknown>): boolean {
  if (str(data['_migratedFrom']) !== '') return true;
  if (str(data['_migratedAt']) !== '') return true;
  const sentVia = str(data['sentVia']);
  return sentVia === 'legacy_orphan' || sentVia === 'legacy_visit_logs';
}

/**
 * The original creation instant for one imported row, or null when none of the
 * three lanes yields one. Pure, so every lane is testable against fixtures.
 */
export function recoverOriginalInstant(data: Record<string, unknown>): string | null {
  // Lane 1: the parsed stamp the migration already preserved.
  const preserved = canonicalInstant(data['_legacySubmittedAt']);
  if (preserved !== null) return preserved;
  // Lane 2: the raw free text, still sitting in createdAt on a row the F7
  // redate never reached.
  const fromCreatedAt = parseLegacyStamp(data['createdAt']);
  if (fromCreatedAt !== null) return fromCreatedAt;
  // Lane 3: the same value as the migration copied into the visit fields. Safe
  // only because LEGACY_STAMP refuses the bare clock times these fields fall
  // back to; see the header.
  const fromVisitDate = parseLegacyStamp(data['visitDate']);
  if (fromVisitDate !== null) return fromVisitDate;
  return parseLegacyStamp(data['sentAt']);
}

export type SkipReason =
  /** Not an imported row. Its `createdAt` is this system's own stamp and is already true. */
  | 'not-migrated'
  /** Already carries a `createdAtSource`. The idempotency branch. */
  | 'already-stamped'
  /**
   * No recoverable original AND no usable `_migratedAt`. Refused rather than
   * guessed at: every value left to write would be invented.
   */
  | 'no-usable-instant';

export interface ProvenancePlan {
  /** Fields to merge onto the report. Empty means nothing to do. */
  update: Record<string, string>;
  /** Set when the row was NOT planned. Reported, never guessed at. */
  skip: SkipReason | null;
  /** What `createdAtSource` this row is getting, or null when it is being skipped. */
  source: CreatedAtSource | null;
}

/**
 * The decision for ONE report. PURE: no Firestore access, so every rule is
 * unit-testable against fixtures.
 */
export function planProvenance(data: Record<string, unknown>): ProvenancePlan {
  const plan: ProvenancePlan = { update: {}, skip: null, source: null };

  if (!isMigratedRow(data)) {
    plan.skip = 'not-migrated';
    return plan;
  }
  // The whole idempotency guarantee, in one branch: a row this script has
  // already answered for carries the answer.
  if (str(data[CREATED_AT_SOURCE_FIELD]) !== '') {
    plan.skip = 'already-stamped';
    return plan;
  }

  const original = recoverOriginalInstant(data);
  const stamp = resolveMigratedCreatedAt(original, data['_migratedAt']);
  if (stamp === null) {
    plan.skip = 'no-usable-instant';
    return plan;
  }

  plan.source = stamp.createdAtSource;
  plan.update['createdAt'] = stamp.createdAt;
  plan.update[CREATED_AT_SOURCE_FIELD] = stamp.createdAtSource;

  // Preserve the recovered original under the name that says what it is, but
  // never over a value already in production.
  if (original !== null && str(data['_legacySubmittedAt']) === '') {
    plan.update['_legacySubmittedAt'] = original;
  }

  return plan;
}

export interface Refusal {
  reportId: string;
  reason: SkipReason;
  createdAt: string;
}

export interface Summary {
  scanned: number;
  notMigrated: number;
  alreadyStamped: number;
  recovered: number;
  markedImport: number;
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
    notMigrated: 0,
    alreadyStamped: 0,
    recovered: 0,
    markedImport: 0,
    sequenceStampsWritten: 0,
    refusals: [],
  };
  const writes: PlannedWrite[] = [];

  for (const doc of snap.docs) {
    summary.scanned += 1;
    const data = doc.data() as Record<string, unknown>;
    const previousCreatedAt = str(data['createdAt']);
    const plan = planProvenance(data);

    if (plan.skip === 'not-migrated') {
      summary.notMigrated += 1;
      continue;
    }
    if (plan.skip === 'already-stamped') {
      summary.alreadyStamped += 1;
      continue;
    }
    if (plan.skip !== null) {
      summary.refusals.push({ reportId: doc.id, reason: plan.skip, createdAt: previousCreatedAt });
      continue;
    }

    if (plan.source === 'original') summary.recovered += 1;
    if (plan.source === 'import') summary.markedImport += 1;
    if (plan.update['_legacySubmittedAt'] !== undefined) summary.sequenceStampsWritten += 1;
    writes.push({ reportId: doc.id, update: plan.update, previousCreatedAt });
  }

  return { summary, writes };
}

function report(summary: Summary, writes: PlannedWrite[], mode: Mode): void {
  console.log('');
  console.log(`=== KinTale createdAt provenance (${mode.toUpperCase()}) ===`);
  console.log(`reports scanned                  : ${summary.scanned}`);
  console.log(`not imported (untouched)         : ${summary.notMigrated}`);
  console.log(`already stamped (untouched)      : ${summary.alreadyStamped}`);
  console.log(`original recovered  -> 'original': ${summary.recovered}`);
  console.log(`original UNKNOWN    -> 'import'  : ${summary.markedImport}`);
  console.log(`_legacySubmittedAt to write      : ${summary.sequenceStampsWritten}`);
  console.log(`refused (nothing written)        : ${summary.refusals.length}`);

  if (writes.length > 0) {
    console.log('');
    console.log('-- planned writes --');
    for (const w of writes) {
      const source = w.update[CREATED_AT_SOURCE_FIELD];
      console.log(
        `  ${REPORTS_COLLECTION}/${w.reportId}  createdAt: "${w.previousCreatedAt}" -> "${w.update['createdAt']}"  (${source})`,
      );
    }
  }

  if (summary.markedImport > 0) {
    console.log('');
    console.log(
      `-- ${summary.markedImport} row(s) MARKED 'import'. Their createdAt is the day they were`,
    );
    console.log("   imported, not the day they were written. Nothing recovered an original for");
    console.log('   them, so they keep a date that is true and say what it is.');
  }

  if (summary.refusals.length > 0) {
    console.log('');
    console.log('-- REFUSED. Left exactly as they are; nothing was guessed. --');
    console.log('   no-usable-instant : neither a recoverable original nor a usable');
    console.log('                       _migratedAt. Needs a person.');
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
  console.log(`APPLIED: ${writes.length} report(s) stamped.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
