import { describe, expect, it } from 'vitest';
import {
  buildKinChanges,
  buildNewKinPayload,
  emptyKinForm,
  hasErrors,
  kinFormFromDto,
  parseAge,
  validateKinForm,
  type KinEditForm,
} from './kinEditForm';
import type { KinDto } from '../api/types';

function kin(overrides: Partial<KinDto> = {}): KinDto {
  return {
    id: 'k1',
    name: 'Buddy',
    species: 'Dog',
    breed: 'Corgi',
    ageYears: 3,
    photoUrl: null,
    status: 'active',
    feedingInstructions: 'Twice a day',
    walkingInstructions: null,
    medications: null,
    allergies: null,
    emergencyNotes: null,
    sitterNotes: null,
    sex: null,
    weight: null,
    colorMarkings: null,
    spayedNeutered: false,
    vetInfo: null,
    staysAs: null,
    routine: null,
    trainingCommands: null,
    feedingBrand: null,
    vaccinations: null,
    ownVetClinicId: '',
    vet: null,
    ...overrides,
  };
}

function formFor(overrides: Partial<KinEditForm> = {}): KinEditForm {
  return { ...kinFormFromDto(kin()), ...overrides };
}

describe('kinFormFromDto', () => {
  it('stringifies age and turns nulls into empty strings', () => {
    const f = kinFormFromDto(kin({ ageYears: 7, breed: null, sitterNotes: null }));
    expect(f.ageYears).toBe('7');
    expect(f.breed).toBe('');
    expect(f.sitterNotes).toBe('');
    expect(f.name).toBe('Buddy');
  });

  it('renders a missing age as an empty string, not "null"', () => {
    expect(kinFormFromDto(kin({ ageYears: null })).ageYears).toBe('');
  });
});

describe('parseAge', () => {
  it('treats blank as an unset (null) age', () => {
    expect(parseAge('')).toBeNull();
    expect(parseAge('   ')).toBeNull();
  });

  it('parses a non-negative number', () => {
    expect(parseAge('0')).toBe(0);
    expect(parseAge('12')).toBe(12);
  });

  it('rejects negatives and non-numbers', () => {
    expect(parseAge('-1')).toBe('invalid');
    expect(parseAge('abc')).toBe('invalid');
    expect(parseAge('3 legs')).toBe('invalid');
  });
});

describe('validateKinForm', () => {
  it('passes a well-formed form', () => {
    expect(hasErrors(validateKinForm(formFor()))).toBe(false);
  });

  it('requires a non-whitespace name', () => {
    expect(validateKinForm(formFor({ name: '' })).name).toBe('Name is required.');
    expect(validateKinForm(formFor({ name: '   ' })).name).toBe('Name is required.');
  });

  it('rejects a name over 80 characters', () => {
    expect(validateKinForm(formFor({ name: 'x'.repeat(81) })).name).toMatch(/80/);
    expect(validateKinForm(formFor({ name: 'x'.repeat(80) })).name).toBeUndefined();
  });

  it('#1291: the text form never carries photoUrl, so a Save can not overwrite an uploaded photo', () => {
    const k = kin({ photoUrl: 'https://res.cloudinary.com/demo/image/upload/v1/old.jpg' });
    const form = kinFormFromDto(k);
    expect(form).not.toHaveProperty('photoUrl');
    // The photo was replaced by an upload since the form was seeded: the
    // cached kin now holds the new URL and the diff still leaves it alone.
    const after = { ...k, photoUrl: 'https://res.cloudinary.com/demo/image/upload/v2/new.jpg' };
    expect(buildKinChanges(after, { ...form, name: 'Buddy 2' })).toEqual({ name: 'Buddy 2' });
    expect(buildNewKinPayload({ ...emptyKinForm(), name: 'Rex' })).not.toHaveProperty('photoUrl');
  });

  it('enforces the species / breed / long-text length caps', () => {
    expect(validateKinForm(formFor({ species: 'x'.repeat(41) })).species).toMatch(/40/);
    expect(validateKinForm(formFor({ breed: 'x'.repeat(81) })).breed).toMatch(/80/);
    expect(validateKinForm(formFor({ feedingInstructions: 'x'.repeat(2001) })).feedingInstructions).toMatch(/2000/);
    expect(validateKinForm(formFor({ emergencyNotes: 'x'.repeat(2000) })).emergencyNotes).toBeUndefined();
  });

  it('rejects an unparsable age', () => {
    expect(validateKinForm(formFor({ ageYears: '-4' })).ageYears).toMatch(/0 to 100/);
    expect(validateKinForm(formFor({ ageYears: '250' })).ageYears).toMatch(/0 to 100/);
    expect(validateKinForm(formFor({ ageYears: '' })).ageYears).toBeUndefined();
  });
});

describe('buildKinChanges', () => {
  it('returns an empty partial when nothing changed', () => {
    expect(buildKinChanges(kin(), formFor())).toEqual({});
  });

  it('includes only the field that changed', () => {
    expect(buildKinChanges(kin(), formFor({ name: 'Rex' }))).toEqual({ name: 'Rex' });
  });

  it('trims values before diffing and sending', () => {
    // Same value with padding is not a change.
    expect(buildKinChanges(kin(), formFor({ name: '  Buddy  ' }))).toEqual({});
    // A genuinely new value is sent trimmed.
    expect(buildKinChanges(kin(), formFor({ breed: '  Beagle  ' }))).toEqual({ breed: 'Beagle' });
  });

  it('clears a field by sending null when its text is emptied', () => {
    expect(buildKinChanges(kin({ feedingInstructions: 'Twice a day' }), formFor({ feedingInstructions: '' }))).toEqual({
      feedingInstructions: null,
    });
  });

  it('parses the age and only sends it when it actually changed', () => {
    expect(buildKinChanges(kin({ ageYears: 3 }), formFor({ ageYears: '5' }))).toEqual({ ageYears: 5 });
    expect(buildKinChanges(kin({ ageYears: 3 }), formFor({ ageYears: '3' }))).toEqual({});
    // Clearing the age sends null.
    expect(buildKinChanges(kin({ ageYears: 3 }), formFor({ ageYears: '' }))).toEqual({ ageYears: null });
  });

  it('leaves the age untouched when the entry is unparsable (validation gates submit)', () => {
    expect(buildKinChanges(kin({ ageYears: 3 }), formFor({ ageYears: 'abc' }))).toEqual({});
  });
});

describe('shared facts (#1310)', () => {
  it('seeds the form from the kin, null becoming empty', () => {
    expect(kinFormFromDto(kin())).toMatchObject({ sex: '', weight: '', colorMarkings: '', spayedNeutered: false });
    expect(
      kinFormFromDto(kin({ sex: 'Female', weight: '52 lbs', colorMarkings: 'Black', spayedNeutered: true })),
    ).toMatchObject({ sex: 'Female', weight: '52 lbs', colorMarkings: 'Black', spayedNeutered: true });
  });
  it('sends only what changed, a cleared text as an empty string (never null), and the flag as a boolean', () => {
    const k = kin({ sex: 'Male', weight: '50 lbs', colorMarkings: 'Black', spayedNeutered: false });
    expect(buildKinChanges(k, formFor({ sex: 'Male', weight: '50 lbs', colorMarkings: 'Black' }))).toEqual({});
    expect(buildKinChanges(k, formFor({ sex: 'Male', weight: '', colorMarkings: 'Black' }))).toEqual({ weight: '' });
    expect(buildKinChanges(k, formFor({ sex: 'Female', weight: '50 lbs', colorMarkings: 'Black', spayedNeutered: true }))).toEqual({
      sex: 'Female',
      spayedNeutered: true,
    });
    expect(buildKinChanges(kin({ spayedNeutered: true }), formFor({ spayedNeutered: false }))).toEqual({ spayedNeutered: false });
  });
  it('treats an unset value and an empty form field as the same (no phantom change)', () => {
    expect(buildKinChanges(kin({ sex: null, weight: null, vetInfo: null }), formFor())).toEqual({});
  });
  it('never sends the old free-text vet note: it is no longer an input (#1908 kin-vet)', () => {
    const k = kin({ vetInfo: 'Dr A' });
    expect(kinFormFromDto(k)).not.toHaveProperty('vetInfo');
    expect(buildKinChanges(k, formFor())).toEqual({});
  });
  it('enforces the server caps', () => {
    expect(validateKinForm(formFor({ sex: 'x'.repeat(41) })).sex).toMatch(/40/);
    expect(validateKinForm(formFor({ weight: 'x'.repeat(41) })).weight).toMatch(/40/);
    expect(validateKinForm(formFor({ colorMarkings: 'x'.repeat(201) })).colorMarkings).toMatch(/200/);
    expect(hasErrors(validateKinForm(formFor({ sex: 'x'.repeat(40), colorMarkings: 'x'.repeat(200) })))).toBe(false);
  });
});
/** #1908 (owner ruling 2026-11-11): the care facts the admin kept, the household's to fill too. */
describe('care facts shared with the admin (#1908)', () => {
  const FIELDS = ['staysAs', 'routine', 'trainingCommands', 'feedingBrand', 'vaccinations'] as const;
  for (const key of FIELDS) {
    it(`${key}: seeds from the Kin, sends a change, clears with '' (never null), and is capped at 2000`, () => {
      expect(kinFormFromDto(kin({ [key]: 'From the office' }))[key]).toBe('From the office');
      expect(kinFormFromDto(kin())[key]).toBe('');
      expect(buildKinChanges(kin(), formFor({ [key]: ' New ' }))).toEqual({ [key]: 'New' });
      expect(buildKinChanges(kin({ [key]: 'Old' }), formFor({ [key]: '' }))).toEqual({ [key]: '' });
      expect(buildKinChanges(kin({ [key]: 'Same' }), formFor({ [key]: 'Same' }))).toEqual({});
      expect(validateKinForm(formFor({ [key]: 'x'.repeat(2001) }))[key]).toMatch(/2000/);
    });
  }
  it('Medications / health notes holds both sides, so it has room for 4000 (#1908 kin-meds)', () => {
    expect(validateKinForm(formFor({ medications: 'x'.repeat(4000) })).medications).toBeUndefined();
    expect(validateKinForm(formFor({ medications: 'x'.repeat(4001) })).medications).toMatch(/4000/);
  });
});
/** #1908 kin-vet: the household's vet unless "Different vet for this Kin" is ticked. */
describe('the Kin vet (#1908 kin-vet)', () => {
  it('a Kin with no vet of its own starts unticked', () => {
    expect(kinFormFromDto(kin())).toMatchObject({ differentVet: false, ownVetClinicId: '' });
  });
  it('a Kin with its own vet starts ticked, on that clinic', () => {
    expect(kinFormFromDto(kin({ ownVetClinicId: 'c2' }))).toMatchObject({ differentVet: true, ownVetClinicId: 'c2' });
  });
  it('ticking and picking sends the clinic', () => {
    expect(buildKinChanges(kin(), formFor({ differentVet: true, ownVetClinicId: 'c2' }))).toEqual({ ownVetClinicId: 'c2' });
  });
  it('unticking sends "" (back to the household vet), whatever clinic the form still remembers', () => {
    expect(buildKinChanges(kin({ ownVetClinicId: 'c2' }), formFor({ differentVet: false, ownVetClinicId: 'c2' }))).toEqual({ ownVetClinicId: '' });
  });
  it('ticked with no clinic chosen cannot be saved', () => {
    expect(validateKinForm(formFor({ differentVet: true, ownVetClinicId: '' })).ownVetClinicId).toMatch(/Choose a vet/);
    expect(validateKinForm(formFor({ differentVet: false, ownVetClinicId: '' })).ownVetClinicId).toBeUndefined();
  });
  it('a Kin from an older backend with no ownVetClinicId reads as the household vet', () => {
    const legacy = { ...kin() } as Partial<KinDto>;
    delete legacy.ownVetClinicId;
    expect(kinFormFromDto(legacy as KinDto)).toMatchObject({ differentVet: false, ownVetClinicId: '' });
    expect(buildKinChanges(legacy as KinDto, kinFormFromDto(legacy as KinDto))).toEqual({});
  });
});
describe('emptyKinForm', () => {
  it('every field starts blank, and it validates as incomplete (name required)', () => {
    const form = emptyKinForm();
    const { spayedNeutered, differentVet, ...text } = form;
    expect(Object.values(text).every((v) => v === '')).toBe(true);
    expect(spayedNeutered).toBe(false);
    expect(differentVet).toBe(false);
    expect(validateKinForm(form).name).toBe('Name is required.');
  });
});
describe('buildNewKinPayload', () => {
  it('sends the full payload (not a diff): every blank field becomes null, name is trimmed', () => {
    const form = { ...emptyKinForm(), name: '  Rex  ', species: 'Dog' };
    expect(buildNewKinPayload(form)).toEqual({
      name: 'Rex',
      species: 'Dog',
      breed: null,
      ageYears: null,
      feedingInstructions: null,
      walkingInstructions: null,
      medications: null,
      allergies: null,
      emergencyNotes: null,
      sitterNotes: null,
    });
  });
  it('adds the shared facts (#1310, #1908) and the Kin vet only when they have a value', () => {
    const form: KinEditForm = {
      ...emptyKinForm(),
      name: 'Rex',
      sex: 'Male',
      weight: ' 52 lbs ',
      colorMarkings: 'Black',
      spayedNeutered: true,
      routine: ' Walk at 7 ',
      vaccinations: 'Rabies 2027',
      differentVet: true,
      ownVetClinicId: 'c2',
    };
    expect(buildNewKinPayload(form)).toMatchObject({
      sex: 'Male',
      weight: '52 lbs',
      colorMarkings: 'Black',
      spayedNeutered: true,
      routine: 'Walk at 7',
      vaccinations: 'Rabies 2027',
      ownVetClinicId: 'c2',
    });
    const blank = buildNewKinPayload({ ...emptyKinForm(), name: 'Rex' });
    for (const k of ['sex', 'weight', 'colorMarkings', 'vetInfo', 'spayedNeutered', 'staysAs', 'routine', 'ownVetClinicId']) {
      expect(blank).not.toHaveProperty(k);
    }
  });
  it('parses a valid age and trims every text field', () => {
    const form: KinEditForm = { ...emptyKinForm(), name: 'Rex', ageYears: '4', breed: '  Beagle  ' };
    const payload = buildNewKinPayload(form);
    expect(payload.ageYears).toBe(4);
    expect(payload.breed).toBe('Beagle');
  });

  it('sends null for an unparsable age rather than blocking (validation gates submit before this runs)', () => {
    const form: KinEditForm = { ...emptyKinForm(), name: 'Rex', ageYears: 'not a number' };
    expect(buildNewKinPayload(form).ageYears).toBeNull();
  });
});

// #1583: weight is a number with an optional unit; a value the pet already has passes unchanged.
describe('validateKinForm weight (#1583)', () => {
  it('accepts a number, a number with a unit, and blank', () => {
    for (const weight of ['', '45', '45 lb', '12.5kg', '8 oz']) {
      expect(validateKinForm(formFor({ weight })).weight).toBeUndefined();
    }
  });

  it('refuses free text', () => {
    for (const weight of ['heavy-ish', '45 stone', '-3', '0']) {
      expect(validateKinForm(formFor({ weight })).weight).toMatch(/Weight is a number/);
    }
  });

  it('lets a weight the pet already carries stand, and refuses a new bad one', () => {
    const k = { weight: 'heavy-ish' };
    expect(validateKinForm(formFor({ weight: 'heavy-ish' }), k).weight).toBeUndefined();
    expect(validateKinForm(formFor({ weight: 'heavy' }), k).weight).toMatch(/Weight is a number/);
    expect(validateKinForm(formFor({ weight: '40 lb' }), k).weight).toBeUndefined();
  });
});
