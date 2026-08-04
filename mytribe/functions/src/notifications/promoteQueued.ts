import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { DISPATCH_COLLECTION } from './dispatcher';

/**
 * Promotes one queued notification into the pair of documents the runtime now
 * uses: the INBOX doc `notifications/{id}` and its WORK ORDER
 * `notificationDispatch/{id}`.
 *
 * ONE HELPER, THREE SWEEPS, AND THAT IS THE POINT. `notificationDebounceSweep`,
 * `notificationScheduledSweep` and `notificationBatchSweep` each built their own
 * promoted document inline, and each built a DIFFERENT one. All three copied
 * `key`, `category`, `recipientUid`, `actorUid`, `data` and `channels`, and all
 * three silently dropped `title`, `description`, `actorName`, `actorPhotoUrl`,
 * `targetType` and `targetId`, every field AO-28 and the deep-link work added to
 * make a notification renderable and clickable. So a notification that arrived
 * by the trigger path had a human title and an Open button, and the byte-identical
 * event arriving as a debounced or scheduled promotion had a bare catalog key and
 * no target at all. Nothing failed; the card was just quietly poorer, which is a
 * shape of bug that survives a green test suite indefinitely.
 *
 * With R5 splitting inbox content from delivery state there is now strictly more
 * to get right per promotion (two documents, id-matched), so the three inline
 * copies became one function and the drop-out class goes with them.
 *
 * TRANSACTIONAL BY CONTRACT. All three sweeps promote inside a transaction that
 * also deletes the queue row, so a partial failure cannot double-dispatch. This
 * takes the caller's `tx` rather than opening its own for exactly that reason.
 */

/** The inbox fields carried forward from a queued doc, all optional on the wire. */
interface QueuedNotification {
  key?: unknown;
  category?: unknown;
  recipientUid?: unknown;
  actorUid?: unknown;
  title?: unknown;
  description?: unknown;
  actorName?: unknown;
  actorPhotoUrl?: unknown;
  data?: unknown;
  detail?: unknown;
  targetType?: unknown;
  targetId?: unknown;
  channels?: unknown;
}

export interface PromoteQueuedOptions {
  /**
   * The promoted mode, stamped on the WORK ORDER only
   * ('debounced-promoted' | 'scheduled-promoted' | 'batched-promoted').
   * It never reaches the notification doc; a recipient does not care which
   * queue their mail sat in, and the Activity Log records it via the
   * NOTIFICATION_DISPATCHED entry the fan-out trigger writes.
   */
  mode: string;
  /**
   * Provenance fields for the work order (`originPendingId`,
   * `originScheduledId`, `scheduledFireAtMs`, `originBatchKey`). Kept on the
   * dispatch doc rather than the notification for the same reason as `mode`.
   */
  origin?: Record<string, unknown>;
  /**
   * Overrides applied over the queued doc's own values. The batch sweep uses
   * this: a digest's `data` is a rollup of many items and its title comes from
   * the catalog def, neither of which can be read off a single queued row.
   */
  overrides?: Partial<Record<keyof QueuedNotification, unknown>>;
}

/** A string field read defensively off a raw Firestore doc. */
function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Writes both documents inside `tx` and returns the shared id.
 *
 * The notification is written FIRST in the transaction body for readability
 * only; a transaction commits atomically, so unlike the trigger path there is no
 * ordering hazard here to guard against.
 */
export function promoteQueuedNotification(
  tx: Transaction,
  queued: QueuedNotification,
  opts: PromoteQueuedOptions,
): string {
  const o = opts.overrides ?? {};
  const pick = <K extends keyof QueuedNotification>(field: K): unknown =>
    field in o ? o[field] : queued[field];

  const notificationRef = db().collection('notifications').doc();
  const detail = pick('detail');
  const data = (pick('data') as Record<string, unknown> | undefined) ?? {};
  const channels = (pick('channels') as string[] | undefined) ?? [];
  const key = s(pick('key'));
  const recipientUid = s(pick('recipientUid'));

  tx.set(notificationRef, {
    key,
    category: s(pick('category')),
    recipientUid,
    actorUid: pick('actorUid') ?? null,
    title: s(pick('title')),
    description: s(pick('description')),
    actorName: s(pick('actorName')),
    actorPhotoUrl: s(pick('actorPhotoUrl')),
    data,
    // Absent, not blank, when the queued row carried none: see NotificationDetail.
    ...(detail && typeof detail === 'object' ? { detail } : {}),
    targetType: s(pick('targetType')),
    targetId: s(pick('targetId')),
    createdAt: FieldValue.serverTimestamp(),
  });

  tx.set(db().collection(DISPATCH_COLLECTION).doc(notificationRef.id), {
    notificationId: notificationRef.id,
    key,
    recipientUid,
    data,
    mode: opts.mode,
    channels,
    status: 'pending',
    ...(opts.origin ?? {}),
    createdAt: FieldValue.serverTimestamp(),
  });

  return notificationRef.id;
}
