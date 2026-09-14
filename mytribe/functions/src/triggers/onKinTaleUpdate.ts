import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { contentDedupeKey, enqueueNotification } from '../notifications/dispatcher';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { claimKinTalePublish, clientAlreadyAnnouncedSend } from '../lib/kinTalePublishClaim';
import { maintainThumbs, TaleThumb } from '../lib/kinTaleThumbs';

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

/**
 * #832: the dispatcher identity of one `kintale.note.added`. Every note targets
 * the tale, so without this a second note inside the dispatcher window was
 * dropped. The body TEXT is hashed, not its length the tracker digest above
 * uses, because two different notes of the same length are two notes.
 */
export function kinTaleNoteDedupeKey(reportId: string, bodyCopy: string, mediaIds: readonly string[]): string {
  return contentDedupeKey(`kintale:${reportId}:note`, { body: bodyCopy, media: [...mediaIds].sort() });
}

type KinCareReportDoc = {
  kinfolkId?: string;
  authorDisplayName?: string;
  authorId?: string;
  bodyCopy?: string;
  mediaFileIds?: string[];
  status?: string;
  sentVia?: string;
  thumbs?: TaleThumb[];
};

/**
 * Two distinct kinfolk-facing moments live on this one collection, and a single
 * update produces at most ONE of them:
 *
 *  1. THE SEND. `status` goes DRAFT → SENT: the KinTale becomes visible to the
 *     household, and `kintale.published` announces it. This is the only place a
 *     web send is ever announced — `onKinTaleCreate` sees only a draft.
 *  2. A POST-PUBLISH NOTE. An already-SENT KinTale gains more body text or more
 *     media (e.g. a 12hr boarding visit where the auntie posts arrival, midway,
 *     and end-of-visit updates to the same report): `kintale.note.added`.
 *
 * Skip cases:
 *  - DRAFT-side updates (no kinfolk-visible state yet, they only see SENT)
 *  - An unsend, SENT → DRAFT
 *  - A send the publishing client already announced itself (see
 *    `clientAlreadyAnnouncedSend`)
 *  - Status-only flips, triage updates, field-response edits without body/media growth
 */
export async function onKinTaleUpdateHandler(event: any): Promise<void> {
  const reportId = event.params.reportId as string;
  const before = event.data?.before?.data() as KinCareReportDoc | undefined;
  const after = event.data?.after?.data() as KinCareReportDoc | undefined;
  if (!before || !after) return;

  // Denormalized feed thumbnails (task-24a): keep `thumbs` in sync with
  // `mediaFileIds` on EVERY update, not just the SENT moment — media
  // routinely gets added, removed, or reordered while a tale is still a
  // DRAFT, and thumbs has to track that. Runs before the status gates below,
  // which are notification concerns, not thumbs concerns. Best-effort: a
  // stamping failure is worth a log, not a broken send/note notification.
  // See `maintainThumbs` for why writing this field back onto this same
  // document (which re-enters this trigger) does not loop.
  try {
    await maintainThumbs(db(), db().doc(`kin_care_reports/${reportId}`), before, after);
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'trigger.thumbs.stamp_failed',
      extra: { reportId, err: (err as Error)?.message },
    });
  }

  // Nothing the household can see. Covers DRAFT → DRAFT and any unsend.
  if (after.status !== 'SENT') return;

  // THE SEND. Announce it and stop — a send is never also a "note added",
  // however much body or media the same write happened to bring with it.
  if (before.status !== 'SENT') {
    await publishKinTale(reportId, after);
    return;
  }

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
      // #832: named by the note's content, so a second note on the same tale
      // sends and a replay of this one does not.
      dedupeKey: kinTaleNoteDedupeKey(reportId, after.bodyCopy ?? '', after.mediaFileIds ?? []),
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
    status: 'SUCCESS',
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

/**
 * The DRAFT → SENT moment: the household can now open this KinTale, so tell
 * them. Silent when the publishing client already announced the send itself, or
 * when another trigger invocation has already claimed this report.
 */
async function publishKinTale(reportId: string, after: KinCareReportDoc): Promise<void> {
  if (clientAlreadyAnnouncedSend(after.sentVia)) {
    logEvent({
      severity: 'info',
      function: 'onKinTaleUpdate',
      event: 'trigger.kintale.skipped.client_dispatched',
      extra: { reportId, sentVia: after.sentVia },
    });
    return;
  }

  const kinfolkId = after.kinfolkId;
  if (!kinfolkId) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'trigger.kintale.missing_kinfolk_id',
      extra: { reportId },
    });
    return;
  }

  if (!(await claimKinTalePublish(reportId))) {
    logEvent({
      severity: 'info',
      function: 'onKinTaleUpdate',
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
        authorDisplayName: after.authorDisplayName ?? null,
      },
      targetType: 'kintale',
      targetId: reportId,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'onKinTaleUpdate',
      event: 'notification.dispatch.failed',
      extra: { kinfolkId, taleId: reportId, err: (err as Error)?.message },
    });
  }
}

export const onKinTaleUpdate = onDocumentUpdated(
  {
    document: 'kin_care_reports/{reportId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinTaleUpdate', onKinTaleUpdateHandler),
);
