import { call } from '../lib/fns';

/**
 * The "Needs triage" surface's callable client: the read side
 * (`listOrphanReports`) and the write side (`triageOrphanReport`,
 * ASSIGN / DUPLICATE / ARCHIVE) for the post-migration orphan
 * `kin_care_reports` rows KinTale Logs surfaces above the normal buckets.
 *
 * THE GAP THIS CLOSES. Android has carried this since M5
 * (`KinCareRepository.kt#assignKinfolkToOrphanReport` /
 * `#markOrphanReportAsDuplicate` / `#archiveOrphanReportAsBadData`, all three
 * routed through the one server callable `triageOrphanReport`). This admin's
 * `src/` tree had zero references to it: an orphan is completed care work
 * with no session to bill it against, and with no web surface it simply did
 * not exist for an operator at a desk instead of a phone.
 *
 * BOTH CALLABLES ARE CONFIRMED LIVE, not assumed from the Android port alone:
 *  - `mytribe/functions/src/admin/triageOrphanReport.ts` (already deployed,
 *    Android's own reference implementation).
 *  - `mytribe/functions/src/admin/listOrphanReports.ts` (built alongside this
 *    client; see its own file header for why the read side needed a callable
 *    rather than a client-side filter over the already-capped KinTales list).
 *
 * Every write below sends the trimmed, pre-validated intent and still lets
 * the server be the final authority: `triageOrphanReport.ts`'s own zod schema
 * re-checks every field, so a rejection here still surfaces as a real
 * `FirebaseError` through `lib/fns.ts#call`, never swallowed.
 */

// ── read ─────────────────────────────────────────────────────────────────

/**
 * One untriaged orphan row, exactly the fields `listOrphanReportsHandler`
 * returns (see its own `OrphanReportSchema`). Deliberately narrower than
 * `KinTaleEntry`: an orphan carries no `kinfolkId`/`kinfolkName` by
 * definition (that is what makes it an orphan), so this is its own shape
 * rather than a reuse of the main list's type.
 */
export interface OrphanReportEntry {
  _id: string;
  bodyCopy: string;
  /** One of the migration provenance markers (`legacy_orphan` / `legacy_visit_logs`). Render through `lib/kinTaleFormat.ts#sentViaLabel`, never raw. */
  sentVia: string;
  createdAt: string;
}

interface ListOrphanReportsResponse {
  reports: OrphanReportEntry[];
  scanned: number;
}

/**
 * Every untriaged orphan the server can see, newest migration row first.
 * Throws (via `lib/fns.call`) on any failure; the caller renders that
 * fail-loud rather than showing an empty "Needs triage" section, which would
 * read as "nothing to do" instead of "the read failed".
 */
export async function listOrphanReports(): Promise<OrphanReportEntry[]> {
  const res = await call<Record<string, never>, ListOrphanReportsResponse>('listOrphanReports', {});
  return Array.isArray(res?.reports) ? res.reports : [];
}

// ── write ────────────────────────────────────────────────────────────────

/** `triageOrphanReportHandler`'s response, field-for-field. */
export interface TriageResult {
  ok: true;
  action: 'ASSIGN' | 'DUPLICATE' | 'ARCHIVE';
  reportId: string;
}

/**
 * Thrown by every function below on a BLANK/malformed argument, before any
 * network call. Mirrors the `require()` guards
 * `KinCareRepository.kt`'s three triage helpers open with: catching a typo'd
 * empty id here is cheaper and clearer than letting the server's zod schema
 * reject it as a generic 400.
 */
export class TriageValidationError extends Error {}

/**
 * Links an orphan report to a real Kinfolk. `suppliedName` is carried only
 * for the server's own mismatch-forensics (`triageOrphanReport.ts` derives
 * the CANONICAL name from the `kinfolk/{id}` doc itself and logs a
 * `nameMismatch` when this differs; the caller's guess is never trusted for
 * the write).
 */
export async function assignKinfolkToOrphanReport(
  reportId: string,
  kinfolkId: string,
  suppliedName?: string,
): Promise<TriageResult> {
  const id = reportId.trim();
  const kid = kinfolkId.trim();
  if (id === '') throw new TriageValidationError('reportId is required.');
  if (kid === '') throw new TriageValidationError('Choose a kinfolk to assign.');

  const name = (suppliedName ?? '').trim();
  const payload = {
    action: 'ASSIGN' as const,
    reportId: id,
    kinfolkId: kid,
    ...(name !== '' ? { suppliedName: name } : {}),
  };
  return call<typeof payload, TriageResult>('triageOrphanReport', payload);
}

/** Marks an orphan report as a duplicate of an existing, already-triaged report. */
export async function markOrphanReportAsDuplicate(
  reportId: string,
  duplicateOfReportId: string,
): Promise<TriageResult> {
  const id = reportId.trim();
  const dupId = duplicateOfReportId.trim();
  if (id === '') throw new TriageValidationError('reportId is required.');
  if (dupId === '') throw new TriageValidationError('Choose the report this duplicates.');
  if (id === dupId) {
    throw new TriageValidationError('A report cannot be marked as a duplicate of itself.');
  }
  const payload = { action: 'DUPLICATE' as const, reportId: id, duplicateOfReportId: dupId };
  return call<typeof payload, TriageResult>('triageOrphanReport', payload);
}

/**
 * Soft-archives an orphan report as bad data. `reason` mirrors the server's
 * own `min(5)` bound (`triageOrphanReport.ts`'s `Args` schema); enforcing it
 * here too means a too-short reason never leaves the browser.
 */
export async function archiveOrphanReportAsBadData(
  reportId: string,
  reason: string,
): Promise<TriageResult> {
  const id = reportId.trim();
  const trimmedReason = reason.trim();
  if (id === '') throw new TriageValidationError('reportId is required.');
  if (trimmedReason.length < 5) {
    throw new TriageValidationError('Archive reason must be at least 5 characters.');
  }
  const payload = { action: 'ARCHIVE' as const, reportId: id, reason: trimmedReason };
  return call<typeof payload, TriageResult>('triageOrphanReport', payload);
}
