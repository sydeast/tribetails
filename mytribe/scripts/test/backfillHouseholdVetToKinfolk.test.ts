import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planVetMigration,
  VET_FIELD_MAP,
} from '../backfillHouseholdVetToKinfolk';

/**
 * Punchlist A2's migration. The rules worth pinning are the ones that decide
 * whether a household ends up dialling the right number: never overwrite the
 * canonical record, never invent a catalog id, never silently resolve a
 * disagreement, and never let one household's hours become every household's.
 */

const LINKED = {
  vetClinicId: 'clinic_a',
  vetClinicName: 'Riverside Animal Hospital',
  vetClinicPhone: '(512) 555 0100',
  vetClinicAddress: '418 Mill St',
};

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });

  it('applies only with an explicit --allow-prod', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });

  it('takes a project override', () => {
    expect(parseArgs(['--project', 'p1']).projectId).toBe('p1');
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArgs(['--wipe'])).toThrow(/unknown arg/);
  });

  it('rejects --project with no value', () => {
    expect(() => parseArgs(['--project'])).toThrow(/requires a value/);
  });
});

describe('planVetMigration: the gap case', () => {
  it('fills a blank kinfolk vet from the household free text', () => {
    const plan = planVetMigration(
      'kf1',
      {},
      { primaryVetName: 'Barton Creek Animal Hospital', primaryVetPhone: '(512) 555 0134' },
    );
    expect(plan.update).toEqual({
      vetClinicName: 'Barton Creek Animal Hospital',
      vetClinicPhone: '(512) 555 0134',
    });
    expect(plan.conflicts).toEqual([]);
  });

  it('fills the emergency slot from the emergency free text', () => {
    const plan = planVetMigration('kf1', {}, { emergencyVetName: 'Austin Pet ER' });
    expect(plan.update).toEqual({ emergencyVetClinicName: 'Austin Pet ER' });
  });

  it('trims what it migrates', () => {
    const plan = planVetMigration('kf1', {}, { primaryVetName: '  Barton Creek  ' });
    expect(plan.update['vetClinicName']).toBe('Barton Creek');
  });

  it('ignores a blank free-text field rather than writing an empty string', () => {
    const plan = planVetMigration('kf1', {}, { primaryVetName: '   ', primaryVetPhone: '' });
    expect(plan.update).toEqual({});
  });

  it('plans nothing for a household with no household_data doc at all', () => {
    const plan = planVetMigration('kf1', LINKED, null);
    expect(plan.update).toEqual({});
    expect(plan.conflicts).toEqual([]);
    expect(plan.hoursToCurate).toBeNull();
  });
});

describe('planVetMigration: never overwrite the canonical record', () => {
  it('leaves a populated kinfolk field alone', () => {
    const plan = planVetMigration('kf1', LINKED, { primaryVetName: 'Some Older Clinic' });
    expect(plan.update).toEqual({});
  });

  it('reports the disagreement as a conflict rather than resolving it', () => {
    const plan = planVetMigration('kf1', LINKED, { primaryVetPhone: '(512) 555 9999' });
    expect(plan.conflicts).toEqual([
      {
        kinfolkId: 'kf1',
        field: 'vetClinicPhone',
        kinfolkValue: '(512) 555 0100',
        householdValue: '(512) 555 9999',
      },
    ]);
  });

  it('is not a conflict when the two stores already agree', () => {
    const plan = planVetMigration('kf1', LINKED, { primaryVetPhone: '(512) 555 0100' });
    expect(plan.conflicts).toEqual([]);
    expect(plan.update).toEqual({});
  });

  it('treats a case-only difference as agreement, not a conflict', () => {
    const plan = planVetMigration('kf1', LINKED, {
      primaryVetName: 'RIVERSIDE ANIMAL HOSPITAL',
    });
    expect(plan.conflicts).toEqual([]);
  });

  it('can fill one field and conflict on another in the same household', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicName: 'Riverside Animal Hospital' },
      { primaryVetName: 'Elsewhere Vets', primaryVetPhone: '(512) 555 0134' },
    );
    expect(plan.update).toEqual({ vetClinicPhone: '(512) 555 0134' });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.field).toBe('vetClinicName');
  });
});

describe('planVetMigration: never invent a clinic id', () => {
  it('writes no vetClinicId, so a migrated household stays honestly unlinked', () => {
    // A guessed id would enrol the household in ANOTHER clinic's fan-out and
    // rewrite its vet with a different practice's details. Worse than no id.
    const plan = planVetMigration('kf1', {}, { primaryVetName: 'Barton Creek' });
    expect(Object.keys(plan.update).some((k) => k.endsWith('Id'))).toBe(false);
  });

  it('writes no emergencyVetClinicId either', () => {
    const plan = planVetMigration('kf1', {}, { emergencyVetName: 'Austin Pet ER' });
    expect(plan.update['emergencyVetClinicId']).toBeUndefined();
  });
});

describe('planVetMigration: hours belong to the clinic', () => {
  it('reports primaryVetHours for curation instead of writing it', () => {
    const plan = planVetMigration('kf1', {}, { primaryVetHours: 'Mon to Fri 8a to 6p' });
    expect(plan.hoursToCurate).toBe('Mon to Fri 8a to 6p');
    // Never lands on the household record: there is no field for it, by design.
    expect(plan.update).toEqual({});
  });

  it('reports nothing when there are no hours on file', () => {
    expect(planVetMigration('kf1', {}, { primaryVetName: 'X' }).hoursToCurate).toBeNull();
  });

  it('never maps hours onto any kinfolk field', () => {
    expect(VET_FIELD_MAP.some(([from]) => from === 'primaryVetHours')).toBe(false);
  });
});

describe('planVetMigration: idempotence', () => {
  it('plans nothing on a second run, because the gap is now filled', () => {
    const household = { primaryVetName: 'Barton Creek', primaryVetPhone: '(512) 555 0134' };
    const first = planVetMigration('kf1', {}, household);
    // Apply the first plan, then re-plan against the result.
    const second = planVetMigration('kf1', { ...first.update }, household);
    expect(second.update).toEqual({});
    expect(second.conflicts).toEqual([]);
  });
});

describe('the field map', () => {
  it('carries exactly the six migrated fields', () => {
    expect(VET_FIELD_MAP).toHaveLength(6);
  });

  it('maps primary to the regular slot and emergency to the emergency slot', () => {
    const map = Object.fromEntries(VET_FIELD_MAP);
    expect(map['primaryVetName']).toBe('vetClinicName');
    expect(map['emergencyVetName']).toBe('emergencyVetClinicName');
  });

  it('keeps the emergency vet a DISTINCT clinic, never folded into the primary', () => {
    const targets = VET_FIELD_MAP.map(([, to]) => to);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
