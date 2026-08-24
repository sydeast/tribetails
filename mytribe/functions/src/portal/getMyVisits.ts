import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { logEvent } from '../lib/logger';
import { isClientLocationSharingEnabled, withoutCoordinates } from '../lib/locationSharing';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface GetMyVisitsRequest {
  kinfolkId?: string;
  /** Page size; default 10, max 50. */
  limit?: number;
}

interface RoutePointDto {
  lat: number;
  lng: number;
  /** Epoch millis. 0 means unknown. */
  t?: number;
}

interface GpsSummaryDto {
  distanceMeters?: number;
  durationSeconds?: number;
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
  route?: RoutePointDto[];
  computedAt?: string;
}

interface VisitDto {
  id: string;
  status: string;
  serviceType: string | null;
  startTimeIso: string | null;
  endTimeIso: string | null;
  arrivedAtIso: string | null;
  departedAtIso: string | null;
  gpsSummary?: GpsSummaryDto;
}

interface GetMyVisitsResult {
  visits: VisitDto[];
}

/**
 * Returns the kinfolk's recent kin_care_sessions (AuntieOS-side) so MyTribe
 * can surface visit replay (route map + summary) on the Schedule screen.
 *
 * Source: `kin_care_sessions` filtered by kinfolkId. AuntieOS owns writes;
 * this is read-only.
 */
export async function getMyVisitsHandler(
  req: CallableRequest<GetMyVisitsRequest>,
): Promise<GetMyVisitsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyVisits');
  // Wasm/JS clients can serialize limit as a double; Firestore requires an int.
  const limit = clamp(Math.trunc(Number(req.data?.limit ?? 10)) || 10, 1, 50);

  // ISSUE #519: the operator's "Let kinfolk see visit locations" switch. Read
  // once per call, before the projection, so a `false` withholds coordinates
  // from every visit in the response rather than per row. Absent reads as ON.
  const shareLocations = await isClientLocationSharingEnabled(db());
  const snap = await db()
    .collection('kin_care_sessions')
    .where('kinfolkId', '==', kinfolkId)
    .orderBy('startTime', 'desc')
    .limit(limit)
    .get();

  const visits: VisitDto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const dto: VisitDto = {
      id: d.id,
      status: typeof data['status'] === 'string' ? (data['status'] as string) : '',
      serviceType: stringOrNull(data['serviceType']),
      startTimeIso: stringOrNull(data['startTime']),
      endTimeIso:   stringOrNull(data['endTime']),
      arrivedAtIso: stringOrNull(data['arrivedAt']),
      departedAtIso: stringOrNull(data['departedAt']),
    };
    const summary = data['gpsSummary'];
    if (summary && typeof summary === 'object') {
      const s = summary as Record<string, unknown>;
      const out: GpsSummaryDto = {};
      if (typeof s['distanceMeters']  === 'number') out.distanceMeters  = s['distanceMeters']  as number;
      if (typeof s['durationSeconds'] === 'number') out.durationSeconds = (s['durationSeconds'] as number);
      if (typeof s['startLat']        === 'number') out.startLat        = s['startLat']        as number;
      if (typeof s['startLng']        === 'number') out.startLng        = s['startLng']        as number;
      if (typeof s['endLat']          === 'number') out.endLat          = s['endLat']          as number;
      if (typeof s['endLng']          === 'number') out.endLng          = s['endLng']          as number;
      if (typeof s['computedAt']      === 'string') out.computedAt      = s['computedAt']      as string;
      const route = s['route'];
      if (Array.isArray(route)) {
        out.route = (route as Array<Record<string, unknown>>)
          .filter((p) => typeof p['lat'] === 'number' && typeof p['lng'] === 'number')
          .map((p) => {
            const r: RoutePointDto = { lat: p['lat'] as number, lng: p['lng'] as number };
            if (typeof p['t'] === 'number') r.t = p['t'] as number;
            return r;
          });
      }
      // Coordinates are withheld when the operator has turned sharing off; the
      // distance and duration stay, because "your Auntie walked 1.2 miles" is
      // the fact of the visit and the switch is about WHERE, not whether.
      const projected = shareLocations ? out : withoutCoordinates(out);
      if (projected) dto.gpsSummary = projected;
    }
    return dto;
  });

  logEvent({ severity: 'info', function: 'getMyVisits', event: 'portal.visits.resolved', uid, extra: { kinfolkId, count: visits.length } });
  return { visits };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export const getMyVisits = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyVisits', getMyVisitsHandler),
);
