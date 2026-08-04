import { str } from './coerce';

/**
 * READING `createdAt`, and knowing whether to believe it.
 *
 * THE OPERATOR'S RULING, 2026-08-04, verbatim:
 *
 *   "createdAt is incorrect when we migrated historical data. the old data's
 *    actual createdAt should be its original creation as in from the old system
 *    not the date that it was migrated"
 *
 * So `createdAt` now means WHEN THE RECORD CAME INTO EXISTENCE, not when it
 * entered this system. For a row imported from the previous system that is the
 * previous system's own recorded instant, wherever it could be recovered.
 *
 * ── THE PART THAT MATTERS ON A SCREEN ─────────────────────────────────────
 *
 * Some imported rows have no recoverable original. The previous system simply
 * did not record a date this migration could read. Those rows keep the IMPORT
 * instant in `createdAt`, because every alternative invents information, and
 * they carry `createdAtSource: 'import'` to say so.
 *
 * Without that marker, "imported on 16 May 2026" and "genuinely created on
 * 16 May 2026" are the same bytes, and a screen that renders both as a created
 * date is repeating the bug in a new place. This module is what lets a screen
 * tell them apart.
 *
 * The writer half, the migration, and the full reasoning for the field shape
 * live in `mytribe/scripts/createdAtProvenance.ts`. This is the reader half,
 * duplicated across the tree boundary the same way `parse_legacy_stamp` is
 * duplicated between the python migration and the backfill script: the admin
 * bundle cannot import from `mytribe/scripts`, and the three string values are
 * the contract between them.
 */

/** Where a document's `createdAt` came from. Mirrors `CreatedAtSource` in `mytribe/scripts/createdAtProvenance.ts`. */
export type CreatedAtSource = 'live' | 'original' | 'import';

const SOURCES: readonly string[] = ['live', 'original', 'import'];

/**
 * Reads a stored `createdAtSource`. Absent, blank, and unrecognized all read as
 * `'live'`.
 *
 * ABSENT MEANS `'live'`, and that is a statement about this database rather than
 * a convenient default. Exactly one bulk import has ever run against it
 * (`visit_logs` -> `kin_care_reports`, May 2026), and the migration that
 * introduced this field stamps it on every row it touches, so a document without
 * the field is a document no import ever claimed.
 *
 * An UNRECOGNIZED value reads as `'live'` rather than throwing, for the same
 * reason every field on `KinTaleEntry` is optional: this runs inside list
 * rendering, and one malformed document must not blank the page.
 */
export function readCreatedAtSource(raw: unknown): CreatedAtSource {
  const trimmed = str(raw).trim();
  return SOURCES.includes(trimmed) ? (trimmed as CreatedAtSource) : 'live';
}

/**
 * Is this row's `createdAt` the day it was IMPORTED rather than the day it was
 * created? The one question a reader has to be able to ask before treating a
 * date as a fact about the record.
 */
export function createdAtIsImportDate(raw: unknown): boolean {
  return readCreatedAtSource(raw) === 'import';
}

/**
 * The short marker a list row shows next to an imported row whose original date
 * is unknown, or `''` for every row whose date can be taken at face value.
 *
 * ONLY `'import'` GETS A MARKER, deliberately. A recovered original is a real
 * creation date and needs no caveat, and a badge on all 83 imported rows would
 * be noise that trains the operator to stop reading badges. The marker exists
 * for the rows where the date on screen is NOT what it looks like.
 */
export function createdAtProvenanceNote(raw: unknown): string {
  return createdAtIsImportDate(raw) ? 'Imported, original date unknown' : '';
}
