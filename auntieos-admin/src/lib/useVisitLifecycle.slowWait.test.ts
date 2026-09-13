// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The status tap, which is the ruling's literal subject.
 *
 *   "nah wait for servers or a tap to sync option if server access is taking
 *    too long"
 *
 * Two halves. It STAYS PESSIMISTIC: nothing paints the new status until
 * Firestore acks, and `saving` is true for the whole of the wait so every clock
 * control is disabled. And it CAN BE RE-SENT: `retry` exists while, and only
 * while, a write is in flight, so the "Sync now" offer at 10s has something
 * real behind it.
 *
 * Re-sending is safe because `patchVisitLifecycle` decides against the row the
 * screen is holding and answers `changed: false` rather than writing twice.
 * That is asserted here rather than assumed, because it is the single property
 * that makes this the one WRITE either app points a sync button at.
 */

const mocks = vi.hoisted(() => ({
  patchVisitLifecycle: vi.fn(),
  lifecycleNowIso: vi.fn(() => '2026-09-12T10:00:00.000Z'),
}));

vi.mock('../api/sessionsWrite', () => ({
  patchVisitLifecycle: (...a: unknown[]) => mocks.patchVisitLifecycle(...a),
}));
vi.mock('./sessionLifecycle', () => ({ lifecycleNowIso: () => mocks.lifecycleNowIso() }));
vi.mock('./visitTracking', () => ({
  beginVisitTracking: vi.fn(),
  endVisitTracking: vi.fn(),
  stopVisitTracking: vi.fn(),
}));

const { useVisitLifecycle } = await import('./useVisitLifecycle');

afterEach(() => vi.clearAllMocks());

const SESSION = { _id: 's1', status: 'SCHEDULED' } as never;
const ARRIVE = { action: 'ARRIVED', label: 'Arrived' } as never;

describe('useVisitLifecycle: pessimistic, and re-sendable while in flight', () => {
  it('offers no retry until a write is actually in flight', () => {
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    expect(result.current.saving).toBe(false);
    // A sync button on a settled clock would re-send a transition nobody asked
    // for, so there is deliberately nothing to press.
    expect(result.current.retry).toBeNull();
  });

  it('stays saving for the whole wait and never paints the new status early', async () => {
    // A write that never settles: the wedged-updateDoc case the escalation is for.
    mocks.patchVisitLifecycle.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));

    act(() => result.current.ask(ARRIVE));
    act(() => result.current.confirm());

    await waitFor(() => expect(result.current.saving).toBe(true));
    // Pessimistic: no outcome sentence yet, because the server has not spoken.
    expect(result.current.write.status).toBe('saving');
    // And now there IS something for "Sync now" to run.
    expect(result.current.retry).not.toBeNull();
  });

  it('re-sends the same action, and a re-send that lost the race changes nothing', async () => {
    let settle: (v: unknown) => void = () => {};
    mocks.patchVisitLifecycle.mockReturnValueOnce(new Promise((r) => (settle = r)));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));

    act(() => result.current.ask(ARRIVE));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.retry).not.toBeNull());

    // The first attempt is still away. Press Sync.
    mocks.patchVisitLifecycle.mockResolvedValueOnce({
      changed: false,
      status: 'ARRIVED',
      from: 'SCHEDULED',
      notification: Promise.resolve({ notified: false }),
    });
    act(() => result.current.retry?.());

    await waitFor(() => expect(mocks.patchVisitLifecycle).toHaveBeenCalledTimes(2));
    // Same action both times: a sync re-sends the transition, it does not
    // invent a different one.
    expect(mocks.patchVisitLifecycle.mock.calls[0]?.[1]).toBe('ARRIVED');
    expect(mocks.patchVisitLifecycle.mock.calls[1]?.[1]).toBe('ARRIVED');

    // THE IDEMPOTENCY PROPERTY. The row was already ARRIVED by the time the
    // re-send landed, so nothing was written and the operator is told exactly
    // that, rather than being given a second arrival with a moved timestamp.
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(result.current.write.status === 'done' && result.current.write.message).toContain(
      'Already ARRIVED',
    );
    settle({
      changed: true,
      status: 'ARRIVED',
      from: 'SCHEDULED',
      notification: Promise.resolve({ notified: false }),
    });
  });
});
