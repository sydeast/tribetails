import type { Timestamp } from 'firebase/firestore';
import { dayKey, formatWhen, machineWhen, type FsTime } from './time';
import { kinTaleState } from './kinTaleFormat';
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

// ── comment threading (issue #397 S6) ────────────────────────────────────

/** One flattened thread row: the comment, plus whether it renders indented under a parent. */
export interface CommentRow {
  comment: KinTaleComment;
  isReply: boolean;
}

/**
 * Groups a flat comment list into a ONE-level thread: each top-level comment
 * (blank/absent `parentCommentId`) followed by its own direct replies, each
 * group in `createdAtMs` order.
 *
 * Ported from the two shipped implementations of the same grouping,
 * `KinTaleCommentsRepository.kt#buildCommentThread` (Android) and
 * `KinTaleReportViewModel.kt#buildCommentThread` (wasm admin), including their
 * orphan rule: a reply whose parent is NOT in the list (a deleted parent, or a
 * deeper nesting an older client wrote) surfaces as its own top-level row
 * rather than being silently dropped. A dropped row would read as "the kinfolk
 * never said that", which is the one thing a comment thread must never do.
 *
 * A `null` `createdAtMs` sorts as 0, the same "oldest first, undated first"
 * treatment both reference implementations use; it is never replaced with
 * `Date.now()`.
 */
export function buildCommentThread(comments: readonly KinTaleComment[]): CommentRow[] {
  const byTime = (a: KinTaleComment, b: KinTaleComment) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
  const ordered = [...comments].sort(byTime);
  const knownIds = new Set(ordered.map((c) => c.id));
  const parentIdOf = (c: KinTaleComment) => (c.parentCommentId ?? '').trim();

  const repliesByParent = new Map<string, KinTaleComment[]>();
  for (const c of ordered) {
    const parent = parentIdOf(c);
    if (parent === '') continue;
    const bucket = repliesByParent.get(parent);
    if (bucket) bucket.push(c);
    else repliesByParent.set(parent, [c]);
  }

  const rows: CommentRow[] = [];
  for (const parent of ordered.filter((c) => parentIdOf(c) === '')) {
    rows.push({ comment: parent, isReply: false });
    for (const reply of repliesByParent.get(parent.id) ?? []) {
      rows.push({ comment: reply, isReply: true });
    }
  }
  for (const c of ordered) {
    const parent = parentIdOf(c);
    if (parent !== '' && !knownIds.has(parent)) rows.push({ comment: c, isReply: false });
  }
  return rows;
}

// ── share link preflight (issue #397 S4) ─────────────────────────────────

/** The report fields `shareLinkPreflightError` reads, in the order it reads them. */
export interface ShareLinkPreflightInput {
  id: string;
  status: string;
  kinfolkId: string;
}

/**
 * Why this KinTale cannot be shared, or `null` when it can. Ported from the
 * wasm admin's own `shareLinkPreflightError` (`KinTaleReportViewModel.kt`),
 * which is the same three checks Android's `requestShareLink` makes inline.
 *
 * Every reason maps to a way `createShareLink` would fail server-side: a draft
 * has nothing a kinfolk should read yet, an unsaved report has no
 * `kin_care_reports` doc to point the link at, and a blank `kinfolkId` fails
 * the server's own tale-belongs-to-family check. Checking here means the
 * operator reads a sentence instead of a callable error code.
 */
export function shareLinkPreflightError(report: ShareLinkPreflightInput): string | null {
  if (kinTaleState(report.status) !== 'sent') return 'Send this KinTale first. Only a sent KinTale can be shared.';
  if (report.id.trim() === '') return 'Cannot share: this KinTale has not been saved yet.';
  if (report.kinfolkId.trim() === '') return 'Cannot share: this KinTale has no kinfolk to route the link to.';
  return null;
}

// ── view-as-kinfolk preview (issue #397 S5) ──────────────────────────────

/**
 * The fields the kinfolk preview reads. Deliberately narrow: a dossier or a
 * 411 note is ADMIN-ONLY and a kinfolk never sees either, so the preview's
 * input type cannot even name them (`share/createShareLink.ts` scrubs the
 * shared payload down to the same three things: author, body, photos).
 */
export interface KinfolkPreviewInput {
  title: string;
  bodyCopy: string;
  authorDisplayName: string;
  kinfolkName: string;
}

/**
 * The headline a kinfolk reads. Prefers the authored title; when the report has
 * none (89 of the 92 live `kin_care_reports` rows carry no `title`) it falls
 * back to the "From {author} for {recipient}" cover line rather than rendering
 * an empty heading. Ported from Android's `kinfolkPreviewHeadline`.
 */
export function kinfolkPreviewHeadline(report: KinfolkPreviewInput): string {
  const title = report.title.trim();
  if (title !== '') return title;
  const author = report.authorDisplayName.trim() || 'Auntie';
  const recipient = report.kinfolkName.trim() || 'your kinfolk';
  return `From ${author} for ${recipient}`;
}

/**
 * The narrative a kinfolk reads, or an honest placeholder when nothing was
 * written. Ported from Android's `kinfolkPreviewBody`; the placeholder is the
 * fact ("nothing was written"), never invented prose.
 */
export function kinfolkPreviewBody(report: Pick<KinfolkPreviewInput, 'bodyCopy'>): string {
  return report.bodyCopy.trim() === '' ? 'No narrative was written for this visit.' : report.bodyCopy;
}
