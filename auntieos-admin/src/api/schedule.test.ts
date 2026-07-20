import { describe, it, expect } from 'vitest';
import { SCHEDULE_SESSIONS_QUERY, SCHEDULE_BUSY_SLOTS_QUERY } from './schedule';

describe('SCHEDULE_SESSIONS_QUERY', () => {
  it('streams the flat top-level kin_care_sessions collection (same collection Sessions.tsx reads)', () => {
    expect(SCHEDULE_SESSIONS_QUERY.path).toBe('kin_care_sessions');
  });

  it('is bounded and server-ordered by startTime desc (AO-29: never an unbounded listen)', () => {
    expect(SCHEDULE_SESSIONS_QUERY.order).toEqual(['startTime', 'desc']);
    expect(SCHEDULE_SESSIONS_QUERY.max).toBe(300);
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(SCHEDULE_SESSIONS_QUERY.filters).toBeUndefined();
  });
});

describe('SCHEDULE_BUSY_SLOTS_QUERY', () => {
  it('streams the flat top-level booking_time_slots collection', () => {
    expect(SCHEDULE_BUSY_SLOTS_QUERY.path).toBe('booking_time_slots');
  });

  it('is bounded and server-ordered by date asc (AO-29: never an unbounded listen)', () => {
    expect(SCHEDULE_BUSY_SLOTS_QUERY.order).toEqual(['date', 'asc']);
    expect(SCHEDULE_BUSY_SLOTS_QUERY.max).toBe(500);
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(SCHEDULE_BUSY_SLOTS_QUERY.filters).toBeUndefined();
  });
});
