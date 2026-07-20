import type { Timestamp } from 'firebase/firestore';
import { dayKey, formatWhen, machineWhen, type FsTime } from './time';
import type { KinTaleComment } from '../api/kinTaleDetail';

/**
 * Pure KinTale DETAIL (single report + comment thread + reactions) formatting
 * helpers, kept out of `screens/KinTaleDetail.tsx` so the mapping logic has
 * direct vitest coverage (the `kinTaleFormat.ts` / `inboxFormat.ts` convention).
 */

// ── epoch-ms -> local day/time (the AO-18 fix, inboxFormat.ts#threadTimeOf's
// convention applied to THIS field's shape) ─────────────────────────────────

/**
 * Wraps a comment's `createdAtMs` epoch-ms number as a fake Firestore
 * `Timestamp` so it can flow through `lib/time.ts`'s LOCAL `dayKey`/`formatWhen`
 * unchanged, the same trick `inboxFormat.ts#threadTimeOf` /
 * `kinTaleFormat.ts#kinTaleTimeOf` each use for their own different input
 * shape (epoch-ms number vs. free-text ISO string). `null` for a missing,
 * non-finite, non-positive, or unparseable value, never a fabricated "now".
 */
export function commentTimeOf(ms: number | null): FsTime {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/** LOCAL `YYYY-MM-DD` day-grouping key for a comment, or `'Undated'`. */
export function commentDayKey(ms: number | null): string {
  return dayKey(commentTimeOf(ms));
}

/**
 * LOCAL "MM-DD HH:mm" for a comment row, or `'Date TBD'` (the `kinTaleFormat.ts#kinTaleWhen`
 * fallback text) when `createdAtMs` is missing or unparseable.
 */
export function commentWhen(ms: number | null): string {
  const formatted = formatWhen(commentTimeOf(ms));
  return formatted === '(no time)' ? 'Date TBD' : formatted;
}

/** Machine-readable local datetime for a comment's `<time dateTime={…}>` attribute. */
export function commentMachineTime(ms: number | null): string | undefined {
  return machineWhen(commentTimeOf(ms));
}

// ── author classification (positive enumeration, no negation, the AO-12 /
// sessionFormat.ts#SessionState convention) ─────────────────────────────────

/**
 * Every author role a comment can honestly report. Mirrors the two literal
 * values `addKinTaleCommentHandler` ever writes (`isStaffCaller ? 'admin' :
 * 'kinfolk'`, see `api/kinTaleDetail.ts`'s file header), plus `'unknown'` for
 * any other text, an honest bucket rather than a guessed side.
 */
export type CommentAuthorRole = 'admin' | 'kinfolk' | 'unknown';

export function commentAuthorRole(authorRole: string): CommentAuthorRole {
  switch ((authorRole ?? '').trim().toLowerCase()) {
    case 'admin':
      return 'admin';
    case 'kinfolk':
      return 'kinfolk';
    default:
      return 'unknown';
  }
}

/**
 * Friendly author label for a comment row. `'Auntie'` for staff (the same
 * fallback `api/kinTalesWrite.ts#saveKinTaleDraft` uses for a nameless admin
 * account), the real `guestName` or `'Kinfolk'` for a household reply, and
 * `'Someone'` for an unrecognized role, never a fabricated identity.
 */
export function commentAuthorLabel(comment: Pick<KinTaleComment, 'authorRole' | 'guestName'>): string {
  switch (commentAuthorRole(comment.authorRole)) {
    case 'admin':
      return 'Auntie';
    case 'kinfolk':
      return (comment.guestName ?? '').trim() || 'Kinfolk';
    case 'unknown':
      return 'Someone';
  }
}

// ── reaction summary ─────────────────────────────────────────────────────

/**
 * Honest, pluralized "who loved this" line. Ported near-verbatim from the
 * wasm `KinTaleReportScreen.kt`'s reaction summary intent ("You and 2 others
 * loved this"), but every number here comes straight from the server's own
 * `loveCount` (see `api/kinTaleDetail.ts#toggleKinTaleLove`'s doc comment: the
 * caller never re-derives the count itself).
 */
export function loveSummaryLabel(loved: boolean, loveCount: number): string {
  if (loveCount <= 0) return 'No reactions yet.';
  if (loveCount === 1) return loved ? 'You loved this.' : '1 person loved this.';
  const others = loveCount - 1;
  return loved
    ? `You and ${others} other${others === 1 ? '' : 's'} loved this.`
    : `${loveCount} people loved this.`;
}

// ── media kind classification (positive enumeration, no negation) ──────────

/**
 * Every media kind `getMyKinTaleMedia` can honestly report, from a
 * `media_files/{id}.mimeType` MIME string. `'other'` covers a `null`
 * `contentType` or anything that isn't `image/*`/`video/*`, an honest bucket
 * (a plain download link) rather than guessing a preview that might not
 * render.
 */
export type KinTaleMediaKind = 'image' | 'video' | 'other';

export function kinTaleMediaKindOf(contentType: string | null): KinTaleMediaKind {
  const ct = (contentType ?? '').trim().toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  return 'other';
}
