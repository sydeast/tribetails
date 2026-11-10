// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  hasPortalAccount,
  visitNoticeConfirmFor,
  visitNoticeConfirmLine,
  visitNoticeOutcomeSentence,
  visitNoticePreview,
} from './visitNotice';
import {
  beginVisitClockWrite,
  clearVisitClockWrite,
  settleVisitClockWrite,
  visitClockState,
} from './visitClockOutcome';
import { BOOKING_CATALOG_KEY } from './useBookingCatalog';
import { BUSINESS_SETTINGS_SHARED_KEY, useHouseholdNoticesLive } from './useHouseholdNoticesLive';
import { invalidateSharedLoad } from './useSharedOneShot';

const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

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
  const base = { action: 'ON_MY_WAY' as const, session: ROUTED, hasPortalAccount: true, noticesLive: true };

  it('will notify only with an account and the switch on', () => {
    expect(visitNoticePreview(base)).toEqual({ kind: 'will_notify' });
  });

  it('names no portal account before the switch (one order, shared with the server)', () => {
    expect(visitNoticePreview({ ...base, hasPortalAccount: false, noticesLive: false })).toEqual({
      kind: 'will_not_notify',
      reason: 'household_has_no_portal_account',
    });
  });

  it('names the switch when the household has an account', () => {
    expect(visitNoticePreview({ ...base, noticesLive: false })).toEqual({
      kind: 'will_not_notify',
      reason: 'household_notices_off',
    });
  });

  it('is unknown while either input is loading', () => {
    expect(visitNoticePreview({ ...base, hasPortalAccount: null })).toEqual({ kind: 'unknown' });
    expect(visitNoticePreview({ ...base, noticesLive: null })).toEqual({ kind: 'unknown' });
  });

  it('knows from the row alone when there is nothing to route to', () => {
    expect(visitNoticePreview({ ...base, session: { kinfolkId: '' } })).toEqual({
      kind: 'will_not_notify',
      reason: 'session_has_no_kinfolk',
    });
    expect(visitNoticePreview({ ...base, session: { kinfolkId: 'kf1' } })).toEqual({
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

  it('is null when there is nothing honest to say yet', () => {
    expect(visitNoticeConfirmLine({ kind: 'unknown' }, 'ARRIVED', 'Dre East')).toBeNull();
    expect(visitNoticeConfirmLine({ kind: 'none' }, 'UNDO_ARRIVAL', 'Dre East')).toBeNull();
  });

  it('visitNoticeConfirmFor runs both steps', () => {
    expect(
      visitNoticeConfirmFor({
        action: 'ARRIVED',
        session: ROUTED,
        hasPortalAccount: true,
        noticesLive: false,
        household: 'Dre East',
      }),
    ).toBe('Dre East will not be told, because notices to households are off in Settings.');
  });
});

describe('hasPortalAccount', () => {
  it('reads the linked login on the household record', () => {
    expect(hasPortalAccount({ uid: 'u1' })).toBe(true);
    expect(hasPortalAccount({ uid: '  ' })).toBe(false);
    expect(hasPortalAccount({})).toBe(false);
    expect(hasPortalAccount(null)).toBeNull();
    expect(hasPortalAccount(undefined)).toBeNull();
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

describe('useHouseholdNoticesLive', () => {
  beforeEach(() => {
    invalidateSharedLoad();
    getBusinessSettings.mockReset();
  });

  it('joins the settings read useBookingCatalog already makes', () => {
    expect(BUSINESS_SETTINGS_SHARED_KEY).toBe(BOOKING_CATALOG_KEY);
  });

  it('is null until the read lands, then the switch', async () => {
    getBusinessSettings.mockResolvedValue({ householdNotificationsLive: true });
    const { result } = renderHook(() => useHouseholdNoticesLive());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('reads anything but true as off', async () => {
    getBusinessSettings.mockResolvedValue({ householdNotificationsLive: false });
    const { result } = renderHook(() => useHouseholdNoticesLive());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('stays null when the read fails, rather than guessing', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission denied'));
    const { result } = renderHook(() => useHouseholdNoticesLive());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });
});
