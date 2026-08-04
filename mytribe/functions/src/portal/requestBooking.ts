import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { approveBookingSeriesCore } from '../admin/approveBookingSeriesCore';
import { resolveDefaultAssignee, type Assignee } from '../lib/defaultAssignee';
import { materializeKinRoster } from '../lib/kinRoster';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { validateResponse } from '../lib/callableResponse';

/**
 * #9 (2026-06-08): Auto-confirm repeat kinfolk. When the operator turns on
 * `business_settings/business_settings.autoConfirmRepeatKinfolk` AND the kinfolk
 * has booked before (a prior envelope exists), a new request is confirmed
 * immediately, skipping the manual Incoming-requests queue. This reuses the same
 * approve core as manageBookingSeries (creates sessions + rolls the envelope), so
 * an auto-confirmed booking is indistinguishable from an admin-approved one.
 *
 * Fail-safe: any failure (setting read, repeat check, or approve) leaves the
 * series 'requested' so it falls back to the manual queue. Never throws.
 */
async function maybeAutoConfirm(kinfolkId: string, batchId: string, uid: string): Promise<void> {
  try {
    const settingsSnap = await db().collection('business_settings').doc('business_settings').get();
    const autoConfirm = settingsSnap.data()?.autoConfirmRepeatKinfolk === true;
    if (!autoConfirm) return;

    // Repeat kinfolk = has at least one prior booking envelope (other than this one).
    const priorSnap = await db().collection(`families/${kinfolkId}/bookings`).limit(2).get();
    const isRepeat = priorSnap.docs.some((d) => d.id !== batchId);
    if (!isRepeat) return;

    const r = await approveBookingSeriesCore({ kinfolkId, batchId, actorUid: uid, actorRole: 'SYSTEM' });
    logEvent({
      severity: 'info', function: 'requestBooking', event: 'portal.booking.autoConfirmed',
      uid, extra: { kinfolkId, batchId, sessionsCreated: r.sessionsCreated, failedVisits: r.failedVisits },
    });
  } catch (err) {
    // Fail-safe: leave the booking in the manual queue rather than dropping it.
    logEvent({
      severity: 'warn', function: 'requestBooking', event: 'autoConfirm.failed',
      uid, extra: { kinfolkId, batchId }, errorMessage: (err as Error)?.message,
    });
  }
}

/** Single-visit (legacy) shape, kept for backward compat. */
const LegacyArgs = z.object({
  kinfolkId: z.string().optional(),
  serviceType: z.string().min(1),
  title: z.string().optional(),
  startTimeMs: z.number().int().positive(),
  endTimeMs: z.number().int().positive().nullable().optional(),
  kinIds: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * Multi-visit (new wizard) shape.
 *
 * A VISIT CARRIES NO ADDRESS, and never will. Operator ruling, 2026-08-04:
 * addresses come from the household. `optimizeRoute.ts` and every navigation
 * affordance already read `serviceAddress` / `homeAddress` / `address` off the
 * household doc and nothing else, so a per-visit place field was an override
 * for an address the booking is not the authority on.
 *
 * This schema is deliberately NOT `.strict()`, which is what makes the removal
 * safe to deploy ahead of the clients: a cached wizard that still sends
 * `location` has the key stripped by zod rather than being refused.
 */
const VisitArgs = z.object({
  startTimeMs: z.number().int().positive(),
  endTimeMs: z.number().int().positive().nullable().optional(),
  serviceId: z.string().min(1),
  serviceName: z.string().min(1).max(120),
  priceCents: z.number().int().nonnegative().nullable().optional(),
});

/**
 * HOW the booking is meant to be billed, recorded as the operator's stated
 * intent, NOT as an instruction this callable acts on.
 *
 * The enum has exactly one member because the wizard's Review step offers
 * exactly one choice: "New Invoice". A second member would be a branch nothing
 * can produce, nothing has tested, and no reader could tell was real. Adding
 * one is a schema change AND a UI change, together.
 *
 * Nothing here raises an invoice. This system has no path that turns an
 * approved booking into an invoice automatically: invoices are created by
 * `createInvoice` and the completed sessions are attached with
 * `linkInvoiceSessions`. Persisting the preference is what lets that later step
 * know what was promised, and the wizard's own copy says so rather than
 * claiming an invoice appears on its own.
 */
const BillingArgs = z
  .object({
    mode: z.enum(['new-invoice']),
  })
  .optional();

/**
 * What the household is told, and how much of it.
 *
 * Both default FALSE, per the mock, which shows both with a red cross:
 * "Email confirmation: Won't send" and "Time visibility: Time windows".
 *
 *   emailConfirmation  send the household a confirmation email for this
 *                      booking. Off means the operator is telling them another
 *                      way.
 *   timeVisibility     show the household the EXACT start time of each visit.
 *                      Off means they see the time window instead, which is the
 *                      honest thing to show when an Auntie's arrival depends on
 *                      the visit before it.
 *
 * Optional as a whole: an absent object means both false, so a legacy payload
 * and an explicit `{ emailConfirmation: false, timeVisibility: false }` persist
 * identically. Neither field is optional WITHIN the object: a half-specified
 * preference is a caller bug, and defaulting one of two booleans silently is
 * how a household gets an email nobody chose to send.
 */
const CommunicationArgs = z
  .object({
    emailConfirmation: z.boolean(),
    timeVisibility: z.boolean(),
  })
  .optional();

const MultiArgs = z.object({
  kinfolkId: z.string().optional(),
  kinIds: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
  pattern: z.enum(['individual', 'weekly']).optional(),
  weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
  visits: z.array(VisitArgs).min(1),
  billing: BillingArgs,
  communication: CommunicationArgs,
});

/**
 * ADR-0003's requestBooking decision: COLLAPSE, not union.
 *
 * The registry (`scripts/contracts/registry.ts`) models one `args` schema per
 * callable, and `readModel.ts` refuses anything whose root is not a single
 * `z.object` (a `z.union` hits its `default` case and throws naming the
 * construct). `MultiArgs` and `LegacyArgs` above are genuinely two different
 * shapes, kept exactly as they are: this handler still dispatches on
 * `Array.isArray(data.visits)` and parses through whichever one matches,
 * UNCHANGED by anything below.
 *
 * `Args` here is a THIRD, separate schema: the superset of both, used ONLY by
 * the registry for contract generation, never for parsing. Checked against
 * what actually calls this callable (`mytribe/web/src/api/bookingApi.ts`,
 * the kinfolk portal's only caller): every live request is `MultiArgs`
 * shaped. Nothing sends the legacy single-visit shape today; `LegacyArgs`
 * is dead-letter back-compat for whatever cached client or webhook still
 * might. A union would document a live fork that does not exist; a superset
 * documents the one shape clients actually build while still typing the
 * legacy fields for the caller that needs them.
 *
 * SAFETY PROPERTY: every payload `Args` can produce also parses under
 * `MultiArgs` or `LegacyArgs`. Two fields are deliberately narrower here than
 * the branch schemas allow, because `readModel.ts` refuses a field that is
 * both `.nullable()` and `.optional()` (Kotlin's one `T?` cannot tell "key
 * omitted" from "key sent null", and on a PATCH those differ). Neither
 * branch here is a patch -- this is a create, so "omitted" and "sent null"
 * already mean the same thing to the handler -- so narrowing the GENERATED
 * shape to one of the two costs nothing real:
 *   - `visits[].endTimeMs` / `priceCents`: always-present, nullable (the
 *     generated client always sends the key, `null` when there is no value),
 *     never omitted.
 *   - the legacy flat `endTimeMs`: optional, never asserted `null` (a
 *     generated legacy caller either has an end time or leaves the key out).
 */
const ExportedVisitArgs = z
  .object({
    startTimeMs: z.number().int().positive(),
    endTimeMs: z.number().int().positive().nullable(),
    serviceId: z.string().min(1),
    serviceName: z.string().min(1).max(120),
    priceCents: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const Args = z
  .object({
    kinfolkId: z.string().optional(),
    kinIds: z.array(z.string()).optional(),
    notes: z.string().max(1000).optional(),
    pattern: z.enum(['individual', 'weekly']).optional(),
    weeklyDays: z.array(z.number().int().min(0).max(6)).optional(),
    /** Multi-visit (preferred) shape. Present <=> this is a multi-visit request. */
    visits: z.array(ExportedVisitArgs).optional(),
    billing: BillingArgs,
    communication: CommunicationArgs,
    /** Legacy single-visit shape. See the header above: no live caller sends this today. */
    serviceType: z.string().min(1).optional(),
    title: z.string().optional(),
    startTimeMs: z.number().int().positive().optional(),
    endTimeMs: z.number().int().positive().optional(),
  })
  .strict();

/** The billing preference as persisted. `null` when the caller stated none. */
export type BookingBilling = { mode: 'new-invoice' } | null;

/** The communication preference as persisted. Always concrete, never null. */
export interface BookingCommunication {
  emailConfirmation: boolean;
  timeVisibility: boolean;
}

/** Both preferences default to the mock's OFF, so an absent object is not an absent decision. */
export const COMMUNICATION_DEFAULT: BookingCommunication = {
  emailConfirmation: false,
  timeVisibility: false,
};

/**
 * Both write paths (multi and legacy) return the identical shape, and both
 * always set `bookingId` -- the interface this replaced marked it optional,
 * but nothing on this file has ever returned without it, so the schema below
 * describes what actually ships rather than carrying a `?` no caller needs.
 */
export const Result = z
  .object({
    /** The envelope id (parent `bookings/{batchId}` doc). */
    batchId: z.string().min(1),
    /**
     * Legacy multi-id alias. In the envelope model this is `[batchId]`, callers
     * that grouped by the returned ids now get the single envelope id.
     */
    bookingIds: z.array(z.string().min(1)).min(1),
    /** Legacy single-id alias, always `batchId` today. */
    bookingId: z.string().min(1),
  })
  .strict();

/** Normalized per-visit input the envelope writer consumes. */
export interface NormalizedVisit {
  startTimeMs: number;
  endTimeMs: number | null;
  serviceId: string | null;
  serviceName: string | null;
  priceCents: number | null;
  title: string | null;
}

/**
 * NOTE-56: resolve `serviceName` + `priceCents` SERVER-SIDE from the canonical
 * `base_services/{serviceId}` catalog. A kinfolk client must never be trusted
 * to supply its own price (it could send `priceCents: 0`) or an arbitrary
 * service label. When the serviceId resolves, the catalog value wins; the
 * client-supplied `priceCents` is ignored entirely.
 *
 * When the serviceId is absent or not in the catalog we set `priceCents = null`
 * and let pricing be resolved downstream at invoice time, rather than persist a
 * client-asserted amount. The client `serviceName` is used only as a display
 * fallback label when the catalog has no entry.
 */
export async function resolveService(
  serviceId: string | null,
  clientServiceName: string | null,
): Promise<{ serviceName: string | null; priceCents: number | null }> {
  if (!serviceId) {
    return { serviceName: clientServiceName, priceCents: null };
  }
  const snap = await db().collection('base_services').doc(serviceId).get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data) {
    // Unknown serviceId -> do NOT trust a client price. Resolve at invoice time.
    logEvent({
      severity: 'warn',
      function: 'requestBooking',
      event: 'service.resolve.miss',
      extra: { serviceId },
    });
    return { serviceName: clientServiceName, priceCents: null };
  }
  const canonicalName = typeof data['name'] === 'string' && (data['name'] as string).length > 0
    ? (data['name'] as string)
    : clientServiceName;
  const rawPrice = data['priceCents'];
  const priceCents =
    typeof rawPrice === 'number' && isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : null;
  return { serviceName: canonicalName, priceCents };
}

/**
 * Writes one parent envelope `families/{kinfolkId}/bookings/{batchId}` plus one
 * `kinCares/{visitId}` per visit inside a single transaction. Envelope-level
 * fields are rolled up from the visit list.
 */
export async function writeEnvelope(opts: {
  kinfolkId: string;
  uid: string;
  batchId: string;
  pattern: 'individual' | 'weekly';
  weeklyDays: number[] | null;
  /**
   * The Kin the caller NAMED. Empty means the caller named none, which under
   * R1 means the whole household and is materialized into the concrete roster
   * below. It is never persisted as `[]`.
   */
  kinIds: string[];
  notes: string | null;
  visits: NormalizedVisit[];
  /** Default-assignee (2026-07-02): the Auntie every new visit starts assigned to. */
  assignee: Assignee | null;
  /** Stated billing intent, or null when the caller stated none. */
  billing?: BookingBilling;
  /** Stated communication preference. Absent means both false, never "unknown". */
  communication?: BookingCommunication;
}): Promise<{ batchId: string; visitIds: string[] }> {
  const { kinfolkId, uid, batchId, pattern, weeklyDays, kinIds, notes, visits, assignee } = opts;
  // Resolved HERE rather than at each call site, so every writer, portal and
  // admin, persists the same concrete pair. A missing preference is a decision
  // (the mock's default is off for both), not an unknown to leave undefined for
  // a reader to guess at.
  const billing = opts.billing ?? null;
  const communication = opts.communication ?? COMMUNICATION_DEFAULT;
  const firestore = db();
  const parentRef = firestore.doc(`families/${kinfolkId}/bookings/${batchId}`);

  // Roll envelope fields from the visits.
  const startMsList = visits.map((v) => v.startTimeMs);
  const firstStartMs = Math.min(...startMsList);
  const lastStartMs = Math.max(...startMsList);
  const serviceIds = new Set(visits.map((v) => v.serviceId ?? null));
  const serviceNames = new Set(visits.map((v) => v.serviceName ?? null));
  const homogeneousServiceId = serviceIds.size === 1 ? [...serviceIds][0] : null;
  const homogeneousServiceName = serviceNames.size === 1 ? [...serviceNames][0] : null;
  // R1: an empty `kinIds` means the WHOLE HOUSEHOLD, and is materialized into
  // the concrete roster here rather than persisted as the literal `[]` that
  // left every reader downstream with nothing to name. See kinRoster.ts for the
  // ruling and for the roster-drift consequence this freeze-at-write accepts.
  //
  // Resolved once for the whole envelope (every visit here shares the same
  // kinIds today) and stamped on the envelope AND each visit, rather than the
  // `kinNames: []` that used to leave the portal saying "your kin" and
  // Android's Schedule with no Pets line at all.
  const { kinIds: kinIdUnion, kinNames } = await materializeKinRoster(kinfolkId, kinIds);

  const visitIds: string[] = [];
  await firestore.runTransaction(async (tx) => {
    tx.set(parentRef, {
      familyId: kinfolkId,
      requestBatchId: batchId,
      envelopeStatus: 'requested',
      requestedByUid: uid,
      pattern,
      weeklyDays,
      serviceId: homogeneousServiceId,
      serviceName: homogeneousServiceName,
      kinIds: kinIdUnion,
      kinNames,
      notes,
      // Booking-level preferences, stated once for the whole request. They are
      // not per-visit: an operator does not send one confirmation email per
      // visit, and does not bill half a series to a different invoice.
      billing,
      communication,
      visitCount: visits.length,
      confirmedCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      firstStartTime: Timestamp.fromMillis(firstStartMs),
      lastStartTime: Timestamp.fromMillis(lastStartMs),
      targetType: 'KIN',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    for (const v of visits) {
      const visitRef = parentRef.collection('kinCares').doc();
      visitIds.push(visitRef.id);
      tx.set(visitRef, {
        batchId,
        familyId: kinfolkId,
        status: 'requested',
        visitProgress: null,
        serviceId: v.serviceId,
        serviceName: v.serviceName,
        serviceType: v.serviceName,
        priceCents: v.priceCents,
        // No `location`. A visit happens at the household's address, which is
        // read live off the household doc by everything that needs it
        // (`optimizeRoute.ts`, the address chips, `BookingDetailModal.tsx`).
        // Operator ruling, 2026-08-04.
        title: v.title ?? v.serviceName,
        startTime: Timestamp.fromMillis(v.startTimeMs),
        endTime: v.endTimeMs != null ? Timestamp.fromMillis(v.endTimeMs) : null,
        kinIds: kinIdUnion,
        kinNames,
        // Default-assignee (2026-07-02): new visits start on the admin's plate;
        // onBookingsWrite fires assignment.assigned off this field.
        assignedAuntieUid: assignee?.uid ?? null,
        auntieDisplayName: assignee?.displayName ?? null,
        auntieAvatarUrl: null,
        requestedByUid: uid,
        sourceBookingId: null,
        sessionId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  return { batchId, visitIds };
}

/**
 * Kinfolk-initiated booking request.
 * Two payload shapes supported:
 *   - Multi-visit (preferred): { visits: [...], kinIds, pattern }
 *   - Legacy: { serviceType, startTimeMs, endTimeMs, kinIds }
 *
 * Both shapes now write the envelope model: ONE parent
 * `families/{kinfolkId}/bookings/{batchId}` doc plus one `kinCares/{visitId}`
 * per visit. The legacy single-visit path is stored as a 1-visit envelope.
 */
export async function requestBookingHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowedIds.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');

  const data = (req.data ?? {}) as Record<string, unknown>;
  const isMulti = Array.isArray((data as { visits?: unknown }).visits);

  if (isMulti) {
    const args = MultiArgs.parse(req.data);
    const kinfolkId = args.kinfolkId ?? allowedIds[0];
    if (!allowedIds.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');

    const now = Date.now();
    args.visits.forEach((v) => {
      if (v.startTimeMs < now - 60_000) {
        throw new HttpsError('invalid-argument', 'Visit startTime must be in the future.');
      }
      if (v.endTimeMs && v.endTimeMs <= v.startTimeMs) {
        throw new HttpsError('invalid-argument', 'endTime must be after startTime.');
      }
    });
    // Kinfolk have no override: a busy-import conflict always refuses the request.
    await guardBookingBusyConflict({ firestore, visits: args.visits, actorUid: uid, actorRole: 'PRIMARY' });
    // A closed day always refuses the request too -- no override, for anyone.
    // See companyHolidayConflict.ts's header for why this guard has none.
    await guardCompanyHolidayConflict({ firestore, visits: args.visits });

    const batchId = `req_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const pattern = args.pattern ?? 'individual';
    // NOTE-56: resolve serviceName + priceCents from the canonical catalog. The
    // client-supplied `v.priceCents` is intentionally discarded here.
    const normalized: NormalizedVisit[] = await Promise.all(
      args.visits.map(async (v) => {
        const resolved = await resolveService(v.serviceId, v.serviceName);
        return {
          startTimeMs: v.startTimeMs,
          endTimeMs: v.endTimeMs ?? null,
          serviceId: v.serviceId,
          serviceName: resolved.serviceName,
          priceCents: resolved.priceCents,
          title: resolved.serviceName ?? v.serviceName,
        };
      }),
    );

    await writeEnvelope({
      kinfolkId,
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
      severity: 'info', function: 'requestBooking',
      event: 'portal.booking.requested.multi', uid,
      extra: { kinfolkId, batchId, count: normalized.length, pattern },
    });
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BOOKING_SUBMITTED,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: uid,
      targetUid: batchId,
      targetCollection: `families/${kinfolkId}/bookings/${batchId}`,
      description: `Kinfolk submitted ${normalized.length} visit(s) (${pattern})`,
      payload: { kinfolkId, batchId, count: normalized.length, pattern, requestBatchId: batchId },
    }).catch((err) => {
      logEvent({
        severity: 'warn', function: 'requestBooking', event: 'audit.write.failed',
        uid, errorMessage: (err as Error)?.message,
      });
    });
    await maybeAutoConfirm(kinfolkId, batchId, uid);
    return validateResponse('requestBooking', Result, { batchId, bookingIds: [batchId], bookingId: batchId });
  }

  // Legacy single-visit path, stored as a 1-visit envelope.
  const args = LegacyArgs.parse(req.data);
  const kinfolkId = args.kinfolkId ?? allowedIds[0];
  if (!allowedIds.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');

  if (args.endTimeMs && args.endTimeMs <= args.startTimeMs) {
    throw new HttpsError('invalid-argument', 'endTime must be after startTime.');
  }
  if (args.startTimeMs < Date.now() - 60_000) {
    throw new HttpsError('invalid-argument', 'startTime must be in the future.');
  }
  // Kinfolk have no override: a busy-import conflict always refuses the request.
  await guardBookingBusyConflict({
    firestore,
    visits: [{ startTimeMs: args.startTimeMs, endTimeMs: args.endTimeMs }],
    actorUid: uid,
    actorRole: 'PRIMARY',
  });
  // A closed day always refuses the request too -- no override, for anyone.
  await guardCompanyHolidayConflict({
    firestore,
    visits: [{ startTimeMs: args.startTimeMs, endTimeMs: args.endTimeMs }],
  });

  const batchId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await writeEnvelope({
    kinfolkId,
    uid,
    batchId,
    pattern: 'individual',
    weeklyDays: null,
    kinIds: args.kinIds ?? [],
    notes: args.notes ?? null,
    visits: [
      {
        startTimeMs: args.startTimeMs,
        endTimeMs: args.endTimeMs ?? null,
        serviceId: null,
        serviceName: args.serviceType,
        priceCents: null,
        title: args.title ?? args.serviceType,
      },
    ],
    assignee: await resolveDefaultAssignee(),
  });

  logEvent({ severity: 'info', function: 'requestBooking', event: 'portal.booking.requested', uid, extra: { kinfolkId, batchId } });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BOOKING_SUBMITTED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: uid,
    targetUid: batchId,
    targetCollection: `families/${kinfolkId}/bookings/${batchId}`,
    description: 'Kinfolk submitted booking (legacy single-visit)',
    payload: { kinfolkId, batchId, serviceType: args.serviceType },
  }).catch((err) => {
    logEvent({
      severity: 'warn', function: 'requestBooking', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  await maybeAutoConfirm(kinfolkId, batchId, uid);
  return validateResponse('requestBooking', Result, { batchId, bookingIds: [batchId], bookingId: batchId });
}

export const requestBooking = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('requestBooking', requestBookingHandler),
);
