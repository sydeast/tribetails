import { useSyncExternalStore } from 'react';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { addDoc } from './firestoreWrite';
import { totalDistanceMeters } from '@tribetails/geo';
import { db } from './firebase';
import { waitForAuthReady } from './auth';

/**
 * The browser's half of visit tracking (issue #772).
 *
 * WHY THE WEB WRITES BREADCRUMBS AT ALL. Only the Android app used to write
 * `kin_care_sessions/{id}/breadcrumbs`, so a visit clocked in from the admin
 * web (mobile Safari or Chrome, when the phone app is not to hand) had an empty
 * Route panel. The operator's ruling: clocking in from the web must track the
 * visit the same way. While a session is ARRIVED and the tab that clocked it in
 * is open, this module watches `navigator.geolocation` and writes each fix to
 * the same subcollection, in the SAME DOCUMENT SHAPE Android writes
 * (`data/model/LocationModels.kt#LocationPoint`, seven numeric fields), so
 * `KinCareRepository#observeBreadcrumbs`, `lib/breadcrumbs.ts`, and
 * `scheduled/purgeOldVisitRoutes.ts` all read a web crumb exactly as they read
 * an Android one. No extra field marks the writer.
 *
 * THE PROMPT IS TIED TO THE CLICK. Browsers only show the location prompt
 * reliably from a user gesture, so `beginVisitTracking` calls
 * `getCurrentPosition` SYNCHRONOUSLY, before any await, and
 * `useVisitLifecycle#confirm` calls it inside the confirm click. The arrive
 * callable runs in parallel: a denied or unavailable location still arrives the
 * visit, it just arrives untracked, and the indicator says so.
 *
 * ONE VISIT PER TAB. An Auntie is at one house. Starting a second visit's watch
 * stops the first. The tracked session id lives in `sessionStorage`, which is
 * exactly the lifetime the ruling names: it survives a reload of the tab that
 * clocked in and dies with that tab. `resumeVisitTracking` restarts the watch on
 * load WITHOUT a new prompt, and only when the Permissions API says location is
 * already granted (or cannot say, on browsers without it).
 *
 * THE SESSION DOCUMENT IS THE GUARD. While the watch runs, a listener on the
 * parent session stops the watch the moment its status leaves ARRIVED, whatever
 * moved it: a depart from this tab, a depart from the phone, an undo, a
 * cancellation, or the document vanishing. The guard is armed only after the
 * arrive callable has resolved, because until then the document still reads
 * ON_MY_WAY and a guard armed early would stop the watch it was meant to keep.
 *
 * CADENCE MATCHES ANDROID. `LocationTrackingService` drops a fix closer than
 * `MapboxConfig.MIN_DISTANCE_FOR_UPDATE` (5 m) to the last saved one and asks
 * the platform for no more than one fix per `LOCATION_FASTEST_INTERVAL` (2 s).
 * The browser's `watchPosition` has neither limit, so both are applied here.
 *
 * DISTANCE AND THE PURGE ARE UNCHANGED. Nothing here writes `gpsSummary`;
 * `purgeOldVisitRoutes` folds whatever is in the subcollection into it
 * regardless of which client wrote the crumbs.
 */

export type VisitTrackingOffReason =
  | 'denied'
  | 'unavailable'
  | 'unsupported'
  | 'write-failed'
  | 'permission-lost';

export type VisitTrackingStatus =
  /** This tab is not tracking this visit. Another client may be. */
  | { phase: 'idle' }
  /** The location prompt or the arrive callable is still outstanding. */
  | { phase: 'starting' }
  /** The watch is running and its fixes are landing. */
  | { phase: 'on'; fixes: number }
  /** This tab tried to track this visit and could not, or stopped early. */
  | { phase: 'off'; reason: VisitTrackingOffReason; message: string };

/** One breadcrumb document, in Android's `LocationPoint` field set and types. */
export interface BreadcrumbDoc {
  latitude: number;
  longitude: number;
  altitude: number;
  accuracy: number;
  /** Epoch millis of the fix. */
  timestamp: number;
  /** m/s. 0 when the device does not report it. */
  speed: number;
  /** Degrees. 0 when the device does not report it. */
  bearing: number;
}

const STORAGE_KEY = 'auntieos.visitTracking.sessionId';
/** `MapboxConfig.MIN_DISTANCE_FOR_UPDATE`. */
const MIN_DISTANCE_METERS = 5;
/** `MapboxConfig.LOCATION_FASTEST_INTERVAL`. */
const MIN_INTERVAL_MS = 2000;

const IDLE: VisitTrackingStatus = { phase: 'idle' };
const STARTING: VisitTrackingStatus = { phase: 'starting' };

// Every fix Android asks for is PRIORITY_HIGH_ACCURACY; matched here.
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 5000 };
const ONCE_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

interface ActiveWatch {
  sessionId: string;
  watchId: number | null;
  unsubscribeDoc: (() => void) | null;
  lastWritten: { lat: number; lng: number; at: number } | null;
  fixes: number;
}

let active: ActiveWatch | null = null;
const statuses = new Map<string, VisitTrackingStatus>();
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function setStatus(sessionId: string, status: VisitTrackingStatus) {
  if (status.phase === 'idle') statuses.delete(sessionId);
  else statuses.set(sessionId, status);
  notify();
}

function statusOf(sessionId: string | null): VisitTrackingStatus {
  if (sessionId === null) return IDLE;
  return statuses.get(sessionId) ?? IDLE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** This tab's tracking status for one visit. `idle` for `null`. */
export function useVisitTracking(sessionId: string | null): VisitTrackingStatus {
  return useSyncExternalStore(subscribe, () => statusOf(sessionId));
}

/** Non-reactive read, for tests and for callers outside React. */
export function getVisitTrackingStatus(sessionId: string): VisitTrackingStatus {
  return statusOf(sessionId);
}

function geolocation(): Geolocation | null {
  if (typeof navigator === 'undefined') return null;
  const g = (navigator as { geolocation?: Geolocation }).geolocation;
  return g !== undefined && g !== null ? g : null;
}

function readStored(): string | null {
  try {
    const v = sessionStorage.getItem(STORAGE_KEY);
    return v !== null && v.trim() !== '' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(sessionId: string | null) {
  try {
    if (sessionId === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, sessionId);
  } catch {
    // Storage blocked (private mode on some browsers): the watch still runs,
    // it just will not survive a reload.
  }
}

function finite(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * A browser fix as the document Android writes. `null` and `NaN` become 0,
 * which is what `LocationPoint`'s defaults are for the same missing readings.
 */
export function breadcrumbFromPosition(position: GeolocationPosition): BreadcrumbDoc {
  const c = position.coords;
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    altitude: finite(c.altitude),
    accuracy: finite(c.accuracy),
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
    speed: finite(c.speed),
    bearing: finite(c.heading),
  };
}

/**
 * Android's save filter: a fix closer than 5 m to the last saved one is noise,
 * and the platform never delivers two in under 2 s. Exported for its test.
 */
export function shouldWriteFix(
  last: { lat: number; lng: number; at: number } | null,
  next: { lat: number; lng: number; at: number },
): boolean {
  if (last === null) return true;
  if (next.at - last.at < MIN_INTERVAL_MS) return false;
  const metres = totalDistanceMeters([
    { lat: last.lat, lng: last.lng },
    { lat: next.lat, lng: next.lng },
  ]);
  return metres >= MIN_DISTANCE_METERS;
}

function offReasonFor(err: GeolocationPositionError): VisitTrackingOffReason {
  return err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
}

/** The sentence that follows "Tracking off for this visit:". Plain, one clause. */
export function offMessage(reason: VisitTrackingOffReason, detail = ''): string {
  switch (reason) {
    case 'denied':
      return 'location was denied in this browser.';
    case 'unavailable':
      return 'this device could not get a location.';
    case 'unsupported':
      return 'this browser cannot share location.';
    case 'permission-lost':
      return 'this browser no longer allows location, so tracking did not resume after the reload.';
    case 'write-failed':
      return detail === '' ? 'the route could not be saved.' : `the route could not be saved. ${detail}`;
  }
}

function off(reason: VisitTrackingOffReason, detail = ''): VisitTrackingStatus {
  return { phase: 'off', reason, message: offMessage(reason, detail) };
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : '';
}

async function writeFix(sessionId: string, position: GeolocationPosition): Promise<boolean> {
  try {
    await addDoc(
      collection(db, 'kin_care_sessions', sessionId, 'breadcrumbs'),
      breadcrumbFromPosition(position),
    );
    return true;
  } catch (err) {
    // A refused write means "tracking on" would be a lie: stop, and say why.
    stopVisitTracking(sessionId, off('write-failed', messageOf(err)));
    return false;
  }
}

function onWatchFix(sessionId: string, position: GeolocationPosition) {
  if (active === null || active.sessionId !== sessionId) return;
  const next = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    at: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
  if (!shouldWriteFix(active.lastWritten, next)) return;
  // Claimed before the write lands so a burst of fixes cannot all pass the
  // filter against the same stale `lastWritten`.
  active.lastWritten = next;
  void writeFix(sessionId, position).then((ok) => {
    if (!ok || active === null || active.sessionId !== sessionId) return;
    active.fixes += 1;
    setStatus(sessionId, { phase: 'on', fixes: active.fixes });
  });
}

function onWatchError(sessionId: string, err: GeolocationPositionError) {
  if (active === null || active.sessionId !== sessionId) return;
  // Only a revoked permission ends the watch. An unavailable or timed-out fix
  // means the device lost signal for a moment, and the next fix corrects it.
  if (err.code === err.PERMISSION_DENIED) stopVisitTracking(sessionId, off('denied'));
}

function sessionStatusOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return '';
  const s = (data as { status?: unknown }).status;
  return typeof s === 'string' ? s.trim().toUpperCase() : '';
}

/**
 * Start the watch and arm the document guard. Idempotent for the same session;
 * a different session's watch is stopped first (one visit per tab).
 */
function startWatch(sessionId: string) {
  const geo = geolocation();
  if (geo === null) {
    setStatus(sessionId, off('unsupported'));
    return;
  }
  if (active !== null && active.sessionId === sessionId) return;
  if (active !== null) stopVisitTracking(active.sessionId);

  const watch: ActiveWatch = {
    sessionId,
    watchId: null,
    unsubscribeDoc: null,
    lastWritten: null,
    fixes: 0,
  };
  active = watch;
  writeStored(sessionId);
  setStatus(sessionId, { phase: 'on', fixes: 0 });

  watch.watchId = geo.watchPosition(
    (pos) => onWatchFix(sessionId, pos),
    (err) => onWatchError(sessionId, err),
    WATCH_OPTIONS,
  );
  watch.unsubscribeDoc = onSnapshot(
    doc(db, 'kin_care_sessions', sessionId),
    (snap) => {
      if (!snap.exists() || sessionStatusOf(snap.data()) !== 'ARRIVED') stopVisitTracking(sessionId);
    },
    () => {
      // A dead listener says nothing about the visit. The watch keeps running;
      // the depart from this tab still stops it, and a breadcrumb write the
      // rules refuse stops it through `writeFix`.
    },
  );
}

/**
 * Stop this tab's watch on `sessionId` if it is the one running, and leave the
 * visit at `finalStatus` (idle by default). Safe to call when nothing is running.
 */
export function stopVisitTracking(sessionId: string, finalStatus: VisitTrackingStatus = IDLE) {
  if (active !== null && active.sessionId === sessionId) {
    const geo = geolocation();
    if (active.watchId !== null && geo !== null) geo.clearWatch(active.watchId);
    if (active.unsubscribeDoc !== null) active.unsubscribeDoc();
    active = null;
    if (readStored() === sessionId) writeStored(null);
  }
  setStatus(sessionId, finalStatus);
}

type FixOutcome = { ok: true; position: GeolocationPosition } | { ok: false; error: GeolocationPositionError };

/** One fix, asked for NOW, synchronously, so the prompt rides the caller's click. */
function requestFix(geo: Geolocation): Promise<FixOutcome> {
  return new Promise((resolve) => {
    geo.getCurrentPosition(
      (position) => resolve({ ok: true, position }),
      (error) => resolve({ ok: false, error }),
      ONCE_OPTIONS,
    );
  });
}

/**
 * Called INSIDE the arrive click, before any await. `arrived` resolves true
 * once the server holds the visit at ARRIVED (a no-op "already arrived" counts),
 * false or rejected when it refused. The location request and the callable run
 * side by side; the watch starts only when both have said yes.
 *
 * A TIMEOUT on the first fix still starts the watch: the Geolocation spec
 * starts the timeout clock only after permission is granted, so a timeout
 * means the GPS was slow and the permission is in hand.
 */
export function beginVisitTracking(sessionId: string, arrived: Promise<boolean>): void {
  const geo = geolocation();
  if (geo === null) {
    setStatus(sessionId, off('unsupported'));
    return;
  }
  if (active !== null && active.sessionId !== sessionId) stopVisitTracking(active.sessionId);
  setStatus(sessionId, STARTING);
  const firstFix = requestFix(geo);

  void Promise.all([arrived.catch(() => false), firstFix]).then(([ok, fix]) => {
    if (!ok) {
      // The visit did not arrive. Nothing to track, and nothing to say about it.
      if (statusOf(sessionId).phase === 'starting') setStatus(sessionId, IDLE);
      return;
    }
    if (!fix.ok && fix.error.code !== fix.error.TIMEOUT) {
      setStatus(sessionId, off(offReasonFor(fix.error)));
      return;
    }
    startWatch(sessionId);
    if (fix.ok && active !== null && active.sessionId === sessionId) {
      active.lastWritten = {
        lat: fix.position.coords.latitude,
        lng: fix.position.coords.longitude,
        at: Number.isFinite(fix.position.timestamp) ? fix.position.timestamp : Date.now(),
      };
      void writeFix(sessionId, fix.position).then((written) => {
        if (!written || active === null || active.sessionId !== sessionId) return;
        active.fixes += 1;
        setStatus(sessionId, { phase: 'on', fixes: active.fixes });
      });
    }
  });
}

/**
 * Called INSIDE the depart click. Asks for one last fix now (permission is
 * already granted, so no prompt), and once the server confirms the depart,
 * stops the watch and writes that fix as the final crumb. A refused depart
 * leaves the watch running: the visit is still ARRIVED.
 *
 * A no-op when this tab is not the one tracking the visit, so a depart of an
 * Android-tracked visit from the web writes no stray web crumb.
 */
export function endVisitTracking(sessionId: string, departed: Promise<boolean>): void {
  if (active === null || active.sessionId !== sessionId) return;
  const geo = geolocation();
  const lastFix: Promise<GeolocationPosition | null> =
    geo === null
      ? Promise.resolve(null)
      : requestFix(geo).then((fix) => (fix.ok ? fix.position : null));

  void departed
    .catch(() => false)
    .then(async (ok) => {
      if (!ok) return;
      stopVisitTracking(sessionId);
      const position = await lastFix;
      if (position === null) return;
      try {
        await addDoc(
          collection(db, 'kin_care_sessions', sessionId, 'breadcrumbs'),
          breadcrumbFromPosition(position),
        );
      } catch {
        // The visit has departed either way; a lost final crumb shortens the
        // drawn route by one point and is not worth a status the row no longer shows.
      }
    });
}

type PermissionRead = 'granted' | 'prompt' | 'denied' | 'unknown';

async function readGeolocationPermission(): Promise<PermissionRead> {
  const perms = (navigator as { permissions?: Permissions }).permissions;
  if (perms === undefined || typeof perms.query !== 'function') return 'unknown';
  try {
    const result = await perms.query({ name: 'geolocation' });
    return result.state === 'granted' || result.state === 'prompt' || result.state === 'denied'
      ? result.state
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * On page load: if this tab clocked a visit in and the browser still allows
 * location, restart the watch without a prompt. Called once from `main.tsx`.
 * Waits for the auth state so the first breadcrumb write carries a token.
 *
 * `prompt` or `denied` ends it: a watch started outside a gesture would either
 * throw a prompt the user did not ask for or fail silently, and the row says
 * why instead. The document guard still validates the session is ARRIVED once
 * the watch starts, so a visit departed from the phone while the tab was gone
 * stops on the first snapshot.
 */
export async function resumeVisitTracking(): Promise<void> {
  const sessionId = readStored();
  if (sessionId === null) return;
  if (geolocation() === null) {
    writeStored(null);
    setStatus(sessionId, off('unsupported'));
    return;
  }
  const auth = await waitForAuthReady();
  if (auth.status !== 'signedIn') {
    writeStored(null);
    return;
  }
  const permission = await readGeolocationPermission();
  if (permission === 'prompt' || permission === 'denied') {
    writeStored(null);
    setStatus(sessionId, off('permission-lost'));
    return;
  }
  startWatch(sessionId);
}

/** Test seam: forget every watch and status without touching the browser. */
export function resetVisitTrackingForTests() {
  if (active !== null) {
    const geo = geolocation();
    if (active.watchId !== null && geo !== null) geo.clearWatch(active.watchId);
    if (active.unsubscribeDoc !== null) active.unsubscribeDoc();
    active = null;
  }
  statuses.clear();
  writeStored(null);
  notify();
}
