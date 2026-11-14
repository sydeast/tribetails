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
const { doc, updateDoc, setDoc, onSnapshot, unsubscribe } = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return {
    doc: vi.fn((..._args: unknown[]) => ({ __ref: true }) as unknown),
    updateDoc: vi.fn(),
    setDoc: vi.fn(),
    unsubscribe,
    // #2037: the read of the server's record of what the household was told.
    onSnapshot: vi.fn((..._args: unknown[]) => unsubscribe),
  };
});
vi.mock('firebase/firestore', () => ({ doc, updateDoc, setDoc, onSnapshot }));
vi.mock('../lib/firebase', () => ({ db: { __db: true } }));

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  patchVisitLifecycle,
  setVisitLifecycle,
  updateKinCareSession,
  VISIT_LIFECYCLE_ILLEGAL_CODE,
  VISIT_NOTICE_WAIT_MS,
  visitStepNoticeId,
  visitStepRecordOutcome,
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
  onSnapshot.mockClear();
  unsubscribe.mockClear();
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

/**
 * #2037: the line and the household notice are the SERVER's, sent from the
 * committed write. This module sends neither, so a reload a second after the
 * tap cannot lose them. It only reads the server's record of what the household
 * was told, for the sentence on the card.
 */
describe('after the write, the browser sends nothing and reads the server record (#2037)', () => {
  /** Deliver the server's record to the live read the module opened. */
  function record(data: Record<string, unknown> | null) {
    const [, next] = onSnapshot.mock.calls.at(-1) as [unknown, (snap: unknown) => void];
    next({ exists: () => data !== null, data: () => data });
  }

  it('calls neither logActivity nor dispatchVisitNotification, for any step', async () => {
    for (const [session, action] of [
      [SCHEDULED_SESSION, 'ON_MY_WAY'],
      [{ ...SCHEDULED_SESSION, status: 'ON_MY_WAY' }, 'ARRIVED'],
      [ARRIVED_SESSION, 'DEPARTED'],
      [ARRIVED_SESSION, 'UNDO_ARRIVAL'],
    ] as const) {
      await patchVisitLifecycle(session, action, { nowIso: NOW });
    }
    expect(callNames()).toEqual([]);
  });

  it('reads the record named by the session, the notice and the stamped time', async () => {
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    expect(doc).toHaveBeenLastCalledWith({ __db: true }, 'visit_step_notices', `s1__departed__${Date.parse(NOW)}`);
    expect(visitStepNoticeId('s1', 'departed', Date.parse(NOW))).toBe(`s1__departed__${Date.parse(NOW)}`);
    record({ notified: true, reason: null });
    await expect(res.notification).resolves.toEqual({ notified: true, notifySkipped: null });
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('waits past a record that does not exist yet', async () => {
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    record(null);
    record({ notified: false, reason: 'household_notices_off' });
    await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: 'household_notices_off' });
  });

  it.each(['household_has_no_portal_account', 'household_notices_off', 'household_prefs_suppressed', 'already_notified'])(
    'passes the recorded reason %s through',
    async (reason) => {
      const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
      record({ notified: false, reason });
      await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: reason });
    },
  );

  it('a record with no reason is "not sent", never a guess', () => {
    expect(visitStepRecordOutcome({ notified: false })).toEqual({ notified: false, notifySkipped: 'not_sent' });
  });

  it('no record in time is "still checking", not "not told", and the read is closed', async () => {
    vi.useFakeTimers();
    try {
      const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
      vi.advanceTimersByTime(VISIT_NOTICE_WAIT_MS);
      await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: 'notice_pending' });
      expect(unsubscribe).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused read is "still checking" and never fails the tap', async () => {
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'DEPARTED', { nowIso: NOW });
    const [, , fail] = onSnapshot.mock.calls.at(-1) as [unknown, unknown, (err: Error) => void];
    fail(new Error('Missing or insufficient permissions.'));
    expect(res.changed).toBe(true);
    await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: 'notice_pending' });
  });

  it('an undo tells nobody and reads nothing', async () => {
    const res = await patchVisitLifecycle(ARRIVED_SESSION, 'UNDO_ARRIVAL', { nowIso: NOW });
    await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: 'no_event_for_action' });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('a session with no routing ids names why at once, as the server records it', async () => {
    const res = await patchVisitLifecycle({ _id: 's1', status: 'ARRIVED', kinfolkId: 'fam1' }, 'DEPARTED', {
      nowIso: NOW,
    });
    await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: 'session_has_no_routing_ids' });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('a session linked to no household names that', async () => {
    const res = await patchVisitLifecycle({ ...ARRIVED_SESSION, kinfolkId: '' }, 'DEPARTED', { nowIso: NOW });
    await expect(res.notification).resolves.toEqual({ notified: false, notifySkipped: 'session_has_no_kinfolk' });
  });

  it('a legacy flat bookingId is routable, so the record is read', async () => {
    await patchVisitLifecycle({ _id: 's1', status: 'ARRIVED', kinfolkId: 'fam1', sourceBookingId: 'legacy1' }, 'DEPARTED', {
      nowIso: NOW,
    });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
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
