import { call } from '../lib/fns';

/**
 * #1408. The office's end of a household's request to remove a Kin that has
 * history (`mytribe/functions/src/admin/kinRemovalRequests.ts`).
 *
 * A household deletes a Kin with nothing on file itself (#1314). With visits,
 * KinTales, photos or records on file it asks instead, and the office either
 * archives the Kin (both copies set to `archived`, the same status the Archive
 * control on Kin Edit writes; nothing is deleted) or declines with an optional
 * note. The household hears either answer.
 *
 * Through a callable rather than `useCollection` so the queue, the band on the
 * Kin profile and Android all read one shape, and so the archive and the
 * request's own status change land in one server transaction.
 */

export type KinRemovalStatus = 'pending' | 'archived' | 'declined';

export interface KinRemovalRequestDto {
  id: string;
  kinfolkId: string;
  /** The household's own copy, `families/{kinfolkId}/kin/{kinId}`. */
  kinId: string;
  /** The flat `kin/{id}` doc this app opens. */
  flatKinId: string | null;
  kinName: string | null;
  reason: string | null;
  status: KinRemovalStatus;
  requestedAtMs: number | null;
  resolvedAtMs: number | null;
  resolutionNote: string | null;
}

export interface ListKinRemovalRequestsArgs {
  flatKinId?: string;
  limit?: number;
}

export interface ListKinRemovalRequestsResult {
  requests: KinRemovalRequestDto[];
}

export type KinRemovalDecision = 'archive' | 'decline';

export interface ResolveKinRemovalRequestArgs {
  requestId: string;
  decision: KinRemovalDecision;
  note?: string;
}

export interface ResolveKinRemovalRequestResult {
  ok: true;
  decision: KinRemovalDecision;
  request: KinRemovalRequestDto;
  flatArchived: boolean;
  familyArchived: boolean;
  householdNotified: boolean;
}

/** Every removal request waiting on the office, oldest first; or one Kin's, by its flat id. */
export function listKinRemovalRequests(flatKinId?: string): Promise<ListKinRemovalRequestsResult> {
  const payload: ListKinRemovalRequestsArgs = flatKinId !== undefined ? { flatKinId } : {};
  return call<ListKinRemovalRequestsArgs, ListKinRemovalRequestsResult>('listKinRemovalRequests', payload);
}

/**
 * Archives the Kin or declines. Owner only: the server refuses an Auntie,
 * because archiving is destructive. An empty note is withheld from the call
 * rather than sent as `''`.
 */
export function resolveKinRemovalRequest(
  requestId: string,
  decision: KinRemovalDecision,
  note?: string,
): Promise<ResolveKinRemovalRequestResult> {
  const trimmed = note?.trim() ?? '';
  const payload: ResolveKinRemovalRequestArgs = { requestId, decision, ...(trimmed !== '' ? { note: trimmed } : {}) };
  return call<ResolveKinRemovalRequestArgs, ResolveKinRemovalRequestResult>('resolveKinRemovalRequest', payload);
}
