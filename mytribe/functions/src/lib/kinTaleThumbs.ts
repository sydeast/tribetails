/**
 * The single `kin_care_reports.thumbs` write path (task-24a). Denormalizes
 * the feed's preview thumbnails onto the tale document at write time so
 * `getMyKinTales` stops resolving up to 8 `media_files` docs per tale on
 * every read — worst case 181 reads for a default 20-tale page. See
 * task-24a-brief.md.
 *
 * `thumbs` keeps the exact `{id, url, contentType}` shape and the 8-tile cap
 * PR24 established for the portal response. Nothing here changes that
 * contract; it only changes where the value comes from.
 */

/** Same shape getMyKinTaleMedia's MediaItem / getMyKinTales' TaleThumb return. */
export interface TaleThumb {
  id: string;
  url: string;
  contentType: string | null;
}

/** Feed card thumbnail-strip cap — operator directive from the PR24 mock review. */
export const MAX_THUMBS_PER_TALE = 8;

/**
 * Turns one `media_files/{id}` doc into the portal's `{id, url, contentType}`
 * shape. This is the SAME mapping `getMyKinTaleMedia` and the old per-read
 * `getMyKinTales` resolver used (storageUrl -> url, mimeType -> contentType).
 * A doc with no `storageUrl` produces no thumb — never a placeholder.
 */
export function mediaDocToThumb(
  id: string,
  data: Record<string, unknown> | undefined,
): TaleThumb | null {
  if (!data) return null;
  const url = typeof data['storageUrl'] === 'string' ? (data['storageUrl'] as string) : '';
  if (!url) return null;
  return {
    id,
    url,
    contentType: typeof data['mimeType'] === 'string' ? (data['mimeType'] as string) : null,
  };
}

/**
 * Resolves at most `MAX_THUMBS_PER_TALE` media docs, in `mediaFileIds` order,
 * via one batched `getAll`. A media doc that's missing or has no
 * `storageUrl` is simply absent from the result — `mediaFileIds` stays the
 * true count, `thumbs` is only ever a preview of it.
 */
export async function computeThumbs(
  firestore: FirebaseFirestore.Firestore,
  mediaFileIds: string[],
): Promise<TaleThumb[]> {
  const ids = mediaFileIds.slice(0, MAX_THUMBS_PER_TALE);
  if (ids.length === 0) return [];

  const refs = ids.map((id) => firestore.doc(`media_files/${id}`));
  const snaps = await firestore.getAll(...refs);

  const thumbs: TaleThumb[] = [];
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const thumb = mediaDocToThumb(snap.id, snap.data() as Record<string, unknown> | undefined);
    if (thumb) thumbs.push(thumb);
  });
  return thumbs;
}

function mediaFileIdsChanged(before: string[] | undefined, after: string[] | undefined): boolean {
  const b = before ?? [];
  const a = after ?? [];
  if (b.length !== a.length) return true;
  return b.some((id, i) => id !== a[i]);
}

/** `undefined` never equals a computed array — it means "never resolved", so
 *  the first pass always writes, even when the resolved value is `[]`. That
 *  materializes "resolved, nothing renderable" as a stored empty array,
 *  which is what stops the write from being attempted again. */
function thumbsEqual(stored: TaleThumb[] | undefined, computed: TaleThumb[]): boolean {
  if (stored === undefined) return false;
  if (stored.length !== computed.length) return false;
  return stored.every(
    (t, i) =>
      t.id === computed[i]?.id &&
      t.url === computed[i]?.url &&
      t.contentType === computed[i]?.contentType,
  );
}

export interface ThumbsMaintainable {
  mediaFileIds?: string[];
  thumbs?: TaleThumb[];
}

/**
 * The single write-path for `kin_care_reports.thumbs`. Called from BOTH
 * `onKinTaleCreate` and `onKinTaleUpdate`, BEFORE either trigger's
 * status/notification gates — media routinely changes while a tale is still
 * a DRAFT, and thumbs has to track that, not just the SENT moment.
 *
 * Loop safety: writing this field back onto the same document re-enters
 * `onKinTaleUpdate` (an update trigger fires on every write, including this
 * one). Two independent guards keep that terminal:
 *
 *   1. Skip entirely, before touching Firestore, when `mediaFileIds` is
 *      unchanged AND `thumbs` is already present (`!== undefined`).
 *      Presence, not truthiness/length, is what "resolved" means — an empty
 *      array counts as resolved (nothing renderable), so a tale whose media
 *      all lack `storageUrl` doesn't recompute forever.
 *   2. Even when guard 1 doesn't short-circuit (e.g. mediaFileIds DID
 *      change), the freshly computed value is compared to what's already
 *      stored and the write is skipped when they match. This is the
 *      belt-and-braces backstop: a bug in guard 1 alone cannot produce an
 *      infinite loop, because a write only happens when the stored value is
 *      actually about to change.
 *
 * The re-entrant call this write produces always lands on guard 1:
 * `mediaFileIds` is unchanged (only `thumbs` differs between that before and
 * after), and `thumbs` is now defined, so it's a zero-Firestore-call no-op.
 */
export async function maintainThumbs(
  firestore: FirebaseFirestore.Firestore,
  ref: FirebaseFirestore.DocumentReference,
  before: ThumbsMaintainable | undefined,
  after: ThumbsMaintainable,
): Promise<'skipped' | 'written'> {
  const changed = mediaFileIdsChanged(before?.mediaFileIds, after.mediaFileIds);
  if (!changed && after.thumbs !== undefined) return 'skipped';

  const computed = await computeThumbs(firestore, after.mediaFileIds ?? []);
  if (thumbsEqual(after.thumbs, computed)) return 'skipped';

  await ref.set({ thumbs: computed }, { merge: true });
  return 'written';
}
