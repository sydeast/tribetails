import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { householdStaffFlag } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { FULL_CPU } from '../lib/runtimeOptions';
import { hasBillingAccess } from '../lib/memberGate';
import { loadVisitExtras, NO_EXTRAS, type VisitExtras } from '../lib/portalVisitLinks';
import {
  BookingDtoSchema,
  EnvelopeDtoSchema,
  envelopeToDto,
  kinCareToDto,
  loadBlocksById,
  stringOrNull,
  visitSortMs,
  resolveBatchId,
  type BookingDto,
  type EnvelopeDto,
} from '../lib/portalBookingDto';

interface GetMyBookingsRequest { kinfolkId?: string }

/**
 * No zod request schema: this callable takes one optional string, read raw
 * off `req.data`, the same situation `getMyInvoices` is in (see the
 * registry's header). `args: null` there is the precedent this follows.
 */

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
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, householdStaffFlag(req.auth, 'getMyBookings'), 'getMyBookings');

  const snap = await firestore
    .collectionGroup('kinCares')
    .where('familyId', '==', kinfolkId)
    .get();

  // #1303: the address, and for completed visits the KinTale and invoice they
  // point at. Billing access is asked after the household is resolved, as the
  // helper requires, and only when a completed visit could use the answer.
  const completedSessions = snap.docs.filter((d) => {
    const data = d.data() as Record<string, unknown>;
    return data['status'] === 'completed' && stringOrNull(data['sessionId']) !== null;
  });
  let extras: VisitExtras = NO_EXTRAS;
  try {
    const billingAccess =
      completedSessions.length > 0
        ? await hasBillingAccess(uid, kinfolkId, req.auth?.token?.admin === true, 'getMyBookings')
        : false;
    extras = await loadVisitExtras(firestore, kinfolkId, { wantLinks: completedSessions.length > 0, billingAccess });
  } catch {
    extras = NO_EXTRAS;
  }
  const blocksById = await loadBlocksById(firestore);
  const nowMs = Date.now();
  // batchId -> kinCare dtos, preserving the parent envelope id per visit.
  const byBatch = new Map<string, BookingDto[]>();
  const all: BookingDto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const batchId = resolveBatchId(d, data);
    const dto = kinCareToDto(d.id, data, batchId, kinfolkId, extras, blocksById);
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
  //
  // #1098: a night awaiting its start time has no `startTimeMs`, and reading
  // that as 0 dropped it from Upcoming entirely. It is upcoming while its night
  // has not passed, and it sorts by that night (see `visitSortMs`).
  const upcoming = all
    .filter((b) => (b.status === 'requested' || b.status === 'confirmed') && isUpcoming(b, nowMs))
    .sort((a, b) => visitSortMs(a) - visitSortMs(b));
  const recent = all
    .filter((b) => b.status === 'completed' || b.status === 'cancelled')
    .sort((a, b) => visitSortMs(b) - visitSortMs(a))
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
      serviceId: null,
      title: stringOrNull(s['serviceType']),
      startTimeMs,
      endTimeMs: isoMillis(s['endTime']),
      // A session always has its time; only a kinCares visit can await one.
      startTimePending: false,
      requestedDate: null,
      timeBlockLabel: null,
      timeBlockStartTime: null,
      timeBlockEndTime: null,
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
      cancelRequestStatus: null,
      cancelRequestReason: null,
      cancelResponseNote: null,
      // A session with no booking envelope has no kinCares doc to carry a
      // request, and the portal cannot ask for one on it either (both request
      // callables need a batchId). Null is the honest answer, not a default.
      rescheduleRequestStatus: null,
      rescheduleRequestedStartTimeMs: null,
      rescheduleRequestedEndTimeMs: null,
      rescheduleRequestReason: null,
      rescheduleResponseNote: null,
      address: extras.address,
      kinTaleId: null,
      invoiceId: null,
    };
    if (status === 'active' || status === 'enRoute') {
      if (!liveVisit) liveVisit = dto;
      else upcoming.push(dto);
    } else {
      upcoming.push(dto);
    }
  }
  upcoming.sort((a, b) => visitSortMs(a) - visitSortMs(b));

  // Read the parent envelopes for envelope-level fields.
  const batchIds = [...byBatch.keys()];
  const envelopes: EnvelopeDto[] = [];
  for (const batchId of batchIds) {
    const kinCares = (byBatch.get(batchId) ?? []).sort((a, b) => visitSortMs(a) - visitSortMs(b));
    const parentSnap = await firestore
      .doc(`families/${kinfolkId}/bookings/${batchId}`)
      .get();
    const env = (parentSnap.data() ?? {}) as Record<string, unknown>;
    envelopes.push(envelopeToDto(batchId, env, kinCares));
  }

  // #1098: an envelope of nights alone has a null `firstStartTimeMs` until the
  // operator sets their times; it sorts by its earliest visit instead of 1970.
  envelopes.sort((a, b) => envelopeSortMs(a) - envelopeSortMs(b));

  logEvent({ severity: 'info', function: 'getMyBookings', event: 'portal.bookings.resolved', uid, extra: { kinfolkId, total: all.length, sessions: sessionSnap.size, envelopes: envelopes.length } });
  return validateResponse('getMyBookings', Result, { liveVisit, upcoming, recent, envelopes });
}

/**
 * Still ahead of the household? A timed visit: its start is no more than a
 * minute past (unchanged). A night awaiting its start time (#1098): its night
 * is today or later, judged in UTC with a day of slack, since this callable
 * reads no business zone. An American evening is already "tomorrow" in UTC,
 * and tonight's overnight must not vanish from the list at 8 PM.
 */
function isUpcoming(b: BookingDto, nowMs: number): boolean {
  if (b.startTimeMs == null && b.startTimePending && b.requestedDate) {
    const yesterdayUtc = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 10);
    return b.requestedDate >= yesterdayUtc;
  }
  return (b.startTimeMs ?? 0) >= nowMs - 60_000;
}

/** An envelope's order: its first start, or its earliest visit's sort time when it has none (#1098). */
function envelopeSortMs(e: EnvelopeDto): number {
  if (e.firstStartTimeMs != null) return e.firstStartTimeMs;
  const keys = e.kinCares.map(visitSortMs).filter((ms) => ms > 0);
  return keys.length > 0 ? Math.min(...keys) : 0;
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
