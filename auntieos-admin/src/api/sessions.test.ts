import { describe, it, expect } from 'vitest';
import {
  SESSIONS_QUERY,
  SESSIONS_PAGE_SIZE,
  sessionsWindowQuery,
  sessionsArchiveQuery,
  sessionsPageQuery,
  sessionsWindowPageQuery,
} from './sessions';

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

/**
 * PHASE 4. The Auntie Time list pages both its day-of window and its Archive.
 * `sessionsWindowQuery` / `sessionsArchiveQuery` above stay for the live
 * listeners that still want a flat capped read.
 */
describe('sessionsPageQuery: the paged range', () => {
  const spec = sessionsPageQuery('2026-01-01', '2026-03-31');

  it('pages the same collection over the same inclusive range', () => {
    expect(spec.path).toBe('kin_care_sessions');
    expect(spec.filters).toEqual([
      ['startTime', '>=', '2026-01-01'],
      ['startTime', '<=', '2026-03-31'],
    ]);
  });

  it('grows a page at a time instead of truncating at a fixed cap', () => {
    expect(spec.pageSize).toBe(SESSIONS_PAGE_SIZE);
    // Bigger than the other two lists on purpose: this screen's counts and its
    // phase groups describe the whole window, so a small first page would leave
    // three numbers describing a fragment. See the constant's own doc.
    expect(SESSIONS_PAGE_SIZE).toBeGreaterThan(25);
  });

  it('ranges and orders on the SAME field, so no composite index is needed', () => {
    for (const f of spec.filters ?? []) expect(f[0]).toBe(spec.order[0]);
  });

  it('keeps the desc order the deployed (kinfolkId, startTime DESC) index covers', () => {
    expect(spec.order).toEqual(['startTime', 'desc']);
  });

  it('stays bounded even when handed a blank range', () => {
    expect(sessionsPageQuery('', '').filters).toHaveLength(2);
  });
});

describe('sessionsWindowPageQuery: the day-of window, paged', () => {
  it('uses exactly the bounds the unpaged window query already used', () => {
    const paged = sessionsWindowPageQuery('2026-07-16');
    expect(paged.filters).toEqual(sessionsWindowQuery('2026-07-16').filters);
    expect(paged.filters).toEqual([
      ['startTime', '>=', '2026-06-16'],
      ['startTime', '<=', '2026-07-31'],
    ]);
  });

  it('reaches FORWARD as well as back, which is why this screen has no "last N days" chips', () => {
    // The toolbar presets are backward-only lower bounds. Auntie Time's window
    // is today plus the next fortnight plus what wrapped recently, so the two
    // are not the same control wearing different clothes.
    const [, , upper] = sessionsWindowPageQuery('2026-07-16').filters?.[1] ?? [];
    expect(String(upper) > '2026-07-16').toBe(true);
  });
});
