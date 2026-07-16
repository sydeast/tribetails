import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { getNotificationDef } from '../notifications/catalog';

/**
 * Drains pending items from `notificationBatch/{uid}/{batchKey}/items/{auto}`
 * and emits one digest `notifications/{id}` per (uid, batchKey) bucket whose
 * oldest item is past its catalog `batchWindowMs`.
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

    const buckets = await db().collectionGroup('items').orderBy('createdAtMs').limit(SCAN_LIMIT).get();
    if (buckets.empty) return;

    const grouped = new Map<string, BucketSummary>();
    for (const itemDoc of buckets.docs) {
      const data = itemDoc.data() as Record<string, unknown>;
      const itemsRef = itemDoc.ref;
      const batchKeyRef = itemsRef.parent.parent;
      const uidRef = batchKeyRef?.parent.parent;
      if (!batchKeyRef || !uidRef) continue;
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
      const createdAtMs = (data.createdAtMs as number | undefined) ?? itemDoc.createTime?.toMillis() ?? now;
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
      extra: { scannedItems: buckets.size, bucketsFlushed: emitted },
    });
  }),
);
