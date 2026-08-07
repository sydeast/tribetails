import { call } from '../lib/fns';
import { relativeDay, weekdayTime } from '../lib/portalFormat';
import type { KinTaleDto } from './types';

/**
 * Wrappers + pure helpers for the KinTales screen (S3). Kept out of
 * api/types.ts + api/portal.ts to avoid merge conflicts with other
 * screens being ported in parallel this session; fold into those shared
 * files in a later cleanup pass (mirrors the O-19 note in the plan doc).
 *
 * The pure formatting/threading/pagination helpers below don't belong in
 * an "api" file long-term either — they live here for the same
 * single-new-file constraint, alongside their vitest coverage in
 * kinTalesApi.test.ts. A cleanup pass should split them into
 * lib/portalFormat.ts (formatting) and a lib/kinTalesFormat.ts-style file.
 */

// ── getMyKinTaleMedia (functions/src/portal/getMyKinTaleMedia.ts) ───────────

export interface GetMyKinTaleMediaRequest {
  kinfolkId?: string;
  taleId: string;
}

export interface KinTaleMediaItemDto {
  id: string;
  url: string;
  contentType: string | null;
}

export interface GetMyKinTaleMediaResult {
  taleId: string;
  media: KinTaleMediaItemDto[];
}

/** Cloudinary CDN URLs for one KinTale's photos, fetched on demand (gallery expand). */
export function getMyKinTaleMedia(taleId: string, kinfolkId?: string): Promise<GetMyKinTaleMediaResult> {
  const payload: GetMyKinTaleMediaRequest = { taleId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<GetMyKinTaleMediaRequest, GetMyKinTaleMediaResult>('getMyKinTaleMedia', payload);
}

// ── getKinTaleComments (functions/src/portal/getKinTaleComments.ts) ─────────
// Backend callable name is `getKinTaleComments`; PortalApi.kt calls it
// `getMyKinTaleComments` client-side. We keep the backend's exact name for
// the `call()` string and use the Kotlin-side name for this wrapper so it
// reads consistently with getMyKinTales/getMyKinTaleMedia.

export interface GetKinTaleCommentsRequest {
  kinfolkId?: string;
  taleId: string;
}

/**
 * NOTE: the backend does NOT include an `authorDisplayName` field (see
 * getKinTaleComments.ts's CommentDoc mapping) even though the Kotlin
 * `KinTaleComment` model has one — it's always null in the live app too.
 * We render a role-derived label instead of pretending a name exists;
 * see `commentAuthorLabel` below.
 */
export interface KinTaleCommentDto {
  id: string;
  authorRole: string;
  authorUid: string | null;
  guestName: string | null;
  body: string;
  parentCommentId: string | null;
  createdAtMs: number | null;
}

export interface GetKinTaleCommentsResult {
  comments: KinTaleCommentDto[];
}

/** Full comment thread for one KinTale, oldest-first. */
export function getMyKinTaleComments(taleId: string, kinfolkId?: string): Promise<GetKinTaleCommentsResult> {
  const payload: GetKinTaleCommentsRequest = { taleId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<GetKinTaleCommentsRequest, GetKinTaleCommentsResult>('getKinTaleComments', payload);
}

// ── addKinTaleComment (functions/src/portal/kinTaleEngagement.ts) ───────────

export interface AddKinTaleCommentRequest {
  kinfolkId?: string;
  taleId: string;
  body: string;
  parentCommentId?: string;
}

export interface AddKinTaleCommentResult {
  commentId: string;
}

/** Posts a top-level comment or, with `parentCommentId`, a reply (single-level; see threadComments). */
export function addKinTaleComment(
  taleId: string,
  body: string,
  opts?: { parentCommentId?: string; kinfolkId?: string },
): Promise<AddKinTaleCommentResult> {
  const payload: AddKinTaleCommentRequest = {
    taleId,
    body,
    ...(opts?.parentCommentId !== undefined ? { parentCommentId: opts.parentCommentId } : {}),
    ...(opts?.kinfolkId !== undefined ? { kinfolkId: opts.kinfolkId } : {}),
  };
  return call<AddKinTaleCommentRequest, AddKinTaleCommentResult>('addKinTaleComment', payload);
}

// ── KinTale reactions (functions/src/portal/kinTaleEngagement.ts) ───────────
// A single love/heart toggle per kinfolk per tale — the mockup's "You and 2
// others loved this" line, previously omitted (see KinTales.tsx's doc
// comment — S4 scope, now built).

export interface KinTaleReactionRequest {
  kinfolkId?: string;
  taleId: string;
}

export interface KinTaleReactionResult {
  loved: boolean;
  loveCount: number;
}

/** Current reaction state for one tale: has the caller loved it, and how many total. */
export function getKinTaleReaction(taleId: string, kinfolkId?: string): Promise<KinTaleReactionResult> {
  const payload: KinTaleReactionRequest = { taleId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<KinTaleReactionRequest, KinTaleReactionResult>('getKinTaleReaction', payload);
}

/** Toggles the caller's own reaction on/off; returns the new state. */
export function toggleKinTaleLove(taleId: string, kinfolkId?: string): Promise<KinTaleReactionResult> {
  const payload: KinTaleReactionRequest = { taleId, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<KinTaleReactionRequest, KinTaleReactionResult>('toggleKinTaleLove', payload);
}

/**
 * "You and 2 others loved this" / "You loved this" / "3 loved this" /
 * "Be the first to love this" — mirrors the mockup's `.react` line
 * (ui-ideas/mytribe-kintales-2026-05-31.html:348) exactly for the
 * loved-by-me + others>0 case, and covers the cases the static mockup
 * didn't need to (nobody loved it yet, or someone else loved it but not you).
 */
export function loveLine(reaction: KinTaleReactionResult): string {
  const { loved, loveCount } = reaction;
  if (loved) {
    const others = loveCount - 1;
    if (others <= 0) return 'You loved this';
    return `You and ${others} ${others === 1 ? 'other' : 'others'} loved this`;
  }
  if (loveCount === 0) return 'Be the first to love this';
  return `${loveCount} ${loveCount === 1 ? 'person' : 'people'} loved this`;
}

// ── createShareLink (functions/src/share/createShareLink.ts) ────────────────
// Unlike every other wrapper in this file, `familyId` is REQUIRED (not
// optional): the server's zod schema requires it, and it is also the
// authorization anchor (requirePrimary gate) — there is no server-side
// resolveKinfolkAccess fallback to omit it in favor of, the way the read
// callables have. A SECONDARY household member is denied server-side
// (requirePrimary); that denial is meant to surface as a visible error here,
// not be pre-filtered client-side, since this screen has no membership-role
// signal to pre-filter on.
//
// The server's zod schema (createShareLink.ts:15-20) has always accepted
// `expiresInDays` (1-90) and `passcode` (4-8 chars) — this wrapper just
// finally carries them (P2 ruling, plan line 2214: "send them; do not widen
// the contract"). `options` is additive: the old two-positional-argument
// call shape (`createShareLink(kinTaleId, familyId)`) still compiles and
// still sends the exact same `{ familyId, kinTaleId, includePhotos: true }`
// payload it always has, so no existing caller's wire behavior changes.

export interface CreateShareLinkRequest {
  familyId: string;
  kinTaleId: string;
  includePhotos?: boolean;
  expiresInDays?: number;
  passcode?: string;
}

export interface CreateShareLinkResult {
  shareId: string;
  shareUrl: string;
}

/**
 * Options for a share link, matching ShareKinTaleModal.kt's form fields.
 * `passcode` is omitted from the wire payload entirely when blank (including
 * whitespace-only) rather than sent as `''` — the server's `.min(4)` would
 * reject an empty string, and that's not the caller's intent when they left
 * the field blank on purpose.
 */
export interface ShareLinkOptions {
  includePhotos: boolean;
  /** 1..90, default 7 — matches the Compose modal's default. */
  expiresInDays: number;
  /** 4..8 chars; blank/whitespace-only is treated as "no passcode". */
  passcode?: string;
}

/** Creates a public, time-limited share link for one KinTale. Photos included by default (the whole point of sharing) when no `options` are given. */
export function createShareLink(kinTaleId: string, familyId: string, options?: ShareLinkOptions): Promise<CreateShareLinkResult> {
  const hasPasscode = Boolean(options?.passcode && options.passcode.trim() !== '');
  const payload: CreateShareLinkRequest = {
    familyId,
    kinTaleId,
    includePhotos: options?.includePhotos ?? true,
    ...(options?.expiresInDays !== undefined ? { expiresInDays: options.expiresInDays } : {}),
    ...(hasPasscode ? { passcode: options!.passcode } : {}),
  };
  return call<CreateShareLinkRequest, CreateShareLinkResult>('createShareLink', payload);
}

// ── revokeShareLink (functions/src/share/revokeShareLink.ts) ────────────────
// PRIMARY member OR the original creator (see revokeShareLink.ts's caller
// check); a SECONDARY non-creator is denied server-side, same fail-loud
// convention as createShareLink above.

export interface RevokeShareLinkRequest {
  shareId: string;
}

export interface RevokeShareLinkResult {
  ok: true;
}

/** Revokes an active share link. Irreversible: `resolveShareLink` refuses a revoked link from then on. */
export function revokeShareLink(shareId: string): Promise<RevokeShareLinkResult> {
  const payload: RevokeShareLinkRequest = { shareId };
  return call<RevokeShareLinkRequest, RevokeShareLinkResult>('revokeShareLink', payload);
}

// ── pure helpers (pagination / filtering / comment threading / labels) ──────

export type KinTalesFilter = 'all' | 'lore' | 'gallery';

/** Client-side filter over an already-loaded page set, mirrors KinTalesScreen.kt's `filtered`. */
export function filterTales(tales: KinTaleDto[], filter: KinTalesFilter): KinTaleDto[] {
  switch (filter) {
    case 'lore':
      return tales.filter((t) => t.mediaIds.length === 0);
    case 'gallery':
      return tales.filter((t) => t.mediaIds.length > 0);
    default:
      return tales;
  }
}

/**
 * Next `before` pagination cursor: the last-loaded tale's `sentAtMs`, or
 * `undefined` if there's nothing to page from (empty list, or the last
 * tale has no sentAtMs — mirrors Kotlin's `tales?.lastOrNull()?.sentAtMs ?: return`).
 */
export function nextTalesCursor(tales: KinTaleDto[]): number | undefined {
  const last = tales[tales.length - 1];
  return last && last.sentAtMs !== null ? last.sentAtMs : undefined;
}

export interface ThreadedComments {
  topLevel: KinTaleCommentDto[];
  repliesByParent: Record<string, KinTaleCommentDto[]>;
}

/**
 * Splits a flat comment list into top-level comments + one level of replies
 * grouped by parent id, each sorted oldest-first. Mirrors the grouping in
 * KinTalesScreen.kt's `KinTaleComments` (single-level nesting: the UI only
 * ever lets you reply to a top-level comment, so a reply-to-a-reply would
 * never surface — same limitation here).
 */
export function threadComments(comments: KinTaleCommentDto[]): ThreadedComments {
  const byTime = (a: KinTaleCommentDto, b: KinTaleCommentDto) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
  const topLevel = comments.filter((c) => !c.parentCommentId).slice().sort(byTime);
  const repliesByParent: Record<string, KinTaleCommentDto[]> = {};
  for (const c of comments) {
    if (c.parentCommentId) {
      (repliesByParent[c.parentCommentId] ??= []).push(c);
    }
  }
  for (const key of Object.keys(repliesByParent)) {
    repliesByParent[key]!.sort(byTime);
  }
  return { topLevel, repliesByParent };
}

/**
 * Display label for a comment author. The backend never sends a real
 * display name (see KinTaleCommentDto's note), so this is role-derived:
 * admin -> "Auntie", a guest reply -> "<name> (Guest)", the signed-in
 * user's own comment -> "You", any other kinfolk -> the generic "Kinfolk".
 */
export function commentAuthorLabel(comment: KinTaleCommentDto, currentUid: string | null): string {
  if (comment.authorRole === 'admin') return 'Auntie';
  if (comment.guestName) return `${comment.guestName} (Guest)`;
  if (currentUid && comment.authorUid === currentUid) return 'You';
  return 'Kinfolk';
}

export interface CommentBadge {
  label: string;
  tone: 'kin' | 'guest';
}

/** Badge chip for a comment row, per the mockup's `.badge.kin` / `.badge.guest`. */
export function commentBadge(comment: KinTaleCommentDto): CommentBadge {
  if (comment.guestName && comment.authorRole !== 'admin') return { label: 'Guest', tone: 'guest' };
  return { label: comment.authorRole === 'admin' ? 'Auntie' : 'Kinfolk', tone: 'kin' };
}

/** Cycles the mockup's `.cav` c1/c2/c3 avatar color variants by row index. */
export function commentAvatarVariant(index: number): 'c1' | 'c2' | 'c3' {
  const variants = ['c1', 'c2', 'c3'] as const;
  return variants[index % 3]!;
}

/** First character of a label, uppercased, for a circular initial avatar. Falls back to "?". */
export function initialOf(label: string): string {
  return label.trim().charAt(0).toUpperCase() || '?';
}

/** "TODAY, 9:31 AM" style timestamp for comments/tale bylines, or "" if unknown. `now` is injectable for tests. */
export function shortTimestamp(ms: number | null, now: number = Date.now()): string {
  if (ms === null) return '';
  const time = weekdayTime(ms).split(', ')[1] ?? '';
  return `${relativeDay(ms, now).toUpperCase()}, ${time}`;
}

/** "3 PHOTOS · TODAY, 9:14 AM" style meta line for a tale byline/talecard header. */
export function taleMetaLabel(tale: KinTaleDto, now: number = Date.now()): string {
  const parts: string[] = [];
  if (tale.mediaIds.length > 0) {
    parts.push(`${tale.mediaIds.length} ${tale.mediaIds.length === 1 ? 'PHOTO' : 'PHOTOS'}`);
  }
  if (tale.sentAtMs !== null) {
    parts.push(shortTimestamp(tale.sentAtMs, now));
  }
  return parts.join(' · ');
}
