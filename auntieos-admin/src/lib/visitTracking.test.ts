// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The browser's visit tracker (issue #772).
 *
 * `navigator.geolocation` is a hand-rolled double: jsdom ships none, and the
 * points that matter are WHEN it is asked (inside the click, synchronously)
 * and WHAT lands in Firestore (Android's seven-field `LocationPoint`, nothing
 * else). Firestore itself is mocked at the SDK boundary so the document shape
 * `addDoc` receives is asserted verbatim.
 */

const { addDoc, onSnapshot, waitForAuthReady } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  onSnapshot: vi.fn(),
  waitForAuthReady: vi.fn(),
}));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  addDoc,
  onSnapshot,
  collection: vi.fn((_db: unknown, ...path: string[]) => ({ kind: 'collection', path })),
  doc: vi.fn((_db: unknown, ...path: string[]) => ({ kind: 'doc', path })),
}));
vi.mock('./auth', () => ({ waitForAuthReady }));

import {
  beginVisitTracking,
  breadcrumbFromPosition,
  endVisitTracking,
  getVisitTrackingStatus,
  resetVisitTrackingForTests,
  resumeVisitTracking,
  shouldWriteFix,
  stopVisitTracking,
} from './visitTracking';

const STORAGE_KEY = 'auntieos.visitTracking.sessionId';

type SuccessCb = (p: GeolocationPosition) => void;
type ErrorCb = (e: GeolocationPositionError) => void;

const geo = {
  getCurrentPosition: vi.fn<(ok: SuccessCb, err?: ErrorCb, opts?: PositionOptions) => void>(),
  watchPosition: vi.fn<(ok: SuccessCb, err?: ErrorCb, opts?: PositionOptions) => number>(() => 7),
  clearWatch: vi.fn(),
};

/** `null` installs no geolocation at all, the way a locked-down browser has none. */
function installGeolocation(value: typeof geo | null) {
  Object.defineProperty(navigator, 'geolocation', { value, configurable: true, writable: true });
}

function position(
  lat: number,
  lng: number,
  timestamp: number,
  extra: Partial<GeolocationCoordinates> = {},
): GeolocationPosition {
  return {
    timestamp,
    coords: {
      latitude: lat,
      longitude: lng,
      altitude: null,
      accuracy: 12,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
      ...extra,
    },
    toJSON: () => ({}),
  } as GeolocationPosition;
}

function geoError(code: 1 | 2 | 3): GeolocationPositionError {
  return {
    code,
    message: 'nope',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

/** Let every queued promise continuation run. */
async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** The watch callbacks the module registered on the last `watchPosition`. */
function watchCallbacks() {
  const call = geo.watchPosition.mock.calls.at(-1);
  if (call === undefined) throw new Error('watchPosition was not called');
  return { onFix: call[0], onError: call[1] as ErrorCb };
}

/** The snapshot callback the module registered on the session document. */
function docCallback(): (snap: { exists: () => boolean; data: () => unknown }) => void {
  const call = onSnapshot.mock.calls.at(-1);
  if (call === undefined) throw new Error('onSnapshot was not called');
  return call[1] as (snap: { exists: () => boolean; data: () => unknown }) => void;
}

const unsubscribeDoc = vi.fn();

beforeEach(() => {
  // `resetAllMocks` drops implementations too, so a `getCurrentPosition`
  // answer set by one case cannot answer the next case's click.
  vi.resetAllMocks();
  installGeolocation(geo);
  geo.getCurrentPosition.mockImplementation(() => {});
  geo.watchPosition.mockReturnValue(7);
  addDoc.mockResolvedValue({ id: 'crumb' });
  onSnapshot.mockReturnValue(unsubscribeDoc);
  waitForAuthReady.mockResolvedValue({ status: 'signedIn', user: {} });
  sessionStorage.clear();
  resetVisitTrackingForTests();
  delete (navigator as { permissions?: unknown }).permissions;
});

afterEach(() => {
  resetVisitTrackingForTests();
});

describe('breadcrumbFromPosition writes the Android LocationPoint shape', () => {
  it('maps the seven fields and turns null readings into 0', () => {
    expect(breadcrumbFromPosition(position(30.2672, -97.7431, 1_770_000_000_000))).toEqual({
      latitude: 30.2672,
      longitude: -97.7431,
      altitude: 0,
      accuracy: 12,
      timestamp: 1_770_000_000_000,
      speed: 0,
      bearing: 0,
    });
  });

  it('carries altitude, speed and heading when the device reports them', () => {
    expect(
      breadcrumbFromPosition(
        position(1, 2, 3, { altitude: 150.5, speed: 1.4, heading: 270, accuracy: 5 }),
      ),
    ).toEqual({
      latitude: 1,
      longitude: 2,
      altitude: 150.5,
      accuracy: 5,
      timestamp: 3,
      speed: 1.4,
      bearing: 270,
    });
  });
});

describe('shouldWriteFix matches the Android save filter', () => {
  const origin = { lat: 30.2672, lng: -97.7431, at: 10_000 };

  it('always writes the first fix', () => {
    expect(shouldWriteFix(null, origin)).toBe(true);
  });

  it('drops a fix under 5 m from the last saved one', () => {
    // ~3 m north.
    expect(shouldWriteFix(origin, { lat: 30.26723, lng: -97.7431, at: 20_000 })).toBe(false);
  });

  it('drops a fix inside the 2 s fastest interval however far it moved', () => {
    expect(shouldWriteFix(origin, { lat: 30.28, lng: -97.7431, at: 11_000 })).toBe(false);
  });

  it('writes a fix that is both 5 m and 2 s past the last one', () => {
    // ~20 m north.
    expect(shouldWriteFix(origin, { lat: 30.26738, lng: -97.7431, at: 12_000 })).toBe(true);
  });
});

describe('beginVisitTracking on the arrive click', () => {
  it('asks for the position synchronously, inside the click, before anything resolves', () => {
    beginVisitTracking('s1', new Promise<boolean>(() => {}));
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'starting' });
  });

  it('granted and arrived: writes the first fix in the Android shape, starts the watch, remembers the tab', async () => {
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(30.2672, -97.7431, 1_000)));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();

    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(addDoc).toHaveBeenCalledWith(
      { kind: 'collection', path: ['kin_care_sessions', 's1', 'breadcrumbs'] },
      {
        latitude: 30.2672,
        longitude: -97.7431,
        altitude: 0,
        accuracy: 12,
        timestamp: 1_000,
        speed: 0,
        bearing: 0,
      },
    );
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(geo.watchPosition.mock.calls[0]?.[2]).toMatchObject({ enableHighAccuracy: true });
    expect(onSnapshot).toHaveBeenCalledWith(
      { kind: 'doc', path: ['kin_care_sessions', 's1'] },
      expect.any(Function),
      expect.any(Function),
    );
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('s1');
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'on', fixes: 1 });
  });

  it('denied: the visit still arrives (the caller owns that), nothing is written, the row says why', async () => {
    geo.getCurrentPosition.mockImplementation((_ok, err) => err?.(geoError(1)));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();

    expect(addDoc).not.toHaveBeenCalled();
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getVisitTrackingStatus('s1')).toEqual({
      phase: 'off',
      reason: 'denied',
      message: 'location was denied in this browser.',
    });
  });

  it('unavailable: same as denied with its own sentence', async () => {
    geo.getCurrentPosition.mockImplementation((_ok, err) => err?.(geoError(2)));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(getVisitTrackingStatus('s1')).toMatchObject({ phase: 'off', reason: 'unavailable' });
  });

  it('a timed-out first fix still starts the watch: the timeout clock only runs once permission is granted', async () => {
    geo.getCurrentPosition.mockImplementation((_ok, err) => err?.(geoError(3)));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(addDoc).not.toHaveBeenCalled();
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'on', fixes: 0 });
  });

  it('a refused arrive starts nothing, even with location granted', async () => {
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(1, 2, 3)));
    beginVisitTracking('s1', Promise.reject(new Error('Wrong status')));
    await flush();
    expect(addDoc).not.toHaveBeenCalled();
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
  });

  it('a browser with no geolocation is off/unsupported and never throws', async () => {
    installGeolocation(null);
    expect(() => beginVisitTracking('s1', Promise.resolve(true))).not.toThrow();
    await flush();
    expect(getVisitTrackingStatus('s1')).toMatchObject({ phase: 'off', reason: 'unsupported' });
  });

  it('a refused breadcrumb write turns tracking off rather than claiming it is on', async () => {
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(1, 2, 3)));
    addDoc.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(getVisitTrackingStatus('s1')).toEqual({
      phase: 'off',
      reason: 'write-failed',
      message: 'the route could not be saved. Missing or insufficient permissions.',
    });
  });
});

describe('the running watch', () => {
  async function arriveTracked() {
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(30.2672, -97.7431, 10_000)));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();
    addDoc.mockClear();
  }

  it('drops a fix under 5 m and writes one that has moved, counting only the writes', async () => {
    await arriveTracked();
    const { onFix } = watchCallbacks();
    onFix(position(30.26723, -97.7431, 13_000));
    await flush();
    expect(addDoc).not.toHaveBeenCalled();

    onFix(position(30.26738, -97.7431, 16_000));
    await flush();
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(addDoc.mock.calls[0]?.[1]).toMatchObject({ latitude: 30.26738, timestamp: 16_000 });
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'on', fixes: 2 });
  });

  it('stops when the session document leaves ARRIVED, whoever moved it', async () => {
    await arriveTracked();
    docCallback()({ exists: () => true, data: () => ({ status: 'DEPARTED' }) });
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(unsubscribeDoc).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
  });

  it('keeps running on a snapshot that still reads ARRIVED', async () => {
    await arriveTracked();
    docCallback()({ exists: () => true, data: () => ({ status: 'arrived' }) });
    expect(geo.clearWatch).not.toHaveBeenCalled();
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'on', fixes: 1 });
  });

  it('stops when the document is gone', async () => {
    await arriveTracked();
    docCallback()({ exists: () => false, data: () => undefined });
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
  });

  it('a revoked permission mid-visit stops the watch and says so; a lost signal does not', async () => {
    await arriveTracked();
    const { onError } = watchCallbacks();
    onError(geoError(2));
    expect(geo.clearWatch).not.toHaveBeenCalled();
    onError(geoError(1));
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(getVisitTrackingStatus('s1')).toMatchObject({ phase: 'off', reason: 'denied' });
  });

  it('one visit per tab: arriving a second visit stops the first', async () => {
    await arriveTracked();
    geo.watchPosition.mockReturnValue(8);
    beginVisitTracking('s2', Promise.resolve(true));
    await flush();
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
    expect(getVisitTrackingStatus('s2')).toEqual({ phase: 'on', fixes: 1 });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('s2');
  });

  it('stopVisitTracking (undo arrival) clears the watch with no final fix', async () => {
    await arriveTracked();
    stopVisitTracking('s1');
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(addDoc).not.toHaveBeenCalled();
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
  });
});

describe('endVisitTracking on the depart click', () => {
  async function arriveTracked() {
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(30.2672, -97.7431, 10_000)));
    beginVisitTracking('s1', Promise.resolve(true));
    await flush();
    addDoc.mockClear();
    geo.getCurrentPosition.mockClear();
  }

  it('asks for the last fix inside the click, and writes it once the depart is confirmed', async () => {
    await arriveTracked();
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(30.27, -97.75, 90_000)));
    endVisitTracking('s1', Promise.resolve(true));
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    await flush();

    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(unsubscribeDoc).toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(addDoc.mock.calls[0]?.[1]).toMatchObject({
      latitude: 30.27,
      longitude: -97.75,
      timestamp: 90_000,
    });
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
  });

  it('a refused depart keeps the watch running and writes nothing', async () => {
    await arriveTracked();
    geo.getCurrentPosition.mockImplementation((ok) => ok(position(30.27, -97.75, 90_000)));
    endVisitTracking('s1', Promise.reject(new Error('Wrong status')));
    await flush();
    expect(geo.clearWatch).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'on', fixes: 1 });
  });

  it('is a no-op when this tab is not the tracker, so a web depart of a phone-tracked visit writes no stray crumb', async () => {
    endVisitTracking('s9', Promise.resolve(true));
    await flush();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });
});

describe('resumeVisitTracking after a reload', () => {
  function installPermissions(state: string | null) {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      writable: true,
      value:
        state === null
          ? undefined
          : { query: vi.fn().mockResolvedValue({ state }) },
    });
  }

  it('does nothing when this tab clocked nothing in', async () => {
    await resumeVisitTracking();
    expect(waitForAuthReady).not.toHaveBeenCalled();
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  it('restarts the watch without a prompt when permission is already granted', async () => {
    sessionStorage.setItem(STORAGE_KEY, 's1');
    installPermissions('granted');
    await resumeVisitTracking();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'on', fixes: 0 });
  });

  it('never starts a watch outside a gesture when the browser would prompt again', async () => {
    sessionStorage.setItem(STORAGE_KEY, 's1');
    installPermissions('prompt');
    await resumeVisitTracking();
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getVisitTrackingStatus('s1')).toMatchObject({ phase: 'off', reason: 'permission-lost' });
  });

  it('tries the watch on a browser with no Permissions API, and lets the watch error settle it', async () => {
    sessionStorage.setItem(STORAGE_KEY, 's1');
    installPermissions(null);
    await resumeVisitTracking();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    watchCallbacks().onError(geoError(1));
    expect(getVisitTrackingStatus('s1')).toMatchObject({ phase: 'off', reason: 'denied' });
  });

  it('waits for auth and gives up when the tab is signed out', async () => {
    sessionStorage.setItem(STORAGE_KEY, 's1');
    installPermissions('granted');
    waitForAuthReady.mockResolvedValue({ status: 'signedOut' });
    await resumeVisitTracking();
    expect(geo.watchPosition).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('a visit the phone departed while the tab was away stops on the first snapshot', async () => {
    sessionStorage.setItem(STORAGE_KEY, 's1');
    installPermissions('granted');
    await resumeVisitTracking();
    docCallback()({ exists: () => true, data: () => ({ status: 'COMPLETED' }) });
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
    expect(getVisitTrackingStatus('s1')).toEqual({ phase: 'idle' });
  });
});
