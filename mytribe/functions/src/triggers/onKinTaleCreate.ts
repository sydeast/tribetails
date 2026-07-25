import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { claimKinTalePublish, clientAlreadyAnnouncedSend } from '../lib/kinTalePublishClaim';

type KinCareReportDoc = {
  kinfolkId?: string;
  authorDisplayName?: string;
  bodyCopy?: string;
  status?: string;
  sentVia?: string;
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
