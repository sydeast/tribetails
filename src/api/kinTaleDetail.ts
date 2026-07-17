import { call } from '../lib/fns';

/**
 * The KinTale DETAIL surface's callable client: comments, the love/react
 * toggle, and media resolution for one `kin_care_reports` doc. The report
 * itself is NOT read here, `screens/KinTaleDetail.tsx` reuses the same bounded
 * `KINTALES_QUERY` stream `KinTales.tsx`/`KinTaleCompose.tsx` already open (the
 * "opens no second listener class" convention `KinTaleCompose.tsx`'s own doc
 * comment states for its own EDIT-mode hydration).
 *
 * Every callable below is confirmed live in
 * `MyTribe/functions/src/portal/{getKinTaleComments,kinTaleEngagement,getMyKinTaleMedia}.ts`
 * (all five re-exported from `functions/src/index.ts`), not assumed from the
 * wasm `KinTaleReportScreen.kt` reference alone:
 *
 *  - `getKinTaleComments({ taleId })` -> `{ comments: [...] }`. Reads
 *    `kin_care_reports/{taleId}/comments` ordered `createdAtMs asc` (oldest
 *    first, a chat-style feed, not the newest-first activity-feed order
 *    `Inbox.tsx`/`Notifications.tsx` use for their own very different "which
 *    thread needs me" lists).
 *  - `addKinTaleComment({ taleId, body, parentCommentId? })` -> `{ commentId
 *    }`. Server-validates `body` (1..2000 chars, rejects whitespace-only) and
 *    a supplied `parentCommentId` (must already exist), so this client sends
 *    the trimmed intent and lets the callable be the final authority; a
 *    rejection propagates as a real Error (`lib/fns.ts#call`'s
 *    `CallableTimeoutError`/`FirebaseError` passthrough), never swallowed.
 *  - `getKinTaleReaction({ taleId })` / `toggleKinTaleLove({ taleId })` -> both
 *    `{ loved: boolean; loveCount: number }`. One reaction doc per calling uid
 *    under `kin_care_reports/{taleId}/reactions/{uid}` (doc existence IS the
 *    "did I react" fact); toggling returns the AUTHORITATIVE post-toggle state
 *    computed server-side, so the caller never re-derives it locally.
 *  - `getMyKinTaleMedia({ taleId, kinfolkId })` -> `{ taleId, media: [{ id,
 *    url, contentType }] }`. Resolves `kin_care_reports/{taleId}.mediaFileIds`
 *    against `media_files/{id}.storageUrl`, a direct Cloudinary CDN url, no
 *    signing. `kinfolkId` IS REQUIRED here even for an admin caller: this
 *    callable authorizes through `resolveKinfolkAccess`, which for a staff uid
 *    with no `requested` id falls back to the CALLER's OWN
 *    `clients/{uid}.kinfolkIds` (an admin account normally has none) and
 *    throws `failed-precondition` rather than silently picking a household.
 *    The other four callables above instead run through
 *    `resolveKinTaleAccess`, which derives `kinfolkId` FROM THE TALE DOC
 *    ITSELF (RULING O-6, Q2), so they take no `kinfolkId` argument from this
 *    client at all, an admin's own uid already carries a valid staff claim for
 *    any tale it can see.
 *
 * `kinfolkId` on the four tale-scoped callables is accepted server-side only
 * for old-client equality-check compat (see `resolveKinTaleAccess`'s doc
 * comment); this client never sends it, matching the derive-don't-trust
 * ruling exactly.
 */

// ── comments ─────────────────────────────────────────────────────────────

/**
 * One `kin_care_reports/{taleId}/comments` row, as `getKinTaleCommentsHandler`
 * returns it. `authorRole` is free text server-side (`data.authorRole ??
 * 'kinfolk'`), classify it through `lib/kinTaleDetailFormat.ts#commentAuthorRole`
 * (positive enumeration, never negation), not by reading this field raw.
 * `guestName` is always `null` on every comment this port's own
 * `addKinTaleComment` ever writes (the handler never sets it); the field
 * exists on the wire shape for an unauthenticated/guest-reply path this repo
 * has not built, so it is modeled here rather than silently dropped.
 */
export interface KinTaleComment {
  id: string;
  authorRole: string;
  authorUid: string | null;
  guestName: string | null;
  body: string;
  parentCommentId: string | null;
  /** Epoch ms, or `null` on a comment doc missing the field. Never a Firestore Timestamp; see `lib/kinTaleDetailFormat.ts`'s AO-18 fix for this shape. */
  createdAtMs: number | null;
}

/** The comment thread for one KinTale, oldest first (the server's own `createdAtMs asc` order, unchanged here). */
export async function getKinTaleComments(taleId: string): Promise<KinTaleComment[]> {
  const res = await call<{ taleId: string }, { comments: KinTaleComment[] }>('getKinTaleComments', { taleId });
  return res.comments ?? [];
}

export interface AddKinTaleCommentInput {
  taleId: string;
  body: string;
  /**
   * Reply-to-a-specific-comment. Accepted end-to-end by the backend, but this
   * port's own compose form (`screens/KinTaleDetail.tsx`) only composes
   * ROOT-level comments; a per-comment "Reply" affordance is a separate,
   * not-yet-built surface, the same "build only what this screen renders"
   * boundary `KinTaleCompose.tsx`'s own doc comment draws around its scope.
   */
  parentCommentId?: string;
}

/** Posts one comment. Returns the new comment's id; the caller re-reads via `getKinTaleComments` for the authoritative row rather than fabricating one locally (this callable's own response carries no other field). */
export async function addKinTaleComment(input: AddKinTaleCommentInput): Promise<string> {
  const payload: { taleId: string; body: string; parentCommentId?: string } = {
    taleId: input.taleId,
    body: input.body,
    ...(input.parentCommentId ? { parentCommentId: input.parentCommentId } : {}),
  };
  const res = await call<typeof payload, { commentId: string }>('addKinTaleComment', payload);
  return res.commentId;
}

// ── love/react ───────────────────────────────────────────────────────────

export interface KinTaleReaction {
  loved: boolean;
  loveCount: number;
}

/** Reads whether the SIGNED-IN caller has reacted to this tale, and the total reaction count. */
export async function getKinTaleReaction(taleId: string): Promise<KinTaleReaction> {
  return call<{ taleId: string }, KinTaleReaction>('getKinTaleReaction', { taleId });
}

/** Toggles the signed-in caller's own reaction. Returns the authoritative post-toggle `{ loved, loveCount }`, computed server-side; the caller should replace its local state with this response rather than deriving the flip itself. */
export async function toggleKinTaleLove(taleId: string): Promise<KinTaleReaction> {
  return call<{ taleId: string }, KinTaleReaction>('toggleKinTaleLove', { taleId });
}

// ── media ────────────────────────────────────────────────────────────────

export interface KinTaleMediaItem {
  id: string;
  /** Direct Cloudinary CDN url, already resolved server-side. No signing, no further URL construction needed. */
  url: string;
  /** e.g. `"image/jpeg"`; `null` when `media_files/{id}.mimeType` is absent. */
  contentType: string | null;
}

/**
 * Resolves a KinTale's `mediaFileIds` to real CDN urls. `kinfolkId` is
 * REQUIRED (see the file header: an admin caller with no own `clients`
 * household record would otherwise hit `failed-precondition`), always pass
 * the tale's own `KinTaleEntry.kinfolkId`, never a fabricated or omitted one.
 */
export async function getMyKinTaleMedia(taleId: string, kinfolkId: string): Promise<KinTaleMediaItem[]> {
  const res = await call<{ taleId: string; kinfolkId: string }, { taleId: string; media: KinTaleMediaItem[] }>(
    'getMyKinTaleMedia',
    { taleId, kinfolkId },
  );
  return res.media ?? [];
}
