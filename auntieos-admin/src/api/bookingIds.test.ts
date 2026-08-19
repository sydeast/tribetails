import { describe, it, expect } from 'vitest';
import { sessionIdForVisit, visitIdForSession } from './bookings';

/**
 * The bridge between the two booking id spaces (issue #389).
 *
 * A booking notification's `targetId` is an ENVELOPE visit id
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`); every admin
 * booking surface reads the FLAT `kin_care_sessions` collection, whose doc id is
 * `vis_{visitId}`, minted that way by `approveBookingSeriesCore.ts:95` and
 * re-derived by `manageBookingSeries.ts:100` and `batchUpdateBookings.ts:184`.
 *
 * The Kotlin mirror of these two functions lives in
 * `android/.../ui/Navigation.kt` and is pinned by the same cases in
 * `NotificationQuickActionsTest.kt`.
 */
describe('the visit-id / session-id bridge', () => {
  it('prefixes a bare envelope visit id', () => {
    expect(sessionIdForVisit('v123')).toBe('vis_v123');
  });

  it('recovers the visit id from a session id', () => {
    expect(visitIdForSession('vis_v123')).toBe('v123');
  });

  it('round-trips a visit id through the session id and back', () => {
    for (const visitId of ['v123', 'abc-def', 'VIS_upper', 'vis', '9', 'visit_1']) {
      expect(visitIdForSession(sessionIdForVisit(visitId))).toBe(visitId);
    }
  });

  it('round-trips a session id through the visit id and back', () => {
    for (const sessionId of ['vis_v123', 'vis_abc-def', 'vis_9']) {
      expect(sessionIdForVisit(visitIdForSession(sessionId))).toBe(sessionId);
    }
  });

  it('is idempotent on an id that already carries the prefix', () => {
    // A notification whose emitter threaded the flat session id must not come
    // out as `vis_vis_...`, which would resolve to nothing at all.
    expect(sessionIdForVisit('vis_v123')).toBe('vis_v123');
    expect(sessionIdForVisit(sessionIdForVisit('v123'))).toBe('vis_v123');
  });

  it('leaves an unprefixed session id alone rather than inventing a visit id', () => {
    // A manually created or legacy session has no envelope counterpart at all.
    expect(visitIdForSession('ad-hoc-session')).toBe('ad-hoc-session');
  });

  it('trims, and answers a blank id with a blank id rather than a bare prefix', () => {
    expect(sessionIdForVisit('  v123  ')).toBe('vis_v123');
    expect(sessionIdForVisit('')).toBe('');
    expect(sessionIdForVisit('   ')).toBe('');
  });
});
