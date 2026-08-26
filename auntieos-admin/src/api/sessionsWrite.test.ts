import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `updateDoc` is mocked and asserted NEVER-CALLED throughout, exactly as
 * `bookingsWrite.test.ts` does. That negative is the most important assertion
 * in the file: Android drives this same lifecycle by patching Firestore from
 * the phone, and a faithful port of that would have been a browser writing a
 * visit's status with no audit bound to the write and no household notified. If
 * `updateDoc` is ever called from this module, that hole is back.
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

import { setVisitLifecycle, updateKinCareSession } from './sessionsWrite';

beforeEach(() => {
  doc.mockClear();
  updateDoc.mockReset();
  setDoc.mockReset();
  call.mockReset();
});

function expectNoDirectWrite() {
  expect(updateDoc).not.toHaveBeenCalled();
  expect(setDoc).not.toHaveBeenCalled();
}

const ok = {
  ok: true,
  sessionId: 's1',
  action: 'ARRIVED',
  from: 'ON_MY_WAY',
  status: 'ARRIVED',
  changed: true,
  notified: true,
  notifySkipped: null,
};

describe('setVisitLifecycle', () => {
  it('calls the callable and never writes Firestore directly', async () => {
    call.mockResolvedValue(ok);
    const res = await setVisitLifecycle('s1', 'ARRIVED', { atIso: '2026-08-24T14:02:00Z' });
    expect(call).toHaveBeenCalledWith('setVisitLifecycle', {
      sessionId: 's1',
      action: 'ARRIVED',
      atIso: '2026-08-24T14:02:00Z',
    });
    expectNoDirectWrite();
    expect(res.changed).toBe(true);
  });

  it('omits the optional keys entirely rather than sending undefined', async () => {
    call.mockResolvedValue(ok);
    await setVisitLifecycle('s1', 'UNDO_ARRIVAL');
    expect(call).toHaveBeenCalledWith('setVisitLifecycle', {
      sessionId: 's1',
      action: 'UNDO_ARRIVAL',
    });
  });

  it('forwards an ETA when one is stated', async () => {
    call.mockResolvedValue(ok);
    await setVisitLifecycle('s1', 'ON_MY_WAY', { etaMinutes: 20 });
    expect(call).toHaveBeenCalledWith('setVisitLifecycle', {
      sessionId: 's1',
      action: 'ON_MY_WAY',
      etaMinutes: 20,
    });
  });

  // Fail-loud: this module never decides what the operator gets to see.
  it('propagates a refusal rather than swallowing it', async () => {
    call.mockRejectedValue(
      Object.assign(new Error('Cannot clock out of this visit while it is SCHEDULED.'), {
        details: { code: 'visit_lifecycle_illegal' },
      }),
    );
    await expect(setVisitLifecycle('s1', 'DEPARTED')).rejects.toThrow(/Cannot clock out/);
    expectNoDirectWrite();
  });

  // The no-op is a resolved call, not a rejection, and the caller has to be able
  // to tell it apart from a write.
  it('passes a changed:false no-op through as success', async () => {
    call.mockResolvedValue({ ...ok, from: 'ARRIVED', changed: false, notified: false });
    const res = await setVisitLifecycle('s1', 'ARRIVED');
    expect(res.changed).toBe(false);
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
    expectNoDirectWrite();
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
    expectNoDirectWrite();
  });
});
