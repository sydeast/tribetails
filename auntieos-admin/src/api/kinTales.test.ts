import { describe, it, expect } from 'vitest';
import {
  KINTALES_QUERY,
  KINTALES_PAGE_SIZE,
  kinTaleMatchesSearch,
  kinTalesLegacyQuery,
  kinTalesPageQuery,
  KINTALES_LEGACY_MAX,
} from './kinTales';

describe('KINTALES_QUERY', () => {
  it('streams the flat top-level kin_care_reports collection', () => {
    expect(KINTALES_QUERY.path).toBe('kin_care_reports');
  });

  it('is bounded and server-ordered by createdAt desc (AO-29: never an unbounded listen)', () => {
    expect(KINTALES_QUERY.order).toEqual(['createdAt', 'desc']);
    expect(KINTALES_QUERY.max).toBe(200);
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(KINTALES_QUERY.filters).toBeUndefined();
  });
});

describe('kinTalesPageQuery: the list screen own paged window', () => {
  it('pages the same collection, still ordered createdAt desc', () => {
    const spec = kinTalesPageQuery({ startIso: null });
    expect(spec.path).toBe('kin_care_reports');
    expect(spec.order).toEqual(['createdAt', 'desc']);
    expect(spec.pageSize).toBe(KINTALES_PAGE_SIZE);
  });

  it('adds no WINDOW predicate for the archive, only the ISO-only ceiling (#1599)', () => {
    // rangeStartIso returns null for "All (archive)" precisely so a screen adds
    // no lower bound. The ceiling is what keeps the free-text rows out of the pager.
    expect(kinTalesPageQuery({ startIso: null }).filters).toEqual([['createdAt', '<', 'A']]);
  });

  it('windows on createdAt, which is the field it also orders by', () => {
    const spec = kinTalesPageQuery({ startIso: '2026-07-18T12:00:00.000Z' });
    expect(spec.filters).toEqual([
      ['createdAt', '>=', '2026-07-18T12:00:00.000Z'],
      ['createdAt', '<', 'A'],
    ]);
    for (const f of spec.filters ?? []) expect(f[0]).toBe(spec.order[0]);
  });

  it('windows against an ISO STRING, because that is what the field holds', () => {
    // kin_care_reports.createdAt is client-stamped ISO text, never a Timestamp.
    // Firestore orders every timestamp before every string, so a string bound on
    // a Timestamp field silently matches nothing; this asserts the value stays
    // the plain string the field can actually be compared to.
    const bound = kinTalesPageQuery({ startIso: '2026-07-18T12:00:00.000Z' }).filters?.[0]?.[2];
    expect(typeof bound).toBe('string');
  });

  it('composes the kinfolk facet with the window, in the deployed index order', () => {
    // Deployed: kin_care_reports (kinfolkId ASC, createdAt DESC).
    const spec = kinTalesPageQuery({ startIso: '2026-07-18T12:00:00.000Z', kinfolkId: 'kf1' });
    expect(spec.filters).toEqual([
      ['kinfolkId', '==', 'kf1'],
      ['createdAt', '>=', '2026-07-18T12:00:00.000Z'],
      ['createdAt', '<', 'A'],
    ]);
  });

  it('treats a blank facet as "every household", never as an empty-string id', () => {
    expect(kinTalesPageQuery({ startIso: null, kinfolkId: '' }).filters).toEqual([['createdAt', '<', 'A']]);
    expect(kinTalesPageQuery({ startIso: null, kinfolkId: undefined }).filters).toEqual([['createdAt', '<', 'A']]);
  });

  it('faceted archive reads carry the facet alone', () => {
    expect(kinTalesPageQuery({ startIso: null, kinfolkId: 'kf1' }).filters).toEqual([
      ['kinfolkId', '==', 'kf1'],
      ['createdAt', '<', 'A'],
    ]);
  });
});

describe('kinTaleMatchesSearch', () => {
  const row = { kinfolkName: 'The Whitfields', title: 'A great day at the park' };

  it('matches everything on a blank or whitespace query', () => {
    expect(kinTaleMatchesSearch(row, '')).toBe(true);
    expect(kinTaleMatchesSearch(row, '   ')).toBe(true);
  });

  it('matches the household and the title, case-insensitively', () => {
    expect(kinTaleMatchesSearch(row, 'whitfield')).toBe(true);
    expect(kinTaleMatchesSearch(row, 'PARK')).toBe(true);
  });

  it('refuses a match that only exists ACROSS two fields', () => {
    // A joined haystack would match this, and the operator could not explain the
    // result from anything on the row.
    expect(kinTaleMatchesSearch(row, 'whitfields a great')).toBe(false);
  });

  it('never throws on the missing fields a real doc genuinely has', () => {
    expect(kinTaleMatchesSearch({}, 'anything')).toBe(false);
    expect(kinTaleMatchesSearch({}, '')).toBe(true);
  });
});

describe('kinTalesLegacyQuery: the free-text createdAt rows (#1599)', () => {
  it('reads exactly the rows the pager leaves out: createdAt at or above the ISO ceiling', () => {
    const spec = kinTalesLegacyQuery();
    expect(spec.path).toBe('kin_care_reports');
    expect(spec.filters).toEqual([['createdAt', '>=', 'A']]);
    expect(spec.order[0]).toBe('createdAt');
    expect(spec.max).toBe(KINTALES_LEGACY_MAX);
  });
  it('puts the household equality first, in the deployed index order', () => {
    expect(kinTalesLegacyQuery('kf1').filters).toEqual([
      ['kinfolkId', '==', 'kf1'],
      ['createdAt', '>=', 'A'],
    ]);
  });
  it('treats a blank household as every household', () => {
    expect(kinTalesLegacyQuery('').filters).toEqual([['createdAt', '>=', 'A']]);
  });
  it('splits the collection with the pager at one boundary, with no row in both and none in neither', () => {
    const pager = kinTalesPageQuery({ startIso: null }).filters?.[0];
    const legacy = kinTalesLegacyQuery().filters?.[0];
    expect(pager?.[2]).toBe(legacy?.[2]);
    expect(pager?.[1]).toBe('<');
    expect(legacy?.[1]).toBe('>=');
  });
});
