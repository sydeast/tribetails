import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { resolveActor, type ResolvedActor } from '../lib/resolveActor';
import { buildNotificationDetail } from './buildNotificationDetail';
import { getNotificationDef } from './catalog';
import { loadBusinessOverride, loadUserPrefs, resolveChannels, streamForRecipient } from './prefs';
import { resolveRecipients } from './recipientResolver';
import type {
  AudienceStream,
  Channel,
  EnqueueArgs,
  NotificationDef,
  NotificationTargetType,
  ResolvedChannels,
} from './types';

const ALL_CHANNELS: Channel[] = ['email', 'sms', 'push'];

/**
 * The work-order collection. `notificationDispatch/{id}` is id-matched to
 * `notifications/{id}` and holds every field the delivery pipeline needs:
 * mode, channel list, dispatch status, and the per-channel subdocs beneath it.
 *
 * IT USED TO BE THE SAME DOCUMENT, and that was the defect behind operator
 * ruling R5. `notifications/{id}` is mail: it is what an operator or a kinfolk
 * reads and acts on. The dispatch record is plumbing: which transports were
 * chosen, whether the fan-out ran, what the provider said. Both were written to
 * the inbox doc, so the Notifications screen rendered "trigger", "channels:
 * email, sms" and "dispatched" as primary card content, and both admin clients
 * put a "Dispatched" counter in the stat strip. The operator's words: "there are
 * many Activity Log records and workflow (Channels, trigger, and dispatched are
 * activity log not notification) in Notifications."
 *
 * The record of what the pipeline DID is not lost by moving it here, it is
 * promoted: `onNotificationDispatchCreate` writes NOTIFICATION_DISPATCHED and
 * `onNotificationChannelCreate` writes NOTIFICATION_RECEIVED, both into the
 * hash-chained `activity_log`, which is where the operator said this belongs and
 * where the second of those two already went.
 */
export const DISPATCH_COLLECTION = 'notificationDispatch';

/**
 * Resolves the originating entity (targetType + targetId) for a dispatch so the
 * notification doc carries a deep-link reference for open-linked + quick
 * approve/deny in the client.
 *
 * Precedence:
 *   1. Explicit args.targetType / args.targetId from a caller that knows the
 *      entity (booking confirm/request, invoice issued, kintale).
 *   2. Derived from well-known id keys in `args.data` so existing callers that
 *      already thread these ids get a target ref for free.
 *   3. '' for both when nothing is resolvable (always-safe default; never throws).
 */
function resolveTargetRef(args: EnqueueArgs): {
  targetType: NotificationTargetType;
  targetId: string;
} {
  const explicitType = args.targetType;
  const explicitId = typeof args.targetId === 'string' ? args.targetId : '';
  if (explicitType && explicitId !== '') {
    return { targetType: explicitType, targetId: explicitId };
  }

  const data = args.data ?? {};
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '');

  // Ordered most-specific first. Booking/invoice/kintale are actionable entities;
  // kinfolk is the catch-all household reference.
  const invoiceId = str(data.invoiceId);
  if (invoiceId) return { targetType: 'invoice', targetId: invoiceId };

  const taleId = str(data.taleId) || str(data.reportId);
  if (taleId) return { targetType: 'kintale', targetId: taleId };

  const bookingId = str(data.bookingId) || str(data.visitId) || str(data.batchId);
  if (bookingId) return { targetType: 'booking', targetId: bookingId };

  const kinfolkId = str(data.kinfolkId) || str(data.familyId);
  if (kinfolkId) return { targetType: 'kinfolk', targetId: kinfolkId };

  return { targetType: '', targetId: '' };
}

/**
 * Single entrypoint for emitting any auto-notification.
 *
 * Behavior by deliveryMode:
 *   trigger   → writes notifications/{auto} → onCreate trigger fans out to channel subdocs
 *   debounced → writes pendingNotifications/{uid}_{key}; bumps fireAfter on collision
 *   batched   → appends to notificationBatch/{uid}/{batchKey}/{auto}
 *   scheduled → writes scheduledNotifications/{auto} with fireAt
 *
 * Caller responsibilities:
 *   - Provide recipientUid for specificUid/kinfolkAcct resolvers.
 *   - Provide args.data.assignedAuntieUid for auntieAssignedToKincare resolver.
 *   - Provide fireAtMs for 'scheduled' mode (defaults to "now" if omitted, logs warning).
 *
 * Returns the list of dispatch document IDs written (one per recipient).
 * Empty array = all recipients had every channel suppressed by prefs.
 */
export async function enqueueNotification(args: EnqueueArgs): Promise<string[]> {
  const def = getNotificationDef(args.key);

  // External keys are delivered by another system (e.g., Firebase Auth Console
  // sends password.reset emails). The catalog row exists for documentation /
  // cross-reference only, short-circuit before resolver/channel fan-out.
  if (def.external === true) {
    logEvent({
      severity: 'info',
      function: 'enqueueNotification',
      event: 'notification.external.skipped',
      extra: {
        key: def.key,
        message: `[external] skipping ${def.key}, delivered by external system`,
      },
    });
    return [];
  }

  const tryResolve = async (resolver?: typeof def.recipientResolver) => {
    try {
      return await resolveRecipients(def, args, resolver);
    } catch (err) {
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'resolver.skipped',
        extra: {
          key: def.key,
          resolver: resolver ?? def.recipientResolver,
          err: (err as Error)?.message,
        },
      });
      return [];
    }
  };
  const primary = await tryResolve();
  const secondary = def.secondaryResolver ? await tryResolve(def.secondaryResolver) : [];
  if (primary.length === 0 && secondary.length === 0) {
    throw new Error(
      `enqueueNotification(${def.key}): no recipients resolved from any resolver`,
    );
  }
  const seen = new Set<string>();
  const recipients = [...primary, ...secondary].filter((r) => {
    if (seen.has(r.uid)) return false;
    seen.add(r.uid);
    return true;
  });

  // AO-28: resolve the actor's name + photo ONCE (not per recipient) so every
  // written NotificationEntry can render who caused it with an avatar.
  const actor = await resolveActor(args.actorUid);

  const writtenIds: string[] = [];
  for (const recipient of recipients) {
    const [userPrefs, businessOverride] = await Promise.all([
      loadUserPrefs(recipient.uid, recipient.collection),
      loadBusinessOverride(def.key),
    ]);
    // Audience revamp 2026-07: each copy gates through its own stream view
    // (clients -> kinfolk; staff -> staff when the key serves staff, else business).
    // The same per-copy answer also decides what the card detail may say, so it
    // is resolved once here and threaded down rather than re-derived (#380).
    const stream = streamForRecipient(def, recipient.collection);
    const channels = resolveChannels(def, userPrefs, businessOverride, stream);

    if (!hasAnyChannel(channels)) {
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'notification.suppressed',
        uid: recipient.uid,
        extra: { key: def.key, reason: 'no-channels-after-prefs' },
      });
      continue;
    }

    const id = await routeByDeliveryMode(def, args, recipient.uid, channels, actor, stream);
    if (id) writtenIds.push(id);
  }

  return writtenIds;
}

function hasAnyChannel(c: ResolvedChannels): boolean {
  return c.email || c.sms || c.push;
}

function activeChannelList(c: ResolvedChannels): Channel[] {
  return ALL_CHANNELS.filter((ch) => c[ch]);
}

async function routeByDeliveryMode(
  def: NotificationDef,
  args: EnqueueArgs,
  recipientUid: string,
  channels: ResolvedChannels,
  actor: ResolvedActor,
  stream: AudienceStream,
): Promise<string | null> {
  const { targetType, targetId } = resolveTargetRef(args);
  // R5: the entity detail the CARD renders, resolved server-side once, here.
  // Every value in it (household, pets, service, date, time, notes, amount) was
  // already being computed downstream for outbound templates and thrown away;
  // see buildNotificationDetail's docstring for the full accounting.
  //
  // `stream` is what keeps staff-only fields off a household's copy (#380). It
  // is per-copy, not per-key: `kincare.changed` writes one copy to the operator
  // and one to the kinfolk, and only the operator's may carry the booking notes.
  const detail = await buildNotificationDetail(
    def.key,
    recipientUid,
    args.data,
    actor.actorName,
    stream,
  );

  /**
   * THE INBOX CONTENT, and nothing else. No `status`, no `mode`, no `channels`:
   * those describe the delivery pipeline and now live on the work-order doc
   * (see DISPATCH_COLLECTION above). Typed loosely rather than as
   * `NotificationDoc` because `createdAt` is a FieldValue sentinel here and a
   * Timestamp on read, which no single interface can honestly say.
   */
  const content = {
    key: def.key,
    category: def.category,
    recipientUid,
    actorUid: args.actorUid ?? null,
    // AO-28: human-renderable content on the entry itself (title + description
    // from the catalog def) + the resolved actor identity, so a client renders
    // "<title> — <actorName>" with an avatar instead of a bare key.
    title: def.label,
    description: def.description,
    actorName: actor.actorName,
    actorPhotoUrl: actor.actorPhotoUrl,
    data: args.data,
    // Omitted entirely when nothing resolved, so a client can distinguish
    // "no detail available" from "detail with every field blank".
    ...(detail ? { detail } : {}),
    // Deep-link reference for open-linked + quick approve/deny. Always present
    // (additive; '' when no entity is resolvable) so the client can branch on it.
    targetType,
    targetId,
    createdAt: FieldValue.serverTimestamp(),
  };

  const activeChannels = activeChannelList(channels);

  /**
   * The queue documents (`pendingNotifications`, `notificationBatch`,
   * `scheduledNotifications`) are workflow records in their own right: nothing
   * reads them as an inbox, and a sweep promotes them into a real notification
   * later. So they legitimately carry `status`/`mode`/`channels` alongside the
   * content the sweep will hand on. This is the base for all three.
   */
  const queueDoc = { ...content, channels: activeChannels };

  switch (def.deliveryMode) {
    case 'trigger': {
      const ref = db().collection('notifications').doc();
      await ref.set(content);
      // The work order goes SECOND and under the same id. Its onCreate trigger
      // fans out to channel subdocs, and that trigger reads the notification it
      // is delivering, so the mail must exist before the postman is called.
      await db().collection(DISPATCH_COLLECTION).doc(ref.id).set({
        notificationId: ref.id,
        key: def.key,
        recipientUid,
        data: args.data,
        mode: 'trigger',
        channels: activeChannels,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
      });
      return ref.id;
    }

    case 'debounced': {
      const docId = `${recipientUid}_${def.key}`;
      const fireAfterMs = Date.now() + (def.debounceMs ?? 30 * 60 * 1000);
      const ref = db().collection('pendingNotifications').doc(docId);
      await ref.set(
        {
          ...queueDoc,
          status: 'pending',
          mode: 'debounced',
          debounceStrategy: def.debounceStrategy ?? 'snapshot',
          fireAfterMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return ref.id;
    }

    case 'batched': {
      if (!def.batchKey) {
        throw new Error(`catalog(${def.key}): batched mode requires batchKey`);
      }
      // PATH CONTRACT. 4 segments: notificationBatch/{uid}/{batchKey}/{auto}.
      // Do not add an `items` level. Handoff notes from 2026-05-10 and this
      // file's own docstring long claimed `.../{batchKey}/items/{auto}`, which
      // is 5 segments and therefore not a document path Firestore can hold; it
      // was never written. Two consumers are pinned to the shape below:
      // `firestore.rules` (`match /notificationBatch/{uid}/{batchKey}/{id}`)
      // and `scheduled/notificationBatchSweep.ts`, whose parent walk reads uid
      // and batchKey straight off these segments. Changing the depth here
      // breaks both and strands every row already written.
      //
      // `queueDoc.createdAt` (serverTimestamp) is the item's age field. The
      // sweep sorts on it in memory rather than in the query, so no
      // COLLECTION_GROUP index is needed for this or any future batchKey; see
      // the sweep's docstring. Renaming or dropping it silently ages every
      // item off `createTime` instead.
      const ref = db()
        .collection('notificationBatch')
        .doc(recipientUid)
        .collection(def.batchKey)
        .doc();
      await ref.set({ ...queueDoc, status: 'pending', mode: 'batched' });
      return ref.id;
    }

    case 'scheduled': {
      const fireAtMs = args.fireAtMs ?? Date.now();
      if (!args.fireAtMs) {
        logEvent({
          severity: 'warn',
          function: 'enqueueNotification',
          event: 'notification.scheduled.missing-fireAt',
          uid: recipientUid,
          extra: { key: def.key, fallbackFireAtMs: fireAtMs },
        });
      }
      const ref = db().collection('scheduledNotifications').doc();
      await ref.set({ ...queueDoc, status: 'pending', mode: 'scheduled', fireAtMs });
      return ref.id;
    }

    default: {
      const exhaustive: never = def.deliveryMode;
      throw new Error(`enqueueNotification(${def.key}): unknown deliveryMode '${String(exhaustive)}'`);
    }
  }
}
