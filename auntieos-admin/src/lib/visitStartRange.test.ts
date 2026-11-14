// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #2279: the browser half of "an Auntie cannot start a visit outside the range
 * of the household". The rule and the range are the server's; this file covers
 * the position the browser hands it, the server path's own wiring, and the two
 * sentences only the browser can say.
 */
const { doc, updateDoc, onSnapshot } = vi.hoisted(() => ({
  doc: vi.fn((..._args: unknown[]) => ({ __ref: true }) as unknown),
  updateDoc: vi.fn(),
  onSnapshot: vi.fn((..._args: unknown[]) => vi.fn()),
}));
vi.mock('firebase/firestore', () => ({ doc, updateDoc, setDoc: vi.fn(), onSnapshot }));
vi.mock('./firebase', () => ({ db: { __db: true } }));
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./fns', () => ({ call }));

import { startVisitWithRangeCheck, verifyVisitArrival } from '../api/sessionsWrite';
import {
  START_NEEDS_PROPERTY_MESSAGE,
  formatRangeDistance,
  isRulesRefusal,
  ownerOutsideRangeSentence,
  requestStartFix,
  startsVisit,
} from './visitStartRange';

const NOW = '2026-11-14T14:02:00Z';
const SCHEDULED = { _id: 's1', status: 'SCHEDULED', kinfolkId: 'fam1' };
const FIX = { lat: 34.05, lng: -118.24, accuracyMeters: 8 };

function stubGeolocation(getCurrentPosition: Geolocation['getCurrentPosition'] | undefined) {
  if (getCurrentPosition === undefined) {
    Reflect.deleteProperty(navigator, 'geolocation');
    return;
  }
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => stubGeolocation(undefined));

describe('requestStartFix', () => {
  it('asks the browser at once, inside the call, and returns the position with its accuracy', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 34.05, longitude: -118.24, accuracy: 8 } } as GeolocationPosition),
    );
    stubGeolocation(getCurrentPosition);
    const pending = requestStartFix();
    // Synchronous: the browser ties its prompt to the click that called this.
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual(FIX);
  });

  it('resolves null when the prompt is refused, so the server can say so', async () => {
    stubGeolocation(vi.fn((_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
      fail?.({ code: 1, message: 'denied' } as GeolocationPositionError),
    ));
    await expect(requestStartFix()).resolves.toBeNull();
  });

  it('resolves null in a browser with no geolocation, and when the browser throws', async () => {
    stubGeolocation(undefined);
    await expect(requestStartFix()).resolves.toBeNull();
    stubGeolocation(vi.fn(() => {
      throw new Error('insecure origin');
    }));
    await expect(requestStartFix()).resolves.toBeNull();
  });

  it('leaves out an accuracy the browser did not give', async () => {
    stubGeolocation(vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 34.05, longitude: -118.24, accuracy: Number.NaN } } as GeolocationPosition),
    ));
    await expect(requestStartFix()).resolves.toEqual({ lat: 34.05, lng: -118.24 });
  });
});

describe('startVisitWithRangeCheck', () => {
  const served = (status: string) => ({
    ok: true,
    sessionId: 's1',
    action: status,
    from: 'SCHEDULED',
    status,
    changed: true,
    notified: true,
    notifySkipped: null,
  });

  it.each(['ON_MY_WAY', 'ARRIVED'] as const)(
    '%s calls the server with the position and writes nothing from the browser',
    async (action) => {
      call.mockResolvedValue(served(action));
      const res = await startVisitWithRangeCheck(SCHEDULED, action, { nowIso: NOW, fix: FIX });
      expect(call).toHaveBeenCalledWith('setVisitLifecycle', {
        sessionId: 's1',
        action,
        atIso: NOW,
        lat: 34.05,
        lng: -118.24,
        accuracyMeters: 8,
      });
      expect(updateDoc).not.toHaveBeenCalled();
      expect(res).toMatchObject({ from: 'SCHEDULED', status: action, changed: true });
      await expect(res.notification).resolves.toEqual({ notified: true, notifySkipped: null });
    },
  );

  it('sends no position when the browser gave none, and still asks the server', async () => {
    call.mockResolvedValue(served('ARRIVED'));
    await startVisitWithRangeCheck(SCHEDULED, 'ARRIVED', { nowIso: NOW, fix: null });
    expect(call).toHaveBeenCalledWith('setVisitLifecycle', { sessionId: 's1', action: 'ARRIVED', atIso: NOW });
  });

  it('passes the server refusal through with its sentence untouched', async () => {
    const refusal =
      'You are 2.3 km from this household. You need to be at the property to start this visit. ' +
      'The owner can start it if you cannot get there.';
    call.mockRejectedValue(Object.assign(new Error(refusal), { details: { code: 'visit_start_outside_range' } }));
    await expect(startVisitWithRangeCheck(SCHEDULED, 'ARRIVED', { nowIso: NOW, fix: FIX })).rejects.toThrow(refusal);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('a second tap on a visit already there is a no-op that costs no round trip', async () => {
    const res = await startVisitWithRangeCheck({ ...SCHEDULED, status: 'ARRIVED' }, 'ARRIVED', { nowIso: NOW, fix: FIX });
    expect(res).toMatchObject({ changed: false, status: 'ARRIVED' });
    expect(call).not.toHaveBeenCalled();
  });

  it('a start from the wrong state is refused before anything is sent', async () => {
    await expect(
      startVisitWithRangeCheck({ ...SCHEDULED, status: 'DEPARTED' }, 'ON_MY_WAY', { nowIso: NOW, fix: FIX }),
    ).rejects.toThrow(/Cannot mark this visit On my way/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('verifyVisitArrival', () => {
  it('sends the session and the position, and nothing else', async () => {
    call.mockResolvedValue({ ok: true, status: 'within' });
    await verifyVisitArrival('s1', FIX);
    expect(call).toHaveBeenCalledWith('verifyVisitArrival', { sessionId: 's1', lat: 34.05, lng: -118.24, accuracyMeters: 8 });
  });
});

describe('the sentences the browser says', () => {
  it('only On my way and Arrived start a visit', () => {
    expect(startsVisit('ON_MY_WAY')).toBe(true);
    expect(startsVisit('ARRIVED')).toBe(true);
    expect(startsVisit('DEPARTED')).toBe(false);
    expect(startsVisit('UNDO_ARRIVAL')).toBe(false);
  });

  it('reads a rules refusal by its code, in either spelling', () => {
    expect(isRulesRefusal({ code: 'permission-denied' })).toBe(true);
    expect(isRulesRefusal({ code: 'firestore/permission-denied' })).toBe(true);
    expect(isRulesRefusal({ code: 'unavailable' })).toBe(false);
    expect(isRulesRefusal(new Error('Missing or insufficient permissions.'))).toBe(false);
    expect(isRulesRefusal(null)).toBe(false);
  });

  it('the rules-refusal sentence says to be at the property and names the owner, in plain words', () => {
    expect(START_NEEDS_PROPERTY_MESSAGE).toContain('at the property');
    expect(START_NEEDS_PROPERTY_MESSAGE).toContain('owner');
    expect(START_NEEDS_PROPERTY_MESSAGE).not.toMatch(/Settings|permission|radius|—|–/i);
  });

  it('formats a distance the way the server does', () => {
    expect(formatRangeDistance(40)).toBe('40 m');
    expect(formatRangeDistance(999.4)).toBe('999 m');
    expect(formatRangeDistance(2300)).toBe('2.3 km');
    expect(formatRangeDistance(Number.NaN)).toBe('an unknown distance');
  });

  it('tells the owner an arrival outside the range was recorded', () => {
    expect(ownerOutsideRangeSentence({ status: 'outside', distanceMeters: 480, verificationRequired: true })).toBe(
      'You arrived 480 m from this household, outside the range. That is recorded on the visit and in the Activity Log.',
    );
  });

  it('says nothing inside the range, with the rule off, or with nothing measured', () => {
    expect(ownerOutsideRangeSentence({ status: 'within', distanceMeters: 20, verificationRequired: true })).toBe('');
    expect(ownerOutsideRangeSentence({ status: 'outside', distanceMeters: 2300, verificationRequired: false })).toBe('');
    expect(ownerOutsideRangeSentence({ status: 'unverified', distanceMeters: 90, verificationRequired: true })).toBe('');
    expect(
      ownerOutsideRangeSentence({ status: 'household_location_unknown', distanceMeters: null, verificationRequired: true }),
    ).toBe('');
  });
});
