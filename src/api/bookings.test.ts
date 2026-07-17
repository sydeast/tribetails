import { describe, it, expect } from 'vitest';
import { BOOKINGS_QUERY } from './bookings';

describe('BOOKINGS_QUERY (AO-29 regression guard: bounded + server-ordered, never an unbounded whole-collection listen)', () => {
  it('reads the flat kin_care_sessions collection, not the nested MyTribe booking-envelope path', () => {
    expect(BOOKINGS_QUERY.path).toBe('kin_care_sessions');
  });

  it('orders by createdAt descending, the one field on this doc that is a real serverTimestamp', () => {
    expect(BOOKINGS_QUERY.order).toEqual(['createdAt', 'desc']);
  });

  it('caps the listener rather than reading the whole collection unbounded', () => {
    expect(BOOKINGS_QUERY.max).toBe(200);
    expect(Number.isFinite(BOOKINGS_QUERY.max)).toBe(true);
    expect(BOOKINGS_QUERY.max).toBeGreaterThan(0);
  });

  it('carries no server-side filter, so it needs no composite Firestore index', () => {
    expect(BOOKINGS_QUERY.filters).toBeUndefined();
  });
});
