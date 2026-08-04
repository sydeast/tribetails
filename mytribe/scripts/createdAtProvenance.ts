/**
 * createdAtProvenance.ts
 *
 * WHAT `createdAt` MEANS, and how a reader can tell whether to believe it.
 *
 * THE OPERATOR'S RULING, 2026-08-04, verbatim:
 *
 *   "createdAt is incorrect when we migrated historical data. the old data's
 *    actual createdAt should be its original creation as in from the old system
 *    not the date that it was migrated (this is going to be true for almost all
 *    historical data: invoices, kintales, media, comments)"
 *
 * This REVERSES the 2026-08-01 ruling, which said `createdAt` meant "created in
 * AuntieOS" and redated every imported row to its ingest stamp. That earlier
 * ruling shipped as `mytribe/scripts/backfillKinTaleCreatedAt.ts` (punchlist F7)
 * and as the `createdAt: ingest` line in
 * `auntieos-admin/migrate_visit_logs_to_kin_care_reports.py`. Both are corrected
 * by the change that adds this file. The F7 script is DELETED rather than left
 * in place, because it was one `npm run` away from writing the import date over
 * every historical KinTale, which is now precisely the defect.
 *
 * ── THE THREE FIELDS ──────────────────────────────────────────────────────
 *
 *   `createdAt`        WHEN THE RECORD CAME INTO EXISTENCE. For a row this
 *                      system created, the instant it created it. For a row
 *                      imported from the previous system, that system's own
 *                      recorded creation instant, wherever it can be recovered.
 *                      This is the field every query orders and windows on.
 *
 *   `_migratedAt`      WHEN THE ROW ENTERED THIS SYSTEM. Already written by
 *                      `migrate_visit_logs_to_kin_care_reports.py:183` on every
 *                      imported KinTale, alongside `_migratedFrom`. Nothing is
 *                      lost by moving `createdAt` off it; the ingest instant
 *                      keeps the field that was always named for it.
 *
 *   `createdAtSource`  WHICH OF THOSE TWO `createdAt` ACTUALLY IS. New here,
 *                      and the whole point of the change. Without it, "imported
 *                      on 16 May 2026" and "genuinely created on 16 May 2026"
 *                      are the same bytes, and a reader who cannot tell them
 *                      apart is looking at the same bug in a new field.
 *
 * ── WHY NOT A SEPARATE `originalCreatedAt`, LEAVING `createdAt` AS INGEST ──
 *
 * That is the obvious shape and it does not survive contact with Firestore.
 *
 * A read would have to order on "the original where it exists, otherwise the
 * ingest date", and Firestore has no COALESCE: no `orderBy` can span two
 * fields. The KinTales list is a bounded, server-ordered, PAGED query, ordered
 * `createdAt desc` with a `startAfter` cursor and a `createdAt >= startIso`
 * window (`auntieos-admin/src/api/kinTales.ts:172-183`). Splitting the truth
 * across two fields leaves two options, and both are worse than the defect:
 *
 *   1. Denormalize a third "sort on this one" field. That field IS `createdAt`
 *      under a new name, plus a second thing that can drift out of sync with
 *      the first two.
 *   2. Read the collection unbounded and sort in memory. That is the AO-29
 *      pattern `useCollection` and `KINTALES_QUERY`'s 200-row cap exist to
 *      make unavailable, and it is documented as a bug class in this codebase
 *      rather than a tradeoff.
 *
 * Keeping `createdAt` as the one sort key also means the deployed composite
 * index `kin_care_reports (kinfolkId ASC, createdAt DESC)`
 * (`mytribe/firestore.indexes.json:256-268`) still serves the faceted list, and
 * the four clients that read this collection do not diverge on which field
 * orders it.
 *
 * So the brief's instinct is right and the split already exists: two fields,
 * one for each instant. `_migratedAt` is the second field, it was there all
 * along, and the fix is to stop overloading `createdAt` with its job.
 *
 * ── A ROW WHOSE ORIGINAL INSTANT CANNOT BE RECOVERED ───────────────────────
 *
 * It keeps the import instant in `createdAt` and is MARKED `'import'`. Stated
 * plainly, because each half is a decision:
 *
 *   It keeps the import instant, because every alternative invents information.
 *   Sorting it to the top, to the bottom, or to a guessed neighbour's date all
 *   assert something about when it happened that nobody knows. The import
 *   instant is at least a true fact about the row, so it sorts by a date that
 *   is real and merely not the one you wanted.
 *
 *   It is marked, because unmarked it is indistinguishable from a row genuinely
 *   created that day. `createdAtSource: 'import'` is the difference, and it is
 *   what lets a list render "Imported 16 May 2026, original date unknown"
 *   instead of a confident lie, and lets an operator explain why a year-old
 *   visit sits where it sits.
 *
 * Nothing here ever writes a date it did not read from somewhere. A row with
 * neither a recoverable original nor a usable ingest stamp is REFUSED and
 * reported by id, never stamped with `now`.
 */

/**
 * Where a document's `createdAt` came from.
 *
 * ABSENT MEANS `'live'`, and that is sound rather than a convenient default.
 * Exactly one bulk import has ever run against this database (`visit_logs` ->
 * `kin_care_reports`, May 2026), it is the only writer of `_migratedFrom`, and
 * the migration that introduces this field stamps `createdAtSource` on every
 * row it touches. So a document without the field is a document no import ever
 * claimed. Treating absence as `'live'` is therefore a statement about this
 * database's history, not an assumption about the field.
 */
export type CreatedAtSource =
  /**
   * This system stamped `createdAt` when it really created the row. The
   * ordinary case, and the one that needs no marker.
   */
  | 'live'
  /**
   * `createdAt` is the SOURCE SYSTEM's own recorded creation instant, carried
   * across at the source's precision and with the source's zone-naivety.
   *
   * For `kin_care_reports` that means specifically: the legacy `submitted`
   * stamp ("September 3, 2025 2:02pm") rendered as if the wall clock were UTC,
   * the convention this corpus already accepted
   * (`cleanup_prod_data_pass1.py#normalize_iso_zulu`: "Treats naive local
   * timestamps as Zulu"). The source records no zone, so none can be recovered.
   *
   * ORDER IS EXACT, THE INSTANT IS APPROXIMATE. Every stamp shifts by the same
   * unknown offset, and a constant offset cannot reorder anything. Sort by this
   * field and window on it; do not present it as a clock time.
   */
  | 'original'
  /**
   * The original instant could NOT be recovered, so `createdAt` holds the
   * IMPORT instant. It is not a creation date and must not be rendered as one.
   * `_migratedAt` holds the same value; `_migratedFrom` names the source doc.
   */
  | 'import';

/** The field name, in one place, so a typo cannot silently create a second field. */
export const CREATED_AT_SOURCE_FIELD = 'createdAtSource';

const SOURCES: readonly CreatedAtSource[] = ['live', 'original', 'import'];

/** A full ISO-8601 instant. Anything else is not an instant and is refused. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Re-renders an ISO instant in the canonical millisecond form
 * ("2026-05-16T20:36:39Z" -> "2026-05-16T20:36:39.000Z"), or null if the text is
 * not an ISO instant at all.
 *
 * ONE FORM ACROSS THE COLLECTION IS WHAT MAKES LEXICAL ORDER EQUAL
 * CHRONOLOGICAL ORDER. `kin_care_reports.createdAt` is an opaque STRING on every
 * doc, not a Firestore Timestamp, so Firestore compares it byte by byte.
 * '...39Z' sorts AFTER '...39.000Z' for the same instant, because 'Z' is 0x5A
 * and '.' is 0x2E. The migration reads `_legacySubmittedAt`, which
 * `migrate_visit_logs_to_kin_care_reports.py:93` writes WITHOUT milliseconds,
 * and writes into a field whose live rows all carry them. Normalizing is what
 * stops that from seeding a smaller copy of the ordering bug being fixed.
 */
export function canonicalInstant(raw: unknown): string | null {
  const trimmed = str(raw);
  if (!ISO_INSTANT.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Reads a stored `createdAtSource`. Anything absent, blank, or not one of the
 * three known values reads as `'live'`.
 *
 * An unrecognized value reads as `'live'` rather than throwing because this runs
 * inside list rendering: a single malformed document must not blank the page,
 * which is the same reasoning `KinTaleEntry`'s all-optional shape is built on.
 * The migration is the only writer, and it only ever writes the three.
 */
export function readCreatedAtSource(raw: unknown): CreatedAtSource {
  const trimmed = str(raw);
  return (SOURCES as readonly string[]).includes(trimmed)
    ? (trimmed as CreatedAtSource)
    : 'live';
}

/**
 * Is this row's `createdAt` the day it was IMPORTED rather than the day it was
 * created? The one question a reader has to be able to ask.
 */
export function createdAtIsImportDate(raw: unknown): boolean {
  return readCreatedAtSource(raw) === 'import';
}

/** What an importer must write for one row's creation instant. */
export interface CreatedAtStamp {
  createdAt: string;
  createdAtSource: Extract<CreatedAtSource, 'original' | 'import'>;
}

/**
 * THE WRITE PATH FOR ANY IMPORT, so that no future one can repeat this defect.
 *
 * An importer does not get to write a bare `createdAt`. It calls this with the
 * source system's instant and its own ingest instant, and the return value
 * carries the marker with the date, inseparably. Passing `null` for
 * `originalIso` is how an importer says "the source did not record one", which
 * is an answer this returns `'import'` for, not something it papers over.
 *
 * Returns `null` when NEITHER instant is usable. That is not an error to
 * swallow: the caller must skip the row and report it, because the only values
 * left to write would be invented.
 */
export function resolveMigratedCreatedAt(
  originalIso: unknown,
  ingestIso: unknown,
): CreatedAtStamp | null {
  const original = canonicalInstant(originalIso);
  if (original !== null) return { createdAt: original, createdAtSource: 'original' };
  const ingest = canonicalInstant(ingestIso);
  if (ingest !== null) return { createdAt: ingest, createdAtSource: 'import' };
  return null;
}
