import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Unified server callable for orphan KinTale triage actions (M5).
 *
 * Replaces three client-side Firestore batch writes (Android repo + Web
 * `__fb` JS bridge) so the audit entry is server-issued and structurally
 * bound to the actual mutation. Eliminates the gap where a compromised
 * admin client could fabricate an audit entry that doesn't match the
 * document state, or could supply a misleading description/name (CWE-345).
 *
 * Each action emits a SCREAMING_SNAKE audit event into `activity_log` and
 * derives the canonical kinfolk display name from the `kinfolk/{id}` doc
 * (not from caller-supplied input, the caller's name is logged separately
 * as `suppliedName` when it diverges, for forensic correlation).
 *
 * Gated by wrapAdminCallable → admin custom claim (H11 unification).
 */

const Args = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ASSIGN'),
    reportId: z.string().min(1).max(120),
    kinfolkId: z.string().min(1).max(120),
    suppliedName: z.string().max(200).optional(),
  }),
  z.object({
    action: z.literal('DUPLICATE'),
    reportId: z.string().min(1).max(120),
    duplicateOfReportId: z.string().min(1).max(120),
  }),
  z.object({
    action: z.literal('ARCHIVE'),
    reportId: z.string().min(1).max(120),
    reason: z.string().min(5).max(500),
  }),
]);

type TriageResult = { ok: true; action: string; reportId: string };

async function deriveKinfolkDisplayName(kinfolkId: string): Promise<string | null> {
  try {
    const snap = await db().collection('kinfolk').doc(kinfolkId).get();
    if (!snap.exists) return null;
    const data = snap.data() as { firstName?: string; lastName?: string } | undefined;
    const first = (data?.firstName ?? '').trim();
    const last = (data?.lastName ?? '').trim();
    const name = [first, last].filter(Boolean).join(' ').trim();
    return name.length ? name : null;
  } catch {
    return null;
  }
}

export async function triageOrphanReportHandler(
  req: CallableRequest<unknown>,
): Promise<TriageResult> {
  const args = Args.parse(req.data);
  const actorUid = req.auth?.uid ?? '';
  if (!actorUid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }

  const reportRef = db().collection('kin_care_reports').doc(args.reportId);
  const reportSnap = await reportRef.get();
  if (!reportSnap.exists) {
    throw new HttpsError('not-found', `kin_care_reports/${args.reportId} not found`);
  }

  const nowIso = new Date().toISOString();

  switch (args.action) {
    case 'ASSIGN': {
      const canonicalName = await deriveKinfolkDisplayName(args.kinfolkId);
      if (!canonicalName) {
        throw new HttpsError(
          'failed-precondition',
          `kinfolk/${args.kinfolkId} not found or has no displayable name`,
        );
      }
      const supplied = (args.suppliedName ?? '').trim();
      const nameMismatch = supplied.length > 0 && supplied !== canonicalName;
      await reportRef.update({
        kinfolkId: args.kinfolkId,
        kinfolkName: canonicalName,
        triageStatus: 'assigned',
        triagedAt: nowIso,
        triagedBy: actorUid,
        updatedAt: nowIso,
      });
      await writeAuditEntry({
        status: 'SUCCESS',
        event: AUDIT_EVENTS.TRIAGE_ORPHAN_REPORT_ASSIGN,
        severity: 'info',
        actorRole: 'AUNTIE',
        actorUid,
        targetUid: args.reportId,
        targetCollection: 'kin_care_reports',
        description: `Assigned orphan KinTale ${args.reportId} to kinfolk ${canonicalName} (${args.kinfolkId})`,
        payload: {
          reportId: args.reportId,
          kinfolkId: args.kinfolkId,
          canonicalName,
          suppliedName: nameMismatch ? supplied : null,
          nameMismatch,
        },
      });
      logEvent({
        severity: 'info',
        function: 'triageOrphanReport',
        event: 'triage.assign.applied',
        uid: actorUid,
        extra: { reportId: args.reportId, kinfolkId: args.kinfolkId, nameMismatch },
      });
      return { ok: true, action: 'ASSIGN', reportId: args.reportId };
    }
    case 'DUPLICATE': {
      if (args.reportId === args.duplicateOfReportId) {
        throw new HttpsError('invalid-argument', 'reportId and duplicateOfReportId must differ');
      }
      const canonicalRef = db().collection('kin_care_reports').doc(args.duplicateOfReportId);
      const canonicalSnap = await canonicalRef.get();
      if (!canonicalSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          `Canonical report kin_care_reports/${args.duplicateOfReportId} not found`,
        );
      }
      await reportRef.update({
        triageStatus: 'duplicate',
        duplicateOfReportId: args.duplicateOfReportId,
        triagedAt: nowIso,
        triagedBy: actorUid,
        updatedAt: nowIso,
      });
      await writeAuditEntry({
        status: 'SUCCESS',
        event: AUDIT_EVENTS.TRIAGE_ORPHAN_REPORT_DUPLICATE,
        severity: 'info',
        actorRole: 'AUNTIE',
        actorUid,
        targetUid: args.reportId,
        targetCollection: 'kin_care_reports',
        description: `Marked orphan KinTale ${args.reportId} as duplicate of ${args.duplicateOfReportId}`,
        payload: {
          reportId: args.reportId,
          duplicateOfReportId: args.duplicateOfReportId,
        },
      });
      logEvent({
        severity: 'info',
        function: 'triageOrphanReport',
        event: 'triage.duplicate.applied',
        uid: actorUid,
        extra: { reportId: args.reportId, duplicateOfReportId: args.duplicateOfReportId },
      });
      return { ok: true, action: 'DUPLICATE', reportId: args.reportId };
    }
    case 'ARCHIVE': {
      await reportRef.update({
        triageStatus: 'archived_bad_data',
        archiveReason: args.reason,
        triagedAt: nowIso,
        triagedBy: actorUid,
        updatedAt: nowIso,
      });
      await writeAuditEntry({
        status: 'SUCCESS',
        event: AUDIT_EVENTS.TRIAGE_ORPHAN_REPORT_ARCHIVE,
        severity: 'info',
        actorRole: 'AUNTIE',
        actorUid,
        targetUid: args.reportId,
        targetCollection: 'kin_care_reports',
        description: `Archived orphan KinTale ${args.reportId} as bad data: ${args.reason}`,
        payload: {
          reportId: args.reportId,
          reason: args.reason,
        },
      });
      logEvent({
        severity: 'info',
        function: 'triageOrphanReport',
        event: 'triage.archive.applied',
        uid: actorUid,
        extra: { reportId: args.reportId },
      });
      return { ok: true, action: 'ARCHIVE', reportId: args.reportId };
    }
  }
}

export const triageOrphanReport = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('triageOrphanReport', triageOrphanReportHandler),
);
