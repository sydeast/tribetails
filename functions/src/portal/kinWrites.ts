import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPerm } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';

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

async function resolveKinfolkId(uid: string, requested: string | undefined): Promise<string> {
  const clientSnap = await db().collection('clients').doc(uid).get();
  const allowed: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowed.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');
  const kinfolkId = requested ?? allowed[0];
  if (!allowed.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');
  return kinfolkId;
}

export async function addKinHandler(req: CallableRequest<unknown>): Promise<{ kinId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = AddArgs.parse(req.data);
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId);
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', req.auth?.token?.admin === true, 'addKin');

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
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId);
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', req.auth?.token?.admin === true, 'updateKin');

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
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId);
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', req.auth?.token?.admin === true, 'archiveKin');

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
