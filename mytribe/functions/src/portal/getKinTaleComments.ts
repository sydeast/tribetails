import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
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

export async function getKinTaleCommentsHandler(
  req: CallableRequest<unknown>,
): Promise<{ comments: Array<Record<string, unknown>> }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  // RULING O-6, Q2: kinfolkId is derived from the tale doc itself, not
  // trusted from the client (staff no longer need to supply it at all).
  await resolveKinTaleAccess(args.taleId, uid, args.kinfolkId, req.auth?.token?.admin === true, 'getKinTaleComments');

  const snap = await db()
    .collection(`kin_care_reports/${args.taleId}/comments`)
    .orderBy('createdAtMs', 'asc')
    .get();

  const comments = snap.docs.map((d) => {
    const data = d.data() as CommentDoc;
    return {
      id: d.id,
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
