import { describe, it, expect } from 'vitest';
import {
  canonicalInstant,
  createdAtIsImportDate,
  readCreatedAtSource,
  resolveMigratedCreatedAt,
  CREATED_AT_SOURCE_FIELD,
} from '../createdAtProvenance';

/**
 * The shared `createdAt` contract, pinned on its own. Every import in this
 * system is supposed to go through `resolveMigratedCreatedAt`, so what it
 * refuses matters as much as what it returns.
 */

describe('canonicalInstant', () => {
  it('re-renders to the millisecond form the live rows already use', () => {
    expect(canonicalInstant('2026-05-16T20:36:39Z')).toBe('2026-05-16T20:36:39.000Z');
  });

  it('leaves an already-canonical instant identical', () => {
    expect(canonicalInstant('2025-12-02T19:00:00.000Z')).toBe('2025-12-02T19:00:00.000Z');
  });

  it('normalizing is load-bearing: the two forms do NOT sort together', () => {
    // 'Z' is 0x5A, '.' is 0x2E, so the SAME instant compares unequal. Writing a
    // mix of the two forms into a string field Firestore orders by byte would
    // seed a smaller copy of the bug this whole change exists to remove.
    expect('2026-05-16T20:36:39Z' > '2026-05-16T20:36:39.000Z').toBe(true);
    expect(canonicalInstant('2026-05-16T20:36:39Z')).toBe(
      canonicalInstant('2026-05-16T20:36:39.000Z'),
    );
  });

  it('accepts an offset instant and normalizes it to UTC', () => {
    expect(canonicalInstant('2026-05-16T15:36:39-05:00')).toBe('2026-05-16T20:36:39.000Z');
  });

  it('refuses anything that is not a full instant', () => {
    expect(canonicalInstant('2026-05-16')).toBeNull();
    expect(canonicalInstant('September 3, 2025 2:02pm')).toBeNull();
    expect(canonicalInstant('')).toBeNull();
    expect(canonicalInstant(undefined)).toBeNull();
    expect(canonicalInstant(1_760_000_000_000)).toBeNull();
  });
});

describe('readCreatedAtSource', () => {
  it('reads back each of the three values', () => {
    expect(readCreatedAtSource('live')).toBe('live');
    expect(readCreatedAtSource('original')).toBe('original');
    expect(readCreatedAtSource('import')).toBe('import');
  });

  it('absent means live, which is a fact about this database, not a guess', () => {
    // One bulk import has ever run, it is the only writer of _migratedFrom, and
    // the migration stamps this field on every row it touches. So a document
    // without the field is a document no import ever claimed.
    expect(readCreatedAtSource(undefined)).toBe('live');
    expect(readCreatedAtSource('')).toBe('live');
    expect(readCreatedAtSource(null)).toBe('live');
  });

  it('an unrecognized value degrades to live rather than throwing', () => {
    // This runs inside list rendering. One malformed document must not blank
    // the page.
    expect(readCreatedAtSource('migrated')).toBe('live');
    expect(readCreatedAtSource(42)).toBe('live');
  });
});

describe('createdAtIsImportDate', () => {
  it('is true for exactly one of the three values', () => {
    expect(createdAtIsImportDate('import')).toBe(true);
    expect(createdAtIsImportDate('original')).toBe(false);
    expect(createdAtIsImportDate('live')).toBe(false);
    expect(createdAtIsImportDate(undefined)).toBe(false);
  });
});

describe('resolveMigratedCreatedAt', () => {
  const INGEST = '2026-05-16T20:36:39Z';

  it('prefers the original, and says it is the original', () => {
    expect(resolveMigratedCreatedAt('2025-09-03T14:02:00Z', INGEST)).toEqual({
      createdAt: '2025-09-03T14:02:00.000Z',
      createdAtSource: 'original',
    });
  });

  it('falls back to the ingest instant, and MARKS it rather than passing it off', () => {
    // The whole point of the field: this row's createdAt is the day it was
    // imported, and a reader can tell.
    expect(resolveMigratedCreatedAt(null, INGEST)).toEqual({
      createdAt: '2026-05-16T20:36:39.000Z',
      createdAtSource: 'import',
    });
  });

  it('treats an unusable original exactly like an absent one', () => {
    expect(resolveMigratedCreatedAt('September 3, 2025 2:02pm', INGEST)?.createdAtSource).toBe(
      'import',
    );
    expect(resolveMigratedCreatedAt('', INGEST)?.createdAtSource).toBe('import');
  });

  it('returns null when NEITHER instant is usable, rather than inventing one', () => {
    // The caller must skip and report. There is no third value that is not a
    // fabrication.
    expect(resolveMigratedCreatedAt(null, null)).toBeNull();
    expect(resolveMigratedCreatedAt('yesterday', 'May 16, 2026')).toBeNull();
  });

  it('never returns "live": an imported row was not created here', () => {
    const stamps = [
      resolveMigratedCreatedAt('2025-09-03T14:02:00Z', INGEST),
      resolveMigratedCreatedAt(null, INGEST),
    ];
    for (const s of stamps) expect(s?.createdAtSource).not.toBe('live');
  });

  it('every value it produces is a STRING, never a Date or a Timestamp', () => {
    // Load-bearing across all four clients: both Kotlin KinCareReport models
    // type createdAt as a non-null String, and the React admin windows the list
    // with a string `>=`. A Timestamp here would crash the Android snapshot
    // listener and silently empty the web list.
    const stamp = resolveMigratedCreatedAt('2025-09-03T14:02:00Z', INGEST);
    expect(typeof stamp?.createdAt).toBe('string');
    expect(typeof stamp?.createdAtSource).toBe('string');
  });
});

describe('CREATED_AT_SOURCE_FIELD', () => {
  it('is the one spelling, so a typo cannot create a second field', () => {
    expect(CREATED_AT_SOURCE_FIELD).toBe('createdAtSource');
  });
});
