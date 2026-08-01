import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { db } from './firestoreAdmin';
import type { AuditEvent } from './auditEvents';
import type { ActorRole, Severity } from './schema';

/**
 * Canonical audit writer. As of 2026-05-19 writes to `activity_log`
 * (was `auditLog`) and uses SCREAMING_SNAKE_CASE for the `actionType`
 * field. The doc shape mirrors AuntieOS Android
 * data/admin/AdminModels.kt:ActivityLogEntry so a single Firestore doc
 * renders identically across Android admin, Web admin, and Functions
 * writers.
 *
 * As of 2026-05-26 every entry is sealed into a SHA-256 hash chain to
 * close C-A from the 2026-05-20 adversarial review. Firestore rules deny
 * update/delete on `activity_log/{id}`, but Firebase Admin SDK bypasses
 * those rules. The chain provides tamper-EVIDENCE at the application
 * layer: each entry binds the prior `entryHash` + monotonic `seq` + a
 * canonical hash of its own fields. Mutating, deleting, or backdating any
 * entry breaks the chain at that point and every entry after it.
 *
 * Chain state lives in `activity_log_chain_head/current` (a single doc
 * holding the latest `lastHash`, `seq`, and `lastEntryId`). Every write
 * runs inside a Firestore transaction so concurrent emitters serialise
 * onto the same chain without forks.
 *
 * Canonical fields (read by admin UIs):
 *   - timestamp        ISO-8601 (Android keeps it as a String)
 *   - actionType       SCREAMING_SNAKE
 *   - description      Human-readable summary
 *   - status           SUCCESS | FAILURE | PENDING
 *   - actorId          uid of acting principal (or '' system)
 *   - targetId         optional target doc id
 *   - targetCollection optional target collection name
 *
 * Functions-only fields retained for forensic value (not read by mobile/web
 * admin lists, surfaced in detail views):
 *   - severity, actorRole, familyId, payload, requestId, clientRequestId,
 *     ip, userAgent, createdAt (server ts)
 *
 * Chain fields (added 2026-05-26):
 *   - seq              monotonic 1-indexed sequence number
 *   - prevHash         entryHash of prior entry (or GENESIS_PREV_HASH for #1)
 *   - entryHash        SHA-256(canonicalHashInput(seq, prevHash, hashableDoc))
 */
export interface WriteAuditArgs {
  event: AuditEvent;
  severity: Severity;
  actorRole: ActorRole;
  actorUid?: string;
  targetUid?: string;
  targetCollection?: string;
  familyId?: string;
  description?: string;
  /**
   * Required, deliberately not defaulted. `severity` and `status` answer
   * different questions: severity says how loudly this entry deserves
   * review (info/warn/critical); status says what actually happened
   * (SUCCESS/FAILURE/PENDING). A sensitive action can succeed and still be
   * `critical` (e.g. AUTH_RECOVERY_TRIGGERED); a routine action can fail and
   * still be `warn` (e.g. ERROR_FUNCTION_FAILURE). Guessing one from the
   * other produced two real bugs found in the 2026-08 A4 audit: a warn-level
   * function failure silently recorded as SUCCESS (wrapCallable.ts), and a
   * critical-level successful recovery/rollback silently recorded as
   * FAILURE (executePrimaryRecovery.ts, migrateFoundationV1Rollback.ts).
   * Every call site must say which one happened.
   */
  status: 'SUCCESS' | 'FAILURE' | 'PENDING';
  payload?: Record<string, unknown>;
  requestId?: string;
  clientRequestId?: string;
  ip?: string;
  userAgent?: string;
}

export const CHAIN_HEAD_COLLECTION = 'activity_log_chain_head';
export const CHAIN_HEAD_DOC_ID = 'current';
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Build a deterministic JSON representation for hashing. Sorts keys,
 * drops `undefined`, drops the Firestore server-timestamp sentinel
 * (which resolves server-side and would differ across tx retries).
 */
/**
 * Recursively sort object keys (and walk arrays) so the JSON is canonical at
 * every depth, not just the top level. Without this, a nested map like
 * `payload` is serialized in insertion order at write but Firestore returns its
 * keys in a different order on read, so re-verification of any entry whose
 * nested keys weren't already alphabetical (e.g. payload `{reportId, reason}`)
 * fails with a false `entry_hash_mismatch`. Sorting deeply makes write-time and
 * read-time serialization always agree.
 */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).filter((k) => src[k] !== undefined).sort()) {
      out[k] = sortDeep(src[k]);
    }
    return out;
  }
  return v;
}

export function canonicalHashInput(
  seq: number,
  prevHash: string,
  hashableDoc: Record<string, unknown>,
): string {
  return JSON.stringify({ seq, prevHash, doc: sortDeep(hashableDoc) });
}

export function computeEntryHash(
  seq: number,
  prevHash: string,
  hashableDoc: Record<string, unknown>,
): string {
  return createHash('sha256').update(canonicalHashInput(seq, prevHash, hashableDoc)).digest('hex');
}

export async function writeAuditEntry(args: WriteAuditArgs): Promise<string> {
  const status = args.status;
  // Default human-readable description when caller didn't supply one.
  // Keeps the admin list readable without forcing every emit site to spell
  // it out: e.g. "AUTH_LOGIN_SUCCESS for uid abc" is fine fallback.
  const description = args.description ?? buildDefaultDescription(args);

  // Hash-input must be deterministic across Firestore tx retries. Compute
  // ISO timestamp + everything besides the server-timestamp sentinel + the
  // chain fields outside the tx callback. Capturing the closure variable
  // means retries re-use the same object.
  const hashableDoc: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    actionType: args.event,
    description,
    status,
    actorId: args.actorUid ?? '',
    targetId: args.targetUid ?? '',
    targetCollection: args.targetCollection ?? '',
    severity: args.severity,
    actorRole: args.actorRole,
    ...(args.actorUid && { actorUid: args.actorUid }),
    ...(args.targetUid && { targetUid: args.targetUid }),
    ...(args.familyId && { familyId: args.familyId }),
    payload: args.payload ?? {},
    ...(args.requestId && { requestId: args.requestId }),
    ...(args.clientRequestId && { clientRequestId: args.clientRequestId }),
    ...(args.ip && { ip: args.ip }),
    ...(args.userAgent && { userAgent: args.userAgent }),
  };

  const id = await db().runTransaction(async (tx) => {
    const headRef = db().collection(CHAIN_HEAD_COLLECTION).doc(CHAIN_HEAD_DOC_ID);
    const headSnap = await tx.get(headRef);
    const headData = headSnap.exists ? (headSnap.data() as ChainHeadDoc | undefined) : undefined;
    const prevSeq = typeof headData?.seq === 'number' ? headData.seq : 0;
    const prevHash =
      typeof headData?.lastHash === 'string' && headData.lastHash.length === 64
        ? headData.lastHash
        : GENESIS_PREV_HASH;
    const seq = prevSeq + 1;
    const entryHash = computeEntryHash(seq, prevHash, hashableDoc);

    const logRef = db().collection('activity_log').doc();
    const fullDoc = {
      ...hashableDoc,
      seq,
      prevHash,
      entryHash,
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.set(logRef, fullDoc);
    tx.set(headRef, {
      seq,
      lastHash: entryHash,
      lastEntryId: logRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return logRef.id;
  });

  return id;
}

interface ChainHeadDoc {
  seq?: number;
  lastHash?: string;
  lastEntryId?: string;
}

function buildDefaultDescription(args: WriteAuditArgs): string {
  const who = args.actorUid ? ` uid=${args.actorUid}` : '';
  const target = args.targetUid ? ` target=${args.targetUid}` : '';
  return `${args.event}${who}${target}`.trim();
}
