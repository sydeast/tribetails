import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';

/**
 * The office's queue of NEW booking requests (issue #533).
 *
 * THE GAP THIS CLOSES. A household asks for care through the portal
 * (`portal/requestBooking`), which writes a booking envelope at
 * `families/{kinfolkId}/bookings/{batchId}` with its visits underneath as
 * `kinCares/{visitId}`, all `requested`. The React admin's Bookings list streams
 * the FLAT `kin_care_sessions` collection, and an envelope visit only becomes a
 * session when `approveBookingSeriesCore` runs. So a `requested` envelope was
 * invisible to that list BY DESIGN, and `VisitRequestsSection` held only the
 * reschedule ask (#399 item 2) and the cancellation ask (#438). A brand new
 * request had no surface anywhere in the React admin: the portal told the
 * household their request was pending and nobody in the office could see it.
 *
 * ONE ROW PER ENVELOPE, NOT PER VISIT. A long weekend is four visit documents
 * and ONE request. `manageBookingSeries` already rules on a whole envelope in a
 * single transaction, and #532 is the standing lesson that the per-visit grain
 * is the wrong one for anything about a REQUEST. So the scan groups by batchId
 * and the operator answers a request, not four visits.
 *
 * WHY THIS IS A CALLABLE AND NOT A CLIENT QUERY. `lib/firestore.ts`'s
 * `CollectionSpec` wraps a single `collection(db, path)` and has no
 * collection-GROUP variant, so the admin app cannot stream the nested
 * `kinCares` subcollection across every household without a new capability in
 * that shared helper. `api/rescheduleRequests.ts` and `api/cancelRequests.ts`
 * arrived through callables for exactly this reason; this is the third.
 */

export const ListArgs = z.object({
  /** Cap on rows returned. The queue is a to-do list, not a report. */
  limit: z.number().int().min(1).max(100).optional(),
});

export const PendingBookingRequestDto = z
  .object({
    kinfolkId: z.string().min(1),
    batchId: z.string().min(1),
    /** Household display name, from the envelope's family doc. Null when unreadable. */
    kinfolkName: z.string().nullable(),
    serviceType: z.string().nullable(),
    kinNames: z.array(z.string()),
    /** The household's own words for the whole request, an envelope-level field. */
    notes: z.string().nullable(),
    /** How many visits in this envelope are still `requested`. */
    visitCount: z.number().int(),
    /** Oldest and newest requested visit, so the UI can name a span without the full list. */
    firstStartTimeMs: z.number().int().nullable(),
    lastStartTimeMs: z.number().int().nullable(),
    /** Every requested visit start, oldest first, so a short request can list its days. */
    startTimeMsList: z.array(z.number().int()),
    /** When the household asked, from the envelope's createdAt. Drives the queue's sort. */
    requestedAtMs: z.number().int().nullable(),
  })
  .strict();

export const ListResult = z
  .object({
    requests: z.array(PendingBookingRequestDto),
  })
  .strict();

/**
 * How many `kinCares` docs the scan reads before grouping.
 *
 * The query CANNOT order by start time. The only `kinCares` collection-group
 * indexes that exist are `(familyId, startTime)` and
 * `(rescheduleRequestStatus, rescheduleRequestedAt)`; there is no
 * `(status, startTime)` composite, so adding an `orderBy` to the status
 * equality would throw FAILED_PRECONDITION in prod while passing every local
 * test against a mock. The scan is therefore an unordered equality read, capped
 * here and sorted in memory, and the cap is logged when hit so the day this
 * business outgrows it is findable rather than silent.
 *
 * 200 visits of pending requests is far past this operator's volume: a pending
 * request is answered in hours, not left to accumulate.
 */
const SCAN_CAP = 200;

function millisOf(v: { toMillis?: () => number } | null | undefined): number | null {
  const ms = v?.toMillis?.();
  return typeof ms === 'number' ? ms : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** One envelope's visits, accumulated as the flat scan walks them. */
interface Group {
  kinfolkId: string;
  batchId: string;
  startTimeMsList: number[];
  serviceType: string | null;
  kinNames: string[];
}

/**
 * Groups a flat scan of requested visits into one entry per envelope.
 *
 * Exported for unit tests: this is the whole "four visits are one request"
 * behavior, and it is worth asserting without a Firestore fixture.
 */
export function groupByEnvelope(
  rows: Array<{ path: string; data: Record<string, unknown> }>,
): Group[] {
  const byKey = new Map<string, Group>();
  for (const row of rows) {
    // families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}
    const segments = row.path.split('/');
    const kinfolkId = segments[1] ?? '';
    const batchId = segments[3] ?? '';
    if (!kinfolkId || !batchId) continue;

    const key = `${kinfolkId}/${batchId}`;
    let group = byKey.get(key);
    if (!group) {
      group = { kinfolkId, batchId, startTimeMsList: [], serviceType: null, kinNames: [] };
      byKey.set(key, group);
    }

    const startMs = millisOf(row.data['startTime'] as Timestamp | null | undefined);
    if (startMs != null) group.startTimeMsList.push(startMs);

    // The envelope's visits share a service and a kin roster today, so the
    // first visit that names either speaks for the request. A visit that names
    // neither must not blank out one that did.
    group.serviceType =
      group.serviceType ??
      stringOrNull(row.data['serviceType']) ??
      stringOrNull(row.data['serviceName']) ??
      stringOrNull(row.data['title']);
    if (group.kinNames.length === 0 && Array.isArray(row.data['kinNames'])) {
      group.kinNames = (row.data['kinNames'] as unknown[]).filter(
        (n): n is string => typeof n === 'string' && n.length > 0,
      );
    }
  }

  for (const group of byKey.values()) group.startTimeMsList.sort((a, b) => a - b);
  return [...byKey.values()];
}

/**
 * Every booking request still waiting on an answer, oldest ask first.
 *
 * The oldest ask is the one to answer, the same ordering the cancellation and
 * reschedule queues use, so the three read as one list in `VisitRequestsSection`.
 */
export async function listPendingBookingRequestsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof ListResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof ListArgs>;
  try {
    args = ListArgs.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listPendingBookingRequests validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const limit = args.limit ?? 50;

  const snap = await db()
    .collectionGroup('kinCares')
    .where('status', '==', 'requested')
    .limit(SCAN_CAP)
    .get();

  const groups = groupByEnvelope(
    snap.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() as Record<string, unknown> })),
  );

  // One parent read per pending ENVELOPE, not per visit: the envelope carries
  // `createdAt` (when the household actually asked, which no visit doc holds),
  // the request-level `notes`, and its own `envelopeStatus`.
  const requests = (
    await Promise.all(
      groups.map(async (group) => {
        let envelope: Record<string, unknown> | null = null;
        let kinfolkName: string | null = null;
        try {
          const parentSnap = await db()
            .doc(`families/${group.kinfolkId}/bookings/${group.batchId}`)
            .get();
          envelope = parentSnap.exists ? ((parentSnap.data() as Record<string, unknown>) ?? null) : null;
        } catch (err) {
          // A group whose parent will not read is still a real pending request.
          // Surface it with the visit-level facts rather than dropping it: an
          // unanswerable request the office cannot see is the whole of #533.
          logEvent({
            severity: 'warn',
            function: 'listPendingBookingRequests',
            event: 'admin.bookingRequests.envelope.readFailed',
            uid,
            extra: { kinfolkId: group.kinfolkId, batchId: group.batchId, err: (err as Error)?.message },
          });
        }

        try {
          const familySnap = await db().doc(`families/${group.kinfolkId}`).get();
          kinfolkName = stringOrNull((familySnap.data() as Record<string, unknown>)?.['displayName']);
        } catch {
          // Same reasoning: a nameless row beats a missing one.
        }

        const list = group.startTimeMsList;
        return {
          kinfolkId: group.kinfolkId,
          batchId: group.batchId,
          kinfolkName,
          serviceType: group.serviceType ?? stringOrNull(envelope?.['serviceName']),
          kinNames:
            group.kinNames.length > 0
              ? group.kinNames
              : Array.isArray(envelope?.['kinNames'])
                ? (envelope!['kinNames'] as unknown[]).filter(
                    (n): n is string => typeof n === 'string' && n.length > 0,
                  )
                : [],
          notes: stringOrNull(envelope?.['notes']),
          visitCount: list.length,
          firstStartTimeMs: list[0] ?? null,
          lastStartTimeMs: list.length > 0 ? list[list.length - 1]! : null,
          startTimeMsList: list,
          requestedAtMs: millisOf(envelope?.['createdAt'] as Timestamp | null | undefined),
        };
      }),
    )
  )
    // Oldest ask first. A request whose envelope would not read has no
    // `requestedAtMs`; it sorts LAST rather than to 1970, so an unknown date
    // never jumps the queue ahead of a household that has genuinely waited.
    .sort(
      (a, b) =>
        (a.requestedAtMs ?? Number.MAX_SAFE_INTEGER) - (b.requestedAtMs ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, limit);

  if (snap.size >= SCAN_CAP) {
    logEvent({
      severity: 'warn',
      function: 'listPendingBookingRequests',
      event: 'admin.bookingRequests.queue.scanCapped',
      uid,
      extra: { scanCap: SCAN_CAP, envelopesFound: groups.length },
    });
  }
  logEvent({
    severity: 'info',
    function: 'listPendingBookingRequests',
    event: 'admin.bookingRequests.queue.read',
    uid,
    extra: { count: requests.length, visitsScanned: snap.size },
  });

  return validateResponse('listPendingBookingRequests', ListResult, { requests });
}

export const listPendingBookingRequests = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listPendingBookingRequests', listPendingBookingRequestsHandler),
);
