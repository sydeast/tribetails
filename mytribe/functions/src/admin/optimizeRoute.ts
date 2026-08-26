import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { ADDRESS_FIELDS, mapboxForwardGeocode } from '../lib/householdLocation';

/**
 * AO-35 Route Optimizer (dashboard widget). Given a day (YYYY-MM-DD) it gathers
 * that day's non-cancelled kin_care_sessions, resolves each household's service
 * address, geocodes + optimizes the drive with Mapbox, and returns the ordered
 * stops with running ETAs plus the total miles/minutes.
 *
 * Fail loud, never fake:
 *  - Missing Mapbox token -> failed-precondition (NO fabricated route).
 *  - A session whose household has no service address, or whose address cannot
 *    be geocoded, is surfaced in `unroutable` with a reason. It is never
 *    silently dropped and never assigned a made-up location.
 *
 * The Mapbox secret is the SAME `MAPBOX_ACCESS_TOKEN` already used by
 * getLocalWeather / mapboxSearch (read from the bound secret env var).
 */

const MAPBOX_ACCESS_TOKEN = 'MAPBOX_ACCESS_TOKEN';
const SESSIONS_COLLECTION = 'kin_care_sessions';
const METERS_PER_MILE = 1609.344;
// Address fields a household doc may carry, in resolution priority. There is no
// single canonical field in the data model (kinfolk docs predate a normalized
// address), so we try the known ones and fail the stop loud if none is present.
// The list itself now lives in `lib/householdLocation.ts`, because #582's
// geocode-on-write has to resolve the SAME address this optimizer routes to; a
// second copy would be two definitions of "the household's address".

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const OptimizeRouteArgs = z.object({
  date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
});

export interface RouteStop {
  order: number;
  sessionId: string;
  kinfolkId: string;
  household: string;
  address: string;
  arrivalEta: string; // HH:MM
}

export interface UnroutableStop {
  sessionId: string;
  household: string;
  reason: string;
}

export interface OptimizeRouteResult {
  stops: RouteStop[];
  totalMiles: number;
  totalMinutes: number;
  unroutable: UnroutableStop[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without Firestore or Mapbox)
// ---------------------------------------------------------------------------

/** Minutes-of-day for an ISO instant, or null when unparseable. */
export function startMinutesFromIso(iso: string): number | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** Total minutes-of-day -> "HH:MM" (wraps at 24h, clamps negatives to 0). */
export function minutesToHhmm(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes)) % (24 * 60);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Running arrival ETAs down an ordered route. arrival[0] = baseMinutes; each
 * later stop adds the preceding leg's drive time. `legDurationsSec` has one
 * entry per leg (i.e. stopCount - 1 entries).
 */
export function computeArrivalEtas(
  stopCount: number,
  legDurationsSec: number[],
  baseMinutes: number,
): string[] {
  const etas: string[] = [];
  let acc = baseMinutes;
  for (let i = 0; i < stopCount; i++) {
    if (i > 0) acc += (legDurationsSec[i - 1] ?? 0) / 60;
    etas.push(minutesToHhmm(acc));
  }
  return etas;
}

function isCancelled(status: unknown): boolean {
  const s = String(status ?? '').toLowerCase();
  return s === 'cancelled' || s === 'canceled';
}

function nextDay(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Mapbox seams (real fetch; mocked in tests via vi.stubGlobal('fetch', ...))
// ---------------------------------------------------------------------------

/**
 * Mapbox v6 forward geocode -> {lon,lat}, or null when nothing matched.
 *
 * ISSUE #582 moved the body to `lib/householdLocation.ts` UNCHANGED, so the
 * coordinate an arrival is checked against and the one this optimizer drives to
 * come out of one request shape. The alias stays because the two callers want
 * different handling around an identical call: here a non-match becomes an
 * `unroutable` stop, there a recorded `serviceLocationError`.
 */
const geocode = mapboxForwardGeocode;

interface OptimizedTrip {
  distanceMeters: number;
  durationSec: number;
  order: number[]; // optimized position (waypoint_index) per INPUT coordinate
  legDurationsSec: number[]; // one per leg, in optimized order
}

/** Mapbox Optimization v1 (open path, start fixed at the first input coord). */
async function optimizeTrip(
  coords: Array<{ lon: number; lat: number }>,
  token: string,
): Promise<OptimizedTrip> {
  const path = coords.map((c) => `${c.lon},${c.lat}`).join(';');
  const params = new URLSearchParams({
    access_token: token,
    source: 'first',
    destination: 'any',
    roundtrip: 'false',
    overview: 'false',
  });
  const resp = await fetch(`https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${path}?${params}`);
  if (!resp.ok) throw new HttpsError('unavailable', `mapbox_optimize_${resp.status}`);
  const body: any = await resp.json();
  if (body?.code !== 'Ok' || !Array.isArray(body?.trips) || body.trips.length === 0) {
    throw new HttpsError('unavailable', `mapbox_optimize_${String(body?.code ?? 'no_trip')}`);
  }
  const trip = body.trips[0];
  const order: number[] = (body.waypoints ?? []).map((w: any) => Number(w?.waypoint_index ?? 0));
  const legDurationsSec: number[] = (trip.legs ?? []).map((l: any) => Number(l?.duration ?? 0));
  return {
    distanceMeters: Number(trip.distance ?? 0),
    durationSec: Number(trip.duration ?? 0),
    order,
    legDurationsSec,
  };
}

// ---------------------------------------------------------------------------

interface DaySession {
  sessionId: string;
  kinfolkId: string;
  household: string;
  address: string;
  startMinutes: number | null;
}

async function resolveHousehold(kinfolkId: string): Promise<{ household: string; address: string }> {
  if (!kinfolkId) return { household: '', address: '' };
  const snap = await db().collection('kinfolk').doc(kinfolkId).get();
  const data = (snap.exists ? snap.data() : undefined) as Record<string, unknown> | undefined;
  if (!data) return { household: kinfolkId, address: '' };

  const first = typeof data.firstName === 'string' ? data.firstName : '';
  const last = typeof data.lastName === 'string' ? data.lastName : '';
  let household = `${first} ${last}`.trim();
  if (!household && typeof data.kinfolkName === 'string') household = data.kinfolkName;
  if (!household) household = kinfolkId;

  let address = '';
  for (const f of ADDRESS_FIELDS) {
    const v = data[f];
    if (typeof v === 'string' && v.trim()) {
      address = v.trim();
      break;
    }
  }
  return { household, address };
}

export async function optimizeRouteHandler(
  req: CallableRequest<unknown>,
): Promise<OptimizeRouteResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof OptimizeRouteArgs>;
  try {
    args = OptimizeRouteArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'optimizeRoute validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const token = (process.env[MAPBOX_ACCESS_TOKEN] ?? '').trim();
  if (!token) throw new HttpsError('failed-precondition', 'mapbox_not_configured');

  // That day's sessions: lexical range on the ISO startTime string captures the
  // whole calendar day; cancellation is filtered in-memory (Firestore has no !=).
  const snap = await db()
    .collection(SESSIONS_COLLECTION)
    .where('startTime', '>=', args.date)
    .where('startTime', '<', nextDay(args.date))
    .get();

  const sessions: DaySession[] = [];
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (isCancelled(data.status)) continue;
    const kinfolkId = typeof data.kinfolkId === 'string' ? data.kinfolkId : '';
    const { household, address } = await resolveHousehold(kinfolkId);
    sessions.push({
      sessionId: d.id,
      kinfolkId,
      household,
      address,
      startMinutes: startMinutesFromIso(typeof data.startTime === 'string' ? data.startTime : ''),
    });
  }

  // Earliest scheduled first, so the fixed route start (source=first) is the
  // first visit of the day and the ETAs read forward from its start time.
  sessions.sort((a, b) => (a.startMinutes ?? 1 << 30) - (b.startMinutes ?? 1 << 30));

  const unroutable: UnroutableStop[] = [];
  const routable: DaySession[] = [];
  for (const s of sessions) {
    if (!s.address) {
      unroutable.push({ sessionId: s.sessionId, household: s.household, reason: 'No service address on file' });
    } else {
      routable.push(s);
    }
  }

  // Geocode each routable stop; a no-match becomes an unroutable (fail loud).
  const geocoded: Array<{ session: DaySession; lon: number; lat: number }> = [];
  for (const s of routable) {
    const g = await geocode(s.address, token);
    if (!g) {
      unroutable.push({ sessionId: s.sessionId, household: s.household, reason: 'Address could not be geocoded' });
    } else {
      geocoded.push({ session: s, lon: g.lon, lat: g.lat });
    }
  }

  const baseMinutes = geocoded[0]?.session.startMinutes ?? 8 * 60; // 08:00 fallback

  let stops: RouteStop[] = [];
  let totalMiles = 0;
  let totalMinutes = 0;

  if (geocoded.length === 1) {
    const only = geocoded[0].session;
    stops = [{ order: 1, sessionId: only.sessionId, kinfolkId: only.kinfolkId, household: only.household, address: only.address, arrivalEta: minutesToHhmm(baseMinutes) }];
  } else if (geocoded.length >= 2) {
    const trip = await optimizeTrip(geocoded.map((g) => ({ lon: g.lon, lat: g.lat })), token);
    // Reorder the input stops by their optimized position.
    const ordered: DaySession[] = new Array(geocoded.length);
    trip.order.forEach((pos, inputIdx) => {
      if (pos >= 0 && pos < geocoded.length) ordered[pos] = geocoded[inputIdx].session;
    });
    const finalOrdered = ordered.filter(Boolean);
    const etas = computeArrivalEtas(finalOrdered.length, trip.legDurationsSec, baseMinutes);
    stops = finalOrdered.map((s, i) => ({
      order: i + 1,
      sessionId: s.sessionId,
      kinfolkId: s.kinfolkId,
      household: s.household,
      address: s.address,
      arrivalEta: etas[i],
    }));
    totalMiles = Math.round((trip.distanceMeters / METERS_PER_MILE) * 10) / 10;
    totalMinutes = Math.round(trip.durationSec / 60);
  }

  logEvent({
    severity: 'info',
    function: 'optimizeRoute',
    event: 'admin.route.optimized',
    uid,
    extra: { date: args.date, stops: stops.length, unroutable: unroutable.length, totalMiles, totalMinutes },
  });

  return { stops, totalMiles, totalMinutes, unroutable };
}

export const optimizeRoute = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', MAPBOX_ACCESS_TOKEN] },
  wrapAdminCallable('optimizeRoute', optimizeRouteHandler),
);
