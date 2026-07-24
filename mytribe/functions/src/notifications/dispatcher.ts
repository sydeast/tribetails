import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { resolveActor, type ResolvedActor } from '../lib/resolveActor';
import { getNotificationDef } from './catalog';
import { loadBusinessOverride, loadUserPrefs, resolveChannels, streamForRecipient } from './prefs';
import { resolveRecipients } from './recipientResolver';
import type {
  Channel,
  EnqueueArgs,
  NotificationDef,
  NotificationTargetType,
  ResolvedChannels,
} from './types';

const ALL_CHANNELS: Channel[] = ['email', 'sms', 'push'];

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
    const channels = resolveChannels(
      def,
      userPrefs,
      businessOverride,
      streamForRecipient(def, recipient.collection),
    );

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

    const id = await routeByDeliveryMode(def, args, recipient.uid, channels, actor);
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
): Promise<string | null> {
  const { targetType, targetId } = resolveTargetRef(args);
  const baseDoc = {
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
    channels: activeChannelList(channels),
    // Deep-link reference for open-linked + quick approve/deny. Always present
    // (additive; '' when no entity is resolvable) so the client can branch on it.
    targetType,
    targetId,
    createdAt: FieldValue.serverTimestamp(),
  };

  switch (def.deliveryMode) {
    case 'trigger': {
      const ref = db().collection('notifications').doc();
      await ref.set({ ...baseDoc, status: 'pending', mode: 'trigger' });
      return ref.id;
    }

    case 'debounced': {
      const docId = `${recipientUid}_${def.key}`;
      const fireAfterMs = Date.now() + (def.debounceMs ?? 30 * 60 * 1000);
      const ref = db().collection('pendingNotifications').doc(docId);
      await ref.set(
        {
          ...baseDoc,
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
      // `baseDoc.createdAt` (serverTimestamp) is the item's age field. The
      // sweep sorts on it in memory rather than in the query, so no
      // COLLECTION_GROUP index is needed for this or any future batchKey; see
      // the sweep's docstring. Renaming or dropping it silently ages every
      // item off `createTime` instead.
      const ref = db()
        .collection('notificationBatch')
        .doc(recipientUid)
        .collection(def.batchKey)
        .doc();
      await ref.set({ ...baseDoc, status: 'pending', mode: 'batched' });
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
      await ref.set({ ...baseDoc, status: 'pending', mode: 'scheduled', fireAtMs });
      return ref.id;
    }

    default: {
      const exhaustive: never = def.deliveryMode;
      throw new Error(`enqueueNotification(${def.key}): unknown deliveryMode '${String(exhaustive)}'`);
    }
  }
}
