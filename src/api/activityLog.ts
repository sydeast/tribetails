import { call } from '../lib/fns';
import { type CollectionSpec } from '../lib/firestore';

/** One `activity_log` row (mirrors the wasm ActivityLogEntry). */
export interface ActivityLogEntry {
  _id: string;
  timestamp: string; // ISO-8601 (some legacy rows store a Firestore Timestamp — see the screen's warning)
  actionType: string; // LOGIN | CREATE_BOOKING | UPDATE_SETTINGS | …
  description: string;
  status: string; // SUCCESS | FAILURE | PENDING
  actorId: string;
  targetId: string;
  targetCollection: string;
  seq?: number; // hash-chain sequence; absent on legacy pre-chain rows
  prevHash: string;
  entryHash: string;
}

/**
 * The bounded, server-ordered activity-log listener. Ordered by `seq` (the
 * hash-chain sequence — the canonical audit order the backend itself uses in
 * verifyActivityLogChain) descending, capped at 200. Legacy rows without `seq`
 * fall outside this chained view, which is correct: they predate the integrity
 * chain. This is the AO-29 fix expressed as a spec, not a client-side cap.
 */
export const ACTIVITY_LOG_QUERY: CollectionSpec = {
  path: 'activity_log',
  order: ['seq', 'desc'],
  max: 200,
};

/** The first offending entry when the chain fails verification. */
export interface VerifyAnomaly {
  code: string; // seq_gap | hash_mismatch | …
  entryId: string;
  seq: number;
  expectedSeq?: number;
}

export type VerifyResult =
  | { ok: true; scanned: number; firstSeq: number | null; lastSeq: number | null; unchainedCount: number }
  | { ok: false; scanned: number; anomaly: VerifyAnomaly };

/**
 * verifyActivityLogChain (admin): walks the SHA-256 hash chain server-side and
 * returns a verdict. `ok: true` = no anomaly in the scanned range.
 */
export async function verifyActivityLogChain(): Promise<VerifyResult> {
  return call<Record<string, never>, VerifyResult>('verifyActivityLogChain', {});
}
