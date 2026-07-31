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
import { resolveKinNames } from '../lib/resolveKinNames';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';

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
 * WHERE a visit happens, as a free-text LABEL.
 *
 * Not a foreign key, and that is a finding rather than a shortcut: this
 * codebase has no property or location model. The only addresses that exist
 * are free-text fields on the household doc (`optimizeRoute.ts` reads
 * `serviceAddress` / `homeAddress` / `address` in that order), so there is no
 * id to point at. A label is what an operator can actually supply for "the
 * back gate", "the boarding house", or a second property the household owns.
 *
 * Optional and nullable, so the frozen legacy payload still validates: every
 * client that has ever called this omits it, and every visit already written
 * has none. Absent means "wherever this household's address says", which is
 * exactly what the whole collection means today.
 */
const VisitLocationArgs = z.string().trim().min(1).max(120).nullable().optional();

/** Multi-visit (new wizard) shape. */
const VisitArgs = z.object({
  startTimeMs: z.number().int().positive(),
  endTimeMs: z.number().int().positive().nullable().optional(),
  serviceId: z.string().min(1),
  serviceName: z.string().min(1).max(120),
  priceCents: z.number().int().nonnegative().nullable().optional(),
  location: VisitLocationArgs,
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

interface RequestBookingResult {
  /** The envelope id (parent `bookings/{batchId}` doc). */
  batchId: string;
  /**
   * Legacy multi-id alias. In the envelope model this is `[batchId]`, callers
   * that grouped by the returned ids now get the single envelope id.
   */
  bookingIds: string[];
  /** Legacy single-id alias retained for backward-compat callers. */
  bookingId?: string;
}

/** Normalized per-visit input the envelope writer consumes. */
export interface NormalizedVisit {
  startTimeMs: number;
  endTimeMs: number | null;
  serviceId: string | null;
  serviceName: string | null;
  priceCents: number | null;
  title: string | null;
  /** Free-text place label, or null. See `VisitLocationArgs` for why it is a label. */
  location?: string | null;
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
  const kinIdUnion = [...new Set(kinIds)];
  // Resolved once for the whole envelope (every visit here shares the same
  // kinIds today) and stamped on the envelope AND each visit, rather than the
  // `kinNames: []` that used to leave the portal saying "your kin" and
  // Android's Schedule with no Pets line at all.
  const kinNames = await resolveKinNames(kinfolkId, kinIdUnion);

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
        // Per-visit, unlike billing/communication above: a series can genuinely
        // run at two places (the house on weekdays, the boarding kennel while
        // the household travels), and rolling it to the envelope would lose
        // that. `null` means "wherever this household's address says".
        location: v.location ?? null,
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
): Promise<RequestBookingResult> {
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
          location: v.location ?? null,
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
    return { batchId, bookingIds: [batchId], bookingId: batchId };
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
  return { batchId, bookingIds: [batchId], bookingId: batchId };
}

export const requestBooking = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('requestBooking', requestBookingHandler),
);
