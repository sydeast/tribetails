import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { FULL_CPU } from '../lib/runtimeOptions';

interface GetMyBookingsRequest { kinfolkId?: string }

/**
 * No zod request schema: this callable takes one optional string, read raw
 * off `req.data`, the same situation `getMyInvoices` is in (see the
 * registry's header). `args: null` there is the precedent this follows.
 */

const BookingDtoSchema = z
  .object({
    /** kinCare (per-visit) document id. */
    id: z.string().min(1),
    /** Envelope id this visit belongs to. */
    batchId: z.string().min(1).nullable(),
    kinfolkId: z.string().min(1),
    status: z.enum(['requested', 'confirmed', 'enRoute', 'active', 'completed', 'cancelled']),
    serviceType: z.string().nullable(),
    title: z.string().nullable(),
    startTimeMs: z.number().int().nullable(),
    endTimeMs: z.number().int().nullable(),
    kinIds: z.array(z.string()),
    kinNames: z.array(z.string()),
    auntieDisplayName: z.string().nullable(),
    auntieAvatarUrl: z.string().nullable(),
    notes: z.string().nullable(),
    requestedByUid: z.string().nullable(),
    createdAtMs: z.number().int().nullable(),
    updatedAtMs: z.number().int().nullable(),
    /** Active visit progress hint, only on status=active. */
    visitProgress: z.enum(['confirmed', 'enRoute', 'active', 'ended']).nullable(),
    /** AuntieOS back-references (null until AuntieOS writes them). */
    sourceBookingId: z.string().nullable(),
    sessionId: z.string().nullable(),
    /** Vendor-parity (2026-07-02): a cancellation ask is pending on this visit. */
    cancelRequested: z.boolean(),
    /**
     * The kinfolk reschedule ask (#399 item 2), or null when this visit has
     * never had one. `pending` while the office has not ruled; `accepted` once
     * the visit has been moved to the proposed time; `declined` when it has
     * not. The proposed window and the operator's note survive the decision on
     * purpose, so the screen can say what was asked for and what came back
     * rather than just "declined".
     */
    rescheduleRequestStatus: z.enum(['pending', 'accepted', 'declined']).nullable(),
    rescheduleRequestedStartTimeMs: z.number().int().nullable(),
    rescheduleRequestedEndTimeMs: z.number().int().nullable(),
    rescheduleRequestReason: z.string().nullable(),
    /** What the office said when it accepted or declined. */
    rescheduleResponseNote: z.string().nullable(),
  })
  .strict();

type BookingDto = z.infer<typeof BookingDtoSchema>;

const EnvelopeDtoSchema = z
  .object({
    batchId: z.string().min(1),
    envelopeStatus: z.enum([
      'requested',
      'partiallyConfirmed',
      'confirmed',
      'inProgress',
      'completed',
      'cancelled',
    ]),
    pattern: z.enum(['individual', 'weekly']),
    serviceName: z.string().nullable(),
    kinIds: z.array(z.string()),
    kinNames: z.array(z.string()),
    notes: z.string().nullable(),
    visitCount: z.number().int().nonnegative(),
    confirmedCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    firstStartTimeMs: z.number().int().nullable(),
    lastStartTimeMs: z.number().int().nullable(),
    kinCares: z.array(BookingDtoSchema),
  })
  .strict();

type EnvelopeDto = z.infer<typeof EnvelopeDtoSchema>;

export const Result = z
  .object({
    liveVisit: BookingDtoSchema.nullable(),
    upcoming: z.array(BookingDtoSchema),
    recent: z.array(BookingDtoSchema),
    envelopes: z.array(EnvelopeDtoSchema),
  })
  .strict();

/**
 * Returns all visits split into live + upcoming + recent buckets, plus the
 * envelope grouping. READ-ONLY.
 * Source: `collectionGroup('kinCares').where('familyId','==',kinfolkId)` for the
 * per-visit docs, and the parent `bookings/{batchId}` docs for envelope fields.
 */
export async function getMyBookingsHandler(
  req: CallableRequest<GetMyBookingsRequest>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyBookings');

  const snap = await firestore
    .collectionGroup('kinCares')
    .where('familyId', '==', kinfolkId)
    .get();

  const nowMs = Date.now();
  // batchId -> kinCare dtos, preserving the parent envelope id per visit.
  const byBatch = new Map<string, BookingDto[]>();
  const all: BookingDto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const batchId = resolveBatchId(d, data);
    const dto: BookingDto = {
      id: d.id,
      batchId,
      kinfolkId,
      status: (data['status'] as BookingDto['status']) ?? 'requested',
      serviceType: stringOrNull(data['serviceType']) ?? stringOrNull(data['serviceName']),
      title: stringOrNull(data['title']),
      startTimeMs: tsMillis(data['startTime']),
      endTimeMs: tsMillis(data['endTime']),
      kinIds: Array.isArray(data['kinIds']) ? (data['kinIds'] as string[]) : [],
      kinNames: Array.isArray(data['kinNames']) ? (data['kinNames'] as string[]) : [],
      auntieDisplayName: stringOrNull(data['auntieDisplayName']),
      auntieAvatarUrl: stringOrNull(data['auntieAvatarUrl']),
      notes: stringOrNull(data['notes']),
      requestedByUid: stringOrNull(data['requestedByUid']),
      createdAtMs: tsMillis(data['createdAt']),
      updatedAtMs: tsMillis(data['updatedAt']),
      visitProgress: (data['visitProgress'] as BookingDto['visitProgress']) ?? null,
      sourceBookingId: stringOrNull(data['sourceBookingId']),
      sessionId: stringOrNull(data['sessionId']),
      cancelRequested: Boolean(data['cancelRequestedAt']),
      rescheduleRequestStatus: rescheduleStatusOf(data['rescheduleRequestStatus']),
      rescheduleRequestedStartTimeMs: tsMillis(data['rescheduleRequestedStartTime']),
      rescheduleRequestedEndTimeMs: tsMillis(data['rescheduleRequestedEndTime']),
      rescheduleRequestReason: stringOrNull(data['rescheduleRequestReason']),
      rescheduleResponseNote: stringOrNull(data['rescheduleResponseNote']),
    };
    if (batchId) {
      const bucket = byBatch.get(batchId) ?? [];
      bucket.push(dto);
      byBatch.set(batchId, bucket);
    }
    return dto;
  });

  // Bucket logic, IDENTICAL to the pre-envelope behaviour so the UI is
  // unchanged when the envelope flag is off.
  let liveVisit = all.find((b) => b.status === 'active' || b.status === 'enRoute') ?? null;
  const upcoming = all
    .filter((b) => (b.status === 'requested' || b.status === 'confirmed') && (b.startTimeMs ?? 0) >= nowMs - 60_000)
    .sort((a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0));
  const recent = all
    .filter((b) => b.status === 'completed' || b.status === 'cancelled')
    .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0))
    .slice(0, 10);

  // Surface AuntieOS-scheduled visits that have NO booking envelope. A visit
  // scheduled directly in the admin app (createKinCareSession / an ad-hoc
  // sitter visit) lives only in `kin_care_sessions`, never in the `kinCares`
  // collection group above, so before this it never reached the kinfolk's
  // Upcoming list. Bookings that DID spawn a session already carry that
  // session's id in `sessionId`; those are skipped here so nothing double-shows.
  const linkedSessionIds = new Set(all.map((b) => b.sessionId).filter((s): s is string => !!s));
  const sessionSnap = await firestore
    .collection('kin_care_sessions')
    .where('kinfolkId', '==', kinfolkId)
    .get();
  // A SCHEDULED visit whose start is more than a day past is stale, not upcoming;
  // in-flight (ON_MY_WAY/ARRIVED) visits show regardless of clock so the kinfolk
  // can watch a live visit that started late.
  const staleFloorMs = nowMs - 24 * 3600_000;
  for (const d of sessionSnap.docs) {
    if (linkedSessionIds.has(d.id)) continue;
    const s = d.data() as Record<string, unknown>;
    const status = mapSessionStatus(stringOrNull(s['status']));
    if (status === null) continue; // completed / cancelled / departed / unknown → not upcoming
    const startTimeMs = isoMillis(s['startTime']);
    if (status === 'confirmed' && (startTimeMs === null || startTimeMs < staleFloorMs)) continue;
    const dto: BookingDto = {
      id: d.id,
      batchId: null,
      kinfolkId,
      status,
      serviceType: stringOrNull(s['serviceType']),
      title: stringOrNull(s['serviceType']),
      startTimeMs,
      endTimeMs: isoMillis(s['endTime']),
      kinIds: Array.isArray(s['kinIds']) ? (s['kinIds'] as string[]) : [],
      kinNames: [],
      auntieDisplayName: null,
      auntieAvatarUrl: null,
      notes: stringOrNull(s['notes']),
      requestedByUid: stringOrNull(s['createdBy']),
      createdAtMs: isoMillis(s['createdAt']),
      updatedAtMs: isoMillis(s['updatedAt']),
      visitProgress: status === 'active' ? 'active' : status === 'enRoute' ? 'enRoute' : null,
      sourceBookingId: stringOrNull(s['sourceBookingId']),
      sessionId: d.id,
      cancelRequested: false,
      // A session with no booking envelope has no kinCares doc to carry a
      // request, and the portal cannot ask for one on it either (both request
      // callables need a batchId). Null is the honest answer, not a default.
      rescheduleRequestStatus: null,
      rescheduleRequestedStartTimeMs: null,
      rescheduleRequestedEndTimeMs: null,
      rescheduleRequestReason: null,
      rescheduleResponseNote: null,
    };
    if (status === 'active' || status === 'enRoute') {
      if (!liveVisit) liveVisit = dto;
      else upcoming.push(dto);
    } else {
      upcoming.push(dto);
    }
  }
  upcoming.sort((a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0));

  // Read the parent envelopes for envelope-level fields.
  const batchIds = [...byBatch.keys()];
  const envelopes: EnvelopeDto[] = [];
  for (const batchId of batchIds) {
    const kinCares = (byBatch.get(batchId) ?? []).sort(
      (a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0),
    );
    const parentSnap = await firestore
      .doc(`families/${kinfolkId}/bookings/${batchId}`)
      .get();
    const env = (parentSnap.data() ?? {}) as Record<string, unknown>;
    envelopes.push({
      batchId,
      envelopeStatus: (env['envelopeStatus'] as EnvelopeDto['envelopeStatus']) ?? 'requested',
      pattern: (env['pattern'] as EnvelopeDto['pattern']) ?? 'individual',
      serviceName: stringOrNull(env['serviceName']),
      kinIds: Array.isArray(env['kinIds']) ? (env['kinIds'] as string[]) : [],
      kinNames: Array.isArray(env['kinNames']) ? (env['kinNames'] as string[]) : [],
      notes: stringOrNull(env['notes']),
      visitCount: numberOr(env['visitCount'], kinCares.length),
      confirmedCount: numberOr(env['confirmedCount'], 0),
      completedCount: numberOr(env['completedCount'], 0),
      firstStartTimeMs: tsMillis(env['firstStartTime']),
      lastStartTimeMs: tsMillis(env['lastStartTime']),
      kinCares,
    });
  }
  envelopes.sort((a, b) => (a.firstStartTimeMs ?? 0) - (b.firstStartTimeMs ?? 0));

  logEvent({ severity: 'info', function: 'getMyBookings', event: 'portal.bookings.resolved', uid, extra: { kinfolkId, total: all.length, sessions: sessionSnap.size, envelopes: envelopes.length } });
  return validateResponse('getMyBookings', Result, { liveVisit, upcoming, recent, envelopes });
}

/**
 * Maps an AuntieOS kin_care_sessions `status` onto the booking status the portal
 * renders. Only non-terminal states map to a value; COMPLETED/DEPARTED/CANCELLED
 * (and anything unrecognized) return null so they are not surfaced as upcoming
 * (completed visits already reach the UI via getMyVisits for GPS replay).
 */
function mapSessionStatus(raw: string | null): BookingDto['status'] | null {
  switch ((raw ?? '').toUpperCase()) {
    case 'SCHEDULED':
      return 'confirmed';
    case 'ON_MY_WAY':
      return 'enRoute';
    case 'ARRIVED':
      return 'active';
    default:
      return null;
  }
}

/** Parses an ISO-8601 string (kin_care_sessions stamps times as strings) to millis. */
function isoMillis(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The stored reschedule state, or null for anything this contract does not
 * publish. An unrecognised string is null rather than passed through: the DTO
 * is `.strict()` and three clients switch on these three values.
 */
function rescheduleStatusOf(v: unknown): 'pending' | 'accepted' | 'declined' | null {
  return v === 'pending' || v === 'accepted' || v === 'declined' ? v : null;
}
/** Prefers the doc's own `batchId` field; falls back to the parent doc id. */
function resolveBatchId(
  doc: { ref?: { parent?: { parent?: { id?: string } | null } } },
  data: Record<string, unknown>,
): string | null {
  const fromField = stringOrNull(data['batchId']);
  if (fromField) return fromField;
  const fromParent = doc.ref?.parent?.parent?.id;
  return typeof fromParent === 'string' && fromParent.length > 0 ? fromParent : null;
}

function stringOrNull(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
function numberOr(v: unknown, fallback: number): number { return typeof v === 'number' ? v : fallback; }
function tsMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === 'number') return v;
  return null;
}

export const getMyBookings = onCall(
  // Portal bookings read.
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('getMyBookings', getMyBookingsHandler),
);
