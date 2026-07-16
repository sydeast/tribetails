import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';

/**
 * Debounce window. Multiple rapid writes inside this window (e.g. backfill,
 * reconcile) count as a single semantic edit and trigger only one notification.
 */
const NOTIFY_DEBOUNCE_MS = 60 * 1000;

/** Stable digest of the kinfolk-visible payload so we can detect a NEW edit
 *  vs a re-emission of the same content (idempotency for triggers). */
function notifyDigest(bodyCopy: string, mediaIds: string[]): string {
  const sortedMedia = [...mediaIds].sort().join(',');
  return `${bodyCopy.length}|${sortedMedia}`;
}

type KinCareReportDoc = {
  kinfolkId?: string;
  authorDisplayName?: string;
  authorId?: string;
  bodyCopy?: string;
  mediaFileIds?: string[];
  status?: string;
};

/**
 * Fires `kintale.note.added` when an already-SENT KinTale gets edited with
 * more body text or additional media (e.g. 12hr boarding visit where auntie
 * posts arrival, midway, and end-of-visit updates to the same report).
 *
 * Skip cases:
 *  - DRAFT updates (no kinfolk-visible state yet, they only see SENT)
 *  - Initial DRAFT → SENT transition (covered by `kintale.published`)
 *  - Status-only flips, triage updates, field-response edits without body/media growth
 */
export async function onKinTaleUpdateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const before = event.data?.before?.data() as KinCareReportDoc | undefined;
  const after = event.data?.after?.data() as KinCareReportDoc | undefined;
  if (!before || !after) return;

  // Only fire for post-publish edits. Skip DRAFT-side updates entirely.
  if (before.status !== 'SENT' || after.status !== 'SENT') return;

  const bodyChanged = (before.bodyCopy ?? '') !== (after.bodyCopy ?? '');
  const beforeMediaCount = Array.isArray(before.mediaFileIds) ? before.mediaFileIds.length : 0;
  const afterMediaCount = Array.isArray(after.mediaFileIds) ? after.mediaFileIds.length : 0;
  const mediaAdded = afterMediaCount > beforeMediaCount;

  if (!bodyChanged && !mediaAdded) return;

  // Idempotency guard: skip if we already notified for this exact content
  // within the debounce window. Tracker lives in a parallel collection so
  // writing the high-water mark does NOT re-trigger this onDocumentUpdated
  // (which would loop). Survives backfill/reconcile rewrites that re-stamp
  // mediaFileIds without semantic change.
  const trackerRef = db().doc(`kinTaleNotifications/${reportId}`);
  const trackerSnap = await trackerRef.get();
  const tracker = trackerSnap.data() as
    | { lastNotifiedAtMs?: number; lastDigest?: string }
    | undefined;
  const afterDigest = notifyDigest(after.bodyCopy ?? '', after.mediaFileIds ?? []);
  const nowMs = Date.now();
  if (tracker?.lastDigest === afterDigest) {
    logEvent({
      severity: 'info',
      function: 'onKinTaleUpdate',
      event: 'trigger.note.skipped.duplicate',
      extra: { reportId, digest: afterDigest },
    });
    return;
  }
  if (
    tracker?.lastNotifiedAtMs &&
    nowMs - tracker.lastNotifiedAtMs < NOTIFY_DEBOUNCE_MS
  ) {
    logEvent({
      severity: 'info',
      function: 'onKinTaleUpdate',
      event: 'trigger.note.skipped.debounce',
      extra: {
        reportId,
        msSinceLast: nowMs - tracker.lastNotifiedAtMs,
        debounceMs: NOTIFY_DEBOUNCE_MS,
      },
    });
    return;
  }

  const kinfolkId = after.kinfolkId;
  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'trigger.note.missing_kinfolk_id',
      extra: { reportId },
    });
    return;
  }

  const recipientUid = await resolveKinfolkUid(kinfolkId);
  try {
    await enqueueNotification({
      key: 'kintale.note.added',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId,
        taleId: reportId,
        authorDisplayName: after.authorDisplayName ?? null,
        bodyChanged,
        mediaAdded,
        addedMediaCount: afterMediaCount - beforeMediaCount,
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, taleId: reportId, err: (err as Error)?.message },
    });
  }

  await writeAuditEntry({
    event: AUDIT_EVENTS.CONTENT_KINTALE_NOTE_ADDED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: after.authorId ?? '',
    targetUid: reportId,
    targetCollection: 'kin_care_reports',
    description: 'Auntie added a note to a sent KinTale',
    payload: {
      kinfolkId,
      taleId: reportId,
      bodyChanged,
      mediaAdded,
      addedMediaCount: afterMediaCount - beforeMediaCount,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'audit.write.failed',
      extra: { reportId, err: (err as Error)?.message },
    });
  });

  // Stamp HWM. Failure here is tolerable, worst case is one duplicate
  // notification on the next write (debounce will still trip).
  await trackerRef.set(
    {
      lastNotifiedAtMs: nowMs,
      lastDigest: afterDigest,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  ).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'hwm.stamp.failed',
      extra: { reportId, err: (err as Error)?.message },
    });
  });
}

export const onKinTaleUpdate = onDocumentUpdated(
  {
    document: 'kin_care_reports/{reportId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleUpdate', onKinTaleUpdateHandler),
);
