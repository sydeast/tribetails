import { call } from '../lib/fns';
import { str } from '../lib/coerce';

/**
 * #1631: delete one unsent KinTale report draft, a `kin_care_reports` doc with
 * `status: 'DRAFT'`, through the `deleteKinTaleReportDraft` callable
 * (`mytribe/functions/src/admin/deleteKinTaleReportDraft.ts`). Android and the
 * desktop console call the same one.
 *
 * The other kind of draft in KinTales > Drafts, a `generated_drafts` doc, has
 * its own delete (`deleteGeneratedDraft`, #1563).
 */
export async function deleteKinTaleReportDraft(reportId: string): Promise<void> {
  await call<{ reportId: string }, { ok: true; reportId: string }>('deleteKinTaleReportDraft', {
    reportId: reportId.trim(),
  });
}

/** The fields the delete gate reads. Everything optional: a cast over raw Firestore data. */
export interface DeletableReportFields {
  _id?: string | undefined;
  status?: string | undefined;
  sentAt?: string | undefined;
  sentVia?: string | undefined;
  kinfolkId?: string | undefined;
  triageStatus?: string | undefined;
}

const LEGACY_ORPHAN_MARKERS = new Set(['legacy_orphan', 'legacy_visit_logs']);

/**
 * Whether a report row may offer Delete at all. The same three refusals the
 * server makes (and `purgeOldDrafts` before it), so the control never appears
 * where its only outcome is a refusal: the status is DRAFT, there is no
 * `sentAt`, and it is not an untriaged migration orphan (those belong to Needs
 * triage). A row with no id has nothing to delete. Pure; tested.
 */
export function canDeleteKinTaleDraft(row: DeletableReportFields): boolean {
  if (str(row._id) === '') return false;
  if (str(row.status).toUpperCase() !== 'DRAFT') return false;
  if (str(row.sentAt) !== '') return false;
  const untriagedOrphan =
    str(row.kinfolkId) === '' && str(row.triageStatus) === '' && LEGACY_ORPHAN_MARKERS.has(str(row.sentVia));
  return !untriagedOrphan;
}
