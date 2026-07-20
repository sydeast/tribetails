import { describe, it, expect } from 'vitest';
import { SESSIONS_QUERY } from './sessions';

describe('SESSIONS_QUERY', () => {
  it('streams the flat top-level kin_care_sessions collection', () => {
    expect(SESSIONS_QUERY.path).toBe('kin_care_sessions');
  });

  it('is bounded and server-ordered by startTime desc (AO-29: never an unbounded listen)', () => {
    expect(SESSIONS_QUERY.order).toEqual(['startTime', 'desc']);
    expect(SESSIONS_QUERY.max).toBe(300);
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(SESSIONS_QUERY.filters).toBeUndefined();
  });
});
