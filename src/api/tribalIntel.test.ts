import { describe, it, expect } from 'vitest';
import { TRIBAL_INTEL_QUERY } from './tribalIntel';

describe('TRIBAL_INTEL_QUERY', () => {
  it('streams the flat top-level training_documents collection', () => {
    expect(TRIBAL_INTEL_QUERY.path).toBe('training_documents');
  });

  it('is bounded and server-ordered by createdAt desc (AO-29: never an unbounded listen)', () => {
    expect(TRIBAL_INTEL_QUERY.order).toEqual(['createdAt', 'desc']);
    expect(TRIBAL_INTEL_QUERY.max).toBe(200);
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(TRIBAL_INTEL_QUERY.filters).toBeUndefined();
  });
});
