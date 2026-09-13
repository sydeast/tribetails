import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * THE ASSERTION THIS FILE EXISTS FOR HAS FLIPPED, and the old one is worth
 * recording because it was right when it was written. It used to say:
 *
 *   "`updateDoc` is mocked and asserted NEVER-CALLED throughout ... If
 *    `updateDoc` is ever called from this module, that hole is back."
 *
 * The hole it meant was a browser writing a visit's status with no audit bound
 * to the write and no household notified. Neither is true here: the audit still
 * goes through `logActivity` into `writeAuditEntry`'s hash chain, the household
 * still gets `dispatchVisitNotification`, and both are asserted below. What
 * changed is that they run BEHIND the write instead of inside it, because the
 * callable in front of them cost a measured 7.9 s Cloud Run cold start on a tap
 * whose handler was 0.67 s.
 *
 * So the negative assertion is now the other way round for the three forward
 * transitions and the undo -- `call('setVisitLifecycle')` must NOT happen -- and
 * the old negative is kept, unchanged and just as load-bearing, for COMPLETE
 * and CANCEL: those never came through this module and still do not.
 */
const { doc, updateDoc, setDoc } = vi.hoisted(() => ({
  doc: vi.fn((..._args: unknown[]) => ({ __ref: true }) as unknown),
  updateDoc: vi.fn(),
  setDoc: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ doc, updateDoc, setDoc }));
vi.mock('../lib/firebase', () => ({ db: { __db: true } }));

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  patchVisitLifecycle,
  setVisitLifecycle,
  updateKinCareSession,
  VISIT_LIFECYCLE_ILLEGAL_CODE,
} from './sessionsWrite';

const NOW = '2026-09-12T14:02:00Z';

/** A visit with the full envelope routing, mid-visit. */
const ARRIVED_SESSION = {
  _id: 's1',
  status: 'ARRIVED',
  onMyWayAt: '2026-09-12T13:40:00Z',
  kinfolkId: 'fam1',
  kinCareBatchId: 'batch1',
  kinCareVisitId: 'visit1',
};

const SCHEDULED_SESSION = { ...ARRIVED_SESSION, status: 'SCHEDULED', onMyWayAt: undefined };

beforeEach(() => {
  doc.mockClear();
  updateDoc.mockReset();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockReset();
  call.mockReset();
  call.mockResolvedValue({ ok: true, dispatchIds: ['d1'], suppressed: false });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every callable name this module reached for, in order. */
function callNames(): string[] {
  return call.mock.calls.map((c) => c[0] as string);
}

describe('patchVisitLifecycle writes the status straight to Firestore', () => {
  it('ON_MY_WAY: one updateDoc on the session, and NO setVisitLifecycle call', async () => {
    const res = await patchVisitLifecycle(SCHEDULED_SESSION, 'ON_MY_WAY', { nowIso: NOW });

    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(doc).toHaveBeenCalledWith({ __db: true }, 'kin_care_sessions', 's1');
    expect(updateDoc.mock.calls[0]?.[1]).toEqual({
      status: 'ON_MY_WAY',
      onMyWayAt: NOW,
      updatedAt: NOW,
    });
    expect(callNames()).not.toContain('setVisitLifecycle');
    expect(res).toMatchObject({ from: 'SCHEDULED', status: 'ON_MY_WAY', changed: true });
  });

  it('ARRIVED: the Android field set, with visitRouteId blank for tracking to fill', async () => {
    await patchVisitLifecycle({ ...SCHEDULED_SESSION, status: 'ON_MY_WAY' }, 'ARRIVED', {
      nowIso: NOW,
    });
    expect(updateDoc.mock.calls[0]?.[1]).toEqual({
      status: 'ARRIVED',
      arrivedAt: NOW,
      visitRouteId: '',
      updatedAt: NOW,
    });
    expect(callNames()).not.toContain('setVisitLifecycle');
  });

  it('DEPARTED: stamps the clock-out and nothing terminal', async () => {
    await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    expect(updateDoc.mock.calls[0]?.[1]).toEqual({
      status: 'DEPARTED',
      departedAt: NOW,
      updatedAt: NOW,
    });
    expect(callNames()).not.toContain('setVisitLifecycle');
  });

  it('UNDO_ARRIVAL: rewinds to ON_MY_WAY and clears every arrival trace', async () => {
    await patchVisitLifecycle(ARRIVED_SESSION, 'UNDO_ARRIVAL', { nowIso: NOW });
    expect(updateDoc.mock.calls[0]?.[1]).toEqual({
      status: 'ON_MY_WAY',
      arrivedAt: '',
      departedAt: '',
      arrivalDistanceMeters: '',
      arrivalAccuracyMeters: '',
      arrivalLocationCheckedAt: '',
      updatedAt: NOW,
    });
  });

  // `updateDoc`, never `setDoc`: a session deleted underneath the operator must
  // fail loudly rather than be resurrected as a three-field stub.
  it('never uses setDoc, so a deleted session fails instead of being recreated', async () => {
    await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('propagates a rejected write fail-loud', async () => {
    updateDoc.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    await expect(patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW })).rejects.toThrow(
      /insufficient permissions/,
    );
  });
});

describe('the audit and the household push run AFTER the write, and cannot fail it', () => {
  it('fires logActivity with Android actionType, after the patch has resolved', async () => {
    const order: string[] = [];
    updateDoc.mockImplementation(async () => {
      order.push('updateDoc');
    });
    call.mockImplementation(async (name: string) => {
      order.push(`call:${name}`);
      return { ok: true, dispatchIds: ['d1'], suppressed: false };
    });

    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    await res.notification;

    expect(order[0]).toBe('updateDoc');
    expect(order).toContain('call:logActivity');
    expect(order).toContain('call:dispatchVisitNotification');
    expect(call).toHaveBeenCalledWith('logActivity', {
      actionType: 'VISIT_DEPARTED',
      description: 'DEPARTED on session s1: ARRIVED -> DEPARTED',
      status: 'SUCCESS',
      targetId: 's1',
      targetCollection: 'kin_care_sessions',
    });
  });

  it('routes the push on the envelope pair, preferring it over a legacy bookingId', async () => {
    const res = await patchVisitLifecycle(
      { ...ARRIVED_SESSION, sourceBookingId: 'legacy1' },
      'DEPARTED',
      { nowIso: NOW },
    );
    await res.notification;
    expect(call).toHaveBeenCalledWith('dispatchVisitNotification', {
      familyId: 'fam1',
      batchId: 'batch1',
      visitId: 'visit1',
      event: 'departed',
    });
  });

  it('falls back to the legacy flat bookingId when there is no envelope', async () => {
    const res = await patchVisitLifecycle(
      { _id: 's1', status: 'ARRIVED', kinfolkId: 'fam1', sourceBookingId: 'legacy1' },
      'DEPARTED',
      { nowIso: NOW },
    );
    await res.notification;
    expect(call).toHaveBeenCalledWith('dispatchVisitNotification', {
      familyId: 'fam1',
      bookingId: 'legacy1',
      event: 'departed',
    });
  });

  // THE CENTRAL CLAIM: the Auntie IS at the door. Losing that because a push
  // could not be enqueued would be the worse outcome, which is why Android
  // wraps both of these in `runCatching` and why neither is awaited in front of
  // the write here.
  it('an audit that throws does not fail the tap', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'logActivity') throw new Error('logActivity unavailable');
      return { ok: true, dispatchIds: ['d1'], suppressed: false };
    });
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    expect(res.changed).toBe(true);
    await expect(res.notification).resolves.toEqual({ notified: true, notifySkipped: null });
  });

  it('a dispatch that throws does not fail the tap, and names the skip', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'dispatchVisitNotification') throw new Error('functions/internal');
      return { ok: true };
    });
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    expect(res.changed).toBe(true);
    await expect(res.notification).resolves.toEqual({
      notified: false,
      notifySkipped: 'dispatch_failed',
    });
  });

  it('both failing together still leaves the visit clocked', async () => {
    call.mockRejectedValue(new Error('everything is down'));
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('DEPARTED');
    await expect(res.notification).resolves.toMatchObject({ notified: false });
  });

  it('an undo tells nobody: no dispatch at all', async () => {
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'UNDO_ARRIVAL', { nowIso: NOW });
    await res.notification;
    expect(callNames()).not.toContain('dispatchVisitNotification');
    await expect(res.notification).resolves.toEqual({
      notified: false,
      notifySkipped: 'no_event_for_action',
    });
  });

  it('a session with no routing ids names why, rather than implying a push', async () => {
    const res = await patchVisitLifecycle(
      { _id: 's1', status: 'ARRIVED', kinfolkId: 'fam1' },
      'DEPARTED',
      { nowIso: NOW },
    );
    await expect(res.notification).resolves.toEqual({
      notified: false,
      notifySkipped: 'session_has_no_routing_ids',
    });
    expect(callNames()).not.toContain('dispatchVisitNotification');
  });

  it('a suppressed dispatch is reported as not notified', async () => {
    call.mockResolvedValue({ ok: true, dispatchIds: [], suppressed: true });
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    await expect(res.notification).resolves.toEqual({
      notified: false,
      notifySkipped: 'household_prefs_suppressed',
    });
  });
});

describe('what patchVisitLifecycle refuses before anything leaves the browser', () => {
  it('a double tap writes NOTHING and keeps the time already on file', async () => {
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'ARRIVED', { nowIso: NOW });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(res).toMatchObject({ changed: false, from: 'ARRIVED', status: 'ARRIVED' });
  });

  it('an illegal action throws with the refusal code, and writes nothing', async () => {
    await expect(
      patchVisitLifecycle(SCHEDULED_SESSION, 'DEPARTED', { nowIso: NOW }),
    ).rejects.toThrow(/Cannot clock out of this visit while it is SCHEDULED/);
    expect(updateDoc).not.toHaveBeenCalled();

    let thrown: { details?: { code?: string } } | null = null;
    try {
      await patchVisitLifecycle(SCHEDULED_SESSION, 'DEPARTED', { nowIso: NOW });
    } catch (e) {
      thrown = e as { details?: { code?: string } };
    }
    expect(thrown?.details?.code).toBe(VISIT_LIFECYCLE_ILLEGAL_CODE);
  });

  // The rules would refuse it anyway; refusing here means the operator reads a
  // sentence instead of a permission-denied.
  it('a COMPLETED visit is out of reach of the clock entirely', async () => {
    await expect(
      patchVisitLifecycle({ ...ARRIVED_SESSION, status: 'COMPLETED' }, 'UNDO_ARRIVAL', {
        nowIso: NOW,
      }),
    ).rejects.toThrow(/this visit is COMPLETED/);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

/**
 * THE CALLABLE IS STILL HERE AND STILL WORKS. It is off the field-tap path, not
 * deleted: it is the only path that reads the document server-side before
 * deciding, and this tree's rule is that unreachable code gets fixed rather
 * than removed.
 */
describe('setVisitLifecycle, kept as the server-side path', () => {
  it('still calls the callable and still writes nothing directly', async () => {
    call.mockResolvedValue({
      ok: true,
      sessionId: 's1',
      action: 'ARRIVED',
      from: 'ON_MY_WAY',
      status: 'ARRIVED',
      changed: true,
      notified: true,
      notifySkipped: null,
    });
    const res = await setVisitLifecycle('s1', 'ARRIVED', { atIso: NOW });
    expect(call).toHaveBeenCalledWith('setVisitLifecycle', {
      sessionId: 's1',
      action: 'ARRIVED',
      atIso: NOW,
    });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
    expect(res.changed).toBe(true);
  });

  it('propagates a refusal rather than swallowing it', async () => {
    call.mockRejectedValue(
      Object.assign(new Error('Cannot clock out of this visit while it is SCHEDULED.'), {
        details: { code: 'visit_lifecycle_illegal' },
      }),
    );
    await expect(setVisitLifecycle('s1', 'DEPARTED')).rejects.toThrow(/Cannot clock out/);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

describe('updateKinCareSession', () => {
  it('calls the callable with only the fields stated', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 's1', updated: ['serviceType'] });
    const res = await updateKinCareSession('s1', { serviceType: 'Drop-In' });
    expect(call).toHaveBeenCalledWith('updateKinCareSession', {
      sessionId: 's1',
      serviceType: 'Drop-In',
    });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
    expect(res.updated).toEqual(['serviceType']);
  });

  it('sends an empty kinIds through untouched: it means the whole household', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 's1', updated: ['kinIds', 'kinNames'] });
    await updateKinCareSession('s1', { kinIds: [] });
    expect(call).toHaveBeenCalledWith('updateKinCareSession', { sessionId: 's1', kinIds: [] });
  });

  it('propagates a not-found fail-loud', async () => {
    call.mockRejectedValue(new Error("Session 's1' not found."));
    await expect(updateKinCareSession('s1', { notes: 'x' })).rejects.toThrow(/not found/);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});
