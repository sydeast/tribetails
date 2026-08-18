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

  it('requires photoUrl to be an http(s) URL', () => {
    expect(validateKinForm(formFor({ photoUrl: 'javascript:alert(1)' })).photoUrl).toMatch(/http/);
    expect(validateKinForm(formFor({ photoUrl: 'ftp://example.com/a.png' })).photoUrl).toMatch(/http/);
    expect(validateKinForm(formFor({ photoUrl: 'not a url' })).photoUrl).toMatch(/http/);
    expect(validateKinForm(formFor({ photoUrl: 'https://example.com/a.png' })).photoUrl).toBeUndefined();
    expect(validateKinForm(formFor({ photoUrl: '' })).photoUrl).toBeUndefined();
  });

  it('enforces the species / breed / long-text length caps', () => {
    expect(validateKinForm(formFor({ species: 'x'.repeat(41) })).species).toMatch(/40/);
    expect(validateKinForm(formFor({ breed: 'x'.repeat(81) })).breed).toMatch(/80/);
    expect(validateKinForm(formFor({ feedingInstructions: 'x'.repeat(2001) })).feedingInstructions).toMatch(/2000/);
    expect(validateKinForm(formFor({ emergencyNotes: 'x'.repeat(2000) })).emergencyNotes).toBeUndefined();
  });

  it('rejects an unparsable age', () => {
    expect(validateKinForm(formFor({ ageYears: '-4' })).ageYears).toMatch(/0 or more/);
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

describe('emptyKinForm', () => {
  it('every field starts blank, and it validates as incomplete (name required)', () => {
    const form = emptyKinForm();
    expect(Object.values(form).every((v) => v === '')).toBe(true);
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
      photoUrl: null,
      feedingInstructions: null,
      walkingInstructions: null,
      medications: null,
      allergies: null,
      emergencyNotes: null,
      sitterNotes: null,
    });
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
