import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isUntriagedOrphan } from '../scheduled/purgeOldDrafts';

/**
 * #1631: delete one unsent KinTale report draft.
 *
 * KinTales > Drafts holds two kinds of draft. A `generated_drafts` doc is
 * deleted by `deleteGeneratedDraft` (#1563). This is the other kind: a
 * `kin_care_reports` doc with `status: 'DRAFT'`, a KinTale started from a Kin
 * Care visit and never sent. Until now nothing removed one except the
 * `purgeOldDrafts` retention job, after `draftRetentionDays`.
 *
 * THE SAME REFUSALS AS THE PURGE (`scheduled/purgeOldDrafts.ts`), so the
 * operator can never delete by hand a row the retention job would refuse:
 *
 *  1. `status` must be DRAFT (case-insensitively). A SENT row is the
 *     household's.
 *  2. `sentAt` must be empty. If the status and the send ever disagree, the
 *     send wins and the row stays.
 *  3. Not an untriaged migration orphan (`isUntriagedOrphan`, shared with the
 *     purge). Those rows are waiting on a triage decision, which is Needs
 *     triage's job (`triageOrphanReport`), not a delete's.
 *
 * Each refusal is `failed-precondition` with a message saying which one, read
 * inside the transaction so a send that lands between the screen's read and
 * this call still wins.
 *
 * MEDIA AND COMMENTS ARE NOT CASCADED, for the purge's reasons: the photos a
 * draft names stay in `media_files` (deleting media is `deleteMediaFile`'s
 * job), and a draft has no comment thread a kinfolk could have written.
 *
 * OWNER ONLY. Destructive, like `deleteGeneratedDraft`, so it is not in
 * `AUNTIE_ALLOWED_CALLABLES` (rule 6 in `lib/auntieAccess.ts`).
 */

const Args = z.object({
  reportId: z.string().trim().min(1).max(200).regex(/^[^/]+$/, 'reportId must be a bare document id'),
});

export interface DeleteKinTaleReportDraftResult {
  ok: true;
  reportId: string;
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function deleteKinTaleReportDraftHandler(
  req: CallableRequest<unknown>,
): Promise<DeleteKinTaleReportDraftResult> {
  const actorUid = req.auth?.uid ?? '';
  if (!actorUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }
  const { reportId } = parsed.data;
  const ref = db().collection('kin_care_reports').doc(reportId);

  const kinfolkId = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'This KinTale no longer exists. It may already have been deleted.');
    }
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (str(data['status']).toUpperCase() !== 'DRAFT') {
      throw new HttpsError('failed-precondition', 'Only an unsent draft can be deleted. This KinTale is not a draft.');
    }
    if (str(data['sentAt']) !== '') {
      throw new HttpsError(
        'failed-precondition',
        'This KinTale has a send time, so the household may have it. It is kept.',
      );
    }
    if (isUntriagedOrphan(data)) {
      throw new HttpsError(
        'failed-precondition',
        'This KinTale is waiting in Needs triage. Assign it, mark it a duplicate or archive it there.',
      );
    }
    tx.delete(ref);
    return str(data['kinfolkId']);
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.KINTALE_REPORT_DRAFT_DELETED,
    severity: 'warn',
    actorRole: 'AUNTIE',
    actorUid,
    targetUid: reportId,
    targetCollection: 'kin_care_reports',
    description: `Deleted unsent KinTale draft kin_care_reports/${reportId} (${kinfolkId || 'no household'})`,
    payload: { reportId, kinfolkId: kinfolkId || null },
  });
  logEvent({
    severity: 'warn',
    function: 'deleteKinTaleReportDraft',
    event: 'kintale.report_draft.deleted',
    uid: actorUid,
    extra: { reportId },
  });
  return { ok: true, reportId };
}

export const deleteKinTaleReportDraft = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteKinTaleReportDraft', deleteKinTaleReportDraftHandler),
);
