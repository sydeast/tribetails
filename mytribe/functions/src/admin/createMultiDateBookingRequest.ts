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
import { writeEnvelope, resolveService, loadServicePriceBook, type NormalizedVisit } from '../portal/requestBooking';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { validateResponse } from '../lib/callableResponse';
import { IdempotencyKeyArg, lookupIdempotentEnvelope } from '../lib/bookingIdempotency';

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
 * what `billing` and `communication` mean, and for why a visit carries no
 * address; this file does not restate it.
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
});

/**
 * The REAL request schema, used for actual `.parse()`. Unchanged by the
 * ADR-0003 follow-up: see `export const Args` below for what changed and why
 * it is safe.
 */
const HandlerArgs = z.object({
  kinfolkId: z.string().min(1),
  /**
   * #644: the caller-minted booking id that makes retrying this callable safe.
   * See `lib/bookingIdempotency.ts` for the whole argument. Optional, so the
   * frozen legacy payload below still parses and the four clients can adopt it
   * one at a time.
   */
  idempotencyKey: IdempotencyKeyArg,
  kinIds: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  pattern: z.enum(['individual', 'weekly']).optional(),
  weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
  visits: z.array(VisitArgs).min(1).max(60),
  billing: z.object({ mode: z.enum(['new-invoice']) }).optional(),
  communication: z
    .object({ emailConfirmation: z.boolean(), timeVisibility: z.boolean() })
    .optional(),
  /**
   * Additive, optional. The admin booking picker (`NewBookingDialog.tsx` /
   * `bookingAvailability.ts`) already treats a busy-block clash as a warning
   * the operator can knowingly submit past, never a hard stop ("the operator
   * is the business"). This is that same affordance, honored server-side: a
   * real `GOOGLE_BUSY_IMPORT` conflict refuses the request unless this is
   * `true`, in which case it is written anyway and audited
   * (`BOOKING_BUSY_CONFLICT_OVERRIDDEN`). Never set by `requestBooking`,
   * which has no override precedent for a kinfolk-initiated request.
   */
  overrideBusyConflict: z.boolean().optional(),
});

/**
 * The EXPORTED, registry-facing request schema (ADR-0003 follow-up).
 *
 * `HandlerArgs` above mirrors `requestBooking`'s `VisitArgs` field for field
 * (see the module header), including the same `.nullable().optional()`
 * combination on `endTimeMs`, `serviceId` and `priceCents`.
 * `readModel.ts` refuses that combination outright: Kotlin's one `T?` cannot
 * distinguish "key omitted" from "key sent null", and on a PATCH those two
 * differ. This callable is a CREATE, not a patch, so they already mean the
 * same thing to the handler, and narrowing the GENERATED shape to one of the
 * two costs nothing real. Below, every such field is always-present and
 * nullable instead: the generated client always sends the key, `null` when
 * there is no value.
 *
 * SAFETY PROPERTY: every payload this schema can produce also satisfies
 * `HandlerArgs`, so a generated client can never build a request the real
 * parser rejects.
 */
const ExportedVisitArgs = z
  .object({
    startTimeMs: z.number().int().positive(),
    endTimeMs: z.number().int().positive().nullable(),
    serviceId: z.string().min(1).nullable(),
    serviceName: z.string().min(1).max(120),
    priceCents: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const Args = z
  .object({
    kinfolkId: z.string().min(1),
    /** #644. Optional here for the same reason it is optional on HandlerArgs. */
    idempotencyKey: IdempotencyKeyArg,
    kinIds: z.array(z.string()).optional(),
    notes: z.string().max(1000).optional(),
    pattern: z.enum(['individual', 'weekly']).optional(),
    weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
    visits: z.array(ExportedVisitArgs).min(1).max(60),
    billing: z.object({ mode: z.enum(['new-invoice']) }).optional(),
    communication: z
      .object({ emailConfirmation: z.boolean(), timeVisibility: z.boolean() })
      .optional(),
    overrideBusyConflict: z.boolean().optional(),
  })
  .strict();

export const Result = z
  .object({
    batchId: z.string().min(1),
    visitIds: z.array(z.string().min(1)),
    visitCount: z.number().int().nonnegative(),
  })
  .strict();

export async function createMultiDateBookingRequestHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = HandlerArgs.parse(req.data);

  // Fail loud on a bad household id rather than writing an orphan envelope under
  // families/{kinfolkId} that the directory will never surface.
  const kinSnap = await db().collection('kinfolk').doc(args.kinfolkId).get();
  if (!kinSnap.exists) {
    throw new HttpsError('not-found', `Kinfolk not found: ${args.kinfolkId}`);
  }

  // #644: a retry of a submission that already landed returns what it stored,
  // and re-runs none of the guards below. See `lookupIdempotentEnvelope` for
  // why re-running them is not merely wasteful: the operator's own retry after
  // a visible error can trip the future-start check on a booking that is
  // already written and fine.
  const replayed = await lookupIdempotentEnvelope({
    kinfolkId: args.kinfolkId,
    key: args.idempotencyKey,
    uid,
  });
  if (replayed) {
    logEvent({
      severity: 'info',
      function: 'createMultiDateBookingRequest',
      event: 'admin.booking.requested.deduped',
      uid,
      extra: { kinfolkId: args.kinfolkId, batchId: replayed.batchId, count: replayed.visitCount },
    });
    return validateResponse('createMultiDateBookingRequest', Result, replayed);
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
  await guardBookingBusyConflict({
    firestore: db(),
    visits: args.visits,
    actorUid: uid,
    actorRole: 'AUNTIE',
    override: args.overrideBusyConflict,
    auditContext: { kinfolkId: args.kinfolkId },
  });
  // A closed day always refuses the request, admin-created or not -- no
  // override. See companyHolidayConflict.ts's header for why.
  await guardCompanyHolidayConflict({ firestore: db(), visits: args.visits });

  const pattern = args.pattern ?? 'individual';
  // resolveService: the catalog wins for name + price; a client priceCents is
  // never trusted (NOTE-56). An admin who omits serviceId gets a display-only
  // serviceName and price resolved at invoice time. #546: the catalog is read
  // once per request through the same price book the portal write path uses, so
  // `serviceRates` — where this business's real prices live — resolves here too
  // instead of missing into a null price.
  const priceBook = await loadServicePriceBook();
  const normalized: NormalizedVisit[] = await Promise.all(
    args.visits.map(async (v) => {
      const resolved = await resolveService(v.serviceId ?? null, v.serviceName, priceBook);
      return {
        startTimeMs: v.startTimeMs,
        endTimeMs: v.endTimeMs ?? null,
        serviceId: v.serviceId ?? null,
        serviceName: resolved.serviceName,
        priceCents: resolved.priceCents,
        title: resolved.serviceName ?? v.serviceName,
      };
    }),
  );

  // #644: the caller's key IS the envelope id when it sent one. Without one
  // this is the same server-minted id it has always been, and the dedupe read
  // inside `writeEnvelope` can never hit.
  const batchId = args.idempotencyKey ?? `req_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const { visitIds, deduped } = await writeEnvelope({
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

  if (deduped) {
    // Lost a race with this submission's OWN other attempt: the fast path above
    // missed because the winner had not committed yet, and the transaction
    // guard caught it instead. The winner already wrote the audit row, so this
    // attempt writes none -- a second BOOKING_SUBMITTED for one booking is the
    // duplicate #644 exists to prevent.
    logEvent({
      severity: 'info',
      function: 'createMultiDateBookingRequest',
      event: 'admin.booking.requested.deduped',
      uid,
      extra: { kinfolkId: args.kinfolkId, batchId, count: visitIds.length, race: true },
    });
    return validateResponse('createMultiDateBookingRequest', Result, {
      batchId,
      visitIds,
      visitCount: visitIds.length,
    });
  }

  logEvent({
    severity: 'info',
    function: 'createMultiDateBookingRequest',
    event: 'admin.booking.requested.multi',
    uid,
    extra: { kinfolkId: args.kinfolkId, batchId, count: normalized.length, pattern },
  });
  await writeAuditEntry({
    status: 'SUCCESS',
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

  return validateResponse('createMultiDateBookingRequest', Result, {
    batchId,
    visitIds,
    visitCount: normalized.length,
  });
}

export const createMultiDateBookingRequest = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createMultiDateBookingRequest', createMultiDateBookingRequestHandler),
);
