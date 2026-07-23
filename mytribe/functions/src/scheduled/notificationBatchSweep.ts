import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { getNotificationDef, NOTIFICATION_CATALOG } from '../notifications/catalog';

/**
 * Drains pending items from `notificationBatch/{uid}/{batchKey}/{auto}` and
 * emits one digest `notifications/{id}` per (uid, batchKey) bucket whose oldest
 * item is past its catalog `batchWindowMs`.
 *
 * PATH: this used to scan `collectionGroup('items')` ordered by `createdAtMs`,
 * describing a 5-segment layout `notificationBatch/{uid}/{batchKey}/items/{auto}`.
 * The only writer (`notifications/dispatcher.ts`, the `batched` case) writes the
 * 4-segment path above, naming the collection after the def's `batchKey`, and
 * `firestore.rules` matches that same 4-segment shape. So the scan matched
 * nothing on two independent counts: no collection is named `items`, and the
 * documents carry `createdAt` (a serverTimestamp) rather than `createdAtMs`,
 * which an `orderBy` would have dropped them for anyway. No digest has ever
 * been emitted and the item rows accumulate.
 *
 * Fixed on the sweeper side rather than the writer side: the writer agrees with
 * the deployed rules, and scanning the real path drains the existing backlog
 * instead of stranding it. The collection group is no longer a constant, so it
 * is derived from the catalog's batched defs.
 *
 * Each digest notification carries `data.items: Array<{itemId, data, createdAtMs}>`
 * so templates can render a multi-row digest. The notification key is
 * preserved from the catalog so the channel subdoc lookup still resolves the
 * right templates.
 *
 * Runs every 5 minutes. Smallest meaningful batch window in the catalog is
 * 5 min (`kintale.comment.added`), so per-minute scan is wasteful for the
 * current catalog. Tighten cadence if a future batchKey wants ≤5-min digest.
 */
const SCAN_LIMIT = 100;

interface BatchItem {
  itemId: string;
  data: Record<string, unknown>;
  createdAtMs: number;
}

interface BucketSummary {
  uid: string;
  batchKey: string;
  catalogKey: string;
  category: string;
  channels: string[];
  oldestCreatedAtMs: number;
  items: BatchItem[];
  itemRefs: FirebaseFirestore.DocumentReference[];
}

export const notificationBatchSweep = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', secrets: ['SENTRY_DSN'] },
  wrapScheduled('notificationBatchSweep', async () => {
    const now = Date.now();

    // One collection-group scan per distinct batchKey the catalog declares. The
    // batchKey IS the collection name under notificationBatch/{uid}, so there is
    // no single group id covering all of them.
    const batchKeys = [
      ...new Set(
        Object.values(NOTIFICATION_CATALOG)
          .filter((def) => def.deliveryMode === 'batched' && def.batchKey)
          .map((def) => def.batchKey as string),
      ),
    ];
    if (batchKeys.length === 0) return;

    const itemDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    for (const key of batchKeys) {
      // Order by `createdAt`, the field the dispatcher actually stamps. Ordering
      // by `createdAtMs` silently dropped every document, since Firestore
      // excludes docs missing the sort field.
      const snap = await db().collectionGroup(key).orderBy('createdAt').limit(SCAN_LIMIT).get();
      itemDocs.push(...snap.docs);
    }
    if (itemDocs.length === 0) return;

    const grouped = new Map<string, BucketSummary>();
    for (const itemDoc of itemDocs) {
      const data = itemDoc.data() as Record<string, unknown>;
      // notificationBatch/{uid}/{batchKey}/{itemId}: the item's parent is the
      // {batchKey} collection, whose parent is the {uid} doc.
      const batchKeyRef = itemDoc.ref.parent;
      const uidRef = batchKeyRef.parent;
      if (!uidRef) continue;
      if (uidRef.parent.id !== 'notificationBatch') continue;

      const uid = uidRef.id;
      const batchKey = batchKeyRef.id;
      const catalogKey = (data.key as string | undefined) ?? '';
      if (!catalogKey) continue;

      const groupId = `${uid}__${batchKey}`;
      let entry = grouped.get(groupId);
      if (!entry) {
        entry = {
          uid,
          batchKey,
          catalogKey,
          category: (data.category as string | undefined) ?? 'kintale',
          channels: (data.channels as string[] | undefined) ?? [],
          oldestCreatedAtMs: Number.MAX_SAFE_INTEGER,
          items: [],
          itemRefs: [],
        };
        grouped.set(groupId, entry);
      }
      // `createdAt` (serverTimestamp) is what the dispatcher writes; `createdAtMs`
      // is kept first for any doc written before this was corrected, and
      // createTime is the last resort so a malformed item still ages out rather
      // than pinning the bucket at `now` forever.
      const createdAt = data.createdAt as FirebaseFirestore.Timestamp | undefined;
      const createdAtMs =
        (data.createdAtMs as number | undefined)
        ?? (typeof createdAt?.toMillis === 'function' ? createdAt.toMillis() : undefined)
        ?? itemDoc.createTime?.toMillis()
        ?? now;
      entry.oldestCreatedAtMs = Math.min(entry.oldestCreatedAtMs, createdAtMs);
      entry.items.push({
        itemId: itemDoc.id,
        data: (data.data as Record<string, unknown> | undefined) ?? {},
        createdAtMs,
      });
      entry.itemRefs.push(itemDoc.ref);
    }

    let emitted = 0;
    for (const bucket of grouped.values()) {
      let windowMs: number;
      try {
        const def = getNotificationDef(bucket.catalogKey);
        if (def.deliveryMode !== 'batched') continue;
        windowMs = def.batchWindowMs ?? 5 * 60 * 1000;
      } catch {
        logEvent({
          severity: 'warn',
          function: 'notificationBatchSweep',
          event: 'batch.unknown.key',
          extra: { catalogKey: bucket.catalogKey, uid: bucket.uid },
        });
        continue;
      }

      if (now - bucket.oldestCreatedAtMs < windowMs) continue;

      try {
        await db().runTransaction(async (tx) => {
          for (const ref of bucket.itemRefs) {
            const fresh = await tx.get(ref);
            if (fresh.exists) tx.delete(ref);
          }
          const newRef = db().collection('notifications').doc();
          tx.set(newRef, {
            key: bucket.catalogKey,
            category: bucket.category,
            recipientUid: bucket.uid,
            actorUid: null,
            data: {
              items: bucket.items.map((i) => ({ itemId: i.itemId, ...i.data, createdAtMs: i.createdAtMs })),
              itemCount: bucket.items.length,
              batchKey: bucket.batchKey,
              windowMs,
            },
            channels: bucket.channels,
            status: 'pending',
            mode: 'batched-promoted',
            originBatchKey: bucket.batchKey,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        emitted += 1;
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'notificationBatchSweep',
          event: 'batch.promote.failed',
          extra: {
            uid: bucket.uid,
            batchKey: bucket.batchKey,
            error: (err as Error)?.message,
          },
        });
      }
    }

    logEvent({
      severity: 'info',
      function: 'notificationBatchSweep',
      event: 'batch.sweep.complete',
      extra: { scannedItems: itemDocs.length, bucketsFlushed: emitted, batchKeys },
    });
  }),
);
