import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  isFamilyKinPath,
  staffKeysPresent,
  compareWithFlat,
} from '../stripFamilyKinStaffFields';
/** The #1335 strip's pure rules, pinned against fixtures with no Firestore. */
describe('stripFamilyKinStaffFields: parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('--allow-prod applies', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });
  it('--dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('--project takes a value and refuses a flag as one', () => {
    expect(parseArgs(['--project', 'p1']).projectId).toBe('p1');
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow('--project requires a value');
  });
  it('refuses an unknown arg', () => {
    expect(() => parseArgs(['--apply'])).toThrow('unknown arg');
  });
});
describe('stripFamilyKinStaffFields: only family kin docs are planned', () => {
  it('accepts families/{fid}/kin/{kinId}', () => {
    expect(isFamilyKinPath('families/f1/kin/k1')).toBe(true);
  });
  it('rejects the flat collection and anything deeper or elsewhere', () => {
    expect(isFamilyKinPath('kin/flat1')).toBe(false);
    expect(isFamilyKinPath('families/f1/kin/k1/photos/p1')).toBe(false);
    expect(isFamilyKinPath('families/f1/pets/k1')).toBe(false);
    expect(isFamilyKinPath('other/f1/kin/k1')).toBe(false);
  });
});
describe('stripFamilyKinStaffFields: staffKeysPresent', () => {
  it('finds every staff-only key present, null-valued included, and nothing else', () => {
    expect(
      staffKeysPresent({
        name: 'Kai',
        sex: 'Male',
        vetInfo: 'Riverside',
        status: 'active',
        legacyKinId: 'flat1',
        officeNotes: 'bites',
        reactive: false,
        routine: null,
        tags: [],
      }),
    ).toEqual(['officeNotes', 'reactive', 'routine', 'tags']);
  });
  it('returns nothing for a clean doc', () => {
    expect(staffKeysPresent({ name: 'Kai', sex: 'Male', weight: '50 lbs' })).toEqual([]);
  });
});
describe('stripFamilyKinStaffFields: compareWithFlat', () => {
  it('same when the flat doc holds the same value, arrays included', () => {
    expect(compareWithFlat('tags', { tags: ['A'] }, { tags: ['A'] })).toBe('same');
  });
  it('same when the family side holds nothing to lose', () => {
    expect(compareWithFlat('routine', { routine: null }, {})).toBe('same');
  });
  it('flags a missing flat doc, a missing flat field and a differing value', () => {
    expect(compareWithFlat('officeNotes', { officeNotes: 'x' }, null)).toBe('no-flat-doc');
    expect(compareWithFlat('officeNotes', { officeNotes: 'x' }, {})).toBe('flat-missing-field');
    expect(compareWithFlat('officeNotes', { officeNotes: 'x' }, { officeNotes: 'y' })).toBe('flat-differs');
  });
});
