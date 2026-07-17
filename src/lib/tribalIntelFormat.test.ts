import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  attachmentCountLabel,
  distinctCommTypes,
  filterByCommType,
  filterTribalIntel,
  isTribalIntelTitleFallback,
  reconcileState,
  reconcileStateInfo,
  relatedToLabel,
  tribalIntelTimeOf,
  tribalIntelTitle,
  tribalIntelWhen,
} from './tribalIntelFormat';

// TZ pinned to a west-of-UTC zone so the AO-18 assertions below are
// meaningful on any CI runner (the identical rationale as
// lib/kinTaleFormat.test.ts / lib/sessionFormat.test.ts). Restored afterAll
// for any sibling test file sharing this worker.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('tribalIntelTimeOf (AO-18: local, never a raw UTC string)', () => {
  it('returns null for a blank or unparseable string, never a fabricated date', () => {
    expect(tribalIntelTimeOf('')).toBeNull();
    expect(tribalIntelTimeOf('   ')).toBeNull();
    expect(tribalIntelTimeOf('not-a-date')).toBeNull();
  });

  it('parses a real ISO instant', () => {
    const t = tribalIntelTimeOf('2026-07-16T13:00:00.000Z');
    expect(t?.toDate().getTime()).toBe(new Date('2026-07-16T13:00:00.000Z').getTime());
  });
});

describe('tribalIntelWhen', () => {
  it("'Date TBD' for a blank uploadedAt, never a fabricated time", () => {
    expect(tribalIntelWhen('')).toBe('Date TBD');
    expect(tribalIntelWhen('   ')).toBe('Date TBD');
  });

  it("'Date TBD' for an unparseable uploadedAt, never a raw string leak", () => {
    expect(tribalIntelWhen('not-a-date')).toBe('Date TBD');
  });

  it('shows the LOCAL clock time, not the UTC hour (AO-18) or the raw ISO string', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
    // instant, matching createTrainingDocument.ts's `new Date().toISOString()`.
    expect(tribalIntelWhen('2026-07-17T01:00:00.000Z')).toBe('07-16 20:00');
  });
});

describe('tribalIntelTitle / isTribalIntelTitleFallback', () => {
  it('passes a real title through', () => {
    expect(tribalIntelTitle('Feeding schedule')).toBe('Feeding schedule');
    expect(isTribalIntelTitleFallback('Feeding schedule')).toBe(false);
  });

  it('falls back to "Untitled Document" for blank/whitespace-only titles', () => {
    expect(tribalIntelTitle('')).toBe('Untitled Document');
    expect(tribalIntelTitle('   ')).toBe('Untitled Document');
    expect(isTribalIntelTitleFallback('')).toBe(true);
    expect(isTribalIntelTitleFallback('   ')).toBe(true);
  });
});

describe('relatedToLabel', () => {
  it('passes a real kinfolkRef through', () => {
    expect(relatedToLabel('The Whitfields')).toBe('The Whitfields');
  });

  it('is null for blank/whitespace-only, never "Related to: " with nothing after it', () => {
    expect(relatedToLabel('')).toBeNull();
    expect(relatedToLabel('   ')).toBeNull();
  });
});

describe('attachmentCountLabel', () => {
  it('pluralizes correctly', () => {
    expect(attachmentCountLabel(1)).toBe('1 attachment');
    expect(attachmentCountLabel(3)).toBe('3 attachments');
  });

  it('is null for zero, never a misleading "0 attachments" pip', () => {
    expect(attachmentCountLabel(0)).toBeNull();
  });
});

describe('distinctCommTypes', () => {
  it('returns distinct, non-blank comm types in first-occurrence order', () => {
    const docs = [
      { communicationType: 'note' },
      { communicationType: 'guide' },
      { communicationType: 'note' },
      { communicationType: '' },
      { communicationType: 'guide' },
    ];
    expect(distinctCommTypes(docs)).toEqual(['note', 'guide']);
  });

  it('is empty for an all-blank collection', () => {
    expect(distinctCommTypes([{ communicationType: '' }, { communicationType: '   ' }])).toEqual([]);
  });
});

describe('filterByCommType', () => {
  const docs = [{ communicationType: 'note' }, { communicationType: 'guide' }, { communicationType: 'note' }];

  it('is a no-op for null (the "All" tab)', () => {
    expect(filterByCommType(docs, null)).toEqual(docs);
  });

  it('keeps only exact matches', () => {
    expect(filterByCommType(docs, 'guide')).toEqual([{ communicationType: 'guide' }]);
  });

  it('is empty for a comm type nothing matches, never falls back to "All"', () => {
    expect(filterByCommType(docs, 'nonexistent')).toEqual([]);
  });
});

describe('filterTribalIntel', () => {
  const docs = [
    { title: 'Feeding schedule', content: 'Twice daily, half cup each.', communicationType: 'note' },
    { title: '', content: 'Vet says increase the walk length gradually.', communicationType: 'guide' },
  ];

  it('is a no-op on a blank query', () => {
    expect(filterTribalIntel(docs, '  ')).toEqual(docs);
  });

  it('matches by title, case-insensitively', () => {
    expect(filterTribalIntel(docs, 'FEEDING')).toEqual([docs[0]]);
  });

  it('matches by content', () => {
    expect(filterTribalIntel(docs, 'vet says')).toEqual([docs[1]]);
  });

  it('matches by communicationType', () => {
    expect(filterTribalIntel(docs, 'guide')).toEqual([docs[1]]);
  });

  it('returns nothing for text present in none of the three fields', () => {
    expect(filterTribalIntel(docs, 'nonexistent-xyz')).toEqual([]);
  });
});

describe('reconcileState (AO-12-style: enumerated, never a fabricated default)', () => {
  it.each([
    ['pending', 'pending'],
    ['applied', 'applied'],
    ['skipped', 'skipped'],
    ['error', 'error'],
  ] as const)('%s classifies as %s', (status, state) => {
    expect(reconcileState(status)).toBe(state);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(reconcileState('  PENDING  ')).toBe('pending');
    expect(reconcileState('Applied')).toBe('applied');
  });

  it('a blank reconcileStatus is its own honest "none" bucket (a pre-spec-23 doc), not "unknown"', () => {
    expect(reconcileState('')).toBe('none');
    expect(reconcileState('   ')).toBe('none');
  });

  it('an unrecognized non-blank status is its own honest "unknown" bucket, never a fabricated pending/applied guess', () => {
    expect(reconcileState('some_new_code')).toBe('unknown');
  });
});

describe('reconcileStateInfo', () => {
  it.each([
    ['none', 'Not yet queued', 'NONE', 'none'],
    ['pending', 'Queued for reconcile', 'PENDING', 'pending'],
    ['applied', 'Folded into dossier/411', 'APPLIED', 'applied'],
    ['skipped', 'Skipped', 'SKIPPED', 'skipped'],
    ['error', 'Reconcile error', 'ERROR', 'error'],
    ['unknown', 'Unknown', 'UNKNOWN', 'unknown'],
  ] as const)('%s -> label %s / chip %s / css %s', (state, label, chipLabel, cssClass) => {
    expect(reconcileStateInfo(state)).toEqual({ label, chipLabel, cssClass });
  });
});
