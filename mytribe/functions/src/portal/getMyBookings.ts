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
import { matchServiceKey, serviceDisplayName, serviceNameCatalogFrom, EMPTY_SERVICE_NAME_CATALOG } from '../lib/serviceDisplayName';
import { hasBillingAccess } from '../lib/memberGate';
import { loadVisitExtras, NO_EXTRAS, type VisitExtras } from '../lib/portalVisitLinks';
import {
  BookingDtoSchema,
  EnvelopeDtoSchema,
  envelopeToDto,
  kinCareToDto,
  householdTimeContextFrom,
  CLOCK_ONLY_TIME_CONTEXT,
  stringOrNull,
  visitSortMs,
  resolveBatchId,
  type BookingDto,
  type EnvelopeDto,
} from '../lib/portalBookingDto';
import { householdBlockFor } from '../lib/bookingTimeBlocks';
import {
  LATE_VISIT_WINDOW_MS,
  bucketOf,
  isUnderWay,
  pickLiveVisit,
  sessionProgressOf,
  withSessionProgress,
} from '../lib/portalVisitProgress';

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

  // The settings read rides alongside the visit query. Fail-soft: a settings
  // doc that will not load leaves names unresolved, never the schedule empty.
  //
  // #1830: the household's sessions are read HERE, with the visits, not after
  // the buckets are cut. A visit takes its On the way / Arrived / Departed from
  // the session it is linked to (`lib/portalVisitProgress.ts`), and that has to
  // be known before anything is sorted into a list. Both queries are scoped to
  // the resolved household, so a visit can only ever be joined to a session of
  // its own household.
  const [snap, settingsSnap, sessionSnap] = await Promise.all([
    firestore.collectionGroup('kinCares').where('familyId', '==', kinfolkId).get(),
    firestore
      .collection('business_settings')
      .doc('business_settings')
      .get()
      .catch(() => null),
    firestore.collection('kin_care_sessions').where('kinfolkId', '==', kinfolkId).get(),
  ]);
  const serviceCatalog = settingsSnap ? serviceNameCatalogFrom(settingsSnap.data()) : EMPTY_SERVICE_NAME_CATALOG;

  // Two ways a visit and its session name each other, and a record can carry
  // either alone: the visit's `sessionId` (every record written since #1575),
  // and the session's `kinCareVisitId` (approval's `vis_` sessions).
  const sessionStatusById = new Map<string, unknown>();
  const sessionByVisitId = new Map<string, { id: string; status: unknown }>();
  for (const d of sessionSnap.docs) {
    const s = d.data() as Record<string, unknown>;
    sessionStatusById.set(d.id, s['status']);
    const visitId = stringOrNull(s['kinCareVisitId']);
    if (visitId !== null) sessionByVisitId.set(visitId, { id: d.id, status: s['status'] });
  }
  /** Sessions that stand behind a booking record, so they are not listed a second time below. */
  const linkedSessionIds = new Set<string>();
  const visitRows = snap.docs.map((d) => {
    const raw = d.data() as Record<string, unknown>;
    const ownSessionId = stringOrNull(raw['sessionId']);
    const linked =
      ownSessionId !== null && sessionStatusById.has(ownSessionId)
        ? { id: ownSessionId, status: sessionStatusById.get(ownSessionId) }
        : (sessionByVisitId.get(d.id) ?? null);
    if (ownSessionId !== null) linkedSessionIds.add(ownSessionId);
    if (linked !== null) linkedSessionIds.add(linked.id);
    // A visit reached only through `kinCareVisitId` still reports its session,
    // which is what the live map and the replay are keyed on.
    const withLink = ownSessionId === null && linked !== null ? { ...raw, sessionId: linked.id } : raw;
    return { doc: d, data: linked !== null ? withSessionProgress(withLink, linked.status) : withLink };
  });

  // #1303: the address, and for completed visits the KinTale and invoice they
  // point at. Billing access is asked after the household is resolved, as the
  // helper requires, and only when a completed visit could use the answer.
  const completedSessions = visitRows.filter(
    ({ data }) => data['status'] === 'completed' && stringOrNull(data['sessionId']) !== null,
  );
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
  // #1863: the same settings read decides what time each visit is shown at.
  const time = settingsSnap ? householdTimeContextFrom(settingsSnap.data() ?? {}) : CLOCK_ONLY_TIME_CONTEXT;
  const nowMs = Date.now();
  // batchId -> kinCare dtos, preserving the parent envelope id per visit.
  const byBatch = new Map<string, BookingDto[]>();
  // Each DTO is built ONCE, from the fields with the session's progress already
  // on them, and that same object goes into its bucket and its envelope. The
  // by-id lookups on every client read the envelope copy too, so a second,
  // unjoined copy there would put CONFIRMED back on a visit that is under way.
  const all: BookingDto[] = visitRows.map(({ doc: d, data }) => {
    const batchId = resolveBatchId(d, data);
    const dto = kinCareToDto(d.id, data, batchId, kinfolkId, extras, time, serviceCatalog);
    if (batchId) {
      const bucket = byBatch.get(batchId) ?? [];
      bucket.push(dto);
      byBatch.set(batchId, bucket);
    }
    return dto;
  });

  // #1832: the lists are cut by `bucketOf` (lib/portalVisitProgress.ts). A
  // visit that is under way is on Upcoming whatever the clock says, and the
  // live visit is ON that list as well as on the live card, so the count beside
  // the tab never reads 0 while the Auntie is at the door.
  //
  // #1098: a night awaiting its start time has no `startTimeMs`, and reading
  // that as 0 dropped it from Upcoming entirely. It is upcoming while its night
  // has not passed, and it sorts by that night (see `visitSortMs`).
  const upcoming = all.filter((b) => bucketOf(b, nowMs) === 'upcoming');
  const recent = all
    .filter((b) => bucketOf(b, nowMs) === 'recent')
    .sort((a, b) => visitSortMs(b) - visitSortMs(a))
    .slice(0, 10);

  // Surface AuntieOS-scheduled visits that have NO booking envelope. A visit
  // scheduled directly in the admin app (an older ad-hoc visit) lives only in
  // `kin_care_sessions`, never in the `kinCares` collection group above, so
  // before this it never reached the kinfolk's Upcoming list. A session that
  // stands behind a booking record was joined to it above; those are skipped
  // here so nothing double-shows.
  //
  // A SCHEDULED visit whose start is more than a day past is stale, not upcoming;
  // a visit that is under way (ON_MY_WAY / ARRIVED) shows regardless
  // of clock so the kinfolk can follow a visit that started late.
  const staleFloorMs = nowMs - LATE_VISIT_WINDOW_MS;
  const sessionServiceKey = (raw: unknown): string | null => {
    const match = matchServiceKey(raw, serviceCatalog);
    return match.kind === 'key' ? match.key : null;
  };
  for (const d of sessionSnap.docs) {
    if (linkedSessionIds.has(d.id)) continue;
    const s = d.data() as Record<string, unknown>;
    const progress = mapSessionStatus(stringOrNull(s['status']));
    if (progress === null) continue; // completed / cancelled / unknown → not upcoming
    const { status, visitProgress } = progress;
    const startTimeMs = isoMillis(s['startTime']);
    if (status === 'confirmed' && (startTimeMs === null || startTimeMs < staleFloorMs)) continue;
    const sessionBlock = householdBlockFor(
      {
        startTimeMs,
        timeBlockId: s['timeBlockId'],
        // A session names its KinCare by `serviceType`; matched to the catalog
        // KEY, which is what `startTimeServiceIds` holds, so an office-booked
        // start-time KinCare keeps its clock here too.
        serviceId: typeof s['serviceId'] === 'string' ? s['serviceId'] : sessionServiceKey(s['serviceType']),
      },
      time.policy,
      time.timeZone,
    );
    const dto: BookingDto = {
      id: d.id,
      batchId: null,
      kinfolkId,
      status,
      serviceType: stringOrNull(s['serviceType']),
      serviceLabel: serviceDisplayName(s['serviceType'], serviceCatalog, s['serviceName']),
      // #1297: was the raw `serviceType`, so a code became the visit's title.
      title: serviceDisplayName(s['serviceType'], serviceCatalog, s['serviceName']),
      serviceId: null,
      startTimeMs,
      endTimeMs: isoMillis(s['endTime']),
      // A session always has its time; only a kinCares visit can await one.
      startTimePending: false,
      requestedDate: null,
      // #1863: an office-booked visit is shown by the same rule as any other:
      // its nearest block in Time Blocks mode, its clock in Exact times mode.
      timeBlockLabel: sessionBlock?.label ?? null,
      timeBlockStartTime: sessionBlock?.startTime ?? null,
      timeBlockEndTime: sessionBlock?.endTime ?? null,
      kinIds: Array.isArray(s['kinIds']) ? (s['kinIds'] as string[]) : [],
      // #1832: the session carries the names it was scheduled with, and the
      // live card says who the Auntie is with. This used to be always empty.
      kinNames: stringList(s['kinNames']),
      auntieDisplayName: null,
      auntieAvatarUrl: null,
      // #1628: NEVER the session's `notes`. On `kin_care_sessions` that field
      // is the office's admin-internal note (Auntie Time's private box: gate
      // codes, key locations), and the #584 rules comment exists because the
      // household must not read it. A visit with no booking request has no
      // household-written note to show here, so there is nothing to project.
      notes: null,
      requestedByUid: stringOrNull(s['createdBy']),
      createdAtMs: isoMillis(s['createdAt']),
      updatedAtMs: isoMillis(s['updatedAt']),
      visitProgress,
      sourceBookingId: stringOrNull(s['sourceBookingId']),
      sessionId: d.id,
      cancelRequested: false,
      cancelRequestStatus: null,
      cancelRequestReason: null,
      cancelResponseNote: null,
      // #2029: an office-booked visit was never a request, so never declined.
      requestDeclinedAtMs: null,
      // A session with no booking envelope has no kinCares doc to carry a
      // request, and the portal cannot ask for one on it either (both request
      // callables need a batchId). Null is the honest answer, not a default.
      rescheduleRequestStatus: null,
      rescheduleRequestedStartTimeMs: null,
      rescheduleRequestedEndTimeMs: null,
      rescheduleRequestedTimeBlockLabel: null,
      rescheduleRequestedTimeBlockStartTime: null,
      rescheduleRequestedTimeBlockEndTime: null,
      rescheduleRequestReason: null,
      rescheduleResponseNote: null,
      address: extras.address,
      kinTaleId: null,
      invoiceId: null,
    };
    upcoming.push(dto);
  }
  // What is happening now leads the list; the rest follow in time order.
  upcoming.sort((a, b) => Number(isUnderWay(b)) - Number(isUnderWay(a)) || visitSortMs(a) - visitSortMs(b));
  // The live card's visit: the one the Auntie is at, else on the way to. A
  // departed visit is never it, so the card clears when she leaves.
  const liveVisit = pickLiveVisit(upcoming);

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

/** An envelope's order: its first start, or its earliest visit's sort time when it has none (#1098). */
function envelopeSortMs(e: EnvelopeDto): number {
  if (e.firstStartTimeMs != null) return e.firstStartTimeMs;
  const keys = e.kinCares.map(visitSortMs).filter((ms) => ms > 0);
  return keys.length > 0 ? Math.min(...keys) : 0;
}

/**
 * Maps an AuntieOS kin_care_sessions `status` onto what the portal renders for
 * a visit with NO booking record. Only unfinished states map to a value;
 * COMPLETED / CANCELLED (and anything unrecognized) return null so they are
 * not surfaced as upcoming (completed visits already reach the UI via
 * getMyVisits for GPS replay).
 *
 * #1832 kept a DEPARTED visit listed until its KinTale was sent. #2123
 * (operator ruling 2026-11-12) made departure the end of the visit, so
 * DEPARTED is finished here exactly as COMPLETED is.
 */
function mapSessionStatus(raw: string | null): Pick<BookingDto, 'status' | 'visitProgress'> | null {
  if ((raw ?? '').trim().toUpperCase() === 'SCHEDULED') return { status: 'confirmed', visitProgress: null };
  const progress = sessionProgressOf(raw);
  return progress === null || progress.status === 'completed' ? null : progress;
}

/** The strings of a stored array, or none. A session's `kinNames` is unvalidated. */
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
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
