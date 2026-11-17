import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { staffBypass } from '../lib/staffGate';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { resolveKinTaleAccess } from '../lib/resolveKinTaleAccess';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';
import { inAppAuthorName, nameOrNull, resolveHouseholdAuthors, type InAppAuthor } from '../lib/kinTaleCommentAuthor';

const Args = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
});

type CommentDoc = {
  authorRole?: string;
  authorUid?: string | null;
  guestName?: string | null;
  body?: string;
  parentCommentId?: string | null;
  createdAtMs?: number;
};
const isStaffComment = (c: CommentDoc): boolean => c.authorRole === 'admin';
const isGuestComment = (c: CommentDoc): boolean =>
  c.authorRole === 'guest' || (typeof c.guestName === 'string' && c.guestName.trim() !== '');
/**
 * An Auntie's `staff` display name per uid (the client prefixes "Auntie"). A
 * staff name that is really an email is not a name, so she reads as a bare
 * "Auntie". Best-effort: a failed read names nobody.
 */
async function resolveStaffNames(comments: CommentDoc[]): Promise<Map<string, string>> {
  const uids = [...new Set(comments.filter((c) => isStaffComment(c) && c.authorUid).map((c) => c.authorUid as string))];
  const names = new Map<string, string>();
  if (uids.length === 0) return names;
  try {
    const firestore = db();
    const snaps = await firestore.getAll(...uids.map((u) => firestore.doc(`staff/${u}`)));
    snaps.forEach((s, i) => {
      const n = nameOrNull((s.data() as { displayName?: unknown } | undefined)?.displayName, [uids[i]!]);
      if (n) names.set(uids[i]!, n);
    });
  } catch {
    // An unresolvable Auntie shows as "Auntie", not an error.
  }
  return names;
}
/**
 * Who wrote each household comment (#1923; `lib/kinTaleCommentAuthor.ts` has the
 * order and why the first fix did not hold): a first name, else the household's
 * name, else "A member of the household". Never an email, never "Kinfolk",
 * never empty. The records are read once per thread.
 */
async function resolveHouseholdNames(kinfolkId: string, comments: CommentDoc[]): Promise<(c: CommentDoc) => InAppAuthor> {
  const household = comments.filter((c) => !isStaffComment(c) && !isGuestComment(c));
  const resolved =
    household.length > 0
      ? await resolveHouseholdAuthors(kinfolkId, household.map((c) => c.authorUid ?? '').filter((u) => u !== ''))
      : null;
  return (c) => {
    const author = c.authorUid ? resolved?.byUid.get(c.authorUid) : undefined;
    return inAppAuthorName(author ?? { personName: null, householdName: resolved?.householdName ?? null });
  };
}
export async function getKinTaleCommentsHandler(
  req: CallableRequest<unknown>,
): Promise<{ comments: Array<Record<string, unknown>> }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  // RULING O-6, Q2: kinfolkId is derived from the tale doc itself, not
  // trusted from the client (staff no longer need to supply it at all).
  // #944: allowlisted for the Auntie - reading the comments on a KinTale she
  // wrote is the job. staffBypass refuses any callable not in auntieAccess.ts.
  const { kinfolkId } = await resolveKinTaleAccess(
    args.taleId, uid, args.kinfolkId, staffBypass(req.auth, 'getKinTaleComments'), 'getKinTaleComments',
  );

  const snap = await db()
    .collection(`kin_care_reports/${args.taleId}/comments`)
    .orderBy('createdAtMs', 'asc')
    .get();

  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as CommentDoc }));

  const all = docs.map((d) => d.data);
  const [staffNames, householdName] = await Promise.all([
    resolveStaffNames(all),
    resolveHouseholdNames(kinfolkId, all),
  ]);
  const comments = docs.map(({ id, data }) => {
    // A guest's typed name is printed as typed, unless they typed an address.
    const guestName = nameOrNull(data.guestName);
    const role = isStaffComment(data) ? 'admin' : isGuestComment(data) ? 'guest' : 'kinfolk';
    let author: InAppAuthor | null;
    if (role === 'admin') {
      const staff = data.authorUid ? staffNames.get(data.authorUid) ?? null : null;
      author = staff === null ? null : { name: staff, isPerson: true };
    } else if (role === 'guest') {
      author = guestName === null ? null : { name: guestName, isPerson: true };
    } else {
      author = householdName(data);
    }
    return {
      id,
      authorDisplayName: author?.name ?? null,
      // True only when the name is the person's own (a household name or the
      // generic line is not), so the portal can say "You" on its own comment.
      authorNameIsPerson: author?.isPerson ?? false,
      authorRole: role,
      authorUid: data.authorUid ?? null,
      guestName,
      body: data.body ?? '',
      parentCommentId: data.parentCommentId ?? null,
      createdAtMs: data.createdAtMs ?? null,
    };
  });
  return { comments };
}

export const getKinTaleComments = onCall(
  // Opened on every tale view.
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('getKinTaleComments', getKinTaleCommentsHandler),
);
