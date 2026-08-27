import { db } from '../lib/firestoreAdmin';

/**
 * The comment thread as a GUEST may see it, for the public shared-KinTale page.
 *
 * ISSUE #624, operator ruling 2026-08-26: "Show guests the thread". Until then a
 * guest could post a note and never see it, or anyone else's, because
 * `ScrubbedSharePayload` carries no comments field and neither share surface
 * rendered one. Submission had shipped; this is the read half.
 *
 * WHY A SEPARATE READER RATHER THAN `getKinTaleComments`. That callable answers
 * a signed-in household member or an admin, and returns `authorUid` with each
 * row. This page is reachable by anyone holding the link. The two audiences do
 * not get the same fields, and the difference is not a filter applied at the
 * edge but a different query result, so the scrub cannot be forgotten by a
 * caller.
 *
 * WHAT A GUEST NEVER RECEIVES:
 *  - `guestEmailHash`. The address is hashed at write time precisely so it is
 *    never readable; putting the hash on a public page hands out a stable
 *    identifier that links one person's notes across every tale they comment on.
 *  - `authorUid`. A household member's Firebase uid on a page anyone can open.
 *  - The household's own names. A comment from the family shows as "The family"
 *    rather than resolving a real person, because the recipient list of a share
 *    link is unknown by construction: the household chose to send a recap, not
 *    to introduce their members to whoever the link reached.
 *
 * The Auntie's display name is a deliberate exception and is NOT resolved here
 * either. `scrubbedPayload.authorDisplayName` already names her at the top of
 * the page, because she authored the thing being shared; a comment does not
 * need to re-derive it, and doing so would mean reading a second collection.
 */

/** One thread row, already scrubbed for a public reader. */
export interface PublicComment {
  /** Display name to print. Never an email, a uid, or a household member's name. */
  name: string;
  /** The comment text, unescaped: the renderer escapes it. */
  body: string;
  /** Epoch millis, or null when the row predates the field. */
  createdAtMs: number | null;
  /** True when a guest wrote it, false when it came from the family's side. */
  fromGuest: boolean;
}

/**
 * The most a single page will render. A thread this long is already a
 * pathological case; the cap exists so one popular share cannot turn a public
 * HTML render into an unbounded read, the same reason every listener in this
 * repo carries one.
 */
export const MAX_PUBLIC_COMMENTS = 200;

/** Shown when a guest left no name, rather than an empty byline. */
export const ANONYMOUS_GUEST_NAME = 'A friend';

/** Shown for anything written from the household's side. */
export const FAMILY_NAME = 'The family';

type CommentDoc = {
  authorRole?: string;
  guestName?: string | null;
  body?: string;
  createdAtMs?: number;
};

/**
 * Scrub one stored comment into what a guest may see.
 *
 * A row with no usable body is dropped by the caller rather than rendered as an
 * empty bubble: a thread that shows a nameless, wordless entry reads as a bug to
 * the person who just posted, and they cannot tell whether it was theirs.
 */
export function toPublicComment(data: CommentDoc): PublicComment | null {
  const body = (data.body ?? '').trim();
  if (body === '') return null;

  const fromGuest = data.authorRole === 'guest';
  const guestName = (data.guestName ?? '').trim();

  return {
    name: fromGuest ? guestName || ANONYMOUS_GUEST_NAME : FAMILY_NAME,
    body,
    createdAtMs: typeof data.createdAtMs === 'number' ? data.createdAtMs : null,
    fromGuest,
  };
}

/**
 * Every comment on a tale that a guest may read, oldest first.
 *
 * Ordered by `createdAtMs` rather than `createdAt`: the server timestamp is
 * written by `FieldValue.serverTimestamp()` and is momentarily null in the
 * writer's own snapshot, where `createdAtMs` is a plain number set in the same
 * write. `getKinTaleComments` orders on the same field for the same reason.
 *
 * A failed read THROWS rather than returning an empty list. An empty thread and
 * a thread that could not be loaded look identical on the page, and the guest
 * who just posted would read the empty one as their note having vanished.
 */
export async function listPublicComments(taleId: string): Promise<PublicComment[]> {
  const snap = await db()
    .collection(`kin_care_reports/${taleId}/comments`)
    .orderBy('createdAtMs', 'asc')
    .limit(MAX_PUBLIC_COMMENTS)
    .get();

  const out: PublicComment[] = [];
  for (const doc of snap.docs) {
    const scrubbed = toPublicComment(doc.data() as CommentDoc);
    if (scrubbed) out.push(scrubbed);
  }
  return out;
}
