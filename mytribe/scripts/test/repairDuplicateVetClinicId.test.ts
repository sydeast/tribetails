import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DUPLICATED_KEY, describeTarget, parseArgs, planRepair, reportLines, resolveTarget, type Args, type Report } from '../repairDuplicateVetClinicId';

const defaults: Args = { projectId: null, allowProd: false, apply: false, samples: 50 };

const row = (key: string, value: string, label = key) => ({ key, label, value });

describe('parseArgs', () => {
  it('is a dry run against no named project by default', () => {
    expect(parseArgs([])).toEqual(defaults);
  });

  it('reads --project, --allow-prod, --apply and --samples', () => {
    expect(parseArgs(['--project', 'auntieos-ttpc', '--allow-prod', '--apply', '--samples', '5'])).toEqual({
      projectId: 'auntieos-ttpc',
      allowProd: true,
      apply: true,
      samples: 5,
    });
  });

  it('--dry-run beats --apply whichever order they come in', () => {
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--dry-run', '--apply']).apply).toBe(true);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--write'])).toThrow(/unknown arg: --write/);
  });

  it('refuses --samples without a number', () => {
    expect(() => parseArgs(['--samples', 'lots'])).toThrow(/whole number/);
  });
});

describe('resolveTarget', () => {
  it('refuses --allow-prod under the emulator: the flag and the environment disagree', () => {
    expect(() => resolveTarget({ ...defaults, allowProd: true }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(
      /--allow-prod refused.*FIRESTORE_EMULATOR_HOST is set/s,
    );
  });

  it('refuses a production run that did not say --allow-prod', () => {
    expect(() => resolveTarget(defaults, {})).toThrow(/would reach PRODUCTION/);
  });

  it('runs against the emulator with no --allow-prod', () => {
    expect(resolveTarget(defaults, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8080',
      projectId: null,
    });
  });

  it('runs against production with --allow-prod and no emulator', () => {
    expect(resolveTarget({ ...defaults, allowProd: true, projectId: 'p' }, {})).toEqual({ kind: 'production', projectId: 'p' });
  });

  it('--apply does not make an emulator run a production one', () => {
    expect(resolveTarget({ ...defaults, apply: true }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }).kind).toBe('emulator');
  });
});

describe('describeTarget: the target is printed before anything is read', () => {
  it('names the emulator and the dry run', () => {
    expect(describeTarget({ ...defaults, projectId: 'p' }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toBe(
      'EMULATOR at 127.0.0.1:8080, project p - DRY RUN (writes nothing)',
    );
  });

  it('names production and the write', () => {
    expect(describeTarget({ ...defaults, allowProd: true, apply: true, projectId: 'p' }, {})).toBe(
      'PRODUCTION Firestore, project p - APPLY (writes)',
    );
  });
});

describe('planRepair', () => {
  const OFFICE = row('gateNote', 'Side gate sticks', 'Set by Auntie');
  const ALLERGY = row('allergy', 'Chicken', 'Allergies');

  it('plans nothing when the key is stored once', () => {
    expect(planRepair([OFFICE, row(DUPLICATED_KEY, 'c1'), ALLERGY])).toMatchObject({ customFields: null, copies: 1 });
  });

  it('plans nothing when the key is not stored at all, or the field is missing', () => {
    expect(planRepair([OFFICE]).customFields).toBeNull();
    expect(planRepair(undefined).customFields).toBeNull();
    expect(planRepair('not a list').customFields).toBeNull();
  });

  it('keeps the NEWEST copy, which is the last one: each duplicating save appended', () => {
    const plan = planRepair([OFFICE, row(DUPLICATED_KEY, 'old-clinic'), ALLERGY, row(DUPLICATED_KEY, 'current-clinic')]);
    expect(plan.kept).toBe('current-clinic');
    expect(plan.dropped).toEqual(['old-clinic']);
    expect(plan.customFields).toEqual([OFFICE, row(DUPLICATED_KEY, 'current-clinic'), ALLERGY]);
  });

  it('keeps every other row, value and position', () => {
    const plan = planRepair([row(DUPLICATED_KEY, 'c1'), OFFICE, row(DUPLICATED_KEY, 'c1'), ALLERGY]);
    expect(plan.customFields).toEqual([row(DUPLICATED_KEY, 'c1'), OFFICE, ALLERGY]);
  });

  it('folds a household that pressed Save many times', () => {
    const many = Array.from({ length: 12 }, (_, i) => row(DUPLICATED_KEY, `c${i}`));
    const plan = planRepair([OFFICE, ...many]);
    expect(plan.copies).toBe(12);
    expect(plan.kept).toBe('c11');
    expect(plan.customFields).toEqual([OFFICE, row(DUPLICATED_KEY, 'c11')]);
  });

  it('carries an entry it cannot read through verbatim rather than deleting it', () => {
    const junk = { notAKey: 1 };
    const plan = planRepair([junk, row(DUPLICATED_KEY, 'a'), 'a bare string', row(DUPLICATED_KEY, 'b')]);
    expect(plan.customFields).toEqual([junk, row(DUPLICATED_KEY, 'b'), 'a bare string']);
  });

  it('is idempotent: the repaired list plans nothing on a second run', () => {
    const first = planRepair([OFFICE, row(DUPLICATED_KEY, 'a'), row(DUPLICATED_KEY, 'b')]);
    expect(planRepair(first.customFields).customFields).toBeNull();
  });
});

describe('reportLines', () => {
  const report: Report = {
    scanned: 4,
    findings: [
      { kinfolkId: 'fam1', path: 'families/fam1', copies: 3, kept: 'c3', dropped: ['c1', 'c2'], rowsBefore: 5, rowsAfter: 3 },
      { kinfolkId: 'fam2', path: 'families/fam2', copies: 2, kept: 'c9', dropped: ['c9'], rowsBefore: 3, rowsAfter: 2 },
    ],
  };

  it('counts the rows it would remove and the households whose copies disagree', () => {
    const text = reportLines(report, 50, null).join('\n');
    expect(text).toContain('Scanned 4 household(s). 2 hold more than one vetClinicId row.');
    expect(text).toContain('Rows that would be removed: 3.');
    expect(text).toContain('Households whose copies disagree (the newest is not what the older ones say): 1.');
  });

  it('says plainly that a dry run wrote nothing', () => {
    expect(reportLines(report, 50, null).join('\n')).toContain('DRY RUN: nothing was written.');
  });

  it('says how many were updated, and that the timestamps were left alone', () => {
    expect(reportLines(report, 50, 2).join('\n')).toContain('APPLIED: 2 household(s) updated. updatedAt was NOT changed.');
  });
});

/**
 * #901: a repaired household keeps its ORIGINAL timestamps. A cleanup that
 * stamps today's date over them makes every later "when did this household last
 * change something" answer wrong. Asserted against the source, because a
 * serverTimestamp slipped into the update is invisible to a plan-level test.
 */
describe('the write touches customFields and nothing else', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'repairDuplicateVetClinicId.ts'), 'utf8');

  it('never writes updatedAt, a serverTimestamp or a repair stamp', () => {
    expect(source).not.toMatch(/serverTimestamp/);
    expect(source).not.toMatch(/FieldValue/);
    expect(source).not.toMatch(/batch\.set\(/);
    expect(source).not.toMatch(/\.set\(\s*db\.doc/);
  });

  it('updates with exactly the one key', () => {
    expect(source).toContain('batch.update(db.doc(w.path), { customFields: w.customFields })');
  });
});
