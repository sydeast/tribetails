import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { promoteQueuedNotification } from '../notifications/promoteQueued';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { getNotificationDef, NOTIFICATION_CATALOG } from '../notifications/catalog';
import { householdNoticeLine, householdNoticeTarget } from '../notifications/buildNotificationDetail';
import { FULL_CPU_SERIAL, SCHEDULE_RETRY_FREQUENT } from '../lib/runtimeOptions';

/**
 * Drains pending items from `notificationBatch/{uid}/{batchKey}/{itemId}` and
 * emits one digest `notifications/{id}` per (uid, batchKey) bucket whose oldest
 * item is past its catalog `batchWindowMs`.
 *
 * ── WHY THE PATH IS 4 SEGMENTS, AND WHY THERE IS NO INDEX ──────────────────
 *
 * Two earlier versions of this sweep read a layout that does not exist.
 *
 * The 2026-05-10 original scanned `collectionGroup('items')` ordered by
 * `createdAtMs`, and its docstring named a 5-segment path
 * `notificationBatch/{uid}/{batchKey}/items/{auto}`. A Firestore document path
 * has an EVEN segment count, so that path can never hold a document: the
 * layout it described was never writable and was never written. Its parent
 * walk (`ref.parent.parent`, then `.parent.parent`) implies a 6-segment path
 * with an unnamed container collection, which appears in no comment, no rule
 * and no data. There is no recoverable `items` design to restore.
 *
 * On 2026-05-15 a COLLECTION_GROUP override for `items`.`createdAtMs` was
 * deployed after the sweep threw `FAILED_PRECONDITION` 950x. That silenced the
 * error by making a query over a nonexistent collection group succeed and
 * return zero rows. The override is a fossil of the broken query, not evidence
 * of a storage design: it is the only COLLECTION_GROUP index in the project
 * with no live query behind it, and its entry lists the three default
 * single-field configs verbatim plus one added group scope, which is what the
 * console emits when a field's scope is widened from an error link.
 *
 * The 4-segment path is what three independent live artifacts agree on: the
 * writer (`notifications/dispatcher.ts`, the `batched` case), `firestore.rules`
 * (`match /notificationBatch/{uid}/{batchKey}/{id}`, written 2026-05-11 against
 * the real writer), and the rows already in production. So the writer was never
 * the bug, and the path stays as it is.
 *
 * The 2026-07-23 fix scanned the right path but ordered by a field:
 * `collectionGroup(batchKey).orderBy('createdAt')`. Firestore auto-creates
 * single-field indexes at COLLECTION scope only, so a group-scoped `orderBy`
 * needs an explicit index per batchKey. None exists for `kintale-comments`,
 * and the sweep threw `FAILED_PRECONDITION` every 5 minutes. Adding that index
 * would also have left a trap: every future batchKey silently reintroduces the
 * same crash until someone remembers to deploy another one.
 *
 * So the scan orders by `documentId()` through `paginateQuery`, the same
 * index-free idiom `kincareReminderCron` has run hourly in production since
 * WARNING-25. An unfiltered `collectionGroup().orderBy(documentId())` uses only
 * the automatic index, so NO index config is required for any batchKey, now or
 * later. Document-id order is not time order, which does not matter here: the
 * scan drains the whole group rather than taking a `.limit()` window, and each
 * bucket's age is computed in memory from the stamped `createdAt` over the
 * complete set. Ordering is restored by sorting before the digest is built.
 *
 * ── DRAIN ──────────────────────────────────────────────────────────────────
 *
 * Every row written since 2026-05-10 is already at the scanned path, so the
 * accumulated backlog drains on the next run with no migration. A bucket
 * larger than MAX_ITEMS_PER_DIGEST is promoted oldest-first across successive
 * runs instead of in one transaction, so a months-deep backlog cannot exceed
 * the per-transaction write limit and stall the bucket permanently.
 *
 * Each digest notification carries `data.items: Array<{itemId, data, createdAtMs}>`
 * so templates can render a multi-row digest. The notification key is preserved
 * from the catalog so the channel subdoc lookup still resolves the right
 * templates.
 *
 * Runs every 5 minutes. Smallest meaningful batch window in the catalog is
 * 5 min (`kintale.comment.added`), so a per-minute scan is wasteful for the
 * current catalog. Tighten cadence if a future batchKey wants a <=5-min digest.
 */

/** Root collection every batch item lives under. Also the parent-walk sentinel. */
export const NOTIFICATION_BATCH_ROOT = 'notificationBatch';

/** Docs per page in the paginated drain. Must exceed a test fixture's row count. */
const PAGE_SIZE = 500;

/**
 * Ceiling of PAGE_SIZE * SAFETY_MAX_PAGES = 10k items held in memory per run.
 * paginateQuery logs CRITICAL when it stops here, so the cap is never silent;
 * the next run 5 minutes later resumes, because promoted items are deleted.
 */
const SAFETY_MAX_PAGES = 20;

/**
 * Items folded into one digest, and deletes in one transaction (+1 for the
 * digest write), kept under the 500-write transaction limit. A bucket holding
 * more drains oldest-first over successive runs.
 */
const MAX_ITEMS_PER_DIGEST = 400;

interface BatchItem {
  itemId: string;
  data: Record<string, unknown>;
  createdAtMs: number;
  ref: FirebaseFirestore.DocumentReference;
}

interface BucketSummary {
  uid: string;
  batchKey: string;
  catalogKey: string;
  category: string;
  channels: string[];
  /**
   * #2093: the words the dispatcher stored on the queued row, which are
   * already this recipient's own (the household's title on a household copy).
   * '' on a row queued before rows carried them; the digest then reads the def.
   */
  title: string;
  description: string;
  /**
   * #1898: the stream the queued row was written for ('kinfolk' for a
   * household's copy). '' on a row queued before rows carried it.
   */
  stream: string;
  items: BatchItem[];
}

/**
 * The distinct `batchKey` values the catalog declares, which are also the
 * collection-group ids to scan: the dispatcher names the collection under
 * `notificationBatch/{uid}` after the def's batchKey. Today that is exactly
 * ['kintale-comments']. Exported so a test can assert the scan targets are
 * derived from the catalog rather than hardcoded.
 */
export function batchedCollectionGroupIds(): string[] {
  return [
    ...new Set(
      Object.values(NOTIFICATION_CATALOG)
        .filter((def) => def.deliveryMode === 'batched' && def.batchKey)
        .map((def) => def.batchKey as string),
    ),
  ];
}

/**
 * Maps an item ref at `notificationBatch/{uid}/{batchKey}/{itemId}` to its
 * bucket. Returns null for anything outside `notificationBatch`, which is the
 * guard that keeps a same-named collection group elsewhere in the database out
 * of the sweep. Exported for testing.
 */
export function resolveBatchBucket(
  ref: FirebaseFirestore.DocumentReference,
): { uid: string; batchKey: string } | null {
  const batchKeyCol = ref.parent; // the {batchKey} collection
  const uidRef = batchKeyCol?.parent; // the notificationBatch/{uid} doc
  if (!uidRef) return null;
  if (uidRef.parent?.id !== NOTIFICATION_BATCH_ROOT) return null;
  const uid = uidRef.id;
  const batchKey = batchKeyCol.id;
  if (!uid || !batchKey) return null;
  return { uid, batchKey };
}

/**
 * Age of one item, in ms. `createdAt` (a serverTimestamp) is what the
 * dispatcher stamps on every queue doc and is therefore the primary source. `createdAtMs`
 * is read first only so a doc carrying one is still honored, and `createTime`
 * is the last resort so a malformed item ages out rather than pinning its
 * bucket at `now` forever. Exported for testing.
 */
export function resolveItemCreatedAtMs(
  data: Record<string, unknown>,
  snap: { createTime?: FirebaseFirestore.Timestamp },
  now: number,
): number {
  const createdAt = data.createdAt as FirebaseFirestore.Timestamp | undefined;
  return (
    (data.createdAtMs as number | undefined)
    ?? (typeof createdAt?.toMillis === 'function' ? createdAt.toMillis() : undefined)
    ?? snap.createTime?.toMillis()
    ?? now
  );
}

/**
 * One sweep pass. Exported so tests drive it directly; `now` is injectable so
 * batch-window expiry is testable without faking timers.
 */
export async function runNotificationBatchSweep(
  now: number = Date.now(),
): Promise<{ scanned: number; emitted: number; batchKeys: string[] }> {
  const batchKeys = batchedCollectionGroupIds();
  if (batchKeys.length === 0) return { scanned: 0, emitted: 0, batchKeys };

  const grouped = new Map<string, BucketSummary>();
  let scanned = 0;

  for (const batchKey of batchKeys) {
    await paginateQuery(
      db().collectionGroup(batchKey),
      (itemDoc) => {
        scanned += 1;
        const bucket = resolveBatchBucket(itemDoc.ref);
        if (!bucket) return;

        const data = itemDoc.data() as Record<string, unknown>;
        const catalogKey = (data.key as string | undefined) ?? '';
        if (!catalogKey) return;

        const groupId = `${bucket.uid}__${bucket.batchKey}`;
        let entry = grouped.get(groupId);
        if (!entry) {
          entry = {
            uid: bucket.uid,
            batchKey: bucket.batchKey,
            catalogKey,
            category: (data.category as string | undefined) ?? 'kintale',
            channels: (data.channels as string[] | undefined) ?? [],
            title: typeof data.title === 'string' ? data.title.trim() : '',
            description: typeof data.description === 'string' ? data.description.trim() : '',
            stream: typeof data.stream === 'string' ? data.stream : '',
            items: [],
          };
          grouped.set(groupId, entry);
        }
        entry.items.push({
          itemId: itemDoc.id,
          data: (data.data as Record<string, unknown> | undefined) ?? {},
          createdAtMs: resolveItemCreatedAtMs(data, itemDoc, now),
          ref: itemDoc.ref,
        });
      },
      {
        pageSize: PAGE_SIZE,
        safetyMaxPages: SAFETY_MAX_PAGES,
        functionName: 'notificationBatchSweep',
      },
    );
  }

  let emitted = 0;
  for (const bucket of grouped.values()) {
    let windowMs: number;
    // Held past the try so the digest can take its human title/description from
    // the same def that declared the batch window.
    let digestDef: ReturnType<typeof getNotificationDef>;
    try {
      const def = getNotificationDef(bucket.catalogKey);
      if (def.deliveryMode !== 'batched') continue;
      windowMs = def.batchWindowMs ?? 5 * 60 * 1000;
      digestDef = def;
    } catch {
      logEvent({
        severity: 'warn',
        function: 'notificationBatchSweep',
        event: 'batch.unknown.key',
        extra: { catalogKey: bucket.catalogKey, uid: bucket.uid },
      });
      continue;
    }

    // Document-id scan order is not time order, so restore it here: the oldest
    // item decides whether the window has elapsed, and the digest renders its
    // rows chronologically.
    bucket.items.sort((a, b) => a.createdAtMs - b.createdAtMs);
    if (now - bucket.items[0].createdAtMs < windowMs) continue;

    const chunk = bucket.items.slice(0, MAX_ITEMS_PER_DIGEST);
    const deferred = bucket.items.length - chunk.length;

    const items = chunk.map((i) => ({ itemId: i.itemId, ...i.data, createdAtMs: i.createdAtMs }));
    // #1898: the ids every item shares, lifted to the top, where the enricher
    // reads them: the household (so the email and push name its Kin instead
    // of rendering "on 's KinTale") and the tale, when there is one.
    const shared = (field: string): Record<string, string> => {
      const values = [...new Set(items.map((i) => (i as Record<string, unknown>)[field]))];
      return values.length === 1 && typeof values[0] === 'string' && values[0] !== '' ? { [field]: values[0] } : {};
    };
    const digestData = {
      ...shared('kinfolkId'),
      ...shared('taleId'),
      ...shared('taleTitle'),
      items,
      itemCount: chunk.length,
      batchKey: bucket.batchKey,
      windowMs,
    };
    // #1898: a household's digest says who commented on which KinTale, and
    // opens that tale (or the KinTales list when the comments span several).
    // The office's copy keeps its own words, and opens the tale when there is one.
    // A row queued before rows carried `stream` is the household's when it
    // carries the household's title (#2093 put it there).
    const household =
      bucket.stream === 'kinfolk' ||
      (bucket.stream === '' && bucket.title !== '' && bucket.title === digestDef.householdTitle?.trim());
    const noticeRow = { key: bucket.catalogKey, recipientUid: bucket.uid, data: digestData };
    const target = householdNoticeTarget(noticeRow);
    const description = household
      ? householdNoticeLine(noticeRow)
      : bucket.description || digestDef.description;
    // The office's copy is left as it was: its clients never had a target for it.
    const householdFields = household
      ? { householdLine: description, targetType: target.targetType, targetId: target.targetId }
      : {};
    try {
      await db().runTransaction(async (tx) => {
        // Deletes only, no reads: deleting an already-deleted doc is a no-op,
        // and a read-per-ref would blow the transaction deadline at this chunk
        // size for no guarantee (the digest write is unconditional either way).
        for (const item of chunk) tx.delete(item.ref);
        // A digest's human content is the words its queued rows carry: the
        // dispatcher wrote them per recipient, so a household's digest reads
        // the household's title (#2093), never the operator's label. A row
        // queued before rows carried words falls back to the catalog def that
        // declared the batch. Before either, the card rendered the bare key.
        promoteQueuedNotification(
          tx,
          {
            key: bucket.catalogKey,
            category: bucket.category,
            recipientUid: bucket.uid,
            actorUid: null,
            title: bucket.title || digestDef.label,
            description,
            channels: bucket.channels,
            ...householdFields,
          },
          {
            mode: 'batched-promoted',
            origin: { originBatchKey: bucket.batchKey },
            overrides: { data: digestData },
          },
        );
      });
      emitted += 1;
      if (deferred > 0) {
        logEvent({
          severity: 'info',
          function: 'notificationBatchSweep',
          event: 'batch.promote.chunked',
          extra: {
            uid: bucket.uid,
            batchKey: bucket.batchKey,
            promoted: chunk.length,
            deferred,
            note: 'bucket larger than MAX_ITEMS_PER_DIGEST; remainder drains next run',
          },
        });
      }
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
    extra: { scannedItems: scanned, bucketsFlushed: emitted, batchKeys },
  });

  return { scanned, emitted, batchKeys };
}

export const notificationBatchSweep = onSchedule(
  // Assembles and dispatches batched digests inside the default 60s timeout.
  // See notificationDebounceSweep.
  {
    schedule: 'every 5 minutes',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
    ...SCHEDULE_RETRY_FREQUENT,
  },
  wrapScheduled('notificationBatchSweep', async () => {
    await runNotificationBatchSweep(Date.now());
  }),
);
