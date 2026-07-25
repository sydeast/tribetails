import { describe, it, expect } from 'vitest';
import { SESSIONS_QUERY, sessionsWindowQuery, sessionsArchiveQuery } from './sessions';

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
/**
 * OPERATOR ISSUE #17. `SESSIONS_QUERY` above stays as it is: three other
 * surfaces (KinTaleCompose, SafeboxWidget, CareFlagsWidget) read the same
 * collection for their own reasons and want the latest rows, not a day-of
 * window. The Auntie Time LIST gets its own bounded, date-ranged query so its
 * data finally matches the sub-header's promise.
 */
describe('sessionsWindowQuery: the default Auntie Time window', () => {
  const spec = sessionsWindowQuery('2026-07-16');
  it('streams the flat top-level kin_care_sessions collection', () => {
    expect(spec.path).toBe('kin_care_sessions');
  });
  it('is bounded and server-ordered (AO-29: never an unbounded listen)', () => {
    expect(spec.max).toBe(300);
    expect(spec.order).toEqual(['startTime', 'desc']);
  });
  it('carries the date range as a server-side predicate, not a client-side trim', () => {
    expect(spec.filters).toEqual([
      ['startTime', '>=', '2026-06-16'],
      ['startTime', '<=', '2026-07-31'],
    ]);
  });
  it('ranges and orders on the SAME field, so no composite index is needed', () => {
    for (const f of spec.filters ?? []) expect(f[0]).toBe(spec.order[0]);
  });
  it('keeps the desc order the deployed (kinfolkId, startTime DESC) index already covers', () => {
    // A test admin's spec picks up a `kinfolkId ==` predicate from lib/testScope,
    // and mytribe/firestore.indexes.json carries (kinfolkId ASC, startTime DESC).
    // Flipping to asc would need an index that is not deployed, and the display
    // order is re-derived by groupSessionsByPhase regardless.
    expect(spec.order[1]).toBe('desc');
  });
});
describe('sessionsArchiveQuery: the older-history seam', () => {
  it('takes an explicit range and bounds it the same way', () => {
    const spec = sessionsArchiveQuery('2026-01-01', '2026-03-31');
    expect(spec.path).toBe('kin_care_sessions');
    expect(spec.order).toEqual(['startTime', 'desc']);
    expect(spec.max).toBe(300);
    expect(spec.filters).toEqual([
      ['startTime', '>=', '2026-01-01'],
      ['startTime', '<=', '2026-03-31'],
    ]);
  });
  it('stays bounded even when handed a blank range, never widening to a whole-collection read', () => {
    const spec = sessionsArchiveQuery('', '');
    expect(spec.max).toBe(300);
    expect(spec.filters).toHaveLength(2);
  });
});
