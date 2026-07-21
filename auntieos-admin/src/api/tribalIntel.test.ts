import { describe, it, expect } from 'vitest';
import { TRIBAL_INTEL_QUERY } from './tribalIntel';

describe('TRIBAL_INTEL_QUERY', () => {
  it('streams the flat top-level training_documents collection', () => {
    expect(TRIBAL_INTEL_QUERY.path).toBe('training_documents');
  });

  it('is bounded and server-ordered by uploadedAt desc (AO-29: never an unbounded listen)', () => {
    expect(TRIBAL_INTEL_QUERY.order).toEqual(['uploadedAt', 'desc']);
    expect(TRIBAL_INTEL_QUERY.max).toBe(200);
  });

  it('sorts by uploadedAt, the one time field EVERY writer stamps, not createdAt', () => {
    // Firestore orderBy(f) DROPS every doc missing f, so the sort field
    // silently decides which rows exist at all. `createdAt` is stamped only by
    // the spec-23 createTrainingDocument callable; the pre-spec-23 rows written
    // by the NDJSON migration import (and the visual-harness seed) carry
    // `uploadedAt` and no `createdAt` whatsoever, so the old sort hid them
    // outright: the same defect shape that made invoices return 0 of 18 live
    // docs. `uploadedAt` is a superset across every writer, so this sort can
    // only ever show MORE than the old one, never fewer. See the spec's own
    // writer-by-writer audit in api/tribalIntel.ts.
    expect(TRIBAL_INTEL_QUERY.order[0]).toBe('uploadedAt');
    expect(TRIBAL_INTEL_QUERY.order[0]).not.toBe('createdAt');
  });

  it('sorts by the same field the row displays, so list order matches visible dates', () => {
    // TribalIntelRow renders tribalIntelWhen(doc.uploadedAt). Ordering by
    // createdAt sorted the list by a field the operator cannot see.
    expect(TRIBAL_INTEL_QUERY.order[0]).toBe('uploadedAt');
  });

  it('carries no filters, so it needs no composite Firestore index', () => {
    expect(TRIBAL_INTEL_QUERY.filters).toBeUndefined();
  });
});
