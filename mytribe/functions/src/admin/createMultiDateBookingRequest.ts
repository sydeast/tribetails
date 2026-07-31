import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveDefaultAssignee } from '../lib/defaultAssignee';
import { writeEnvelope, resolveService, type NormalizedVisit } from '../portal/requestBooking';

/**
 * AO-25: admin-side multi-date / recurring booking request.
 *
 * The kinfolk-facing `requestBooking` already writes a multi-visit envelope for
 * arbitrary (non-consecutive) dates and a `pattern:'weekly'` recurrence, but it
 * is gated on the CALLER being a kinfolk (`clients/{uid}.kinfolkIds`), so an
 * admin cannot create a booking on a household's behalf through it. This is the
 * admin equivalent: same envelope model, same per-visit service resolution and
 * time validation, but authenticated as staff and targeting an arbitrary
 * `kinfolkId`. It REUSES `requestBooking`'s `writeEnvelope`/`resolveService`
 * rather than duplicating the envelope shape, so an admin-created request is
 * byte-for-byte the same document a kinfolk-created one is and flows through the
 * identical approve path (manageBookingSeries / approveBookingSeriesCore).
 *
 * "Multi-date" = one entry per visit in `visits[]`, each with its own
 * `startTimeMs`, so non-consecutive dates need no special handling. "Recurring"
 * = the caller expands the weekly pattern into concrete visits client-side (the
 * same contract requestBooking's wizard uses) and passes `pattern:'weekly'` +
 * `weeklyDays` as envelope metadata; this callable stores the concrete visits.
 *
 * Created as `envelopeStatus:'requested'` (writeEnvelope's fixed status), so an
 * admin-created request lands in the same Incoming-requests queue for an
 * explicit approve, rather than silently auto-confirming sessions.
 */
/**
 * MIRRORS `requestBooking`'s VisitArgs/MultiArgs field for field, on purpose:
 * the two callables write the same envelope through the same `writeEnvelope`,
 * so a field one accepts and the other rejects would mean a booking an operator
 * can file and a household cannot, or the reverse. See requestBooking.ts for
 * what `location`, `billing` and `communication` mean and why each is shaped
 * the way it is; this file does not restate it.
 *
 * `serviceId` is the one deliberate difference and predates this: the admin may
 * omit it (a service the operator has not put in the catalog yet), where the
 * portal requires it.
 *
 * Every field added here is OPTIONAL, which is what keeps the frozen legacy
 * payload valid: the single-page dialog that shipped before the wizard sends
 * `{ kinfolkId, visits: [{ startTimeMs, serviceName }] }` and nothing else, and
 * there is a test that fails if it ever stops parsing.
 */
const VisitArgs = z.object({
  startTimeMs: z.number().int().positive(),
  endTimeMs: z.number().int().positive().nullable().optional(),
  serviceId: z.string().min(1).nullable().optional(),
  serviceName: z.string().min(1).max(120),
  priceCents: z.number().int().nonnegative().nullable().optional(),
  location: z.string().trim().min(1).max(120).nullable().optional(),
});

const Args = z.object({
  kinfolkId: z.string().min(1),
  kinIds: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  pattern: z.enum(['individual', 'weekly']).optional(),
  weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
  visits: z.array(VisitArgs).min(1).max(60),
  billing: z.object({ mode: z.enum(['new-invoice']) }).optional(),
  communication: z
    .object({ emailConfirmation: z.boolean(), timeVisibility: z.boolean() })
    .optional(),
});

export async function createMultiDateBookingRequestHandler(
  req: CallableRequest<unknown>,
): Promise<{ batchId: string; visitIds: string[]; visitCount: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  // Fail loud on a bad household id rather than writing an orphan envelope under
  // families/{kinfolkId} that the directory will never surface.
  const kinSnap = await db().collection('kinfolk').doc(args.kinfolkId).get();
  if (!kinSnap.exists) {
    throw new HttpsError('not-found', `Kinfolk not found: ${args.kinfolkId}`);
  }

  const now = Date.now();
  args.visits.forEach((v) => {
    if (v.startTimeMs < now - 60_000) {
      throw new HttpsError('invalid-argument', 'Every visit startTime must be in the future.');
    }
    if (v.endTimeMs && v.endTimeMs <= v.startTimeMs) {
      throw new HttpsError('invalid-argument', 'endTime must be after startTime.');
    }
  });

  const pattern = args.pattern ?? 'individual';
  // resolveService: the base_services catalog wins for name + price; a client
  // priceCents is never trusted (NOTE-56). An admin who omits serviceId gets a
  // display-only serviceName and price resolved at invoice time.
  const normalized: NormalizedVisit[] = await Promise.all(
    args.visits.map(async (v) => {
      const resolved = await resolveService(v.serviceId ?? null, v.serviceName);
      return {
        startTimeMs: v.startTimeMs,
        endTimeMs: v.endTimeMs ?? null,
        serviceId: v.serviceId ?? null,
        serviceName: resolved.serviceName,
        priceCents: resolved.priceCents,
        title: resolved.serviceName ?? v.serviceName,
        location: v.location ?? null,
      };
    }),
  );

  const batchId = `req_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const { visitIds } = await writeEnvelope({
    kinfolkId: args.kinfolkId,
    uid,
    batchId,
    pattern,
    weeklyDays: args.weeklyDays ?? null,
    kinIds: args.kinIds ?? [],
    notes: args.notes ?? null,
    visits: normalized,
    assignee: await resolveDefaultAssignee(),
    billing: args.billing ?? null,
    ...(args.communication ? { communication: args.communication } : {}),
  });

  logEvent({
    severity: 'info',
    function: 'createMultiDateBookingRequest',
    event: 'admin.booking.requested.multi',
    uid,
    extra: { kinfolkId: args.kinfolkId, batchId, count: normalized.length, pattern },
  });
  await writeAuditEntry({
    event: AUDIT_EVENTS.BOOKING_SUBMITTED,
    severity: 'info',
    // The operator/admin acts as AUNTIE in the audit vocabulary (ActorRole has
    // no ADMIN member); requestBooking uses PRIMARY for the kinfolk themselves.
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: batchId,
    targetCollection: `families/${args.kinfolkId}/bookings/${batchId}`,
    description: `Admin created ${normalized.length} visit(s) (${pattern}) for ${args.kinfolkId}`,
    payload: { kinfolkId: args.kinfolkId, batchId, count: normalized.length, pattern, requestBatchId: batchId },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'createMultiDateBookingRequest',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { batchId, visitIds, visitCount: normalized.length };
}

export const createMultiDateBookingRequest = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createMultiDateBookingRequest', createMultiDateBookingRequestHandler),
);
