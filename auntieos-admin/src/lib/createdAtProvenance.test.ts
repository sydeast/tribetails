import { describe, it, expect } from 'vitest';
import {
  readCreatedAtSource,
  createdAtIsImportDate,
  createdAtProvenanceNote,
} from './createdAtProvenance';

/**
 * The reader half of the `createdAt` provenance contract. The three string
 * values are all that crosses the boundary between the migration
 * (`mytribe/scripts/createdAtProvenance.ts`) and this bundle, so what happens to
 * a FOURTH value matters as much as the three.
 */

describe('readCreatedAtSource', () => {
  it('reads back each of the three values', () => {
    expect(readCreatedAtSource('live')).toBe('live');
    expect(readCreatedAtSource('original')).toBe('original');
    expect(readCreatedAtSource('import')).toBe('import');
  });

  it('absent means live, which is a fact about this database, not a guess', () => {
    // One bulk import has ever run against it, and the migration stamps this
    // field on every row it touches, so a document without the field is a
    // document no import ever claimed.
    expect(readCreatedAtSource(undefined)).toBe('live');
    expect(readCreatedAtSource('')).toBe('live');
    expect(readCreatedAtSource(null)).toBe('live');
  });

  it('degrades an unrecognized value to live instead of throwing', () => {
    // This runs inside list rendering. KinTaleEntry is a CAST over raw
    // Firestore data, and one malformed document blanking the whole KinTales
    // page through the error boundary is a failure this codebase has already
    // shipped once (2026-07-20).
    expect(readCreatedAtSource('migrated')).toBe('live');
    expect(readCreatedAtSource(42)).toBe('live');
    expect(readCreatedAtSource({ source: 'import' })).toBe('live');
  });

  it('tolerates the surrounding whitespace a hand-edited doc can carry', () => {
    expect(readCreatedAtSource('  import  ')).toBe('import');
  });
});

describe('createdAtIsImportDate', () => {
  it('is true for exactly the one value that means "this is not a creation date"', () => {
    expect(createdAtIsImportDate('import')).toBe(true);
    expect(createdAtIsImportDate('original')).toBe(false);
    expect(createdAtIsImportDate('live')).toBe(false);
    expect(createdAtIsImportDate(undefined)).toBe(false);
  });
});

describe('createdAtProvenanceNote', () => {
  it('marks the row whose date is not what it looks like', () => {
    expect(createdAtProvenanceNote('import')).toBe('Imported, original date unknown');
  });

  it('says NOTHING about a recovered original, which is a real creation date', () => {
    // A badge on all 83 imported rows would be noise that trains the operator
    // to stop reading badges. The marker is for the rows it is true of.
    expect(createdAtProvenanceNote('original')).toBe('');
  });

  it('says nothing about a row this system created', () => {
    expect(createdAtProvenanceNote('live')).toBe('');
    expect(createdAtProvenanceNote(undefined)).toBe('');
  });
});
