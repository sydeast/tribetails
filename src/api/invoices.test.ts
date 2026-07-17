import { describe, it, expect } from 'vitest';
import { INVOICES_QUERY } from './invoices';

describe('INVOICES_QUERY', () => {
  it('streams the flat top-level invoices collection', () => {
    expect(INVOICES_QUERY.path).toBe('invoices');
  });

  it('is bounded and server-ordered by createdAt desc (AO-29: never an unbounded listen)', () => {
    expect(INVOICES_QUERY.order).toEqual(['createdAt', 'desc']);
    expect(INVOICES_QUERY.max).toBe(200);
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(INVOICES_QUERY.filters).toBeUndefined();
  });
});
