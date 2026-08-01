import { describe, it, expect } from 'vitest';
import { resolveHouseholdVet, hasVet, BLANK_VET } from './householdVet';
import { type VetClinic } from '../api/vetClinics';

const RIVERSIDE: VetClinic = {
  _id: 'c1',
  name: 'Riverside Animal Hospital',
  phone: '(512) 555 0100',
  address: '418 Mill St',
  hours: 'Mon to Fri 8a to 6p',
};
const ER: VetClinic = {
  _id: 'er1',
  name: 'Austin Pet ER',
  phone: '(512) 555 0300',
  address: '4 Night Ln',
  hours: '24 hours',
  isEmergency: true,
};
const CATALOG = [RIVERSIDE, ER];

describe('a linked household resolves through the clinic', () => {
  it('reads name, phone and address from the catalog row', () => {
    const { primary } = resolveHouseholdVet({ primaryVetClinicId: 'c1' }, CATALOG);
    expect(primary).toMatchObject({
      name: 'Riverside Animal Hospital',
      phone: '(512) 555 0100',
      address: '418 Mill St',
      linked: true,
    });
  });

  it('reads HOURS from the clinic, not from the household', () => {
    // Hours belong to the practice. A linked household must never read the
    // legacy per-household copy, or one household's stale note would win.
    const { primary } = resolveHouseholdVet(
      { primaryVetClinicId: 'c1', primaryVetHours: 'STALE, do not use' },
      CATALOG,
    );
    expect(primary.hours).toBe('Mon to Fri 8a to 6p');
  });

  it('IGNORES legacy free text entirely when linked', () => {
    // The whole point: one copy. A stale name on the household must not shadow
    // the catalog, or correcting the clinic would appear to do nothing.
    const { primary } = resolveHouseholdVet(
      { primaryVetClinicId: 'c1', primaryVetName: 'Some Old Clinic', primaryVetPhone: '999' },
      CATALOG,
    );
    expect(primary.name).toBe('Riverside Animal Hospital');
    expect(primary.phone).toBe('(512) 555 0100');
  });

  it('sees a correction to the clinic with no household write at all', () => {
    const corrected = [{ ...RIVERSIDE, phone: '(512) 555 0199' }];
    const { primary } = resolveHouseholdVet({ primaryVetClinicId: 'c1' }, corrected);
    expect(primary.phone).toBe('(512) 555 0199');
  });

  it('flags a linked clinic that has been retired', () => {
    const { primary } = resolveHouseholdVet({ primaryVetClinicId: 'c1' }, [
      { ...RIVERSIDE, archived: true },
    ]);
    expect(primary.archived).toBe(true);
    expect(primary.name).toBe('Riverside Animal Hospital');
  });
});

describe('the emergency vet stays a distinct practice', () => {
  it('resolves separately from the primary', () => {
    const vet = resolveHouseholdVet(
      { primaryVetClinicId: 'c1', emergencyVetClinicId: 'er1' },
      CATALOG,
    );
    expect(vet.primary.name).toBe('Riverside Animal Hospital');
    expect(vet.emergency.name).toBe('Austin Pet ER');
    expect(vet.emergency.hours).toBe('24 hours');
  });

  it('can be set with no primary at all', () => {
    const vet = resolveHouseholdVet({ emergencyVetClinicId: 'er1' }, CATALOG);
    expect(hasVet(vet.primary)).toBe(false);
    expect(vet.emergency.name).toBe('Austin Pet ER');
  });

  it('never folds the primary into the emergency slot', () => {
    const vet = resolveHouseholdVet({ primaryVetClinicId: 'c1' }, CATALOG);
    expect(hasVet(vet.emergency)).toBe(false);
  });
});

describe('an unlinked household still shows what is on file', () => {
  it('falls back to the legacy free text', () => {
    const { primary } = resolveHouseholdVet(
      {
        primaryVetName: 'Barton Creek Animal Hospital',
        primaryVetPhone: '(512) 555 0134',
        primaryVetAddress: '1000 Barton Creek Blvd',
        primaryVetHours: 'Mon to Fri 9a to 5p',
      },
      CATALOG,
    );
    expect(primary).toMatchObject({
      name: 'Barton Creek Animal Hospital',
      phone: '(512) 555 0134',
      hours: 'Mon to Fri 9a to 5p',
      linked: false,
    });
  });

  it('is marked unlinked, so a screen can say a correction cannot reach it', () => {
    const { primary } = resolveHouseholdVet({ primaryVetName: 'Somewhere' }, CATALOG);
    expect(primary.linked).toBe(false);
  });

  it('trims what it shows', () => {
    const { primary } = resolveHouseholdVet({ primaryVetName: '  Somewhere  ' }, CATALOG);
    expect(primary.name).toBe('Somewhere');
  });
});

describe('a dangling link fails loud', () => {
  it('reports dangling rather than silently using stale legacy text', () => {
    // Falling back here would hide a broken link behind old data, which is
    // exactly how a wrong number survives a migration.
    const { primary } = resolveHouseholdVet(
      { primaryVetClinicId: 'gone', primaryVetName: 'Stale Clinic', primaryVetPhone: '999' },
      CATALOG,
    );
    expect(primary.dangling).toBe(true);
    expect(primary.name).toBe('');
    expect(primary.phone).toBe('');
  });

  it('treats an unresolved id as dangling while the catalog is empty', () => {
    const { primary } = resolveHouseholdVet({ primaryVetClinicId: 'c1' }, []);
    expect(primary.dangling).toBe(true);
  });
});

describe('edges', () => {
  it('resolves a null household to blanks', () => {
    expect(resolveHouseholdVet(null, CATALOG)).toEqual({
      primary: BLANK_VET,
      emergency: BLANK_VET,
    });
  });

  it('resolves an empty household to blanks', () => {
    const vet = resolveHouseholdVet({}, CATALOG);
    expect(hasVet(vet.primary)).toBe(false);
    expect(hasVet(vet.emergency)).toBe(false);
  });

  it('treats a whitespace-only clinic id as unlinked', () => {
    const { primary } = resolveHouseholdVet(
      { primaryVetClinicId: '   ', primaryVetName: 'On File' },
      CATALOG,
    );
    expect(primary.linked).toBe(false);
    expect(primary.name).toBe('On File');
  });

  it('hasVet is true on a phone alone, since that is the number that matters', () => {
    expect(hasVet({ ...BLANK_VET, phone: '(512) 555 0100' })).toBe(true);
  });
});
