import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';

type KinCareReportDoc = {
  kinfolkId?: string;
  authorDisplayName?: string;
  bodyCopy?: string;
};

/**
 * Watches `kin_care_reports/{reportId}` (canonical KinTale collection).
 * kinfolkId is a field on the doc, not a path parameter.
 */
export async function onKinTaleCreateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const report = event.data?.data() as KinCareReportDoc | undefined;
  const kinfolkId = report?.kinfolkId;

  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCreate',
      event: 'trigger.kintale.missing_kinfolk_id',
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
        authorDisplayName: report?.authorDisplayName ?? null,
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
