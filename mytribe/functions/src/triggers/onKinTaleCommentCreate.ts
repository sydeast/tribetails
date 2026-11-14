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
  /** A guest's name, sanitized on write (`public/addGuestKinTaleComment.ts`). */
  guestName?: string | null;
};
function textOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
/**
 * #1898: who wrote the comment, the way the household's thread names them
 * (`portal/getKinTaleComments.ts`): a guest by the name they typed, an Auntie
 * as "Auntie" and her staff name, a household member by first name. '' when
 * nothing names them; the notice then counts the comments instead. Never an
 * email: a stored name that is really an email address leaves the author
 * unnamed.
 */
export async function commentAuthorName(kinfolkId: string, comment: CommentDoc): Promise<string> {
  const guest = textOf(comment.guestName);
  if (guest) return guest;
  const uid = textOf(comment.authorUid);
  if (!uid) return '';
  try {
    if (comment.authorRole === 'admin') {
      const name = textOf((await db().doc(`staff/${uid}`).get()).data()?.displayName);
      // A staff name that is really an email is not a name (#2030).
      if (!name || name.includes('@')) return '';
      return /^auntie\b/i.test(name) ? name : `Auntie ${name}`;
    }
    const [member, client] = await db().getAll(
      db().doc(`families/${kinfolkId}/members/${uid}`),
      db().doc(`clients/${uid}`),
    );
    const name = textOf(member?.data()?.displayName) || textOf(client?.data()?.displayName);
    const first = name.split(/\s+/)[0] ?? '';
    return first.includes('@') ? '' : first;
  } catch {
    return '';
  }
}

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
  const report = reportSnap.data() as { kinfolkId?: string; title?: unknown } | undefined;
  const kinfolkId = report?.kinfolkId;
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
        // #1898: what the household's notice names: who wrote it, on which tale.
        authorName: await commentAuthorName(kinfolkId, comment),
        taleTitle: textOf(report?.title),
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
