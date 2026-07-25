import { describe, it, expect, vi, beforeEach } from 'vitest';

const { doc, updateDoc } = vi.hoisted(() => ({
  doc: vi.fn((..._args: unknown[]) => ({ __ref: true }) as unknown),
  updateDoc: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({ doc, updateDoc }));
vi.mock('../lib/firebase', () => ({ db: { __db: true } }));

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  setBookingStatus,
  approveBooking,
  rejectBooking,
  cancelBooking,
  markBookingCompleted,
  rescheduleBooking,
  batchUpdateBookings,
} from './bookingsWrite';

beforeEach(() => {
  doc.mockClear();
  updateDoc.mockReset();
  call.mockReset();
});

describe('setBookingStatus (the shared direct-write primitive)', () => {
  it('resolves the ref against kin_care_sessions/{bookingId}', async () => {
    updateDoc.mockResolvedValue(undefined);
    await setBookingStatus('ses1', 'SCHEDULED');
    expect(doc).toHaveBeenCalledWith({ __db: true }, 'kin_care_sessions', 'ses1');
  });

  it('writes a bare {status} patch when no extra fields are given', async () => {
    updateDoc.mockResolvedValue(undefined);
    await setBookingStatus('ses1', 'SCHEDULED');
    expect(updateDoc).toHaveBeenCalledWith({ __ref: true }, { status: 'SCHEDULED' });
  });

  it('merges extra fields alongside status (e.g. completedAt)', async () => {
    updateDoc.mockResolvedValue(undefined);
    await setBookingStatus('ses1', 'COMPLETED', { completedAt: '2026-07-16T10:00:00.000Z' });
    expect(updateDoc).toHaveBeenCalledWith(
      { __ref: true },
      { status: 'COMPLETED', completedAt: '2026-07-16T10:00:00.000Z' },
    );
  });

  it('propagates a write failure fail-loud, never swallowed', async () => {
    updateDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(setBookingStatus('ses1', 'SCHEDULED')).rejects.toThrow('permission-denied');
  });
});

describe('approveBooking (ports platformApproveBooking verbatim)', () => {
  it('writes the bare {"status":"SCHEDULED"} patch, no extra fields', async () => {
    updateDoc.mockResolvedValue(undefined);
    await approveBooking('ses1');
    expect(updateDoc).toHaveBeenCalledWith({ __ref: true }, { status: 'SCHEDULED' });
  });
});

describe('rejectBooking (ports platformRejectBooking verbatim)', () => {
  it('writes the bare {"status":"CANCELLED"} patch', async () => {
    updateDoc.mockResolvedValue(undefined);
    await rejectBooking('ses1');
    expect(updateDoc).toHaveBeenCalledWith({ __ref: true }, { status: 'CANCELLED' });
  });
});

describe('cancelBooking (ports KinCareSessionsScreen.kt "Cancel KinCare")', () => {
  it('writes the same bare {"status":"CANCELLED"} patch as rejectBooking', async () => {
    updateDoc.mockResolvedValue(undefined);
    await cancelBooking('ses1');
    expect(updateDoc).toHaveBeenCalledWith({ __ref: true }, { status: 'CANCELLED' });
  });
});

describe('markBookingCompleted (ports KinCareSessionsScreen.kt "Mark Completed")', () => {
  it('writes status COMPLETED plus the caller-supplied completedAt, verbatim', async () => {
    updateDoc.mockResolvedValue(undefined);
    await markBookingCompleted('ses1', '2026-07-16T10:00:00.000Z');
    expect(updateDoc).toHaveBeenCalledWith(
      { __ref: true },
      { status: 'COMPLETED', completedAt: '2026-07-16T10:00:00.000Z' },
    );
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
