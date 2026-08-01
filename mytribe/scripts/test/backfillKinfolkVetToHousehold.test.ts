import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planVetMigration,
  RETIRED_KINFOLK_VET_FIELDS,
} from '../backfillKinfolkVetToHousehold';
/**
 * The pure planner. The DELETE itself is proven against a real emulator
 * document in `backfillKinfolkVetToHousehold.emulator.test.ts`, because
 * `SetOptions.merge()` semantics are exactly the thing that cannot be
 * established by reasoning about a fixture.
 */
describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('applies only with an explicit --allow-prod', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });
  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArgs(['--wipe'])).toThrow(/unknown arg/);
  });
});
describe('carrying the catalog link across', () => {
  it('moves the clinic id onto the household', () => {
    const plan = planVetMigration('kf1', { vetClinicId: 'clinic_a' }, {});
    expect(plan.householdUpdate).toEqual({ primaryVetClinicId: 'clinic_a' });
  });
  it('moves the emergency clinic id into its own slot', () => {
    const plan = planVetMigration('kf1', { emergencyVetClinicId: 'clinic_er' }, {});
    expect(plan.householdUpdate).toEqual({ emergencyVetClinicId: 'clinic_er' });
  });
  it('keeps the emergency vet a DISTINCT clinic from the primary', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicId: 'clinic_a', emergencyVetClinicId: 'clinic_er' },
      {},
    );
    expect(plan.householdUpdate).toEqual({
      primaryVetClinicId: 'clinic_a',
      emergencyVetClinicId: 'clinic_er',
    });
  });
  it('never overwrites a household that already chose a vet', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicId: 'clinic_a' },
      { primaryVetClinicId: 'clinic_b' },
    );
    expect(plan.householdUpdate).toEqual({});
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      field: 'primaryVetClinicId',
      householdValue: 'clinic_b',
      kinfolkValue: 'clinic_a',
    });
  });
  it('is not a conflict when both sides already agree', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicId: 'clinic_a' },
      { primaryVetClinicId: 'clinic_a' },
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.householdUpdate).toEqual({});
  });
});
describe('an unlinked kinfolk vet carries its strings, never a guessed id', () => {
  it('moves the free text when there is no clinic id', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicName: 'Barton Creek', vetClinicPhone: '(512) 555 0134' },
      {},
    );
    expect(plan.householdUpdate).toEqual({
      primaryVetName: 'Barton Creek',
      primaryVetPhone: '(512) 555 0134',
    });
  });
  it('NEVER invents a clinic id from a name', () => {
    // A wrong id would enrol the household in another clinic's record and show
    // a different practice's phone number. Worse than no id.
    const plan = planVetMigration('kf1', { vetClinicName: 'Barton Creek' }, {});
    expect(Object.keys(plan.householdUpdate).some((k) => k.endsWith('ClinicId'))).toBe(false);
  });
  it('defers to a household that is already linked', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicName: 'Old Text' },
      { primaryVetClinicId: 'clinic_b' },
    );
    expect(plan.householdUpdate).toEqual({});
  });
  it('reports a free-text disagreement rather than resolving it', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicPhone: '(512) 555 9999' },
      { primaryVetPhone: '(512) 555 0100' },
    );
    expect(plan.householdUpdate).toEqual({});
    expect(plan.conflicts).toHaveLength(1);
  });
  it('treats a case-only difference as agreement', () => {
    const plan = planVetMigration(
      'kf1',
      { vetClinicName: 'BARTON CREEK' },
      { primaryVetName: 'Barton Creek' },
    );
    expect(plan.conflicts).toEqual([]);
  });
});
describe('clearing the retired kinfolk fields', () => {
  it('flags a doc carrying any retired field', () => {
    expect(planVetMigration('kf1', { vetClinicName: 'X' }, {}).clearKinfolk).toBe(true);
  });
  it('flags a doc whose retired field is merely EMPTY, not absent', () => {
    // An empty string is still a stored field, and still a second copy.
    expect(planVetMigration('kf1', { vetClinicId: '' }, {}).clearKinfolk).toBe(true);
  });
  it('does not flag a doc that never had one', () => {
    expect(planVetMigration('kf1', { firstName: 'Sam' }, {}).clearKinfolk).toBe(false);
  });
  it('retires all eight fields, so no partial copy survives', () => {
    expect(RETIRED_KINFOLK_VET_FIELDS).toHaveLength(8);
    expect(RETIRED_KINFOLK_VET_FIELDS).toContain('vetClinicId');
    expect(RETIRED_KINFOLK_VET_FIELDS).toContain('emergencyVetClinicAddress');
  });
});
describe('hours', () => {
  it('reports household hours for curation instead of writing them', () => {
    const plan = planVetMigration('kf1', {}, { primaryVetHours: 'Mon to Fri 8a to 6p' });
    expect(plan.hoursToCurate).toBe('Mon to Fri 8a to 6p');
    expect(plan.householdUpdate).toEqual({});
  });
  it('never maps hours onto a household field', () => {
    const plan = planVetMigration('kf1', { vetClinicId: 'c1' }, { primaryVetHours: 'x' });
    expect(Object.keys(plan.householdUpdate)).not.toContain('primaryVetHours');
  });
});
describe('idempotence', () => {
  it('plans nothing on a second run', () => {
    const kinfolk = { vetClinicId: 'clinic_a' };
    const first = planVetMigration('kf1', kinfolk, {});
    // After applying: the household is linked and the kinfolk fields are gone.
    const second = planVetMigration('kf1', {}, { ...first.householdUpdate });
    expect(second.householdUpdate).toEqual({});
    expect(second.clearKinfolk).toBe(false);
    expect(second.conflicts).toEqual([]);
  });
});
