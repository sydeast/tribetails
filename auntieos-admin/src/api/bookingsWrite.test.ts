import { describe, it, expect, vi, beforeEach } from 'vitest';

const { doc, getDoc, updateDoc } = vi.hoisted(() => ({
  doc: vi.fn((..._args: unknown[]) => ({ __ref: true }) as unknown),
  getDoc: vi.fn(),
  updateDoc: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ doc, getDoc, updateDoc }));
vi.mock('../lib/firebase', () => ({ db: { __db: true } }));

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  transitionBookingStatus,
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
  batchUpdateBookings,
  assignAuntie,
  addBookingNote,
  addInternalBookingNote,
} from './bookingsWrite';

beforeEach(() => {
  doc.mockClear();
  getDoc.mockReset();
  updateDoc.mockReset();
  call.mockReset();
});

/**
 * A3: these four USED to be `updateDoc(doc(db, 'kin_care_sessions', id), {...})`
 * straight from the browser, and this suite used to assert exactly that patch.
 * The single most important assertion in the file is now the negative one: no
 * status write reaches Firestore from this client at all. If `updateDoc` is
 * ever called again from this module the audit hole is back, and these tests
 * are what says so.
 */
function expectNoDirectWrite() {
  expect(updateDoc).not.toHaveBeenCalled();
}

describe('transitionBookingStatus (the shared callable primitive)', () => {
  it('calls the transitionBookingStatus callable and never writes Firestore directly', async () => {
    call.mockResolvedValue({
      ok: true, sessionId: 'ses1', action: 'CANCEL', from: 'SCHEDULED', status: 'CANCELLED', changed: true,
    });
    const result = await transitionBookingStatus({ sessionId: 'ses1', action: 'CANCEL' });
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses1',
      action: 'CANCEL',
    });
    expectNoDirectWrite();
    expect(result.changed).toBe(true);
  });

  it('propagates a refusal fail-loud, never swallowed', async () => {
    call.mockRejectedValue(new Error('Cannot COMPLETE a booking in status CANCELLED.'));
    await expect(
      transitionBookingStatus({ sessionId: 'ses1', action: 'COMPLETE' }),
    ).rejects.toThrow('Cannot COMPLETE a booking in status CANCELLED.');
  });
});

describe('approveBooking', () => {
  it('sends action APPROVE for the booking id, through the callable', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses1', action: 'APPROVE', from: 'PENDING', status: 'SCHEDULED', changed: true });
    await approveBooking('ses1');
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses1',
      action: 'APPROVE',
    });
    expectNoDirectWrite();
  });
});

describe('rejectBooking (a request that was never approved)', () => {
  it('sends action REJECT, NOT a rewritten CANCEL', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses1', action: 'REJECT', from: 'PENDING', status: 'CANCELLED', changed: true });
    await rejectBooking('ses1');
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses1',
      action: 'REJECT',
    });
    expectNoDirectWrite();
  });
});

describe('cancelBooking (a visit that WAS approved)', () => {
  it('sends action CANCEL, a different action from REJECT even though both end at CANCELLED', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses2', action: 'CANCEL', from: 'SCHEDULED', status: 'CANCELLED', changed: true });
    await cancelBooking('ses2');
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses2',
      action: 'CANCEL',
    });
  });

  it('passes a trimmed reason through when the operator supplied one', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses2', action: 'CANCEL', from: 'SCHEDULED', status: 'CANCELLED', changed: true });
    await cancelBooking('ses2', '  household away  ');
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses2',
      action: 'CANCEL',
      reason: 'household away',
    });
  });

  it('omits the key entirely for a blank reason rather than sending an empty string', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses2', action: 'CANCEL', from: 'SCHEDULED', status: 'CANCELLED', changed: true });
    await cancelBooking('ses2', '   ');
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses2',
      action: 'CANCEL',
    });
  });
});

describe('markBookingCompleted', () => {
  it('sends action COMPLETE with the caller-supplied completedAt, verbatim', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses3', action: 'COMPLETE', from: 'SCHEDULED', status: 'COMPLETED', changed: true });
    await markBookingCompleted('ses3', '2026-07-16T10:00:00.000Z');
    expect(call).toHaveBeenCalledWith('transitionBookingStatus', {
      sessionId: 'ses3',
      action: 'COMPLETE',
      completedAt: '2026-07-16T10:00:00.000Z',
    });
    expectNoDirectWrite();
  });
});

describe('rescheduleBooking (admin callable)', () => {
  it('calls rescheduleBooking with {sessionId, startTime, endTime}, matching the Zod contract', async () => {
    call.mockResolvedValue({ ok: true, sessionId: 'ses1' });
    const result = await rescheduleBooking('ses1', '2026-07-20T09:00', '2026-07-20T10:00');
    expect(call).toHaveBeenCalledWith('rescheduleBooking', {
      sessionId: 'ses1',
      startTime: '2026-07-20T09:00',
      endTime: '2026-07-20T10:00',
    });
    expect(result).toEqual({ ok: true, sessionId: 'ses1' });
  });

  it('propagates a callable failure fail-loud (e.g. not-found)', async () => {
    call.mockRejectedValue(new Error("Session 'ses1' not found."));
    await expect(rescheduleBooking('ses1', '2026-07-20T09:00', '2026-07-20T10:00')).rejects.toThrow(
      'not found',
    );
  });
});

describe('batchUpdateBookings (admin callable, envelope visits)', () => {
  it('sends exactly { ids, action }, matching the backend Zod contract', async () => {
    call.mockResolvedValue({ ok: true, action: 'APPROVE', updated: 1, failed: [] });
    await batchUpdateBookings(['v1'], 'APPROVE');
    expect(call).toHaveBeenCalledWith('batchUpdateBookings', { ids: ['v1'], action: 'APPROVE' });
  });

  it('carries REJECT through as REJECT, not a rewritten CANCEL', async () => {
    call.mockResolvedValue({ ok: true, action: 'REJECT', updated: 1, failed: [] });
    await batchUpdateBookings(['v1'], 'REJECT');
    expect(call).toHaveBeenCalledWith('batchUpdateBookings', { ids: ['v1'], action: 'REJECT' });
  });

  it('returns the per-id failures verbatim so a partial batch is visible', async () => {
    call.mockResolvedValue({
      ok: true,
      action: 'APPROVE',
      updated: 0,
      failed: [{ id: 'v1', error: 'not found' }],
    });
    const result = await batchUpdateBookings(['v1'], 'APPROVE');
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([{ id: 'v1', error: 'not found' }]);
  });

  it('propagates a callable rejection fail-loud', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(batchUpdateBookings(['v1'], 'APPROVE')).rejects.toThrow('permission-denied');
  });
});

describe('assignAuntie (admin callable, envelope visits only)', () => {
  it('calls assignAuntie with {kinfolkId, batchId, visitId, auntieUid}, matching the Zod contract', async () => {
    call.mockResolvedValue({ ok: true, visitId: 'v1', auntieUid: 'u1' });
    const result = await assignAuntie('kf1', 'b1', 'v1', 'u1');
    expect(call).toHaveBeenCalledWith('assignAuntie', {
      kinfolkId: 'kf1',
      batchId: 'b1',
      visitId: 'v1',
      auntieUid: 'u1',
    });
    expect(result).toEqual({ ok: true, visitId: 'v1', auntieUid: 'u1' });
  });
  it('sends an explicit null to UNASSIGN (the contract is nullable, not optional)', async () => {
    call.mockResolvedValue({ ok: true, visitId: 'v1', auntieUid: null });
    await assignAuntie('kf1', 'b1', 'v1', null);
    expect(call).toHaveBeenCalledWith('assignAuntie', {
      kinfolkId: 'kf1',
      batchId: 'b1',
      visitId: 'v1',
      auntieUid: null,
    });
  });
  it('propagates a callable failure fail-loud (e.g. no staff record)', async () => {
    call.mockRejectedValue(new Error('assignAuntie: no staff record for that uid.'));
    await expect(assignAuntie('kf1', 'b1', 'v1', 'u9')).rejects.toThrow('no staff record');
  });
});
describe('addBookingNote (kinfolk-facing; portal callable, server enforces the 3h cutoff)', () => {
  it('sends the envelope ids so the server writes under kinCares/{visitId}/notes', async () => {
    call.mockResolvedValue({ noteId: 'n1' });
    await expect(addBookingNote('kf1', 'b1', 'v1', '  Fed the cat.  ')).resolves.toEqual({
      noteId: 'n1',
    });
    expect(call).toHaveBeenCalledWith('addBookingNote', {
      kinfolkId: 'kf1',
      batchId: 'b1',
      visitId: 'v1',
      body: 'Fed the cat.',
    });
  });
  it('propagates the server cutoff rejection fail-loud rather than silently no-oping', async () => {
    call.mockRejectedValue(
      new Error('Notes cannot be edited within 3 hours of booking start window.'),
    );
    await expect(addBookingNote('kf1', 'b1', 'v1', 'late')).rejects.toThrow('within 3 hours');
  });
});
describe('addInternalBookingNote (admin-only; separate callable, separate subcollection)', () => {
  it('sends the same envelope ids to the admin callable', async () => {
    call.mockResolvedValue({ noteId: 'n2' });
    await addInternalBookingNote('kf1', 'b1', 'v1', 'Gate code changed.');
    expect(call).toHaveBeenCalledWith('addInternalBookingNote', {
      kinfolkId: 'kf1',
      batchId: 'b1',
      visitId: 'v1',
      body: 'Gate code changed.',
    });
  });
  it('propagates a callable failure fail-loud', async () => {
    call.mockRejectedValue(new Error('booking not found'));
    await expect(addInternalBookingNote('kf1', 'b1', 'v1', 'x')).rejects.toThrow('booking not found');
  });
});
