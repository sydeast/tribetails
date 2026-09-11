// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * The visit clock's wiring into the browser tracker (issue #772).
 *
 * WHAT IS ASSERTED IS THE TICK. The browser ties its location prompt to a
 * user gesture, so `beginVisitTracking` has to be called synchronously inside
 * `confirm`, before the callable settles. The tracker itself is a mock here;
 * its behaviour has its own spec in `visitTracking.test.ts`.
 */

const { setVisitLifecycle, beginVisitTracking, endVisitTracking, stopVisitTracking } = vi.hoisted(
  () => ({
    setVisitLifecycle: vi.fn(),
    beginVisitTracking: vi.fn(),
    endVisitTracking: vi.fn(),
    stopVisitTracking: vi.fn(),
  }),
);
vi.mock('../api/sessionsWrite', () => ({ setVisitLifecycle }));
vi.mock('./visitTracking', () => ({ beginVisitTracking, endVisitTracking, stopVisitTracking }));

import { useVisitLifecycle } from './useVisitLifecycle';
import { lifecycleActionsFor } from './sessionLifecycle';

function actionNamed(action: string) {
  const all = [
    ...lifecycleActionsFor('scheduled'),
    ...lifecycleActionsFor('onMyWay'),
    ...lifecycleActionsFor('arrived'),
    ...lifecycleActionsFor('departed'),
  ];
  const def = all.find((a) => a.action === action);
  if (def === undefined) throw new Error(`no lifecycle action ${action}`);
  return def;
}

function accepted(status: string, from = 'ON_MY_WAY') {
  return {
    ok: true,
    sessionId: 's1',
    action: status,
    from,
    status,
    changed: from !== status,
    notified: true,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useVisitLifecycle hands the clock to the browser tracker', () => {
  it('ARRIVED: starts tracking inside the confirm, before the callable resolves', async () => {
    let resolve: (v: unknown) => void = () => {};
    setVisitLifecycle.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));

    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());

    expect(beginVisitTracking).toHaveBeenCalledTimes(1);
    expect(beginVisitTracking.mock.calls[0]?.[0]).toBe('s1');
    expect(beginVisitTracking.mock.calls[0]?.[1]).toBeInstanceOf(Promise);
    expect(setVisitLifecycle).toHaveBeenCalledTimes(1);

    resolve(accepted('ARRIVED'));
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(true);
  });

  it('ARRIVED already on file (changed: false) still counts as arrived for the tracker', async () => {
    setVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(true);
  });

  it('a refused arrive tells the tracker false, and the row shows the refusal', async () => {
    setVisitLifecycle.mockRejectedValue(new Error('Wrong status for ARRIVED.'));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(false);
    await waitFor(() =>
      expect(result.current.write).toEqual({ status: 'error', message: 'Wrong status for ARRIVED.' }),
    );
  });

  it('DEPARTED: ends tracking inside the confirm with the callable outcome', async () => {
    setVisitLifecycle.mockResolvedValue(accepted('DEPARTED', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));
    act(() => result.current.ask(actionNamed('DEPARTED')));
    act(() => result.current.confirm());
    expect(endVisitTracking).toHaveBeenCalledTimes(1);
    expect(endVisitTracking.mock.calls[0]?.[0]).toBe('s1');
    await expect(endVisitTracking.mock.calls[0]?.[1]).resolves.toBe(true);
    expect(beginVisitTracking).not.toHaveBeenCalled();
  });

  it('UNDO_ARRIVAL: stops tracking once the server has undone it, with no fix', async () => {
    setVisitLifecycle.mockResolvedValue(accepted('ON_MY_WAY', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(stopVisitTracking).toHaveBeenCalledWith('s1'));
    expect(endVisitTracking).not.toHaveBeenCalled();
  });

  it('a refused undo leaves the watch alone', async () => {
    setVisitLifecycle.mockRejectedValue(new Error('Wrong status.'));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(stopVisitTracking).not.toHaveBeenCalled();
  });

  it('ON_MY_WAY touches no tracker', async () => {
    setVisitLifecycle.mockResolvedValue(accepted('ON_MY_WAY', 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle('s1', 'the Wrens'));
    act(() => result.current.ask(actionNamed('ON_MY_WAY')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(beginVisitTracking).not.toHaveBeenCalled();
    expect(endVisitTracking).not.toHaveBeenCalled();
    expect(stopVisitTracking).not.toHaveBeenCalled();
  });

  it('no session id: neither the callable nor the tracker is touched', () => {
    const { result } = renderHook(() => useVisitLifecycle(null, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    expect(setVisitLifecycle).not.toHaveBeenCalled();
    expect(beginVisitTracking).not.toHaveBeenCalled();
  });
});
