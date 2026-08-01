import { describe, it, expect } from 'vitest';
import {
  clinicUsage,
  clinicMatchesQuery,
  filterClinics,
  pendingClinics,
  activeClinics,
  archivedClinics,
  draftFromClinic,
  draftChanged,
  canSaveDraft,
  draftNameCollides,
  clinicMonogram,
  normClinicName,
  type VetLinkedHousehold,
} from './vetClinicManager';
import { type VetClinic } from '../api/vetClinics';

function clinic(over: Partial<VetClinic> & { _id: string }): VetClinic {
  return { name: 'Riverside Animal Hospital', ...over };
}

const RIVERSIDE = clinic({ _id: 'c1' });

describe('clinicUsage', () => {
  function kf(over: Partial<VetLinkedHousehold> & { _id: string }): VetLinkedHousehold {
    return over;
  }

  it('counts a household linked by the regular slot (on household_data)', () => {
    expect(clinicUsage(RIVERSIDE, [kf({ _id: 'k1', primaryVetClinicId: 'c1' })])).toEqual({
      linked: 1,
      unlinked: 0,
    });
  });

  it('counts a household linked by the emergency slot', () => {
    expect(clinicUsage(RIVERSIDE, [kf({ _id: 'k1', emergencyVetClinicId: 'c1' })])).toEqual({
      linked: 1,
      unlinked: 0,
    });
  });

  it('counts a household using both slots exactly once', () => {
    const both = kf({ _id: 'k1', primaryVetClinicId: 'c1', emergencyVetClinicId: 'c1' });
    expect(clinicUsage(RIVERSIDE, [both]).linked).toBe(1);
  });

  it('ignores a household on a different clinic', () => {
    expect(clinicUsage(RIVERSIDE, [kf({ _id: 'k1', primaryVetClinicId: 'other' })])).toEqual({
      linked: 0,
      unlinked: 0,
    });
  });

  it('counts a legacy name-only household as UNLINKED, not linked', () => {
    // The distinction the whole split exists for: a correction cannot reach it.
    const legacy = kf({ _id: 'k1', primaryVetClinicId: '', primaryVetName: 'Riverside Animal Hospital' });
    expect(clinicUsage(RIVERSIDE, [legacy])).toEqual({ linked: 0, unlinked: 1 });
  });

  it('matches a legacy household case and space insensitively', () => {
    const legacy = kf({ _id: 'k1', primaryVetName: 'riverside   ANIMAL hospital' });
    expect(clinicUsage(RIVERSIDE, [legacy]).unlinked).toBe(1);
  });

  it('does NOT count a name match when the household is linked elsewhere', () => {
    // A household pointing at a different id that happens to share a name is
    // not this clinic's household.
    const other = kf({
      _id: 'k1',
      primaryVetClinicId: 'c2',
      primaryVetName: 'Riverside Animal Hospital',
    });
    expect(clinicUsage(RIVERSIDE, [other])).toEqual({ linked: 0, unlinked: 0 });
  });

  it('never name-matches a clinic with a blank name', () => {
    const blank = clinic({ _id: 'c9', name: '' });
    expect(clinicUsage(blank, [kf({ _id: 'k1', primaryVetName: '' })]).unlinked).toBe(0);
  });

  it('counts nothing against an empty household list', () => {
    expect(clinicUsage(RIVERSIDE, [])).toEqual({ linked: 0, unlinked: 0 });
  });
});

describe('search', () => {
  const all = [
    clinic({ _id: 'a', name: 'Riverside Animal Hospital', phone: '(512) 744-4644', address: '3675 Gattis School Rd' }),
    clinic({ _id: 'b', name: 'The Mill Vet', phone: '(512) 555-0200', address: '9 Oak Rd' }),
  ];

  it('matches everything on a blank query', () => {
    expect(filterClinics(all, '')).toHaveLength(2);
    expect(filterClinics(all, '   ')).toHaveLength(2);
  });

  it('matches on name, case insensitively', () => {
    expect(filterClinics(all, 'riverside').map((c) => c._id)).toEqual(['a']);
  });

  it('matches on phone', () => {
    expect(filterClinics(all, '744-4644').map((c) => c._id)).toEqual(['a']);
  });

  it('matches on address', () => {
    expect(filterClinics(all, 'gattis').map((c) => c._id)).toEqual(['a']);
  });

  it('returns nothing on no match', () => {
    expect(filterClinics(all, 'zzznotfound')).toEqual([]);
  });

  it('tolerates a clinic missing every searchable field', () => {
    expect(clinicMatchesQuery(clinic({ _id: 'x', name: undefined }), 'q')).toBe(false);
  });
});

describe('buckets', () => {
  const approved = clinic({ _id: 'a', verified: true });
  const legacy = clinic({ _id: 'l' }); // no verified field: approved
  const pending = clinic({ _id: 'p', verified: false });
  const retired = clinic({ _id: 'r', archived: true });
  const retiredPending = clinic({ _id: 'rp', verified: false, archived: true });
  const all = [approved, legacy, pending, retired, retiredPending];

  it('treats a missing verified flag as approved', () => {
    expect(activeClinics(all).map((c) => c._id)).toEqual(['a', 'l']);
  });

  it('lists only live pending submissions', () => {
    expect(pendingClinics(all).map((c) => c._id)).toEqual(['p']);
  });

  it('keeps a rejected submission out of the pending queue', () => {
    // Rejecting is archiving, so it must not come back as work to do.
    expect(pendingClinics(all).map((c) => c._id)).not.toContain('rp');
  });

  it('lists retired rows separately', () => {
    expect(archivedClinics(all).map((c) => c._id)).toEqual(['r', 'rp']);
  });
});

describe('the draft', () => {
  const stored = clinic({
    _id: 'c1',
    phone: '555',
    address: '1 Ln',
    website: 'https://x.com',
    hours: '8a to 6p',
    notes: 'n',
    isEmergency: false,
  });

  it('seeds from the stored row', () => {
    expect(draftFromClinic(stored)).toEqual({
      name: 'Riverside Animal Hospital',
      phone: '555',
      address: '1 Ln',
      website: 'https://x.com',
      hours: '8a to 6p',
      notes: 'n',
      isEmergency: false,
    });
  });

  it('defaults every absent field on a legacy row', () => {
    expect(draftFromClinic(clinic({ _id: 'x', name: 'Old' }))).toEqual({
      name: 'Old',
      phone: '',
      address: '',
      website: '',
      hours: '',
      notes: '',
      isEmergency: false,
    });
  });

  it('is unchanged against itself', () => {
    expect(draftChanged(stored, draftFromClinic(stored))).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    const d = { ...draftFromClinic(stored), name: '  Riverside Animal Hospital  ' };
    expect(draftChanged(stored, d)).toBe(false);
  });

  it('sees a phone correction', () => {
    expect(draftChanged(stored, { ...draftFromClinic(stored), phone: '556' })).toBe(true);
  });

  it('sees an hours edit', () => {
    expect(draftChanged(stored, { ...draftFromClinic(stored), hours: '9a to 5p' })).toBe(true);
  });

  it('sees the emergency flag flip', () => {
    expect(draftChanged(stored, { ...draftFromClinic(stored), isEmergency: true })).toBe(true);
  });

  it('sees a field being CLEARED, since the save clears it server-side', () => {
    expect(draftChanged(stored, { ...draftFromClinic(stored), address: '' })).toBe(true);
  });

  it('cannot save with no change', () => {
    expect(canSaveDraft(stored, draftFromClinic(stored))).toBe(false);
  });

  it('cannot save with a blank name even when other fields changed', () => {
    expect(canSaveDraft(stored, { ...draftFromClinic(stored), name: '  ', phone: '556' })).toBe(
      false,
    );
  });

  it('can save a real change under a real name', () => {
    expect(canSaveDraft(stored, { ...draftFromClinic(stored), phone: '556' })).toBe(true);
  });
});

describe('draftNameCollides', () => {
  const all = [clinic({ _id: 'c1', name: 'Riverside' }), clinic({ _id: 'c2', name: 'The Mill Vet' })];

  it('flags a rename onto another clinic', () => {
    const d = { ...draftFromClinic(all[0]!), name: 'the  MILL vet' };
    expect(draftNameCollides('c1', d, all)).toBe(true);
  });

  it('does not flag a clinic keeping its own name', () => {
    expect(draftNameCollides('c1', draftFromClinic(all[0]!), all)).toBe(false);
  });

  it('does not flag a case-only rename of itself', () => {
    const d = { ...draftFromClinic(all[0]!), name: 'RIVERSIDE' };
    expect(draftNameCollides('c1', d, all)).toBe(false);
  });

  it('does not flag a blank name (the empty-name guard owns that)', () => {
    expect(draftNameCollides('c1', { ...draftFromClinic(all[0]!), name: '' }, all)).toBe(false);
  });
});

describe('normClinicName', () => {
  it('folds case, collapses whitespace, trims', () => {
    expect(normClinicName('  The  MILL   Vet ')).toBe('the mill vet');
  });
});

describe('clinicMonogram', () => {
  it('takes the initials of the first two words', () => {
    expect(clinicMonogram('Riverside Animal Hospital')).toBe('RA');
  });

  it('takes two letters of a single word', () => {
    expect(clinicMonogram('Riverside')).toBe('RI');
  });

  it('falls back rather than rendering an empty avatar', () => {
    expect(clinicMonogram('   ')).toBe('?');
  });
});
