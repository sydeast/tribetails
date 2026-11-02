import type { Timestamp } from 'firebase-admin/firestore';

/**
 * #1408. A household's request to remove a Kin that has history.
 *
 * #1314 lets a household delete a Kin itself only when nothing references it
 * (`portal/kinWrites.ts#findKinHistory`). When something does, the household
 * asks instead, and the office archives the Kin (every visit, invoice and tale
 * is kept) or declines. This module is the record both halves share.
 *
 * ONE DOCUMENT PER KIN, `kin_removal_requests/{kinfolkId}_{kinId}`. The id is
 * deterministic so "one open request per Kin" is a single transactional read
 * rather than a query, and so the portal finds a Kin's request with one get. A
 * new request after a decline replaces the declined one; the decision itself
 * stays in the audit log (`KIN_REMOVAL_REQUEST_RESOLVED`).
 *
 * Top level rather than under `families/{fid}` so the office's queue is a
 * plain single-field query (`status == 'pending'`) with no collection-group
 * index. `kinfolkId` on the doc is what the Firestore rule reads to let the
 * household see its own requests.
 *
 * Written ONLY by the callables (`requestKinRemoval`, `resolveKinRemovalRequest`);
 * the rule refuses every client write.
 */

export const KIN_REMOVAL_REQUESTS = 'kin_removal_requests';

export type KinRemovalStatus = 'pending' | 'archived' | 'declined';

/** The stored shape. Timestamps are server stamps. */
export interface KinRemovalRequestDoc {
  kinfolkId: string;
  /** The family doc id, `families/{kinfolkId}/kin/{kinId}`. */
  kinId: string;
  /** The AuntieOS flat mirror id, `kin/{flatKinId}`, when one is linked. */
  flatKinId: string | null;
  kinName: string | null;
  reason: string | null;
  status: KinRemovalStatus;
  /** What was on file when the household asked (visits, tales, photos, records). */
  blockedBy: string[];
  requestedByUid: string;
  requestedAt: Timestamp | null;
  resolvedByUid: string | null;
  resolvedAt: Timestamp | null;
  /** The office's optional note on a decline (or an archive). */
  resolutionNote: string | null;
}

/** What a client sees of one request. Times are epoch milliseconds. */
export interface KinRemovalRequestDto {
  id: string;
  kinfolkId: string;
  kinId: string;
  flatKinId: string | null;
  kinName: string | null;
  reason: string | null;
  status: KinRemovalStatus;
  requestedAtMs: number | null;
  resolvedAtMs: number | null;
  resolutionNote: string | null;
}

export function kinRemovalRequestId(kinfolkId: string, kinId: string): string {
  return `${kinfolkId}_${kinId}`;
}

function millis(value: unknown): number | null {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function status(value: unknown): KinRemovalStatus {
  return value === 'archived' || value === 'declined' ? value : 'pending';
}

/** Maps a stored doc to the wire shape every client reads. */
export function kinRemovalRequestDto(id: string, data: Record<string, unknown>): KinRemovalRequestDto {
  return {
    id,
    kinfolkId: str(data['kinfolkId']) ?? '',
    kinId: str(data['kinId']) ?? '',
    flatKinId: str(data['flatKinId']),
    kinName: str(data['kinName']),
    reason: str(data['reason']),
    status: status(data['status']),
    requestedAtMs: millis(data['requestedAt']),
    resolvedAtMs: millis(data['resolvedAt']),
    resolutionNote: str(data['resolutionNote']),
  };
}
