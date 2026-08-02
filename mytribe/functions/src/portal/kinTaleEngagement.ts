import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeRichText } from '../lib/richText';
import { resolveKinTaleAccess } from '../lib/resolveKinTaleAccess';
import { FULL_CPU } from '../lib/runtimeOptions';

const Body = z.string().min(1).max(2000).refine((s) => s.trim().length > 0, {
  message: 'body cannot be whitespace-only',
});

const CommentArgs = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
  body: Body,
  parentCommentId: z.string().min(1).max(200).optional(),
});

async function ensureParentCommentExists(taleId: string, parentCommentId: string): Promise<void> {
  const snap = await db()
    .doc(`kin_care_reports/${taleId}/comments/${parentCommentId}`)
    .get();
  if (!snap.exists) throw new HttpsError('not-found', 'parent comment not found');
}

export async function addKinTaleCommentHandler(
  req: CallableRequest<unknown>,
): Promise<{ commentId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = CommentArgs.parse(req.data);
  const body = sanitizeRichText(args.body);
  if (body.length === 0) {
    throw new HttpsError('invalid-argument', 'body cannot be whitespace-only');
  }
  const isAdmin = req.auth?.token?.admin === true;

  // RULING O-6, Q2: kinfolkId is derived from the tale doc itself, not
  // trusted from the client.
  const { kinfolkId, isStaffCaller } = await resolveKinTaleAccess(
    args.taleId, uid, args.kinfolkId, isAdmin, 'addKinTaleComment',
  );
  if (args.parentCommentId) {
    await ensureParentCommentExists(args.taleId, args.parentCommentId);
  }

  const ref = await db()
    .collection(`kin_care_reports/${args.taleId}/comments`)
    .add({
      authorUid: uid,
      authorRole: isStaffCaller ? 'admin' : 'kinfolk',
      body,
      parentCommentId: args.parentCommentId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    });
  logEvent({
    severity: 'info',
    function: 'addKinTaleComment',
    event: 'portal.kintale.comment.added',
    uid,
    extra: {
      kinfolkId,
      taleId: args.taleId,
      commentId: ref.id,
      parentCommentId: args.parentCommentId ?? null,
      authorRole: isStaffCaller ? 'admin' : 'kinfolk',
    },
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CONTENT_KINTALE_COMMENT_POSTED,
    severity: 'info',
    actorRole: isStaffCaller ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetUid: ref.id,
    targetCollection: `kin_care_reports/${args.taleId}/comments`,
    description: `${isStaffCaller ? 'Admin' : 'Kinfolk'} posted KinTale comment`,
    payload: {
      kinfolkId,
      taleId: args.taleId,
      commentId: ref.id,
      parentCommentId: args.parentCommentId ?? null,
      authorRole: isStaffCaller ? 'admin' : 'kinfolk',
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn', function: 'addKinTaleComment', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  return { commentId: ref.id };
}

export const addKinTaleComment = onCall(
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  // getKinTaleReaction / toggleKinTaleLove below take the 0.25 vCPU default.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('addKinTaleComment', addKinTaleCommentHandler),
);

// ---------------------------------------------------------------------------
// KinTale reactions: a single love/heart toggle per kinfolk per tale, mirrors
// the mockup's "You and 2 others loved this" line (ui-ideas/
// mytribe-kintales-2026-05-31.html). Own subcollection
// (kin_care_reports/{taleId}/reactions/{uid}), not a field on the tale doc
// itself — that doc is AuntieOS-owned/written (see getMyKinTales.ts's
// "READ-ONLY. AuntieOS owns the writes." comment); comments already
// established the pattern of MyTribe-owned state living in its own
// subcollection alongside an AuntieOS-owned parent doc, and reactions
// follows the same convention. Doc id = uid, so "does this doc exist" IS
// "did this kinfolk react" — no separate exists-check field needed, and a
// toggle is just a delete-if-present-else-set.
// ---------------------------------------------------------------------------

const ReactionArgs = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
});

function reactionsCollection(taleId: string) {
  return db().collection(`kin_care_reports/${taleId}/reactions`);
}

async function reactionSummary(taleId: string, uid: string): Promise<{ loved: boolean; loveCount: number }> {
  const [mine, countSnap] = await Promise.all([
    reactionsCollection(taleId).doc(uid).get(),
    reactionsCollection(taleId).count().get(),
  ]);
  return { loved: mine.exists, loveCount: countSnap.data().count };
}

export async function getKinTaleReactionHandler(
  req: CallableRequest<unknown>,
): Promise<{ loved: boolean; loveCount: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ReactionArgs.parse(req.data);
  await resolveKinTaleAccess(args.taleId, uid, args.kinfolkId, req.auth?.token?.admin === true, 'getKinTaleReaction');
  return reactionSummary(args.taleId, uid);
}

export const getKinTaleReaction = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getKinTaleReaction', getKinTaleReactionHandler),
);

export async function toggleKinTaleLoveHandler(
  req: CallableRequest<unknown>,
): Promise<{ loved: boolean; loveCount: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ReactionArgs.parse(req.data);
  const { kinfolkId } = await resolveKinTaleAccess(args.taleId, uid, args.kinfolkId, req.auth?.token?.admin === true, 'toggleKinTaleLove');

  const ref = reactionsCollection(args.taleId).doc(uid);
  // Read the "before" state once — existence + count together — then derive
  // the "after" state locally instead of re-querying post-write. Firestore
  // reads aren't guaranteed to observe a write that just landed from the
  // same request in every SDK/emulator combination, so computing the delta
  // ourselves is both more correct and cheaper than a second round trip.
  const [existing, countSnap] = await Promise.all([ref.get(), reactionsCollection(args.taleId).count().get()]);
  const beforeCount = countSnap.data().count;

  let result: { loved: boolean; loveCount: number };
  if (existing.exists) {
    await ref.delete();
    result = { loved: false, loveCount: Math.max(0, beforeCount - 1) };
  } else {
    await ref.set({ createdAt: FieldValue.serverTimestamp(), createdAtMs: Date.now() });
    result = { loved: true, loveCount: beforeCount + 1 };
  }

  logEvent({
    severity: 'info',
    function: 'toggleKinTaleLove',
    event: 'portal.kintale.reaction.toggled',
    uid,
    extra: { kinfolkId, taleId: args.taleId, loved: result.loved },
  });
  return result;
}

export const toggleKinTaleLove = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('toggleKinTaleLove', toggleKinTaleLoveHandler),
);
