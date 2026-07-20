import { describe, it, expect } from 'vitest';
import { mediaTargetQuery, NO_TARGET_ENTITY_ID_SENTINEL } from './media';

describe('mediaTargetQuery', () => {
  it('scopes to media_files, filtered by entityId, newest first, capped at 500', () => {
    const spec = mediaTargetQuery('demo-family-001');
    expect(spec.path).toBe('media_files');
    expect(spec.filters).toEqual([['entityId', '==', 'demo-family-001']]);
    expect(spec.order).toEqual(['uploadedAt', 'desc']);
    expect(spec.max).toBe(500);
  });

  it('trims stray whitespace off a route-supplied id', () => {
    const spec = mediaTargetQuery('  demo-family-001  ');
    expect(spec.filters).toEqual([['entityId', '==', 'demo-family-001']]);
  });

  it('a blank id resolves to the sentinel, never an empty-string filter and never no filter at all', () => {
    const spec = mediaTargetQuery('');
    expect(spec.filters).toEqual([['entityId', '==', NO_TARGET_ENTITY_ID_SENTINEL]]);
    // Never the AO-29 shape: a filters array that is empty/undefined would stream
    // the whole media_files collection.
    expect(spec.filters?.length).toBe(1);
    expect(spec.filters?.[0]?.[2]).not.toBe('');
  });

  it('whitespace-only id is treated the same as blank', () => {
    const spec = mediaTargetQuery('   ');
    expect(spec.filters).toEqual([['entityId', '==', NO_TARGET_ENTITY_ID_SENTINEL]]);
  });

  it('the sentinel is not a plausible real Firestore entityId', () => {
    // Real values look like "demo-family-001", a session id, a kin id: short and
    // opaque. The sentinel is deliberately shaped so it could never collide.
    expect(NO_TARGET_ENTITY_ID_SENTINEL.startsWith('__')).toBe(true);
  });
});
