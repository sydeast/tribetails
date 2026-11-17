import { call, type CallOptions } from '../lib/fns';
import { auntieName, relativeDay, weekdayTime } from '../lib/portalFormat';
import { parseDateKey } from '../lib/bookingWizardLogic';
import type { ChecklistItemDto, KinTaleDto } from './types';

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
 * `authorDisplayName` is who wrote it, resolved server-side (getKinTaleComments.ts,
 * `lib/kinTaleCommentAuthor.ts` for the order): the Auntie's staff name (print it
 * through `auntieName`), the name a guest typed, or for a household member their
 * first name, else the household's name, else "A member of the household". It is
 * never an email. `authorNameIsPerson` is false when the name is the household's
 * or the generic line, so the reader's own comment can say "You" instead.
 */
export interface KinTaleCommentDto {
  id: string;
  authorDisplayName?: string | null;
  authorNameIsPerson?: boolean;
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
 * Display label for a comment author, the name the server resolved (#1923):
 * an Auntie -> "Auntie Maya" (via `auntieName`, so "Auntie" is said once),
 * a guest -> the name they typed (the GUEST badge says the rest, #1922), a
 * household member -> their first name, and the signed-in user's own comment
 * -> "<name> (you)", or "You" when the server knows only the household's name.
 * With no name at all it falls back to the role word: "Auntie", "Guest",
 * "Kinfolk".
 */
export function commentAuthorLabel(comment: KinTaleCommentDto, currentUid: string | null): string {
  const name = (comment.authorDisplayName ?? '').trim();
  const role = commentRole(comment);
  if (role === 'admin') return auntieName(name) ?? 'Auntie';
  if (role === 'guest') return name || (comment.guestName ?? '').trim() || 'Guest';
  if (isOwnComment(comment, currentUid)) return name && comment.authorNameIsPerson !== false ? `${name} (you)` : 'You';
  return name || 'Kinfolk';
}
/** Which side wrote a comment. A note carrying a guest name is a guest's, whatever its role says. */
export function commentRole(comment: KinTaleCommentDto): 'admin' | 'guest' | 'kinfolk' {
  if (comment.authorRole === 'admin') return 'admin';
  if (comment.authorRole === 'guest' || (comment.guestName ?? '').trim() !== '') return 'guest';
  return 'kinfolk';
}
/** True for the signed-in user's own comment. */
export function isOwnComment(comment: KinTaleCommentDto, currentUid: string | null): boolean {
  return currentUid !== null && comment.authorUid === currentUid && commentRole(comment) === 'kinfolk';
}
/**
 * The letter on a comment's avatar: the author's NAME, never the "(you)"
 * suffix and never the "You" fallback word, so one person shows one letter
 * wherever they appear (their comments and their own composer). The reader's
 * own comment takes the composer's letter unless the server named the person.
 */
export function commentInitial(
  comment: KinTaleCommentDto,
  currentUid: string | null,
  ownInitial: string = initialOf('You'),
): string {
  const name = (comment.authorDisplayName ?? '').trim();
  const role = commentRole(comment);
  if (role === 'admin') return initialOf(name || 'Auntie');
  if (role === 'guest') return initialOf(name || comment.guestName || 'Guest');
  if (isOwnComment(comment, currentUid) && (!name || comment.authorNameIsPerson === false)) return ownInitial;
  return initialOf(name || 'Kinfolk');
}
export interface CommentBadge {
  label: string;
  tone: 'kin' | 'guest';
}

/** Badge chip for a comment row, per the mockup's `.badge.kin` / `.badge.guest`. */
export function commentBadge(comment: KinTaleCommentDto): CommentBadge {
  const role = commentRole(comment);
  if (role === 'guest') return { label: 'Guest', tone: 'guest' };
  return { label: role === 'admin' ? 'Auntie' : 'Kinfolk', tone: 'kin' };
}
/**
 * Avatar colour class for a comment row. The reader's own comments take `me`,
 * the composer's colour (#1923: one person, one avatar); every other row cycles
 * the mockup's c1/c2/c3 by row index.
 */
export function commentAvatarClass(comment: KinTaleCommentDto, currentUid: string | null, index: number): string {
  return isOwnComment(comment, currentUid) ? 'me' : commentAvatarVariant(index);
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

/**
 * When a tale was sent, for its byline: the formatted time, or the stored text
 * as written when the server could read no date from it (#1775), or "" when it
 * carries neither. Never a guessed date.
 */
export function taleSentLabel(tale: KinTaleDto, now: number = Date.now()): string {
  if (tale.sentAtMs !== null) return shortTimestamp(tale.sentAtMs, now);
  return tale.sentAtText?.trim() ?? '';
}
/** "3 PHOTOS · TODAY, 9:14 AM" style meta line for a tale byline/talecard header. */
export function taleMetaLabel(tale: KinTaleDto, now: number = Date.now()): string {
  const parts: string[] = [];
  if (tale.mediaIds.length > 0) {
    parts.push(`${tale.mediaIds.length} ${tale.mediaIds.length === 1 ? 'PHOTO' : 'PHOTOS'}`);
  }
  const sent = taleSentLabel(tale, now);
  if (sent !== '') parts.push(sent);
  return parts.join(' · ');
}
// ── what a tale is about (#2056) ────────────────────────────────────────────
//
// The household read a title, a story and "FED" with four Kin on the visit, and
// could not tell the KinCare, the day or whose bowl. `getMyKinTales` now sends
// the KinCare's name, the visit's business day and the Kin's names; these turn
// them into the two lines and the chip text the card prints. Every input is
// optional, and a missing one is left out of the line, never printed as a
// placeholder.

const TALE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TALE_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function cleanNames(names: readonly unknown[] | undefined | null): string[] {
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim());
}

/** "Biscuit", "Biscuit and Mochi", "Biscuit, Mochi and Pip". '' for no names. */
export function kinNameList(names: readonly unknown[] | undefined | null): string {
  const clean = cleanNames(names);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/**
 * The visit's day off its `YYYY-MM-DD` key: "Tue, Nov 10", with the year when
 * it is not this one ("Mon, Nov 10, 2025"). Null when the key is missing or
 * unreadable. The key is already the business's day, so it is read as a plain
 * calendar date and never shifted by the device's zone.
 */
export function taleVisitDayLabel(visitDate: string | undefined | null, now: number = Date.now()): string | null {
  if (typeof visitDate !== 'string') return null;
  const d = parseDateKey(visitDate.trim());
  if (d === null || Number.isNaN(d.getTime())) return null;
  const base = `${TALE_WEEKDAYS[d.getDay()]}, ${TALE_MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** "30 Minute Quick Check · Biscuit, Mochi and Pip": the KinCare and the Kin, whichever are known. '' for neither. */
export function taleAboutLine(tale: Pick<KinTaleDto, 'serviceLabel' | 'kinNames'>): string {
  const service = typeof tale.serviceLabel === 'string' ? tale.serviceLabel.trim() : '';
  return [service, kinNameList(tale.kinNames)].filter((p) => p !== '').join(' · ');
}

/** A done care task as its chip reads: "Fed for Biscuit" when it was done for named Kin, else just "Fed". */
export function careTaskLabel(item: ChecklistItemDto): string {
  const forKin = kinNameList(item.kinNames);
  return forKin === '' ? item.text : `${item.text} for ${forKin}`;
}

// ── getMyKinPhotos (functions/src/portal/getMyKinPhotos.ts) ─────────────────
//
// The whole household's photo archive, for the Gallery screen. Distinct from
// getMyKinTaleMedia above, which resolves the media of ONE tale the caller
// already has the id of.
//
// Hand-typed rather than generated: the contract registry publishes the invoice
// and booking surfaces to three clients, and its header is explicit that adding
// a line there is a decision to publish. The rest of this file's KinTale
// callables are hand-typed for the same reason.
export interface KinPhotoDto {
  /** The media record's id. Stable, and unique within a page. */
  id: string;
  url: string;
  /** MIME type, e.g. 'image/jpeg'. Null when the record never carried one. */
  contentType: string | null;
  /** The KinTale this photo came from, so a tile can link back to the story. */
  taleId: string;
  taleTitle: string;
  takenAtMs: number | null;
}
export interface KinPortraitDto {
  kinId: string;
  kinName: string;
  url: string;
}
export interface GetMyKinPhotosResult {
  photos: KinPhotoDto[];
  /** Current Kin portraits. Populated on the first page only. */
  portraits: KinPortraitDto[];
  hasMore: boolean;
  /** Cursor for the next page, or null at the end of the archive. */
  nextBefore: number | null;
}
export interface GetMyKinPhotosRequest {
  kinfolkId?: string;
  /** KinTales read per page. Photos returned is whatever those tales carry. */
  limit?: number;
  /** `nextBefore` from the previous page. */
  before?: number;
}
export function getMyKinPhotos(
  kinfolkId?: string,
  opts: { limit?: number; before?: number } = {},
  options?: CallOptions,
): Promise<GetMyKinPhotosResult> {
  const payload: GetMyKinPhotosRequest = {
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.before !== undefined ? { before: opts.before } : {}),
  };
  return call<GetMyKinPhotosRequest, GetMyKinPhotosResult>('getMyKinPhotos', payload, options);
}
