import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinNames } from '../lib/resolveKinNames';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';

/**
 * 1E §A.9: server-bound creation of a kin_care_sessions doc (scheduleNewVisit).
 * Replaces client-side session writes so the audit entry is issued server-side
 * and structurally bound to the actual mutation (matches the triageOrphanReport
 * pattern). Gated by wrapAdminCallable (admin custom claim).
 */
const Args = z.object({
  kinfolkId: z.string().min(1).max(120),
  kinIds: z.array(z.string().min(1).max(120)).max(50).default([]),
  serviceType: z.string().min(1).max(120),
  startTime: z.string().min(1).max(40),
  endTime: z.string().min(1).max(40),
  serviceDurationMinutes: z.number().int().min(0).max(24 * 60).optional(),
  notes: z.string().max(4000).optional(),
  /** Additive, optional. See `overrideBusyConflict` on `createMultiDateBookingRequest.ts` Args for the full rationale; this is the same admin-only escape hatch. */
  overrideBusyConflict: z.boolean().optional(),
});

export interface CreateKinCareSessionResult {
  ok: true;
  sessionId: string;
}

export async function createKinCareSessionHandler(
  req: CallableRequest<unknown>,
): Promise<CreateKinCareSessionResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'createKinCareSession validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  await guardBookingBusyConflict({
    firestore: db(),
    visits: [{ startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) }],
    actorUid: uid,
    actorRole: 'AUNTIE',
    override: args.overrideBusyConflict,
    auditContext: { kinfolkId: args.kinfolkId },
  });

  const kinNames = await resolveKinNames(args.kinfolkId, args.kinIds);
  const ref = await db().collection('kin_care_sessions').add({
    kinfolkId: args.kinfolkId,
    kinIds: args.kinIds,
    kinNames,
    serviceType: args.serviceType,
    startTime: args.startTime,
    endTime: args.endTime,
    serviceDurationMinutes: args.serviceDurationMinutes ?? 0,
    notes: args.notes ?? '',
    status: 'SCHEDULED',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.CREATE_KINCARE_SESSION,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { sessionId: ref.id, kinfolkId: args.kinfolkId, serviceType: args.serviceType, startTime: args.startTime },
  });

  logEvent({
    severity: 'info',
    function: 'createKinCareSession',
    event: 'admin.kinCareSession.created',
    uid,
    extra: { sessionId: ref.id, kinfolkId: args.kinfolkId },
  });

  return { ok: true, sessionId: ref.id };
}

export const createKinCareSession = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createKinCareSession', createKinCareSessionHandler),
);
