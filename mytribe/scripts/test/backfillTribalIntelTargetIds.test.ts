import { describe, it, expect } from 'vitest';
import {
  buildCreatedKinfolkDoc,
  buildNameIndex,
  buildPlanFrom,
  kinfolkNameCandidates,
  looksLikeDocumentId,
  normalizeName,
  parseArgs,
  planTargetForRow,
  reportLines,
  splitWrittenName,
  CREATED_BY_BACKFILL,
  type KinfolkRow,
  type TrainingDocRow,
} from '../backfillTribalIntelTargetIds';

/**
 * The sweep behind issue #460. Everything here runs against fixtures: the plan
 * builder takes two arrays and an id generator, so the whole decision — which
 * rows are repaired, which records are created, and which are refused as
 * ambiguous — is provable without Firestore.
 */

const ROSTER: KinfolkRow[] = [
  { id: 'kf-jane', data: { firstName: 'Jane', lastName: 'Halbrook', email: 'jane@example.test' } },
  { id: 'kf-marcus', data: { firstName: 'Marcus', lastName: 'Vance' } },
  // Two households answer to "Chris Doyle". Neither may ever be guessed.
  { id: 'kf-chris-a', data: { firstName: 'Chris', lastName: 'Doyle', email: 'chris@a.test' } },
  { id: 'kf-chris-b', data: { firstName: 'Chris', lastName: 'Doyle', email: 'chris@b.test' } },
];

function ids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `new-${n}`;
  };
}

function plan(rows: TrainingDocRow[]) {
  return buildPlanFrom(ROSTER, rows, ids());
}

describe('normalizeName', () => {
  it('folds case, punctuation, and repeated whitespace to one form', () => {
    expect(normalizeName('  Jane   Halbrook ')).toBe('jane halbrook');
    expect(normalizeName('HALBROOK, JANE')).toBe('halbrook jane');
    expect(normalizeName('Jane-Halbrook')).toBe('jane halbrook');
  });

  it('is empty for a string with nothing matchable in it', () => {
    expect(normalizeName('   ---  ')).toBe('');
  });
});

describe('kinfolkNameCandidates', () => {
  it('offers both token orders, because a spreadsheet export writes surname first', () => {
    const c = kinfolkNameCandidates({ firstName: 'Jane', lastName: 'Halbrook' });
    expect(c).toContain('jane halbrook');
    expect(c).toContain('halbrook jane');
  });

  it('includes displayName, businessName, and email', () => {
    const c = kinfolkNameCandidates({
      displayName: 'Janie H',
      businessName: 'Halbrook Farms',
      email: 'jane@example.test',
    });
    expect(c).toContain('janie h');
    expect(c).toContain('halbrook farms');
    expect(c).toContain('jane example test');
  });
});

describe('buildNameIndex', () => {
  it('collects every kinfolk that answers to one name', () => {
    const index = buildNameIndex(ROSTER);
    expect(index.get('jane halbrook')).toEqual(['kf-jane']);
    expect(index.get('chris doyle')).toEqual(['kf-chris-a', 'kf-chris-b']);
  });
});

describe('looksLikeDocumentId', () => {
  it('treats a generated id as an id and a written name as a name', () => {
    expect(looksLikeDocumentId('Xk92mZq0aB4cD7eF1gH3')).toBe(true);
    // A short hand-made id must NOT read as a name, or the sweep would create a
    // kinfolk called "demo-family-001".
    expect(looksLikeDocumentId('demo-family-001')).toBe(true);
    expect(looksLikeDocumentId('Jane Halbrook')).toBe(false);
    expect(looksLikeDocumentId('Cher')).toBe(false);
    expect(looksLikeDocumentId("O'Brien")).toBe(false);
  });
});

describe('planTargetForRow', () => {
  const known = new Set(ROSTER.map((r) => r.id));
  const index = buildNameIndex(ROSTER);

  it('leaves a row that already carries a live id in both fields alone', () => {
    expect(
      planTargetForRow({ targetKinfolkId: 'kf-jane', kinfolkRef: 'kf-jane' }, known, index),
    ).toEqual({ kind: 'ok', id: 'kf-jane' });
  });

  it('copies a live id across when only the legacy field carries it', () => {
    expect(planTargetForRow({ kinfolkRef: 'kf-jane' }, known, index)).toEqual({
      kind: 'mirror',
      id: 'kf-jane',
    });
  });

  it('resolves a stored NAME to the one kinfolk that answers to it', () => {
    expect(planTargetForRow({ kinfolkRef: 'Jane Halbrook' }, known, index)).toEqual({
      kind: 'resolved',
      name: 'Jane Halbrook',
      id: 'kf-jane',
    });
  });

  it('resolves a surname-first spelling too', () => {
    expect(planTargetForRow({ kinfolkRef: 'Halbrook, Jane' }, known, index)).toMatchObject({
      kind: 'resolved',
      id: 'kf-jane',
    });
  });

  it('REFUSES a name that two households answer to', () => {
    expect(planTargetForRow({ kinfolkRef: 'Chris Doyle' }, known, index)).toEqual({
      kind: 'ambiguous',
      name: 'Chris Doyle',
      candidates: ['kf-chris-a', 'kf-chris-b'],
    });
  });

  it('plans a record for a name nobody on the roster answers to', () => {
    expect(planTargetForRow({ kinfolkRef: 'Nora Bell' }, known, index)).toEqual({
      kind: 'create',
      name: 'Nora Bell',
    });
  });

  it('reports an id-shaped reference that no longer exists rather than inventing a person for it', () => {
    expect(planTargetForRow({ kinfolkRef: 'Xk92mZq0aB4cD7eF1gH3' }, known, index)).toEqual({
      kind: 'dangling',
      value: 'Xk92mZq0aB4cD7eF1gH3',
    });
  });

  it('reports a row that names nobody at all', () => {
    expect(planTargetForRow({ title: 'orphan note' }, known, index)).toEqual({ kind: 'empty' });
  });

  it('prefers targetKinfolkId over the legacy field when both are present', () => {
    expect(
      planTargetForRow({ targetKinfolkId: 'kf-marcus', kinfolkRef: 'Jane Halbrook' }, known, index),
    ).toEqual({ kind: 'mirror', id: 'kf-marcus' });
  });
});

describe('splitWrittenName / buildCreatedKinfolkDoc', () => {
  it('takes the last token as the surname and keeps the raw string verbatim', () => {
    expect(splitWrittenName('Mary Jo Bell')).toEqual({ firstName: 'Mary Jo', lastName: 'Bell' });
    const doc = buildCreatedKinfolkDoc('Mary Jo Bell', ['t1']);
    expect(doc.displayName).toBe('Mary Jo Bell');
    expect(doc._createdBy).toBe(CREATED_BY_BACKFILL);
    expect(doc._createdFromTribalIntelDocIds).toEqual(['t1']);
  });

  it('gives a one-word name no surname rather than guessing a family', () => {
    expect(splitWrittenName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('fabricates no email, phone, or join date', () => {
    const doc = buildCreatedKinfolkDoc('Nora Bell', ['t1']);
    expect(doc.email).toBeUndefined();
    expect(doc.phoneNumber).toBeUndefined();
    expect(doc.joinDate).toBeUndefined();
  });
});

describe('buildPlanFrom', () => {
  it('counts each bucket and plans a write only for the rows it can settle', () => {
    const p = plan([
      { id: 't-ok', data: { targetKinfolkId: 'kf-jane', kinfolkRef: 'kf-jane' } },
      { id: 't-mirror', data: { kinfolkRef: 'kf-marcus' } },
      { id: 't-name', data: { kinfolkRef: 'Jane Halbrook' } },
      { id: 't-new', data: { kinfolkRef: 'Nora Bell' } },
      { id: 't-ambig', data: { kinfolkRef: 'Chris Doyle' } },
      { id: 't-dead', data: { kinfolkRef: 'Xk92mZq0aB4cD7eF1gH3' } },
      { id: 't-none', data: { title: 'no target' } },
    ]);

    expect(p.summary.scanned).toBe(7);
    expect(p.summary.alreadyResolvable).toBe(1);
    expect(p.summary.mirrored).toBe(1);
    expect(p.summary.resolvedByName).toBe(1);
    expect(p.summary.pointedAtNewRecords).toBe(1);
    expect(p.creations).toHaveLength(1);
    expect(p.summary.ambiguous).toHaveLength(1);
    expect(p.summary.dangling).toHaveLength(1);
    expect(p.summary.noTarget).toEqual(['t-none']);
    // Four rows settled, three left for a human: the ok row needs no write.
    expect(p.writes.map((w) => w.trainingDocId)).toEqual(['t-mirror', 't-name', 't-new']);
  });

  it('NEVER writes the ambiguous row, and names every candidate for the human', () => {
    const p = plan([{ id: 't-ambig', data: { kinfolkRef: 'Chris Doyle' } }]);
    expect(p.writes).toEqual([]);
    expect(p.creations).toEqual([]);
    const [a] = p.summary.ambiguous;
    expect(a.trainingDocId).toBe('t-ambig');
    expect(a.candidates.map((c) => c.id)).toEqual(['kf-chris-a', 'kf-chris-b']);
    // The labels have to tell the two apart, or the list cannot be acted on.
    expect(a.candidates[0].label).toContain('chris@a.test');
    expect(a.candidates[1].label).toContain('chris@b.test');
  });

  it('creates ONE record for several notes about the same missing person', () => {
    const p = plan([
      { id: 't1', data: { kinfolkRef: 'Nora Bell' } },
      { id: 't2', data: { kinfolkRef: 'nora  bell' } },
      { id: 't3', data: { kinfolkRef: 'Bell, Nora' } },
    ]);
    expect(p.creations).toHaveLength(1);
    expect(p.creations[0].trainingDocIds).toEqual(['t1', 't2', 't3']);
    expect(p.creations[0].doc._createdFromTribalIntelDocIds).toEqual(['t1', 't2', 't3']);
    // All three rows point at that one new id.
    expect(new Set(p.writes.map((w) => w.targetKinfolkId))).toEqual(new Set([p.creations[0].kinfolkId]));
  });

  it('writes the id to both fields, so the nightly pipeline resolves either way', () => {
    const p = plan([{ id: 't-name', data: { kinfolkRef: 'Jane Halbrook' } }]);
    expect(p.writes[0]).toEqual({
      trainingDocId: 't-name',
      targetKinfolkId: 'kf-jane',
      reason: 'resolved',
      was: 'Jane Halbrook',
    });
  });
});

describe('reportLines (the dry run an operator decides from)', () => {
  const p = plan([
    { id: 't-name', data: { kinfolkRef: 'Jane Halbrook' } },
    { id: 't-new', data: { kinfolkRef: 'Nora Bell' } },
    { id: 't-ambig', data: { kinfolkRef: 'Chris Doyle' } },
    { id: 't-dead', data: { kinfolkRef: 'Xk92mZq0aB4cD7eF1gH3' } },
  ]);
  const text = reportLines(p, 'dry-run').join('\n');

  it('says it is a dry run and gives every count', () => {
    expect(text).toContain('DRY RUN');
    expect(text).toContain('training_documents scanned    : 4');
    expect(text).toContain('AMBIGUOUS, left untouched     : 1');
    expect(text).toContain('rows a human must decide      : 2');
  });

  it('lists the ambiguous row with both candidates, and says nothing was written', () => {
    expect(text).toContain('training_documents/t-ambig  "Chris Doyle" matches 2');
    expect(text).toContain('kf-chris-a');
    expect(text).toContain('kf-chris-b');
    expect(text).toMatch(/AMBIGUOUS[\s\S]*NOT written/);
  });

  it('prints the whole document it would create, and warns about duplicates', () => {
    expect(text).toContain('from "Nora Bell"');
    expect(text).toContain('"displayName":"Nora Bell"');
    expect(text).toContain('DUPLICATE person');
  });

  it('lists the dangling id separately from the names it can create', () => {
    expect(text).toMatch(/DANGLING IDS[\s\S]*t-dead/);
  });
});

describe('parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs([]).mode).toBe('dry-run');
  });

  it('applies only under --allow-prod', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });

  it('lets --dry-run win in either flag order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('refuses a --project that swallowed the next flag', () => {
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/--project requires a value/);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--yolo'])).toThrow(/unknown arg/);
  });
});
