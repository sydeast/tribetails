// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * The visit clock's wiring into the browser tracker (issue #772), and the
 * two-stage sentence the direct write produces.
 *
 * WHAT IS ASSERTED IS THE TICK. The browser ties its location prompt to a
 * user gesture, so `beginVisitTracking` has to be called synchronously inside
 * `confirm`, before the write settles. The tracker itself is a mock here; its
 * behaviour has its own spec in `visitTracking.test.ts`.
 *
 * THE SECOND THING ASSERTED IS THAT THE HOOK DOES NOT CLAIM A NOTIFICATION IT
 * HAS NOT SEEN. The household push settles AFTER the write, so the status
 * sentence has to land first and be amended later. A hook that said "the Wrens
 * were notified" on the strength of the patch alone would be the exact lie this
 * file's subject has been warned about since #703.
 */

const { patchVisitLifecycle, beginVisitTracking, endVisitTracking, stopVisitTracking } = vi.hoisted(
  () => ({
    patchVisitLifecycle: vi.fn(),
    beginVisitTracking: vi.fn(),
    endVisitTracking: vi.fn(),
    stopVisitTracking: vi.fn(),
  }),
);
vi.mock('../api/sessionsWrite', () => ({ patchVisitLifecycle }));
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

/** The row the screen holds. The hook takes this, not a bare id. */
const SESSION = { _id: 's1', status: 'ARRIVED', kinfolkId: 'fam1' };
function accepted(status: string, from = 'ON_MY_WAY', notified = true) {
  return {
    sessionId: 's1',
    action: status,
    from,
    status,
    changed: from !== status,
    notification: Promise.resolve({
      notified,
      notifySkipped: notified ? null : 'dispatch_failed',
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useVisitLifecycle hands the clock to the browser tracker', () => {
  it('ARRIVED: starts tracking inside the confirm, before the write resolves', async () => {
    let resolve: (v: unknown) => void = () => {};
    patchVisitLifecycle.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));

    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());

    expect(beginVisitTracking).toHaveBeenCalledTimes(1);
    expect(beginVisitTracking.mock.calls[0]?.[0]).toBe('s1');
    expect(beginVisitTracking.mock.calls[0]?.[1]).toBeInstanceOf(Promise);
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);

    resolve(accepted('ARRIVED'));
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(true);
  });

  it('ARRIVED already on file (changed: false) still counts as arrived for the tracker', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(true);
  });

  it('a refused arrive tells the tracker false, and the row shows the refusal', async () => {
    patchVisitLifecycle.mockRejectedValue(new Error('Wrong status for ARRIVED.'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(false);
    await waitFor(() =>
      expect(result.current.write).toEqual({ status: 'error', message: 'Wrong status for ARRIVED.' }),
    );
  });

  it('DEPARTED: ends tracking inside the confirm with the write outcome', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('DEPARTED', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('DEPARTED')));
    act(() => result.current.confirm());
    expect(endVisitTracking).toHaveBeenCalledTimes(1);
    expect(endVisitTracking.mock.calls[0]?.[0]).toBe('s1');
    await expect(endVisitTracking.mock.calls[0]?.[1]).resolves.toBe(true);
    expect(beginVisitTracking).not.toHaveBeenCalled();
  });

  it('UNDO_ARRIVAL: stops tracking once the undo has landed, with no fix', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ON_MY_WAY', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(stopVisitTracking).toHaveBeenCalledWith('s1'));
    expect(endVisitTracking).not.toHaveBeenCalled();
  });

  it('a refused undo leaves the watch alone', async () => {
    patchVisitLifecycle.mockRejectedValue(new Error('Wrong status.'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(stopVisitTracking).not.toHaveBeenCalled();
  });

  it('ON_MY_WAY touches no tracker', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ON_MY_WAY', 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ON_MY_WAY')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(beginVisitTracking).not.toHaveBeenCalled();
    expect(endVisitTracking).not.toHaveBeenCalled();
    expect(stopVisitTracking).not.toHaveBeenCalled();
  });

  it('no session id: neither the write nor the tracker is touched', () => {
    const { result } = renderHook(() => useVisitLifecycle(null, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    expect(patchVisitLifecycle).not.toHaveBeenCalled();
    expect(beginVisitTracking).not.toHaveBeenCalled();
  });
});

describe('the sentence never claims a notification it has not seen', () => {
  it('says the status change first, and only says "notified" once the push lands', async () => {
    let settle: (v: unknown) => void = () => {};
    patchVisitLifecycle.mockResolvedValue({
      sessionId: 's1',
      action: 'ARRIVED',
      from: 'ON_MY_WAY',
      status: 'ARRIVED',
      changed: true,
      notification: new Promise((r) => (settle = r)),
    });
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());

    // The write has acked; the push has NOT. The household must not be in the
    // sentence yet, in either direction.
    await waitFor(() =>
      expect(result.current.write).toEqual({ status: 'done', message: 'ON_MY_WAY → ARRIVED.' }),
    );

    await act(async () => {
      settle({ notified: true, notifySkipped: null });
    });
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message: 'ON_MY_WAY → ARRIVED. the Wrens was notified.',
      }),
    );
  });

  // A failed dispatch is NOT a failed tap. The visit is clocked either way; the
  // operator is simply told the household did not hear about it.
  it('a dispatch that failed still leaves the tap done, and says so', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'ON_MY_WAY', false));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message: 'ON_MY_WAY → ARRIVED. The household was not notified.',
      }),
    );
  });

  // The no-op branch: nothing was written, so nothing is claimed about the
  // household and the time already on file is named as untouched.
  it('a double tap reports the no-op without a notification clause', async () => {
    patchVisitLifecycle.mockResolvedValue({
      sessionId: 's1',
      action: 'ARRIVED',
      from: 'ARRIVED',
      status: 'ARRIVED',
      changed: false,
      notification: Promise.resolve({
        notified: false,
        notifySkipped: 'already_in_this_state',
      }),
    });
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message:
          'Already ARRIVED. Nothing was changed, and the time already on file is unchanged.',
      }),
    );
  });

  it('hands the whole row to the write, not just an id', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'ON_MY_WAY'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(patchVisitLifecycle).toHaveBeenCalledTimes(1));
    expect(patchVisitLifecycle.mock.calls[0]?.[0]).toBe(SESSION);
    expect(patchVisitLifecycle.mock.calls[0]?.[1]).toBe('ARRIVED');
    // The stamped instant is the caller's, in `lifecycleNowIso`'s whole-second
    // `Z` format, not a millisecond one the two apps would disagree about.
    const options = patchVisitLifecycle.mock.calls[0]?.[2] as { nowIso: string };
    expect(options.nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
