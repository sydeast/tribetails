import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPerm } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';

/** Only http(s) URLs allowed, defends against javascript:, data:, file: payloads. */
const SafeUrl = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//i.test(s), { message: 'photoUrl must be http or https' });

const KinPayload = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .refine((s) => s.trim().length > 0, { message: 'name cannot be whitespace-only' }),
  species: z.string().max(40).nullable().optional(),
  breed: z.string().max(80).nullable().optional(),
  ageYears: z.number().nonnegative().nullable().optional(),
  photoUrl: SafeUrl.nullable().optional(),
  feedingInstructions: z.string().max(2000).nullable().optional(),
  walkingInstructions: z.string().max(2000).nullable().optional(),
  medications: z.string().max(2000).nullable().optional(),
  allergies: z.string().max(2000).nullable().optional(),
  emergencyNotes: z.string().max(2000).nullable().optional(),
  sitterNotes: z.string().max(2000).nullable().optional(),
  legacyKinId: z.string().max(40).nullable().optional(),
});

const AddArgs = z.object({
  kinfolkId: z.string().optional(),
  kin: KinPayload,
});
const UpdateArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: z.string().min(1),
  kin: KinPayload.partial(),
});
const ArchiveArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: z.string().min(1),
  reason: z.enum(['noLongerWithUs', 'restore']),
});

// Was a hard clients/{uid}.kinfolkIds check with no staff path: an operator
// impersonating a household got permission-denied here, before ever reaching
// requireKinfolkPerm below (which already knew how to bypass staff). Now
// delegates to the same resolver the read side uses, so staff (admin claim OR
// the AUNTIE_OPERATOR_UIDS allowlist) resolve any existing kinfolkId, and a
// cross-tenant resolution is audit-logged inside the resolver itself.
async function resolveKinfolkId(
  uid: string,
  requested: string | undefined,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<string> {
  const { kinfolkId } = await resolveKinfolkAccess(uid, requested, hasAdminClaim, functionName);
  return kinfolkId;
}

export async function addKinHandler(req: CallableRequest<unknown>): Promise<{ kinId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = AddArgs.parse(req.data);
  const hasAdminClaim = req.auth?.token?.admin === true;
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'addKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'addKin');

  const ref = await db().collection(`families/${kinfolkId}/kin`).add({
    ...args.kin,
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdByUid: uid,
  });
  logEvent({ severity: 'info', function: 'addKin', event: 'portal.kin.added', uid, extra: { kinfolkId, kinId: ref.id } });
  return { kinId: ref.id };
}

export async function updateKinHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = UpdateArgs.parse(req.data);
  const hasAdminClaim = req.auth?.token?.admin === true;
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'updateKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'updateKin');

  await db().doc(`families/${kinfolkId}/kin/${args.kinId}`).set(
    {
      ...args.kin,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    },
    { merge: true },
  );
  logEvent({ severity: 'info', function: 'updateKin', event: 'portal.kin.updated', uid, extra: { kinfolkId, kinId: args.kinId } });
  return { ok: true };
}

export async function archiveKinHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ArchiveArgs.parse(req.data);
  const hasAdminClaim = req.auth?.token?.admin === true;
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'archiveKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'archiveKin');

  const status = args.reason === 'restore' ? 'active' : 'noLongerWithUs';
  await db().doc(`families/${kinfolkId}/kin/${args.kinId}`).set(
    {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    },
    { merge: true },
  );
  logEvent({ severity: 'info', function: 'archiveKin', event: 'portal.kin.archived', uid, extra: { kinfolkId, kinId: args.kinId, status } });
  return { ok: true };
}

export const addKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('addKin', addKinHandler),
);
export const updateKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('updateKin', updateKinHandler),
);
export const archiveKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('archiveKin', archiveKinHandler),
);
