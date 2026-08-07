import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { claimKinTalePublish, clientAlreadyAnnouncedSend } from '../lib/kinTalePublishClaim';
import { seedReconcileStatus } from '../lib/reconcileStatus';
import { maintainThumbs, TaleThumb } from '../lib/kinTaleThumbs';

type KinCareReportDoc = {
  kinfolkId?: string;
  authorDisplayName?: string;
  bodyCopy?: string;
  status?: string;
  sentVia?: string;
  mediaFileIds?: string[];
  thumbs?: TaleThumb[];
};

/**
 * Watches `kin_care_reports/{reportId}` (canonical KinTale collection).
 * kinfolkId is a field on the doc, not a path parameter.
 *
 * Announces `kintale.published` only for a report created ALREADY SENT (seeds,
 * imports, any future straight-to-send writer). Both admin clients create a
 * DRAFT first and flip it later, and a draft is invisible to the household —
 * until 2026-07 this trigger fired on that draft create, so every household was
 * alerted the moment an Auntie started typing and handed a link to a report it
 * could not open. The send itself is announced by `onKinTaleUpdate` on the
 * DRAFT → SENT transition.
 */
export async function onKinTaleCreateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const report = event.data?.data() as KinCareReportDoc | undefined;

  // Denormalized feed thumbnails (task-24a): stamp `thumbs` from
  // `mediaFileIds` at create time so `getMyKinTales` never resolves media
  // docs on the hot path. Runs before the SENT gate below — both admin
  // clients create a DRAFT first, and its photos need thumbs just as much as
  // a straight-to-SENT create's do. Best-effort like the reconcile enrolment
  // below: a stamping failure is worth a log, not a blocked announcement.
  if (report) {
    try {
      await maintainThumbs(db(), db().doc(`kin_care_reports/${reportId}`), undefined, report);
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'onKinTaleCreate',
        event: 'trigger.thumbs.stamp_failed',
        extra: { reportId, err: (err as Error)?.message },
      });
    }
  }

  // Enrol the report in the reconcile pipeline. Runs BEFORE the draft return
  // below, because a draft is the normal create and still has to reconcile;
  // gating it on SENT would leave the common case out. Never blocks the
  // announcement: a report that fails to enrol is worth a log, not a silent
  // kinfolk notification failure.
  try {
    const outcome = await seedReconcileStatus(reportId);
    logEvent({
      severity: 'info',
      function: 'onKinTaleCreate',
      event: `trigger.reconcile.${outcome}`,
      extra: { reportId },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCreate',
      event: 'trigger.reconcile.seed_failed',
      extra: { reportId, err: (err as Error)?.message },
    });
  }

  // Not household-visible yet. A DRAFT create is the normal case for both admin
  // clients and must stay silent.
  if (report?.status !== 'SENT') {
    logEvent({
      severity: 'info',
      function: 'onKinTaleCreate',
      event: 'trigger.kintale.skipped.not_sent',
      extra: { reportId, status: report?.status ?? null },
    });
    return;
  }

  // The publishing client already announced this send through the catalog.
  if (clientAlreadyAnnouncedSend(report.sentVia)) {
    logEvent({
      severity: 'info',
      function: 'onKinTaleCreate',
      event: 'trigger.kintale.skipped.client_dispatched',
      extra: { reportId, sentVia: report.sentVia },
    });
    return;
  }

  const kinfolkId = report.kinfolkId;
  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCreate',
      event: 'trigger.kintale.missing_kinfolk_id',
      extra: { reportId },
    });
    return;
  }

  if (!(await claimKinTalePublish(reportId))) {
    logEvent({
      severity: 'info',
      function: 'onKinTaleCreate',
      event: 'trigger.kintale.skipped.already_published',
      extra: { reportId },
    });
    return;
  }

  const recipientUid = await resolveKinfolkUid(kinfolkId);
  try {
    await enqueueNotification({
      key: 'kintale.published',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId,
        taleId: reportId,
        authorDisplayName: report.authorDisplayName ?? null,
      },
      targetType: 'kintale',
      targetId: reportId,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCreate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, taleId: reportId, err: (err as Error)?.message },
    });
  }
}

export const onKinTaleCreate = onDocumentCreated(
  {
    document: 'kin_care_reports/{reportId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleCreate', onKinTaleCreateHandler),
);
