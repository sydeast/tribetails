import type { DeleteKinResult, KinRemovalRequestDto } from '../api/types';

/**
 * #1408. What the foot of Kin Edit offers for taking a Kin off the profile,
 * decided from the one `deleteKin` read the screen already makes (#1314):
 *
 *  - `delete`:   nothing on file, so the household deletes it itself.
 *  - `request`:  history on file and no open request, so the household asks
 *                the office (a declined request comes back here, with its note).
 *  - `pending`:  a request is waiting on the office; nothing to tap.
 *
 * `archived` never reaches this screen: an archived Kin is off the roster.
 */
export type KinRemovalOption =
  | { kind: 'delete' }
  | { kind: 'request'; declined: KinRemovalRequestDto | null }
  | { kind: 'pending'; request: KinRemovalRequestDto };

export function kinRemovalOption(result: DeleteKinResult): KinRemovalOption {
  if (result.canDelete) return { kind: 'delete' };
  const request = result.removalRequest ?? null;
  if (request?.status === 'pending') return { kind: 'pending', request };
  return { kind: 'request', declined: request?.status === 'declined' ? request : null };
}

/** "Nov 2, 2026", the date the household asked or the office answered. Same on Android. */
export function formatRemovalDate(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
