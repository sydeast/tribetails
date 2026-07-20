import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import {
  CHAIN_HEAD_COLLECTION,
  CHAIN_HEAD_DOC_ID,
  GENESIS_PREV_HASH,
  computeEntryHash,
} from '../lib/writeAuditEntry';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Admin callable that walks the `activity_log` hash chain and reports any
 * tampering. Pairs with the 2026-05-26 write-time chain in writeAuditEntry
 * to close C-A from the 2026-05-20 adversarial review.
 *
 * Three classes of breakage detected:
 *   1. `prev_hash_mismatch`, entry N+1's prevHash doesn't equal entry N's
 *      entryHash (someone modified/deleted/inserted an entry).
 *   2. `entry_hash_mismatch`, recomputing the canonical hash of an entry's
 *      hashable fields produces a different value than the stored entryHash
 *      (someone modified fields in place).
 *   3. `seq_gap`, sequence numbers skip (entry was deleted) or repeat
 *      (chain forked, concurrent writer outside the transaction).
 *
 * Default mode walks the full chain. `since` argument allows incremental
 * audits (e.g., nightly cron only re-verifies recent entries). The head
 * pointer is also cross-checked.
 *
 * Result `ok: true` means no anomaly found in the scanned range. Any
 * anomaly returns `ok: false` + the first offending entry id + a code.
 */

const Args = z.object({
  /** Restrict scan to entries with seq >= this value. Default: 1 (full scan). */
  since: z.number().int().positive().optional(),
  /** Hard cap on entries scanned per invocation. Default 5000. */
  limit: z.number().int().positive().max(50000).optional(),
});

export type VerifyAnomaly =
  | {
      code: 'prev_hash_mismatch';
      entryId: string;
      seq: number;
      expectedPrevHash: string;
      actualPrevHash: string;
    }
  | {
      code: 'entry_hash_mismatch';
      entryId: string;
      seq: number;
      expectedEntryHash: string;
      actualEntryHash: string;
    }
  | {
      code: 'seq_gap';
      entryId: string;
      seq: number;
      expectedSeq: number;
    }
  | {
      code: 'head_mismatch';
      headLastHash: string;
      observedLastHash: string;
      headSeq: number;
      observedSeq: number;
    };

export type VerifyResult =
  | {
      ok: true;
      scanned: number;
      firstSeq: number | null;
      lastSeq: number | null;
      /** activity_log docs lacking chain fields (client-direct legacy writes). */
      unchainedCount: number;
    }
  | { ok: false; scanned: number; anomaly: VerifyAnomaly };

const HASHABLE_FIELDS_OMIT = new Set(['seq', 'prevHash', 'entryHash', 'createdAt']);

function extractHashableFields(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (HASHABLE_FIELDS_OMIT.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function verifyActivityLogChainHandler(
  req: CallableRequest<unknown>,
): Promise<VerifyResult> {
  const parsed = Args.safeParse(req.data ?? {});
  const since = parsed.success && parsed.data.since !== undefined ? parsed.data.since : 1;
  const limit = parsed.success && parsed.data.limit !== undefined ? parsed.data.limit : 5000;

  let query = db().collection('activity_log').orderBy('seq', 'asc');
  if (since > 1) query = query.where('seq', '>=', since);
  query = query.limit(limit);

  const snap = await query.get();

  // Coverage counter: total docs in activity_log vs entries in the chain.
  // Client-direct writers (AuntieOS Android `AuntieRepository.logActivity`,
  // AuntieOS Web `jsAddDoc("activity_log", ...)`) currently bypass
  // writeAuditEntry, those entries lack `seq` and are invisible to the
  // `.orderBy('seq')` query above. Surface the count so operators can plan
  // migration to a server-side callable.
  let unchainedCount = 0;
  try {
    const totalSnap = await db().collection('activity_log').count().get();
    const totalDocs = totalSnap.data().count;
    unchainedCount = Math.max(0, totalDocs - snap.size);
  } catch {
    // count() unavailable (older emulator): leave unchainedCount=0; not fatal.
  }

  if (snap.empty) {
    // Empty chain is valid (no chain-bearing writes yet). Still report
    // unchainedCount so operators see legacy client writes.
    return { ok: true, scanned: 0, firstSeq: null, lastSeq: null, unchainedCount };
  }

  // Walk entries in seq order. First entry's expected prevHash is GENESIS
  // for a from-scratch scan; for incremental scans (since > 1) we read the
  // entry at `since - 1` to seed expectedPrevHash.
  let expectedPrevHash = GENESIS_PREV_HASH;
  let expectedSeq = since;
  if (since > 1) {
    const seedSnap = await db()
      .collection('activity_log')
      .where('seq', '==', since - 1)
      .limit(1)
      .get();
    if (!seedSnap.empty) {
      const seed = seedSnap.docs[0].data() as Record<string, unknown>;
      expectedPrevHash =
        typeof seed.entryHash === 'string' ? (seed.entryHash as string) : GENESIS_PREV_HASH;
    }
  }

  let scanned = 0;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;

  for (const docSnap of snap.docs) {
    scanned += 1;
    const data = docSnap.data() as Record<string, unknown>;
    const entryId = docSnap.id;
    const seq = typeof data.seq === 'number' ? (data.seq as number) : -1;
    const prevHash = typeof data.prevHash === 'string' ? (data.prevHash as string) : '';
    const entryHash = typeof data.entryHash === 'string' ? (data.entryHash as string) : '';

    if (firstSeq === null) firstSeq = seq;
    lastSeq = seq;

    if (seq !== expectedSeq) {
      return {
        ok: false,
        scanned,
        anomaly: { code: 'seq_gap', entryId, seq, expectedSeq },
      };
    }
    if (prevHash !== expectedPrevHash) {
      return {
        ok: false,
        scanned,
        anomaly: {
          code: 'prev_hash_mismatch',
          entryId,
          seq,
          expectedPrevHash,
          actualPrevHash: prevHash,
        },
      };
    }
    const hashable = extractHashableFields(data);
    const recomputed = computeEntryHash(seq, prevHash, hashable);
    if (recomputed !== entryHash) {
      return {
        ok: false,
        scanned,
        anomaly: {
          code: 'entry_hash_mismatch',
          entryId,
          seq,
          expectedEntryHash: recomputed,
          actualEntryHash: entryHash,
        },
      };
    }
    expectedPrevHash = entryHash;
    expectedSeq = seq + 1;
  }

  // Head cross-check: if we scanned to the end (snap.size < limit means we
  // exhausted the query), the chain head pointer should match the last
  // observed entry.
  if (snap.size < limit) {
    const headSnap = await db()
      .collection(CHAIN_HEAD_COLLECTION)
      .doc(CHAIN_HEAD_DOC_ID)
      .get();
    if (headSnap.exists) {
      const headData = headSnap.data() as Record<string, unknown>;
      const headSeq = typeof headData.seq === 'number' ? (headData.seq as number) : -1;
      const headLastHash =
        typeof headData.lastHash === 'string' ? (headData.lastHash as string) : '';
      if (headSeq !== lastSeq || headLastHash !== expectedPrevHash) {
        return {
          ok: false,
          scanned,
          anomaly: {
            code: 'head_mismatch',
            headLastHash,
            observedLastHash: expectedPrevHash,
            headSeq,
            observedSeq: lastSeq ?? -1,
          },
        };
      }
    }
  }

  logEvent({
    severity: 'info',
    function: 'verifyActivityLogChain',
    event: 'chain.verify.ok',
    extra: { scanned, firstSeq, lastSeq, unchainedCount },
  });
  return { ok: true, scanned, firstSeq, lastSeq, unchainedCount };
}

export const verifyActivityLogChain = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('verifyActivityLogChain', verifyActivityLogChainHandler),
);
