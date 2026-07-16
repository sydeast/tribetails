import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { db } from '../lib/firestoreAdmin';

type CommentDoc = {
  authorUid?: string;
  authorRole?: string;
  body?: string;
};

/**
 * Watches `kin_care_reports/{reportId}/comments/{commentId}`.
 * Reads kinfolkId from the parent report doc (it's not a path param).
 */
export async function onKinTaleCommentCreateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const commentId = event.params.commentId as string;
  const comment = event.data?.data() as CommentDoc | undefined;
  if (!comment) return;

  const reportSnap = await db().doc(`kin_care_reports/${reportId}`).get();
  const kinfolkId = (reportSnap.data() as { kinfolkId?: string } | undefined)?.kinfolkId;
  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCommentCreate',
      event: 'trigger.comment.missing_kinfolk_id',
      extra: { reportId, commentId },
    });
    return;
  }

  const recipientUid = await resolveKinfolkUid(kinfolkId);
  try {
    await enqueueNotification({
      key: 'kintale.comment.added',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId,
        taleId: reportId,
        commentId,
        authorUid: comment.authorUid ?? null,
        authorRole: comment.authorRole ?? null,
        preview: (comment.body ?? '').slice(0, 200),
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleCommentCreate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, taleId: reportId, commentId, err: (err as Error)?.message },
    });
  }
}

export const onKinTaleCommentCreate = onDocumentCreated(
  {
    document: 'kin_care_reports/{reportId}/comments/{commentId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleCommentCreate', onKinTaleCommentCreateHandler),
);
