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
 *  - A household member's full name. Ruling 2026-11-01 on #1322 (issue #1407):
 *    a note from a household member is signed with first name and last initial
 *    ("Pat R."), and with "The family" when no name can be resolved.
 *
 * A staff (`admin`) comment is signed the way the in-app thread signs it
 * (#1371, #1416): "Auntie Maya" from `staff/{uid}.displayName`, or a bare
 * "Auntie" when none resolves. It is never "The family", which would put her
 * words in the household's mouth. Only the display name leaves this module.
 */

/** One thread row, already scrubbed for a public reader. */
export interface PublicComment {
  /** Display name to print. Never an email, a uid, or a full household member name. */
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
  authorUid?: string | null;
  guestName?: string | null;
  body?: string;
  createdAtMs?: number;
};

/**
 * "First L." from a stored household display name. Member records keep a single
 * `displayName` string, so it is split on whitespace: first token plus the
 * initial of the last token. One token shows alone; empty yields null so the
 * caller falls back to "The family".
 */
export function householdSignature(displayName: unknown): string | null {
  const tokens = (typeof displayName === 'string' ? displayName : '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return tokens[0]!;
  const initial = [...tokens[tokens.length - 1]!][0]!.toUpperCase();
  return `${tokens[0]} ${initial}.`;
}
/**
 * "Auntie Maya" from a stored staff display name, the same rule the in-app
 * thread applies (#1322, #1371): the role word is said once, so a name that
 * already carries "Auntie" is left as it is. Blank yields null so the caller
 * falls back to a bare "Auntie".
 */
export function staffSignature(displayName: unknown): string | null {
  const name = (typeof displayName === 'string' ? displayName : '').trim();
  if (name === '') return null;
  return /\bauntie\b/i.test(name) ? name : `Auntie ${name}`;
}
/** Shown for a staff comment when no staff name resolves. */
export const AUNTIE_FALLBACK_NAME = 'Auntie';
/** Signatures resolved for one thread, keyed by author uid. */
type Signatures = { household: Map<string, string>; staff: Map<string, string> };
/**
 * Resolve comment authors to signatures in ONE batched read per thread:
 * household members (member record first, `clients` record for accounts that
 * predate the member model, same order as `getKinTaleComments`) and staff
 * (`staff/{uid}`, as `getKinTaleComments` reads it) share a single getAll. A
 * failed or empty lookup leaves the author unnamed, so the note reads "The
 * family" / "Auntie" rather than failing the page.
 */
async function resolveSignatures(taleId: string, docs: CommentDoc[]): Promise<Signatures> {
  const out: Signatures = { household: new Map(), staff: new Map() };
  const named = docs.filter((d) => !(d.guestName ?? '').trim() && d.authorUid);
  const householdUids = [
    ...new Set(named.filter((d) => d.authorRole === 'kinfolk').map((d) => d.authorUid as string)),
  ];
  const staffUids = [
    ...new Set(named.filter((d) => d.authorRole === 'admin').map((d) => d.authorUid as string)),
  ];
  if (householdUids.length === 0 && staffUids.length === 0) return out;
  try {
    const firestore = db();
    let kinfolkId: string | null = null;
    if (householdUids.length > 0) {
      const taleSnap = await firestore.doc(`kin_care_reports/${taleId}`).get();
      const id = (taleSnap.data() as { kinfolkId?: unknown } | undefined)?.kinfolkId;
      if (typeof id === 'string' && id) kinfolkId = id;
    }
    const hUids = kinfolkId ? householdUids : [];
    const snaps = await firestore.getAll(
      ...hUids.map((u) => firestore.doc(`families/${kinfolkId}/members/${u}`)),
      ...hUids.map((u) => firestore.doc(`clients/${u}`)),
      ...staffUids.map((u) => firestore.doc(`staff/${u}`)),
    );
    const nameOf = (s: { data(): unknown } | undefined): unknown =>
      (s?.data() as { displayName?: unknown } | undefined)?.displayName;
    hUids.forEach((u, i) => {
      const sig = householdSignature(nameOf(snaps[i])) ?? householdSignature(nameOf(snaps[i + hUids.length]));
      if (sig) out.household.set(u, sig);
    });
    staffUids.forEach((u, i) => {
      const sig = staffSignature(nameOf(snaps[hUids.length * 2 + i]));
      if (sig) out.staff.set(u, sig);
    });
  } catch {
    // Best-effort: an unresolvable author is signed "The family" / "Auntie".
  }
  return out;
}
/**
 * Scrub one stored comment into what a guest may see.
 *
 * A row with no usable body is dropped by the caller rather than rendered as an
 * empty bubble: a thread that shows a nameless, wordless entry reads as a bug to
 * the person who just posted, and they cannot tell whether it was theirs.
 */
export function toPublicComment(
  data: CommentDoc,
  signature?: string | null,
): PublicComment | null {
  const body = (data.body ?? '').trim();
  if (body === '') return null;

  const fromGuest = data.authorRole === 'guest';
  const guestName = (data.guestName ?? '').trim();

  return {
    name: fromGuest
      ? guestName || ANONYMOUS_GUEST_NAME
      : data.authorRole === 'admin'
        ? signature || AUNTIE_FALLBACK_NAME
        : data.authorRole === 'kinfolk' && signature
          ? signature
          : FAMILY_NAME,
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

  const rows = snap.docs.map((d) => d.data() as CommentDoc);
  const signatures = await resolveSignatures(taleId, rows);
  const out: PublicComment[] = [];
  for (const row of rows) {
    const scrubbed = toPublicComment(
      row,
      row.authorUid
        ? (row.authorRole === 'admin' ? signatures.staff : signatures.household).get(row.authorUid)
        : null,
    );
    if (scrubbed) out.push(scrubbed);
  }
  return out;
}
