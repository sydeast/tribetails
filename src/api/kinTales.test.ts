import { describe, it, expect } from 'vitest';
import { KINTALES_QUERY } from './kinTales';

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
