import { describe, it, expect } from 'vitest';
import {
  isBlankTargetId,
  targetTypeLabel,
  matchesTargetType,
  withMediaDefaults,
} from './mediaScopeFormat';

describe('isBlankTargetId', () => {
  it('true for empty and whitespace-only ids', () => {
    expect(isBlankTargetId('')).toBe(true);
    expect(isBlankTargetId('   ')).toBe(true);
  });
  it('false for a real id', () => {
    expect(isBlankTargetId('demo-family-001')).toBe(false);
  });
});

describe('targetTypeLabel', () => {
  it('maps household -> Household', () => {
    expect(targetTypeLabel('household')).toBe('Household');
  });
  it('maps kin -> Kin', () => {
    expect(targetTypeLabel('kin')).toBe('Kin');
  });
});

describe('matchesTargetType (exact, case-sensitive, no normalization)', () => {
  it('matches an identical literal', () => {
    expect(matchesTargetType('kin', 'kin')).toBe(true);
    expect(matchesTargetType('household', 'household')).toBe(true);
  });
  it('does NOT match on casing, mirroring the wasm source exactly', () => {
    expect(matchesTargetType('KIN', 'kin')).toBe(false);
    expect(matchesTargetType('kinfolk', 'kin')).toBe(false);
    expect(matchesTargetType('HOUSEHOLD', 'household')).toBe(false);
  });
  it('a real production entityType value ("kinfolk") does not match either route type literally', () => {
    // Documents the exact ambiguity api/media.ts's header describes: this is
    // why screens/Media.tsx does not apply this filter today.
    expect(matchesTargetType('kinfolk', 'kin')).toBe(false);
    expect(matchesTargetType('kinfolk', 'household')).toBe(false);
  });
});

describe('withMediaDefaults', () => {
  it('fills every rendered field when the doc is missing all of them', () => {
    const filled = withMediaDefaults({ _id: 'm1' });
    expect(filled).toEqual({
      _id: 'm1',
      kinfolkId: '',
      // #397 S2: the media callables cross-check these against the stored doc,
      // so a row that carries neither must read as "no entity" rather than as
      // undefined that a caller could quietly substitute a route segment for.
      entityId: '',
      entityType: '',
      fileType: 'IMAGE',
      storageUrl: '',
      thumbnailUrl: '',
      uploadedAt: '',
      uploadedBy: '',
      description: '',
      originalFileName: '',
      isProfilePhoto: false,
      durationSeconds: 0,
    });
  });

  it('mirrors the real Stage 0I sandbox doc shape without throwing and fills the rest', () => {
    // Shape of the actual production doc "test-kinfolk-001-media-1" sampled via
    // the Firebase MCP tools: no fileType/description/originalFileName/
    // thumbnailUrl/uploadedBy at all.
    const sandboxDoc = {
      _id: 'test-kinfolk-001-media-1',
      kinfolkId: 'test-kinfolk-001',
      storageUrl: 'https://example.test/sandbox-media-1.jpg',
      uploadedAt: '2026-07-02T16:00:00.000Z',
      isProfilePhoto: false,
    };
    const filled = withMediaDefaults(sandboxDoc);
    expect(filled.fileType).toBe('IMAGE');
    expect(filled.description).toBe('');
    expect(filled.originalFileName).toBe('');
    expect(filled.storageUrl).toBe(sandboxDoc.storageUrl);
    expect(filled.uploadedAt).toBe(sandboxDoc.uploadedAt);
  });

  it('preserves every field a doc DOES set, never overwriting real data with a default', () => {
    const filled = withMediaDefaults({
      _id: 'm2',
      fileType: 'VIDEO',
      description: 'Rufus at the park',
      isProfilePhoto: true,
      durationSeconds: 42,
    });
    expect(filled.fileType).toBe('VIDEO');
    expect(filled.description).toBe('Rufus at the park');
    expect(filled.isProfilePhoto).toBe(true);
    expect(filled.durationSeconds).toBe(42);
  });
});
