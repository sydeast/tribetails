import { call } from '../lib/fns';

/**
 * The KinTale DETAIL surface's callable client: comments, the love/react
 * toggle, media resolution, and the kinfolk-facing share link for one
 * `kin_care_reports` doc. The report
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
 *  - `createShareLink({ familyId, kinTaleId, includePhotos })` -> `{ shareId,
 *    shareUrl }`. Registered in `functions/src/index.ts` and implemented in
 *    `functions/src/share/createShareLink.ts`: it writes a
 *    `sharedKinTales/{shareId}` doc holding a SCRUBBED payload (author display
 *    name, body copy, and the resolved photo urls, nothing else), arrayUnions
 *    the new id onto the tale, writes an audit row, and returns the public url.
 *    `familyId` here is the tale's OWN `kinfolkId`: the server re-reads the
 *    tale and refuses (`not-found`) when the two disagree, so it is an
 *    authorization anchor, not a routing convenience.
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
   * Reply-to-a-specific-comment. `screens/KinTaleDetail.tsx` sets this from its
   * per-row "Reply" affordance (issue #397 S6); omitted, the comment posts at
   * the root of the thread. The server validates that the parent already
   * exists, so a stale id fails loud rather than silently orphaning a reply.
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

// ── share link ───────────────────────────────────────────────────────────

export interface CreateShareLinkResult {
  shareId: string;
  /** The full public url the server built from `SHARE_LINK_BASE_URL`. Never assembled client-side. */
  shareUrl: string;
}

/**
 * Mints a public, read-only share link for one KinTale.
 *
 * `familyId` is the tale's own `kinfolkId` and is REQUIRED: unlike the four
 * tale-scoped callables above there is no `resolveKinTaleAccess` derivation to
 * fall back on, the server compares it against the tale doc and answers
 * `not-found` when they disagree.
 *
 * The server's own zod schema also accepts `expiresInDays` (1..90) and a
 * `passcode` (4..8 chars). Neither is sent here, and neither is surfaced in the
 * admin UI: the two reference implementations for THIS screen (Android
 * `ui/kintales/KinTaleReportScreen.kt` and the wasm admin's
 * `KinTaleReportViewModel.kt#createShareLink`) send neither, so the link takes
 * the server's own `SHARE_DEFAULT_TTL_DAYS` default and carries no passcode.
 * The kinfolk portal's `mytribe/web/src/components/ShareKinTaleDialog.tsx` is
 * the shipped precedent for an expiry/passcode/revoke form if an admin-side one
 * is ever wanted; it is a distinct surface, not part of this parity slice.
 *
 * Fail loud: a callable rejection propagates (`lib/fns.ts#call` passthrough).
 * No url is ever fabricated locally.
 */
export async function createShareLink(
  taleId: string,
  kinfolkId: string,
  includePhotos = true,
): Promise<CreateShareLinkResult> {
  const payload = { familyId: kinfolkId, kinTaleId: taleId, includePhotos };
  return call<typeof payload, CreateShareLinkResult>('createShareLink', payload);
}
