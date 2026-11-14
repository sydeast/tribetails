import { describe, it, expect, vi } from 'vitest';
import { buildDbMock } from '../../functions/test/_helpers/mockDb';
import {
  DELETE,
  MEDS_MAX,
  applyUpdate,
  isEmptyPlan,
  mergeMedications,
  parseArgs,
  planHouseholdVet,
  planPair,
  run,
} from '../backfillKinSharedFields';

const FLAT = 'kin/flat1';
const FAM = 'families/f1/kin/k1';

describe('backfillKinSharedFields: parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('--allow-prod applies; --dry-run beats it in either order', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('refuses an unknown arg, --apply included', () => {
    expect(() => parseArgs(['--apply'])).toThrow('unknown arg');
  });
});

/** kin-meds ruling 2026-11-12: one field; the office's notes become the household's to read. */
describe('backfillKinSharedFields: medications merge', () => {
  it('joins two different notes, household first, a blank line between', () => {
    expect(mergeMedications('Thyroid tablet', 'Give with food')).toBe('Thyroid tablet\n\nGive with food');
  });
  it('one blank, or both the same: the other is the field', () => {
    expect(mergeMedications('', 'Give with food')).toBe('Give with food');
    expect(mergeMedications(null, 'Give with food')).toBe('Give with food');
    expect(mergeMedications('Thyroid', '')).toBe('Thyroid');
    expect(mergeMedications(' Thyroid ', 'Thyroid')).toBe('Thyroid');
  });
  it('writes the joined text to both copies and deletes the stale flat copy of the household key', () => {
    const p = planPair(FLAT, { medicationHealthNotes: 'Give with food', medications: 'Thyroid' }, FAM, { medications: 'Thyroid' });
    expect(p.familyUpdate.medications).toBe('Thyroid\n\nGive with food');
    expect(p.flatUpdate.medicationHealthNotes).toBe('Thyroid\n\nGive with food');
    expect(p.flatUpdate.medications).toBe(DELETE);
  });
  it('lists a joined text over the portal cap rather than leaving it uneditable unseen', () => {
    const p = planPair(FLAT, { medicationHealthNotes: 'a'.repeat(MEDS_MAX) }, FAM, { medications: 'b' });
    expect(p.notes.map((n) => n.kind)).toContain('meds-over-cap');
  });
});

describe('backfillKinSharedFields: #1908 care facts', () => {
  it('copies the admin care facts to a household copy that has none', () => {
    const flat = { staysAs: 'Crate', routine: 'Walk at 7', trainingCommands: 'Sit', feedingBrand: 'Acme', vaccinations: 'Rabies 2027' };
    const p = planPair(FLAT, flat, FAM, {});
    expect(p.familyUpdate).toMatchObject(flat);
  });
  it('keeps a household value that differs, and lists it', () => {
    const p = planPair(FLAT, { routine: 'Walk at 7' }, FAM, { routine: 'Walk at 8' });
    expect(p.familyUpdate).not.toHaveProperty('routine');
    expect(p.notes).toContainEqual({ path: FAM, kind: 'care-fact-differs', detail: 'routine' });
  });
  it('turns a null text on the admin copy into "" (no admin decoder meets a null)', () => {
    const p = planPair(FLAT, { allergies: null, feedingInstructions: 'x' }, FAM, {});
    expect(p.flatUpdate.allergies).toBe('');
    expect(p.flatUpdate).not.toHaveProperty('feedingInstructions');
  });
  it('never writes a staff-only field to the household copy', () => {
    const p = planPair(FLAT, { officeNotes: 'bites', reactive: true, tags: ['VIP'] }, FAM, {});
    for (const k of ['officeNotes', 'reactive', 'tags', 'medicationHealthNotes']) expect(p.familyUpdate).not.toHaveProperty(k);
  });
});

describe('backfillKinSharedFields: #1907 age', () => {
  it('a portal age reaches a blank admin age as text', () => {
    expect(planPair(FLAT, {}, FAM, { ageYears: 0.5 }).flatUpdate.age).toBe('0.5');
  });
  it('an admin age reaches a blank portal age as a number', () => {
    expect(planPair(FLAT, { age: '4 years' }, FAM, {}).familyUpdate.ageYears).toBe(4);
  });
  it('two ages that disagree are listed, never guessed', () => {
    const p = planPair(FLAT, { age: '4' }, FAM, { ageYears: 5 });
    expect(p.familyUpdate).not.toHaveProperty('ageYears');
    expect(p.flatUpdate).not.toHaveProperty('age');
    expect(p.notes.map((n) => n.kind)).toContain('age-differs');
  });
  it('deletes the stale verbatim ageYears the old mirror left on the admin copy', () => {
    expect(planPair(FLAT, { age: '4', ageYears: 4 }, FAM, { ageYears: 4 }).flatUpdate.ageYears).toBe(DELETE);
  });
});

describe('backfillKinSharedFields: the old free-text vet note', () => {
  it('is counted and listed, never moved', () => {
    const p = planPair(FLAT, { vetInfo: 'Dr A, 555 0100' }, FAM, {});
    expect(p.notes).toContainEqual({ path: FAM, kind: 'legacy-vet-note', detail: 'Dr A, 555 0100' });
    expect(p.familyUpdate).not.toHaveProperty('vetInfo');
    expect(p.flatUpdate).not.toHaveProperty('vetInfo');
  });
});

describe('backfillKinSharedFields: the household vet moves to the one store', () => {
  const row = (v: string) => ({ customFields: [{ key: 'other', label: 'X', value: 'y' }, { key: 'vetClinicId', label: 'Vet Clinic', value: v }] });
  it('a portal pick with no admin vet moves to household_data, created keyed by the household', () => {
    expect(planHouseholdVet('f1', row('c1'), null)).toEqual({
      kinfolkId: 'f1',
      move: { householdDataPath: 'household_data/f1', create: true, clinicId: 'c1' },
      dropRow: true,
      notes: [],
    });
  });
  it('moves into the household_data doc the admin already keeps', () => {
    const p = planHouseholdVet('f1', row('c1'), { path: 'household_data/auto9', data: { kinfolkId: 'f1' } });
    expect(p.move).toEqual({ householdDataPath: 'household_data/auto9', create: false, clinicId: 'c1' });
  });
  it('the same vet on both: only the row goes', () => {
    expect(planHouseholdVet('f1', row('c1'), { path: 'household_data/a', data: { primaryVetClinicId: 'c1' } })).toMatchObject({ move: null, dropRow: true });
  });
  it('two different vets: the admin one stands, the row stays, and it is listed', () => {
    const p = planHouseholdVet('f1', row('c1'), { path: 'household_data/a', data: { primaryVetClinicId: 'c2' } });
    expect(p).toMatchObject({ move: null, dropRow: false });
    expect(p.notes[0].kind).toBe('household-vet-differs');
  });
  it('no row: nothing to do', () => {
    expect(planHouseholdVet('f1', { customFields: [] }, null)).toMatchObject({ move: null, dropRow: false, notes: [] });
  });
});

describe('backfillKinSharedFields: idempotent', () => {
  it('a second plan over the result of the first plans nothing', () => {
    const flat = {
      medicationHealthNotes: 'Give with food',
      medications: 'Thyroid',
      routine: 'Walk at 7',
      allergies: null,
      age: '',
      ageYears: 2,
    };
    const family = { medications: 'Thyroid', ageYears: 2 };
    const first = planPair(FLAT, flat, FAM, family);
    expect(isEmptyPlan(first)).toBe(false);
    const second = planPair(FLAT, applyUpdate(flat, first.flatUpdate), FAM, applyUpdate(family, first.familyUpdate));
    expect(isEmptyPlan(second)).toBe(true);
  });
});

describe('backfillKinSharedFields: run', () => {
  function world() {
    return buildDbMock({
      docs: {
        [FAM]: { name: 'Kai', medications: 'Thyroid' },
        'families/f1': { customFields: [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'c1' }] },
      },
      queryDocs: {
        kin: [
          { id: 'flat1', data: { familyKinPath: FAM, medicationHealthNotes: 'Give with food', routine: 'Walk at 7' } },
          { id: 'flat2', data: { kinfolkId: 'f1', name: 'Office only' } },
        ],
        household_data: [],
        families: [{ id: 'f1', data: { customFields: [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'c1' }] } }],
      },
    });
  }
  it('the dry run writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = world();
    const { plan, ops } = await run(ctx.db as any, 'dry-run');
    log.mockRestore();
    expect(ops).toBe(0);
    expect(ctx.writes).toEqual([]);
    expect(plan.pairs).toHaveLength(1);
    expect(plan.unlinked).toBe(1);
    expect(plan.households.filter((h) => h.move)).toHaveLength(1);
  });
  it('the apply writes the plan, with the echo stamps that keep both triggers still', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ctx = world();
    const { ops } = await run(ctx.db as any, 'apply');
    log.mockRestore();
    expect(ops).toBe(4);
    const fam = ctx.writes.find((w) => w.path === FAM)!;
    expect(fam.data).toMatchObject({ medications: 'Thyroid\n\nGive with food', routine: 'Walk at 7', _mirrorOrigin: 'flat' });
    const flat = ctx.writes.find((w) => w.path === FLAT)!;
    expect(flat.data).toMatchObject({ medicationHealthNotes: 'Thyroid\n\nGive with food', _mirrorOrigin: 'family' });
    expect(ctx.writes.find((w) => w.path === 'household_data/f1')!.data).toMatchObject({ primaryVetClinicId: 'c1', kinfolkId: 'f1' });
    expect(ctx.writes.find((w) => w.path === 'families/f1')!.data.customFields).toEqual([]);
    // The office-only Kin with no link is never written by this script.
    expect(ctx.writes.find((w) => w.path === 'kin/flat2')).toBeUndefined();
  });
});
