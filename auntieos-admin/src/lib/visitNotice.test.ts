// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  actionNotifiesHousehold,
  visitNoticeConfirmFor,
  visitNoticeConfirmLine,
  visitNoticeOutcomeSentence,
  visitNoticePreview,
  visitRoutingSkip,
  type VisitNoticeReach,
} from './visitNotice';
import {
  beginVisitClockWrite,
  clearVisitClockWrite,
  settleVisitClockWrite,
  visitClockState,
} from './visitClockOutcome';
import { useVisitNoticeReach } from './useVisitNoticeReach';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./fns', () => ({ call }));

/**
 * #1794: the words the operator reads about the household, before and after a
 * visit-clock tap. Android's `domain/VisitNoticeWords.kt` carries the same
 * sentences; `VisitNoticeWordsTest.kt` pins them there.
 */

const ROUTED = { kinfolkId: 'kf1', kinCareBatchId: 'b1', kinCareVisitId: 'v1' };

describe('visitNoticeOutcomeSentence', () => {
  it.each([
    [{ notified: true, notifySkipped: null }, 'Dre East was notified.'],
    [
      { notified: false, notifySkipped: 'household_has_no_portal_account' },
      'Dre East was not notified, because they have no portal account.',
    ],
    [
      { notified: false, notifySkipped: 'household_notices_off' },
      'Dre East was not notified, because notices to households are off in Settings.',
    ],
    [
      { notified: false, notifySkipped: 'household_prefs_suppressed' },
      'Dre East was not notified, because this notice is turned off for them.',
    ],
    [
      { notified: false, notifySkipped: 'already_notified' },
      'Dre East was already told about this step, so it was not sent again.',
    ],
    [
      { notified: false, notifySkipped: 'session_has_no_routing_ids' },
      'Dre East was not notified, because this visit is not linked to a booking.',
    ],
    [
      { notified: false, notifySkipped: 'session_has_no_kinfolk' },
      'No household was notified, because this visit is not linked to one.',
    ],
    [{ notified: false, notifySkipped: 'dispatch_failed' }, 'The notice to Dre East could not be sent.'],
    // #2037: the server sends from the saved step; the card only stopped waiting.
    [
      { notified: false, notifySkipped: 'notice_pending' },
      'Still checking whether Dre East was told. The Activity Log will show it.',
    ],
    [{ notified: false, notifySkipped: 'not_sent' }, 'Dre East was not notified.'],
    [{ notified: false, notifySkipped: 'something_newer' }, 'Dre East was not notified.'],
  ])('%j reads %s', (outcome, sentence) => {
    expect(visitNoticeOutcomeSentence(outcome, 'Dre East')).toBe(sentence);
  });

  it('says nothing about the household for an undo or a double tap', () => {
    expect(visitNoticeOutcomeSentence({ notified: false, notifySkipped: 'no_event_for_action' }, 'Dre East')).toBe('');
    expect(visitNoticeOutcomeSentence({ notified: false, notifySkipped: 'already_in_this_state' }, 'Dre East')).toBe(
      '',
    );
  });

  it('opens a sentence with a capital even when the name starts lower case', () => {
    expect(visitNoticeOutcomeSentence({ notified: true, notifySkipped: null }, 'the Wrens')).toBe(
      'The Wrens was notified.',
    );
  });

  it('never uses an em dash', () => {
    for (const reason of ['household_has_no_portal_account', 'household_notices_off', 'dispatch_failed']) {
      expect(visitNoticeOutcomeSentence({ notified: false, notifySkipped: reason }, 'X')).not.toContain('—');
    }
  });
});

describe('visitNoticePreview', () => {
  const told: VisitNoticeReach = { status: 'ready', willNotify: true, reason: null };
  const not = (reason: string | null): VisitNoticeReach => ({ status: 'ready', willNotify: false, reason });
  const base = { action: 'ON_MY_WAY' as const, session: ROUTED, reach: told };

  it('will notify when the server says a notice can go out', () => {
    expect(visitNoticePreview(base)).toEqual({ kind: 'will_notify' });
  });

  it('names no portal account when the server does', () => {
    expect(visitNoticePreview({ ...base, reach: not('household_has_no_portal_account') })).toEqual({
      kind: 'will_not_notify',
      reason: 'household_has_no_portal_account',
    });
  });

  it('names the switch when the server does', () => {
    expect(visitNoticePreview({ ...base, reach: not('household_notices_off') })).toEqual({
      kind: 'will_not_notify',
      reason: 'household_notices_off',
    });
  });

  it('is checking while the server is being asked', () => {
    expect(visitNoticePreview({ ...base, reach: { status: 'checking' } })).toEqual({ kind: 'checking' });
  });

  it('is unknown, and promises nothing, when the server gave no usable answer', () => {
    expect(visitNoticePreview({ ...base, reach: { status: 'unknown' } })).toEqual({ kind: 'unknown' });
    expect(visitNoticePreview({ ...base, reach: not('a_reason_from_a_newer_server') })).toEqual({ kind: 'unknown' });
    expect(visitNoticePreview({ ...base, reach: not(null) })).toEqual({ kind: 'unknown' });
  });

  it('knows from the row alone when there is nothing to route to, whatever the server would say', () => {
    expect(visitNoticePreview({ ...base, session: { kinfolkId: '' } })).toEqual({
      kind: 'will_not_notify',
      reason: 'session_has_no_kinfolk',
    });
    expect(visitNoticePreview({ ...base, session: { kinfolkId: 'kf1' }, reach: { status: 'checking' } })).toEqual({
      kind: 'will_not_notify',
      reason: 'session_has_no_routing_ids',
    });
    expect(
      visitNoticePreview({ ...base, session: { kinfolkId: 'kf1', sourceBookingId: 'legacy7' } }),
    ).toEqual({ kind: 'will_notify' });
  });

  it('is none for an undo, which never notifies', () => {
    expect(visitNoticePreview({ ...base, action: 'UNDO_ARRIVAL' })).toEqual({ kind: 'none' });
  });

  it('visitRoutingSkip and actionNotifiesHousehold say whether there is anything to ask', () => {
    expect(visitRoutingSkip(ROUTED)).toBeNull();
    expect(visitRoutingSkip({ kinfolkId: '  ' })).toBe('session_has_no_kinfolk');
    expect(visitRoutingSkip({ kinfolkId: 'kf1' })).toBe('session_has_no_routing_ids');
    expect(actionNotifiesHousehold('ARRIVED')).toBe(true);
    expect(actionNotifiesHousehold('UNDO_ARRIVAL')).toBe(false);
  });
});

describe('visitNoticeConfirmLine', () => {
  it.each([
    ['ON_MY_WAY', 'Dre East will be told their Auntie is on the way.'],
    ['ARRIVED', 'Dre East will be told their Auntie has arrived.'],
    ['DEPARTED', 'Dre East will be told the visit has finished.'],
  ] as const)('promises %s in its own words', (action, line) => {
    expect(visitNoticeConfirmLine({ kind: 'will_notify' }, action, 'Dre East')).toBe(line);
  });

  it('says why not, in plain words', () => {
    expect(
      visitNoticeConfirmLine(
        { kind: 'will_not_notify', reason: 'household_notices_off' },
        'ARRIVED',
        'Dre East',
      ),
    ).toBe('Dre East will not be told, because notices to households are off in Settings.');
    expect(
      visitNoticeConfirmLine(
        { kind: 'will_not_notify', reason: 'household_has_no_portal_account' },
        'DEPARTED',
        'Dre East',
      ),
    ).toBe('Dre East will not be told, because they have no portal account.');
  });

  it('is null when there is nothing honest to say', () => {
    expect(visitNoticeConfirmLine({ kind: 'unknown' }, 'ARRIVED', 'Dre East')).toBeNull();
    expect(visitNoticeConfirmLine({ kind: 'none' }, 'UNDO_ARRIVAL', 'Dre East')).toBeNull();
  });

  it('says it is checking while the answer is on its way, and promises nothing', () => {
    const line = visitNoticeConfirmLine({ kind: 'checking' }, 'ARRIVED', 'Dre East');
    expect(line).toBe('Checking whether Dre East will be told.');
    expect(visitNoticeConfirmLine({ kind: 'checking' }, 'ARRIVED', '')).toBe('Checking who will be told.');
  });

  it('visitNoticeConfirmFor runs both steps', () => {
    expect(
      visitNoticeConfirmFor({
        action: 'ARRIVED',
        session: ROUTED,
        reach: { status: 'ready', willNotify: false, reason: 'household_notices_off' },
        household: 'Dre East',
      }),
    ).toBe('Dre East will not be told, because notices to households are off in Settings.');
  });
});

describe('visitClockOutcome: the store the card reads after it remounts', () => {
  it('keeps the latest write and drops a stale settle', () => {
    const first = beginVisitClockWrite('s9');
    const second = beginVisitClockWrite('s9');
    settleVisitClockWrite('s9', first, { status: 'done', message: 'old' });
    expect(visitClockState('s9')).toEqual({ status: 'saving' });
    settleVisitClockWrite('s9', second, { status: 'done', message: 'new' });
    expect(visitClockState('s9')).toEqual({ status: 'done', message: 'new' });
  });

  it('a clear invalidates a write still settling', () => {
    const seq = beginVisitClockWrite('s8');
    clearVisitClockWrite('s8');
    settleVisitClockWrite('s8', seq, { status: 'done', message: 'late' });
    expect(visitClockState('s8')).toEqual({ status: 'idle' });
  });

  it('keeps visits apart', () => {
    const seq = beginVisitClockWrite('a');
    settleVisitClockWrite('a', seq, { status: 'done', message: 'a done' });
    expect(visitClockState('b')).toEqual({ status: 'idle' });
    expect(visitClockState(null)).toEqual({ status: 'idle' });
  });
});

describe('useVisitNoticeReach: the confirm asks the server (#1840)', () => {
  beforeEach(() => {
    call.mockReset();
  });

  it('asks nothing while there is no household to ask about', () => {
    const { result } = renderHook(() => useVisitNoticeReach(null));
    expect(result.current).toEqual({ status: 'checking' });
    expect(call).not.toHaveBeenCalled();
  });

  it('is checking until the answer lands, then carries it', async () => {
    call.mockResolvedValue({ ok: true, willNotify: true, reason: null });
    const { result } = renderHook(() => useVisitNoticeReach('kf1'));
    expect(result.current).toEqual({ status: 'checking' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', willNotify: true, reason: null }));
    expect(call).toHaveBeenCalledWith('previewVisitNotification', { familyId: 'kf1' });
  });

  it('carries the reason for a household with no portal sign-in', async () => {
    call.mockResolvedValue({ ok: true, willNotify: false, reason: 'household_has_no_portal_account' });
    const { result } = renderHook(() => useVisitNoticeReach('kf1'));
    await waitFor(() =>
      expect(result.current).toEqual({
        status: 'ready',
        willNotify: false,
        reason: 'household_has_no_portal_account',
      }),
    );
  });

  it('is unknown when the call fails, never a guess', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    call.mockRejectedValue(new Error('functions/not-found'));
    const { result } = renderHook(() => useVisitNoticeReach('kf1'));
    await waitFor(() => expect(result.current).toEqual({ status: 'unknown' }));
    warn.mockRestore();
  });

  it('is unknown when the answer has no willNotify (a server from before the preview)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    call.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useVisitNoticeReach('kf1'));
    await waitFor(() => expect(result.current).toEqual({ status: 'unknown' }));
    warn.mockRestore();
  });

  it('asks again each time a confirm opens, and never shows the last answer meanwhile', async () => {
    call.mockResolvedValueOnce({ ok: true, willNotify: false, reason: 'household_has_no_portal_account' });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useVisitNoticeReach(id), {
      initialProps: { id: 'kf1' as string | null },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ id: null });
    let release: (v: unknown) => void = () => {};
    call.mockReturnValueOnce(new Promise((r) => (release = r)));
    rerender({ id: 'kf1' });
    expect(result.current).toEqual({ status: 'checking' });

    await act(async () => {
      release({ ok: true, willNotify: true, reason: null });
    });
    expect(result.current).toEqual({ status: 'ready', willNotify: true, reason: null });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('drops an answer that lands after the confirm moved to another household', async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    call.mockReturnValueOnce(new Promise((r) => (releaseFirst = r)));
    call.mockResolvedValueOnce({ ok: true, willNotify: false, reason: 'household_notices_off' });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useVisitNoticeReach(id), {
      initialProps: { id: 'kf1' as string | null },
    });
    rerender({ id: 'kf2' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      releaseFirst({ ok: true, willNotify: true, reason: null });
    });
    expect(result.current).toEqual({ status: 'ready', willNotify: false, reason: 'household_notices_off' });
  });
});

// #2185: an Auntie never sees Settings (ruling 2026-11-13), so her lines name
// the owner. The owner's lines stay word for word.
describe('#2185 the switch-off lines under an Auntie sign-in', () => {
  it('the outcome names the owner, not Settings', () => {
    const line = visitNoticeOutcomeSentence(
      { notified: false, notifySkipped: 'household_notices_off' },
      'Dre East',
      true,
    );
    expect(line).toBe('Dre East was not notified, because the owner has notices to households turned off.');
    expect(line).not.toMatch(/Settings/);
  });

  it('#2037: still checking, without the Activity Log she does not have', () => {
    expect(visitNoticeOutcomeSentence({ notified: false, notifySkipped: 'notice_pending' }, 'Dre East', true)).toBe(
      'Still checking whether Dre East was told.',
    );
  });

  it('the confirm names the owner, not Settings', () => {
    const line = visitNoticeConfirmFor({
      action: 'ARRIVED',
      session: ROUTED,
      reach: { status: 'ready', willNotify: false, reason: 'household_notices_off' },
      household: 'Dre East',
      auntie: true,
    });
    expect(line).toBe('Dre East will not be told, because the owner has notices to households turned off.');
    expect(line).not.toMatch(/Settings/);
  });

  it('the owner keeps the Settings wording, and that is the default', () => {
    expect(
      visitNoticeOutcomeSentence({ notified: false, notifySkipped: 'household_notices_off' }, 'Dre East', false),
    ).toBe('Dre East was not notified, because notices to households are off in Settings.');
    expect(
      visitNoticeConfirmLine({ kind: 'will_not_notify', reason: 'household_notices_off' }, 'ARRIVED', 'Dre East', false),
    ).toBe('Dre East will not be told, because notices to households are off in Settings.');
  });

  it('changes no other line for an Auntie', () => {
    expect(
      visitNoticeOutcomeSentence(
        { notified: false, notifySkipped: 'household_has_no_portal_account' },
        'Dre East',
        true,
      ),
    ).toBe('Dre East was not notified, because they have no portal account.');
    expect(visitNoticeConfirmLine({ kind: 'will_notify' }, 'ARRIVED', 'Dre East', true)).toBe(
      'Dre East will be told their Auntie has arrived.',
    );
  });
});
