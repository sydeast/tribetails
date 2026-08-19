import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TRIBAL_INTEL_DELETE_CAVEAT,
  TRIBAL_INTEL_QUEUED_MESSAGE,
  attachmentCountLabel,
  dropEmptyTribalIntel,
  distinctCommTypes,
  filterByCommType,
  filterTribalIntel,
  isTribalIntelTitleFallback,
  reconcileState,
  reconcileStateInfo,
  tribalIntelTarget,
  tribalIntelTargetKindLabel,
  tribalIntelTargetLabel,
  tribalIntelTargetName,
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

describe('tribalIntelTarget (issue #393: three targets, said out loud)', () => {
  it('reads a HOUSEHOLD entry as the household it names', () => {
    expect(tribalIntelTarget({ targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1' })).toEqual({
      kind: 'household',
      id: 'kf1',
    });
  });

  it('reads a KINFOLK entry as one human client, not the whole house', () => {
    expect(tribalIntelTarget({ targetType: 'KINFOLK', targetKinfolkId: 'kf1' })).toEqual({
      kind: 'kinfolk',
      id: 'kf1',
    });
  });

  it('reads a KIN entry as the one animal it names', () => {
    expect(tribalIntelTarget({ targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'k9' })).toEqual({
      kind: 'kin',
      id: 'k9',
    });
  });

  it('is case- and whitespace-insensitive about the stored text', () => {
    expect(tribalIntelTarget({ targetType: ' kinfolk ', targetKinfolkId: 'kf1' }).kind).toBe('kinfolk');
    expect(tribalIntelTarget({ targetType: 'kin', targetKinfolkId: 'kf1', targetKinId: 'k9' }).kind).toBe(
      'kin',
    );
  });

  it('defaults a legacy entry with no target type to the household it is filed under', () => {
    // The NDJSON migration rows carry `kinfolkRef` and nothing else. Household
    // is the widest honest reading of a document that names nobody narrower.
    expect(tribalIntelTarget({ kinfolkRef: 'demo-family-002' })).toEqual({
      kind: 'household',
      id: 'demo-family-002',
    });
  });

  it('defaults an unrecognized target type to household rather than guessing', () => {
    expect(tribalIntelTarget({ targetType: 'FAMILY', targetKinfolkId: 'kf1' }).kind).toBe('household');
  });

  it('falls back to household for a KIN entry that names no kin', () => {
    expect(tribalIntelTarget({ targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: '  ' })).toEqual({
      kind: 'household',
      id: 'kf1',
    });
  });

  it('falls back to household for a KINFOLK entry that names nobody', () => {
    expect(tribalIntelTarget({ targetType: 'KINFOLK' })).toEqual({ kind: 'household', id: '' });
  });

  it('prefers targetKinfolkId over the legacy kinfolkRef when both are present', () => {
    expect(
      tribalIntelTarget({ targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1', kinfolkRef: 'stale' }).id,
    ).toBe('kf1');
  });
});

describe('tribalIntelTargetKindLabel', () => {
  it("names each target with the operator's own word", () => {
    expect(tribalIntelTargetKindLabel('household')).toBe('Household');
    expect(tribalIntelTargetKindLabel('kinfolk')).toBe('Kinfolk');
    expect(tribalIntelTargetKindLabel('kin')).toBe('Kin');
  });
});

const ROSTER_KINFOLK = [
  { _id: 'kf1', firstName: 'Jane', lastName: 'Halbrook' },
  { _id: 'kf2', firstName: 'Sam', lastName: '' },
];
const ROSTER_KIN = [
  { _id: 'k9', kinfolkId: 'kf1', name: 'Rufus' },
  { _id: 'k10', kinfolkId: 'kf1', name: '' },
];

describe('tribalIntelTargetName', () => {
  it('names a household by the surname it shares', () => {
    expect(tribalIntelTargetName({ kind: 'household', id: 'kf1' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe(
      'the Halbrooks',
    );
  });

  it('names a kinfolk by their own name', () => {
    expect(tribalIntelTargetName({ kind: 'kinfolk', id: 'kf1' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe(
      'Jane Halbrook',
    );
  });

  it('names a kin by their own name', () => {
    expect(tribalIntelTargetName({ kind: 'kin', id: 'k9' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe('Rufus');
  });

  it('uses the person name for a household with no surname on file', () => {
    expect(tribalIntelTargetName({ kind: 'household', id: 'kf2' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe('Sam');
  });

  it('shows the raw id when the roster holds no match, never a blank', () => {
    expect(tribalIntelTargetName({ kind: 'household', id: 'gone' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe('gone');
    expect(tribalIntelTargetName({ kind: 'kin', id: 'gone' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe('gone');
  });

  it('shows the raw id for a kin whose name is blank', () => {
    expect(tribalIntelTargetName({ kind: 'kin', id: 'k10' }, ROSTER_KINFOLK, ROSTER_KIN)).toBe('k10');
  });

  it('is null when the entry names nothing at all', () => {
    expect(tribalIntelTargetName({ kind: 'household', id: '' }, ROSTER_KINFOLK, ROSTER_KIN)).toBeNull();
  });
});

describe('tribalIntelTargetLabel', () => {
  it('labels all three targets with the kind and the resolved name', () => {
    expect(
      tribalIntelTargetLabel({ targetType: 'HOUSEHOLD', targetKinfolkId: 'kf1' }, ROSTER_KINFOLK, ROSTER_KIN),
    ).toBe('Household: the Halbrooks');
    expect(
      tribalIntelTargetLabel({ targetType: 'KINFOLK', targetKinfolkId: 'kf1' }, ROSTER_KINFOLK, ROSTER_KIN),
    ).toBe('Kinfolk: Jane Halbrook');
    expect(
      tribalIntelTargetLabel(
        { targetType: 'KIN', targetKinfolkId: 'kf1', targetKinId: 'k9' },
        ROSTER_KINFOLK,
        ROSTER_KIN,
      ),
    ).toBe('Kin: Rufus');
  });

  it('never calls a single-kinfolk entry a household', () => {
    // The reported defect: a row reading "Related to: demo-family-002" under
    // household wording, on an entry that is about one kinfolk.
    const label = tribalIntelTargetLabel(
      { targetType: 'KINFOLK', targetKinfolkId: 'kf1' },
      ROSTER_KINFOLK,
      ROSTER_KIN,
    );
    expect(label).not.toContain('Household');
    expect(label).toBe('Kinfolk: Jane Halbrook');
  });

  it('is null for an entry that names nobody, so the row shows no target line', () => {
    expect(tribalIntelTargetLabel({}, ROSTER_KINFOLK, ROSTER_KIN)).toBeNull();
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
describe('dropEmptyTribalIntel', () => {
  it('drops a row with no title, no content, and no attachment so it never shows as "Untitled Document"', () => {
    const kept = dropEmptyTribalIntel([
      { title: '', content: '', attachments: [] },
      { title: 'Gate code', content: '' },
    ]);
    expect(kept).toEqual([{ title: 'Gate code', content: '' }]);
  });

  it('treats whitespace-only text as empty, matching the archive junk-row filter', () => {
    expect(dropEmptyTribalIntel([{ title: '   ', content: '\n' }])).toEqual([]);
  });

  it('keeps a row that has only attachments (the server allows saving one)', () => {
    const attachmentOnly = { title: '', content: '', attachments: [{ fileName: 'gate.jpg' }] };
    expect(dropEmptyTribalIntel([attachmentOnly])).toEqual([attachmentOnly]);
  });

  it('tolerates a legacy doc missing every field rather than throwing on it', () => {
    expect(dropEmptyTribalIntel([{}])).toEqual([]);
  });
});
describe('honesty copy', () => {
  it('the save confirmation names the next reconcile pass and denies an instant fold outright', () => {
    expect(TRIBAL_INTEL_QUEUED_MESSAGE).toMatch(/next reconcile pass/i);
    expect(TRIBAL_INTEL_QUEUED_MESSAGE).toMatch(/not instantly/i);
    // No completed claim: the dossier and 411 have not changed yet.
    expect(TRIBAL_INTEL_QUEUED_MESSAGE).not.toMatch(/\b(is|are|now|already|has been|have been)\s+(updated|folded|merged)\b/i);
  });

  it('the delete caveat states that already-folded dossier and 411 text is NOT unmerged', () => {
    expect(TRIBAL_INTEL_DELETE_CAVEAT).toMatch(/does not unmerge/i);
    expect(TRIBAL_INTEL_DELETE_CAVEAT).toMatch(/dossier/i);
    expect(TRIBAL_INTEL_DELETE_CAVEAT).toMatch(/411/);
  });
  it('both strings name all THREE destinations, because a household note reaches none of the other two', () => {
    for (const copy of [TRIBAL_INTEL_QUEUED_MESSAGE, TRIBAL_INTEL_DELETE_CAVEAT]) {
      expect(copy).toMatch(/dossier/i);
      expect(copy).toMatch(/household bank/i);
      expect(copy).toMatch(/411/);
    }
  });

  it('neither string uses an em dash or en dash (Den copy rule)', () => {
    expect(TRIBAL_INTEL_QUEUED_MESSAGE).not.toMatch(/[—–]/);
    expect(TRIBAL_INTEL_DELETE_CAVEAT).not.toMatch(/[—–]/);
  });
});
