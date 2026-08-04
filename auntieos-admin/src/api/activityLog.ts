import { call } from '../lib/fns';
import { type CollectionSpec } from '../lib/firestore';

/**
 * One `activity_log` row (mirrors the wasm ActivityLogEntry).
 *
 * Every document field is optional because this interface is a CAST over raw
 * Firestore data, not a validation of it. Writers across three platforms and
 * several schema generations have produced rows missing any of these keys, and
 * a `.slice()` or `.toUpperCase()` on an absent one throws into React's error
 * boundary and blanks the whole screen. Read them with a default at the point
 * of use (see lib/coerce). `_id` stays required: useCollection always sets it.
 */
export interface ActivityLogEntry {
  _id: string;
  timestamp?: string | undefined; // ISO-8601 (chained rows are always ISO; see ACTIVITY_LOG_QUERY)
  actionType?: string | undefined; // LOGIN | CREATE_BOOKING | UPDATE_SETTINGS | …
  description?: string | undefined;
  status?: string | undefined; // SUCCESS | FAILURE | PENDING | ERROR
  actorId?: string | undefined;
  targetId?: string | undefined;
  targetCollection?: string | undefined;
  seq?: number; // hash-chain sequence; absent on legacy pre-chain rows
  prevHash?: string | undefined;
  entryHash?: string | undefined;
  /**
   * THE FORENSIC FIELDS, and they were the operator's complaint about this
   * screen: "the Activity Log is seriously lacking, cant see shit or what the
   * fuck actually happened."
   *
   * `writeAuditEntry` has written every one of these on every entry since
   * 2026-05-19. Its own docstring calls them "Functions-only fields retained
   * for forensic value (not read by mobile/web admin lists, surfaced in detail
   * views)", and there was no detail view, so nothing ever surfaced them. The
   * row rendered actionType, description, actor and target and stopped, which is
   * why a NOTIFICATION_RECEIVED entry could say "Notification X delivered via
   * email" and be unable to tell you to whom, over which provider, or with what
   * message id, all three of which were sitting in `payload` on the same
   * document.
   *
   * `payload` is `unknown` on purpose: it is per-event-type and has no schema,
   * so any narrower promise here would be one nothing keeps. Read it through
   * `activityPayloadRows` (lib/activityDetail.ts), which flattens it defensively.
   */
  payload?: unknown;
  severity?: string | undefined; // info | warn | critical
  actorRole?: string | undefined; // SYSTEM | PRIMARY | AUNTIE | …
  familyId?: string | undefined;
  requestId?: string | undefined;
  clientRequestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * The bounded, server-ordered activity-log listener. Ordered by `seq` (the
 * hash-chain sequence, the canonical audit order the backend itself walks in
 * verifyActivityLogChain) descending, capped at 200. Legacy rows without `seq`
 * are excluded server-side by the orderBy (Firestore drops docs missing the sort
 * field), which is correct: they predate the integrity chain, and it means this
 * query never returns the mixed-timestamp-type rows (AO-37 is designed out here).
 * This is the AO-29 fix expressed as a spec, not a client-side cap.
 */
export const ACTIVITY_LOG_QUERY: CollectionSpec = {
  path: 'activity_log',
  order: ['seq', 'desc'],
  max: 200,
};

/**
 * The first offending entry when the chain fails verification. Mirrors the
 * backend union verbatim (verifyActivityLogChain.ts), note `head_mismatch`
 * carries no entryId/seq, so the screen must branch on `code`.
 */
export type VerifyAnomaly =
  | { code: 'prev_hash_mismatch'; entryId: string; seq: number; expectedPrevHash: string; actualPrevHash: string }
  | { code: 'entry_hash_mismatch'; entryId: string; seq: number; expectedEntryHash: string; actualEntryHash: string }
  | { code: 'seq_gap'; entryId: string; seq: number; expectedSeq: number }
  | { code: 'head_mismatch'; headLastHash: string; observedLastHash: string; headSeq: number; observedSeq: number };

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
