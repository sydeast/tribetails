import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { wrapScheduled } from '../lib/wrapScheduled';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { sanitizePlainText } from '../lib/richText';
import { anthropicClient } from '../lib/aiCopy';
import { AI_BATCHES_COLLECTION, TALES_COLLECTION } from '../admin/aiBackfillTaleTitles';

/**
 * O-8 bulk-job collector: polls Anthropic message batches created by
 * aiBackfillTaleTitles and applies finished results.
 *
 * Batches usually finish within an hour (hard max 24h), so a 15-minute poll
 * is plenty. Each processing `ai_batches` doc is checked; when its batch has
 * ended, every succeeded result writes a title onto its tale, guarded by a
 * transaction that re-checks the title is STILL empty (an auntie may have
 * hand-titled the tale while the batch ran; the human always wins).
 */

const MAX_BATCHES_PER_RUN = 10;
export const MAX_TITLE_CHARS = 80;
/**
 * Anthropic batches hard-expire at 24h; anything still not 'ended' well past
 * that is wedged (deleted batch, API change, bad id). Marked 'stale' so it
 * stops being re-polled forever.
 */
export const BATCH_STALE_MS = 26 * 60 * 60 * 1000;

interface ApplyCounts {
  applied: number;
  skippedTitled: number;
  skippedMissing: number;
  errored: number;
}

/** Normalizes a model title result: plain text, single line, hard cap. */
export function normalizeTitle(raw: string): string {
  const flat = sanitizePlainText(raw).replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”.]+$/g, '');
  return flat.length > MAX_TITLE_CHARS ? flat.slice(0, MAX_TITLE_CHARS).trim() : flat;
}

async function applyTitle(taleId: string, title: string): Promise<'applied' | 'skippedTitled' | 'skippedMissing'> {
  const ref = db().collection(TALES_COLLECTION).doc(taleId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'skippedMissing';
    const existing = (snap.data() as Record<string, unknown>)['title'];
    if (typeof existing === 'string' && existing.trim().length > 0) return 'skippedTitled';
    tx.update(ref, {
      title,
      titleGeneratedByAi: true,
      titleGeneratedAtMs: Date.now(),
    });
    return 'applied';
  });
}

export async function runAiBatchPoll(): Promise<void> {
  const pending = await db()
    .collection(AI_BATCHES_COLLECTION)
    .where('status', '==', 'processing')
    .limit(MAX_BATCHES_PER_RUN)
    .get();
  if (pending.empty) return;

  const client = anthropicClient();

  for (const doc of pending.docs) {
    const batchId = doc.id;
    // Per-batch isolation (review finding 1): one broken batch must never
    // wedge the cron — the unguarded path would rethrow out of the loop,
    // leave every doc 'processing', and re-fail identically every 15 min.
    try {
      await pollOneBatch(client, doc, batchId);
    } catch (err) {
      logEvent({
        severity: 'error',
        function: 'aiBatchPollCron',
        event: 'batch.poll.failed',
        errorMessage: `${batchId}: ${(err as Error)?.message}`,
      });
      // Stale escape hatch: stop re-polling batches that can no longer finish.
      const createdAtMs = (doc.data() as Record<string, unknown>)['createdAtMs'];
      if (typeof createdAtMs === 'number' && Date.now() - createdAtMs > BATCH_STALE_MS) {
        await doc.ref
          .update({ status: 'stale', staleAtMs: Date.now(), lastError: (err as Error)?.message ?? 'unknown' })
          .catch(() => undefined);
      }
    }
  }
}

async function pollOneBatch(
  client: ReturnType<typeof anthropicClient>,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  batchId: string,
): Promise<void> {
  const batch = await client.messages.batches.retrieve(batchId);
  if (batch.processing_status !== 'ended') {
    // Not done yet is normal inside the first day; past the stale window it
    // never will be — close it out so the queue can't clog.
    const createdAtMs = (doc.data() as Record<string, unknown>)['createdAtMs'];
    if (typeof createdAtMs === 'number' && Date.now() - createdAtMs > BATCH_STALE_MS) {
      await doc.ref.update({ status: 'stale', staleAtMs: Date.now() });
    }
    return;
  }

  const counts: ApplyCounts = { applied: 0, skippedTitled: 0, skippedMissing: 0, errored: 0 };
  for await (const result of await client.messages.batches.results(batchId)) {
    const taleId = result.custom_id;
    if (result.result.type !== 'succeeded') {
      counts.errored += 1;
      continue;
    }
    const text = result.result.message.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const title = normalizeTitle(text);
    if (title.length === 0) {
      counts.errored += 1;
      continue;
    }
    try {
      counts[await applyTitle(taleId, title)] += 1;
    } catch (err) {
      counts.errored += 1;
      logEvent({
        severity: 'warn',
        function: 'aiBatchPollCron',
        event: 'title.apply.failed',
        errorMessage: `${taleId}: ${(err as Error)?.message}`,
      });
    }
  }

  await doc.ref.update({ status: 'done', completedAtMs: Date.now(), counts: { ...counts } });

  await writeAuditEntry({
    event: AUDIT_EVENTS.AI_TALE_TITLES_APPLIED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: 'system:aiBatchPollCron',
    targetCollection: TALES_COLLECTION,
    description: `AI tale titles applied from batch ${batchId} (${counts.applied} applied, ${counts.skippedTitled + counts.skippedMissing} skipped, ${counts.errored} errored)`,
    payload: { batchId, ...counts },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'aiBatchPollCron',
      event: 'audit.write.failed',
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'aiBatchPollCron',
    event: 'batch.completed',
    extra: { batchId, ...counts },
  });
}

export const aiBatchPollCron = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'America/New_York',
    secrets: ['SENTRY_DSN', 'ANTHROPIC_API_KEY'],
  },
  wrapScheduled('aiBatchPollCron', async () => {
    await runAiBatchPoll();
  }),
);
