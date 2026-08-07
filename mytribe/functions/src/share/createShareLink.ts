import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { isStaff } from '../lib/staffGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { SHARE_DEFAULT_TTL_DAYS } from '../lib/schema';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';

const Args = z.object({
  familyId: z.string().min(1),
  kinTaleId: z.string().min(1),
  includePhotos: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  passcode: z.string().min(4).max(8).optional(),
});

export async function createShareLinkHandler(req: CallableRequest<unknown>): Promise<{ shareId: string; shareUrl: string }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);

  // Fail loud before any Firestore write. Without this guard the handler
  // creates the sharedKinTales doc, arrayUnions it onto the kinTale, and
  // writes a SUCCESS audit entry, then returns the literal string
  // "undefined/<id>" as the share URL — a broken link backed by a record
  // and an audit trail both claiming success. There is no safe default
  // share domain to fall back to: guessing one would mint links pointing
  // at a host that may not serve them, which is the silent degradation
  // the repo's fail-loud rule forbids. A misconfigured deploy is not the
  // caller's fault, hence failed-precondition rather than invalid-argument.
  // A trailing slash is an operator typo in an env var, not a caller
  // input, and stripping it still produces a correct URL — so this
  // normalizes rather than rejects, per the fail-loud priority order
  // (works correctly > fails visibly > silent degradation). Normalize
  // BEFORE the emptiness check: a value of "/" or "///" is truthy but
  // strips down to "", and must be treated the same as unset rather than
  // slipping through to build a broken relative URL.
  const shareBaseUrl = (process.env.SHARE_LINK_BASE_URL ?? '').replace(/\/+$/, '');
  if (!shareBaseUrl) {
    throw new HttpsError('failed-precondition', 'SHARE_LINK_BASE_URL is not configured');
  }

  // The AuntieOS operator (auntie) authors KinTales and shares them; she is not a
  // tribe member, so she bypasses the family PRIMARY gate. Family PRIMARY members
  // can still create share links for their own tribe.
  if (!isStaff(req.auth.uid, req.auth.token?.admin === true, 'createShareLink')) {
    const caller = await loadMember(args.familyId, req.auth.uid);
    requirePrimary(caller);
  }
  const taleSnap = await db().doc(`kin_care_reports/${args.kinTaleId}`).get();
  if (!taleSnap.exists) throw new HttpsError('not-found', 'kinTale not found');
  const tale = taleSnap.data() as { bodyCopy?: string; mediaFileIds?: string[]; authorDisplayName?: string; kinfolkId?: string };
  if (tale.kinfolkId !== args.familyId) throw new HttpsError('not-found', 'kinTale not found');
  const days = args.expiresInDays ?? SHARE_DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + days * 86400 * 1000);
  const photos: string[] = [];
  if (args.includePhotos && tale.mediaFileIds?.length) {
    for (const id of tale.mediaFileIds) {
      const m = await db().doc(`media_files/${id}`).get();
      if (!m.exists) continue;
      const md = m.data() as { storageUrl?: string };
      if (md.storageUrl) photos.push(md.storageUrl);
    }
  }
  const passcodeHash = args.passcode ? await argon2.hash(args.passcode) : undefined;
  const ref = await db().collection('sharedKinTales').add({
    tribeId: args.familyId,
    sourceKinTaleId: args.kinTaleId,
    scrubbedPayload: {
      authorDisplayName: tale.authorDisplayName ?? 'Auntie',
      body: tale.bodyCopy ?? '',
      photos,
    },
    includePhotos: args.includePhotos,
    expiresAt,
    passcodeHash: passcodeHash ?? null,
    revoked: false,
    createdBy: req.auth.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  await db().doc(`kin_care_reports/${args.kinTaleId}`).update({
    sharedAsIds: FieldValue.arrayUnion(ref.id),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CONTENT_SHARE_LINK_CREATED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    familyId: args.familyId,
    payload: { shareId: ref.id, kinTaleId: args.kinTaleId, includePhotos: args.includePhotos, hasPasscode: !!args.passcode },
  });
  const shareUrl = `${shareBaseUrl}/${ref.id}`;
  return { shareId: ref.id, shareUrl };
}

export const createShareLink = onCall(
  // Hashes the share passcode.
  // argon2id: measured 136ms of CPU per hash at parallelism 4, so a quarter
  // vCPU would stretch it past half a second of wall clock.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['TRIBE_PIN_PEPPER', 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    ...FULL_CPU,
  },
  wrapCallable('createShareLink', createShareLinkHandler),
);
