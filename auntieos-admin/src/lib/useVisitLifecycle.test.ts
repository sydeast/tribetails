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

const {
  patchVisitLifecycle,
  startVisitWithRangeCheck,
  undoArrivalThroughServer,
  verifyVisitArrival,
  beginVisitTracking,
  endVisitTracking,
  stopVisitTracking,
  useArrivalRule,
  requestStartFix,
} = vi.hoisted(() => ({
  patchVisitLifecycle: vi.fn(),
  startVisitWithRangeCheck: vi.fn(),
  undoArrivalThroughServer: vi.fn(),
  verifyVisitArrival: vi.fn(),
  beginVisitTracking: vi.fn(),
  endVisitTracking: vi.fn(),
  stopVisitTracking: vi.fn(),
  useArrivalRule: vi.fn(),
  requestStartFix: vi.fn(),
}));
vi.mock('../api/sessionsWrite', () => ({
  patchVisitLifecycle,
  startVisitWithRangeCheck,
  undoArrivalThroughServer,
  verifyVisitArrival,
}));
vi.mock('./visitTracking', () => ({ beginVisitTracking, endVisitTracking, stopVisitTracking }));
// #2279: the arrival rule and the position are the two inputs the start gate
// adds. Everything else in `visitStartRange` is the real thing.
vi.mock('./useArrivalRule', () => ({ useArrivalRule }));
vi.mock('./visitStartRange', async (orig) => ({
  ...(await orig<typeof import('./visitStartRange')>()),
  requestStartFix,
}));

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
  // The rule is off unless a test turns it on, which is every test that
  // predates #2279.
  useArrivalRule.mockReturnValue(false);
  requestStartFix.mockResolvedValue(null);
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
      expect(result.current.write).toEqual({ status: 'done', message: 'Marked arrived. Checking whether the Wrens was told.' }),
    );

    await act(async () => {
      settle({ notified: true, notifySkipped: null });
    });
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message: 'Marked arrived. The Wrens was notified.',
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
        message: 'Marked arrived. The notice to the Wrens could not be sent.',
      }),
    );
  });

  // #1794: a card that remounts while the WRITE is still away (another card's
  // reload, the Archive toggle) must keep its "Sync now" offer, not come back
  // as a dead saving row with every clock control disabled.
  it('a card that remounts mid-write still offers to re-send the same action', async () => {
    patchVisitLifecycle.mockReturnValue(new Promise(() => {}));
    const first = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    act(() => first.result.current.ask(actionNamed('ARRIVED')));
    act(() => first.result.current.confirm());
    expect(first.result.current.saving).toBe(true);
    first.unmount();

    const second = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    expect(second.result.current.saving).toBe(true);
    expect(second.result.current.retry).not.toBeNull();
    act(() => second.result.current.retry!());
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(2);
    expect(patchVisitLifecycle.mock.calls[1]![1]).toBe('ARRIVED');
  });

  // #1794: the board unmounts the card between the write and the push (the
  // reload, then the move to Active). Unmount FIRST, settle AFTER: the reverse
  // order passes without the store and proves nothing.
  it('a card that remounts before the push settles still shows why nobody was told', async () => {
    let settle: (v: unknown) => void = () => {};
    patchVisitLifecycle.mockResolvedValue({
      sessionId: 's1',
      action: 'ARRIVED',
      from: 'ON_MY_WAY',
      status: 'ARRIVED',
      changed: true,
      notification: new Promise((r) => (settle = r)),
    });
    const first = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    act(() => first.result.current.ask(actionNamed('ARRIVED')));
    act(() => first.result.current.confirm());
    await waitFor(() =>
      expect(first.result.current.write).toEqual({ status: 'done', message: 'Marked arrived. Checking whether Dre East was told.' }),
    );
    first.unmount();

    const second = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    expect(second.result.current.write).toEqual({ status: 'done', message: 'Marked arrived. Checking whether Dre East was told.' });
    await act(async () => {
      settle({ notified: false, notifySkipped: 'household_notices_off' });
    });
    await waitFor(() =>
      expect(second.result.current.write).toEqual({
        status: 'done',
        message:
          'Marked arrived. Dre East was not notified, because notices to households are off in Settings.',
      }),
    );
  });

  // #2038: the undo is quiet, and the card says what that means for the
  // household. #2357: it says the arrival notice is off their list only once
  // the server has recorded that it took one off.
  function undoResult(undone: Promise<{ arrived: boolean; departed: boolean } | null> | undefined, from = 'ARRIVED') {
    return {
      sessionId: 's1',
      action: 'UNDO_ARRIVAL',
      from,
      status: 'ON_MY_WAY',
      changed: true,
      notification: Promise.resolve({ notified: false, notifySkipped: 'no_event_for_action' }),
      ...(undone === undefined ? {} : { undone }),
    };
  }
  async function undoOn(hook: { current: ReturnType<typeof useVisitLifecycle> }) {
    act(() => hook.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => hook.current.confirm());
  }
  it('an undo says it is checking their list, then that the arrival notice is off it', async () => {
    let settle: (off: { arrived: boolean; departed: boolean } | null) => void = () => {};
    patchVisitLifecycle.mockResolvedValue(undoResult(new Promise((resolve) => (settle = resolve))));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    await undoOn(result);
    // The wait is said, and nothing is claimed about their list yet.
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message: "Back to on the way. No message was sent about the undo. Checking the household's notifications list.",
      }),
    );
    await act(async () => {
      settle({ arrived: true, departed: false });
    });
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message:
          "Back to on the way. No message was sent about the undo. The arrival notice is off the household's notifications list.",
      }),
    );
    expect((result.current.write as { message?: string }).message).not.toMatch(/was notified|Checking/);
  });

  it('an undo for a household that was never told says so, and does not say a notice came off', async () => {
    patchVisitLifecycle.mockResolvedValue(undoResult(Promise.resolve({ arrived: false, departed: false })));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    await undoOn(result);
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message:
          'Back to on the way. No message was sent about the undo. The household was not told about the arrival, so nothing was on their notifications list.',
      }),
    );
  });

  it('an undo from Departed names both notices when both came off', async () => {
    patchVisitLifecycle.mockResolvedValue(undoResult(Promise.resolve({ arrived: true, departed: true }), 'DEPARTED'));
    const { result } = renderHook(() => useVisitLifecycle({ ...SESSION, status: 'DEPARTED' }, 'Dre East'));
    await undoOn(result);
    await waitFor(() =>
      expect((result.current.write as { message?: string }).message).toBe(
        "Back to on the way. No message was sent about the undo. The arrival and departure notices are off the household's notifications list.",
      ),
    );
  });

  it("an undo whose record never came claims nothing about the household's list", async () => {
    patchVisitLifecycle.mockResolvedValue(undoResult(Promise.resolve(null)));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'Dre East'));
    await undoOn(result);
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message: 'Back to on the way. No message was sent about the undo.',
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
          'Already arrived. Nothing was changed, and the time already on file is unchanged.',
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

/**
 * #2279, operator ruling 2026-11-14: "cant start visit until within range of
 * the property ... only admin auntie can complete visits outside of ranges".
 *
 * With "Verify arrival and departure" on, an Auntie's On my way and Arrived go
 * to the server with her position, and the server's refusal is what she reads.
 * The owner keeps the direct write, and an arrival outside the range is said
 * to be recorded.
 */
describe('an Auntie starting a visit while arrival verification is on', () => {
  const SCHEDULED = { _id: 's1', status: 'SCHEDULED', kinfolkId: 'fam1' };
  const FAR = { lat: 34.09, lng: -118.3, accuracyMeters: 10 };
  const REFUSAL =
    'You are 2.3 km from this household. You need to be at the property to start this visit. ' +
    'The owner can start it if you cannot get there.';

  beforeEach(() => {
    useArrivalRule.mockReturnValue(true);
    requestStartFix.mockResolvedValue(FAR);
  });

  it.each(['ON_MY_WAY', 'ARRIVED'] as const)(
    '%s goes to the server with her position, never straight to Firestore',
    async (action) => {
      startVisitWithRangeCheck.mockResolvedValue(accepted(action, 'SCHEDULED'));
      const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
      act(() => result.current.ask(actionNamed(action)));
      act(() => result.current.confirm());
      // Asked inside the confirm click, before anything resolves.
      expect(requestStartFix).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(result.current.write.status).toBe('done'));
      expect(startVisitWithRangeCheck).toHaveBeenCalledWith(SCHEDULED, action, expect.objectContaining({ fix: FAR }));
      expect(patchVisitLifecycle).not.toHaveBeenCalled();
    },
  );

  it.each(['ON_MY_WAY', 'ARRIVED'] as const)(
    '%s refused outside the range shows the server sentence as it is',
    async (action) => {
      startVisitWithRangeCheck.mockRejectedValue(
        Object.assign(new Error(REFUSAL), { details: { code: 'visit_start_outside_range' } }),
      );
      const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
      act(() => result.current.ask(actionNamed(action)));
      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.write).toEqual({ status: 'error', message: REFUSAL }));
      expect(patchVisitLifecycle).not.toHaveBeenCalled();
    },
  );

  it('a refused arrival starts no tracking', async () => {
    startVisitWithRangeCheck.mockRejectedValue(new Error(REFUSAL));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await expect(beginVisitTracking.mock.calls[0]?.[1]).resolves.toBe(false);
  });

  it('a tap with no position still goes to the server, which answers in its own words', async () => {
    requestStartFix.mockResolvedValue(null);
    startVisitWithRangeCheck.mockRejectedValue(new Error('We could not get your location.'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(startVisitWithRangeCheck).toHaveBeenCalledWith(SCHEDULED, 'ARRIVED', expect.objectContaining({ fix: null }));
    expect(result.current.write).toEqual({ status: 'error', message: 'We could not get your location.' });
  });

  it('inside the range it works, and says what the household was told', async () => {
    startVisitWithRangeCheck.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message: 'Marked arrived. The Wrens was notified.',
      }),
    );
    // The server measured it on the way in; no second measurement is sent.
    expect(verifyVisitArrival).not.toHaveBeenCalled();
  });

  it('the rule still loading (unknown) is treated as on: the server decides', async () => {
    useArrivalRule.mockReturnValue(null);
    startVisitWithRangeCheck.mockResolvedValue(accepted('ON_MY_WAY', 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('ON_MY_WAY')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(startVisitWithRangeCheck).toHaveBeenCalledTimes(1);
    expect(patchVisitLifecycle).not.toHaveBeenCalled();
  });

  // #2038: her Undo arrival goes to the server under the same switch, which
  // is also where the arrival's notice comes off the household's list.
  it('Undo arrival goes to the server, never straight to Firestore, and asks for no position', async () => {
    undoArrivalThroughServer.mockResolvedValue({
      sessionId: 's1',
      action: 'UNDO_ARRIVAL',
      from: 'ARRIVED',
      status: 'SCHEDULED',
      changed: true,
      notification: Promise.resolve({ notified: false, notifySkipped: 'no_event_for_action' }),
      undone: Promise.resolve({ arrived: true, departed: false }),
    });
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(undoArrivalThroughServer).toHaveBeenCalledTimes(1);
    expect(undoArrivalThroughServer).toHaveBeenCalledWith(SESSION);
    expect(patchVisitLifecycle).not.toHaveBeenCalled();
    expect(requestStartFix).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((result.current.write as { message?: string }).message).toBe(
        "Back to scheduled. No message was sent about the undo. The arrival notice is off the household's notifications list.",
      ),
    );
    await waitFor(() => expect(stopVisitTracking).toHaveBeenCalledWith('s1'));
  });

  it('an undo the server refuses shows the server sentence and leaves the watch alone', async () => {
    undoArrivalThroughServer.mockRejectedValue(new Error('This visit could not be found.'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(result.current.write).toEqual({ status: 'error', message: 'This visit could not be found.' });
    expect(stopVisitTracking).not.toHaveBeenCalled();
  });

  it('the rule still loading (unknown) sends her undo to the server too', async () => {
    useArrivalRule.mockReturnValue(null);
    undoArrivalThroughServer.mockResolvedValue(accepted('SCHEDULED', 'ARRIVED', false));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(undoArrivalThroughServer).toHaveBeenCalledTimes(1));
    expect(patchVisitLifecycle).not.toHaveBeenCalled();
  });

  it('the owner keeps the direct undo with the rule on', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('SCHEDULED', 'ARRIVED', false));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, false));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    expect(undoArrivalThroughServer).not.toHaveBeenCalled();
  });

  it('Departed stays a direct write with no position asked for', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('DEPARTED', 'ARRIVED'));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('DEPARTED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    expect(startVisitWithRangeCheck).not.toHaveBeenCalled();
    expect(requestStartFix).not.toHaveBeenCalled();
  });
});

describe('an Auntie starting a visit while arrival verification is off', () => {
  const SCHEDULED = { _id: 's1', status: 'SCHEDULED', kinfolkId: 'fam1' };

  it.each(['ON_MY_WAY', 'ARRIVED'] as const)('%s is the direct write it always was', async (action) => {
    patchVisitLifecycle.mockResolvedValue(accepted(action, 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed(action)));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    expect(startVisitWithRangeCheck).not.toHaveBeenCalled();
    expect(requestStartFix).not.toHaveBeenCalled();
  });

  it('a start the rules refuse reads as plain words, and her next tap goes to the server', async () => {
    // The owner switched the rule on after this screen last read it.
    patchVisitLifecycle.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(result.current.write).toEqual({
      status: 'error',
      message:
        'You need to be at the property to start this visit. Tap again and allow location when asked. ' +
        'The owner can also start it.',
    });

    startVisitWithRangeCheck.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(startVisitWithRangeCheck).toHaveBeenCalledTimes(1));
  });

  it('Undo arrival is the direct write it always was', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('SCHEDULED', 'ARRIVED', false));
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    expect(undoArrivalThroughServer).not.toHaveBeenCalled();
  });

  // #2038: the owner switched the rule on after this screen last read it. An
  // undo needs no position, so the same tap is finished by the server.
  it('an undo the rules refuse is carried out by the server in the same tap', async () => {
    patchVisitLifecycle.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    undoArrivalThroughServer.mockResolvedValue({
      sessionId: 's1',
      action: 'UNDO_ARRIVAL',
      from: 'ARRIVED',
      status: 'SCHEDULED',
      changed: true,
      notification: Promise.resolve({ notified: false, notifySkipped: 'no_event_for_action' }),
    });
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    expect(undoArrivalThroughServer).toHaveBeenCalledTimes(1);
    expect((result.current.write as { message?: string }).message).toMatch(/^Back to scheduled\. No message was sent about the undo\./);
  });

  it('the owner whose undo the rules refuse is shown the refusal, with no second try', async () => {
    patchVisitLifecycle.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, false));
    act(() => result.current.ask(actionNamed('UNDO_ARRIVAL')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(undoArrivalThroughServer).not.toHaveBeenCalled();
  });

  it('a rules refusal on Departed is not dressed up as a range refusal', async () => {
    patchVisitLifecycle.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }),
    );
    const { result } = renderHook(() => useVisitLifecycle(SESSION, 'the Wrens', undefined, true));
    act(() => result.current.ask(actionNamed('DEPARTED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('error'));
    expect(result.current.write).toEqual({ status: 'error', message: 'Missing or insufficient permissions.' });
  });
});

describe('the owner starting a visit while arrival verification is on', () => {
  const SCHEDULED = { _id: 's1', status: 'SCHEDULED', kinfolkId: 'fam1' };
  const FAR = { lat: 34.09, lng: -118.3, accuracyMeters: 10 };

  beforeEach(() => {
    useArrivalRule.mockReturnValue(true);
    requestStartFix.mockResolvedValue(FAR);
  });

  it.each(['ON_MY_WAY', 'ARRIVED'] as const)('%s is a direct write from anywhere', async (action) => {
    patchVisitLifecycle.mockResolvedValue(accepted(action, 'SCHEDULED'));
    verifyVisitArrival.mockResolvedValue({ status: 'within', distanceMeters: 20, radiusMeters: 150, verificationRequired: true });
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens'));
    act(() => result.current.ask(actionNamed(action)));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    expect(startVisitWithRangeCheck).not.toHaveBeenCalled();
  });

  it('an arrival outside the range is measured after it lands, and the card says it was recorded', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    verifyVisitArrival.mockResolvedValue({
      status: 'outside',
      distanceMeters: 2300,
      radiusMeters: 150,
      verificationRequired: true,
    });
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() =>
      expect(result.current.write).toEqual({
        status: 'done',
        message:
          'Marked arrived. The Wrens was notified. You arrived 2.3 km from this household, ' +
          'outside the range. That is recorded on the visit and in the Activity Log.',
      }),
    );
    expect(verifyVisitArrival).toHaveBeenCalledWith('s1', FAR);
  });

  it('an arrival inside the range adds nothing to the sentence', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    verifyVisitArrival.mockResolvedValue({ status: 'within', distanceMeters: 20, radiusMeters: 150, verificationRequired: true });
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(verifyVisitArrival).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.write).toEqual({ status: 'done', message: 'Marked arrived. The Wrens was notified.' }),
    );
  });

  it('a measurement that fails leaves the arrival standing and says nothing', async () => {
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    verifyVisitArrival.mockRejectedValue(new Error('The server could not be reached.'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(verifyVisitArrival).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.write).toEqual({ status: 'done', message: 'Marked arrived. The Wrens was notified.' }),
    );
  });

  it('with no position there is nothing to measure, and the arrival still lands', async () => {
    requestStartFix.mockResolvedValue(null);
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(verifyVisitArrival).not.toHaveBeenCalled();
  });

  it('with the rule off the owner is asked for no position and nothing is measured', async () => {
    useArrivalRule.mockReturnValue(false);
    patchVisitLifecycle.mockResolvedValue(accepted('ARRIVED', 'SCHEDULED'));
    const { result } = renderHook(() => useVisitLifecycle(SCHEDULED, 'the Wrens'));
    act(() => result.current.ask(actionNamed('ARRIVED')));
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.write.status).toBe('done'));
    expect(requestStartFix).not.toHaveBeenCalled();
    expect(verifyVisitArrival).not.toHaveBeenCalled();
  });
});
