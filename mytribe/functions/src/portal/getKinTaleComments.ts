import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { staffBypass } from '../lib/staffGate';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { resolveKinTaleAccess } from '../lib/resolveKinTaleAccess';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';

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

type AuthorNames = { staff: Map<string, string>; household: Map<string, string> };

const firstToken = (name: string): string => name.trim().split(/\s+/)[0] ?? '';
const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Who wrote each comment, for the household reading the thread. An Auntie is
 * named by her `staff` display name (the client prefixes "Auntie"); a household
 * member by the FIRST name on their member record, falling back to their
 * `clients` record for accounts that predate the member model. Reads are batched
 * per distinct author, never per comment, and a failed or empty lookup leaves
 * the author unnamed rather than failing the thread.
 */
async function resolveAuthorNames(kinfolkId: string, comments: CommentDoc[]): Promise<AuthorNames> {
  const staffUids = new Set<string>();
  const householdUids = new Set<string>();
  for (const c of comments) {
    if (!c.authorUid || c.guestName) continue;
    (c.authorRole === 'admin' ? staffUids : householdUids).add(c.authorUid);
  }
  const names: AuthorNames = { staff: new Map(), household: new Map() };
  const firestore = db();
  try {
    if (staffUids.size > 0) {
      const snaps = await firestore.getAll(...[...staffUids].map((u) => firestore.doc(`staff/${u}`)));
      snaps.forEach((s, i) => {
        const n = textOf((s.data() as { displayName?: unknown } | undefined)?.displayName);
        if (n) names.staff.set([...staffUids][i]!, n);
      });
    }
    if (householdUids.size > 0) {
      const uids = [...householdUids];
      const refs = [
        ...uids.map((u) => firestore.doc(`families/${kinfolkId}/members/${u}`)),
        ...uids.map((u) => firestore.doc(`clients/${u}`)),
      ];
      const snaps = await firestore.getAll(...refs);
      uids.forEach((u, i) => {
        const n =
          textOf((snaps[i]?.data() as { displayName?: unknown } | undefined)?.displayName) ||
          textOf((snaps[i + uids.length]?.data() as { displayName?: unknown } | undefined)?.displayName);
        if (n) names.household.set(u, firstToken(n));
      });
    }
  } catch {
    // Best-effort: an unresolvable author shows as a role label, not an error.
  }
  return names;
}

function commentAuthorName(c: CommentDoc, names: AuthorNames): string | null {
  const guest = textOf(c.guestName);
  if (guest) return guest;
  if (!c.authorUid) return null;
  return (c.authorRole === 'admin' ? names.staff : names.household).get(c.authorUid) ?? null;
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

  const names = await resolveAuthorNames(kinfolkId, docs.map((d) => d.data));

  const comments = docs.map(({ id, data }) => {
    return {
      id,
      authorDisplayName: commentAuthorName(data, names),
      authorRole: data.authorRole ?? 'kinfolk',
      authorUid: data.authorUid ?? null,
      guestName: data.guestName ?? null,
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
