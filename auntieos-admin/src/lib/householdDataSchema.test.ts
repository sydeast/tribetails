import { describe, it, expect } from 'vitest';
import {
  HOUSEHOLD_FIELD_KEYS,
  HOUSEHOLD_SECTIONS,
  blankHouseholdFields,
  householdDataSchema,
  isDialablePhone,
  sectionErrors,
  sectionFilledCount,
  validateHouseholdData,
  type HouseholdFields,
} from './householdDataSchema';

function fields(over: Partial<HouseholdFields> = {}): HouseholdFields {
  return { ...blankHouseholdFields(), ...over };
}

const veterinary = HOUSEHOLD_SECTIONS.find((s) => s.id === 'veterinary')!;
const routines = HOUSEHOLD_SECTIONS.find((s) => s.id === 'routines')!;

describe('the catalog and the schema stay in step', () => {
  it('catalogues exactly the schema keys, no more and no fewer', () => {
    // The one thing keeping the read view, the editor, and the validator from
    // drifting apart. A field added to the schema and forgotten in the catalog
    // is a field nobody can ever fill in, and it would fail HERE, not live.
    expect([...HOUSEHOLD_FIELD_KEYS].sort()).toEqual(Object.keys(householdDataSchema.shape).sort());
  });

  it('catalogues all 30 android HouseholdData fields, each exactly once', () => {
    expect(HOUSEHOLD_FIELD_KEYS).toHaveLength(30);
    expect(new Set(HOUSEHOLD_FIELD_KEYS).size).toBe(30);
  });

  it('gives every field a label and every section a title', () => {
    for (const section of HOUSEHOLD_SECTIONS) {
      expect(section.title.trim()).not.toBe('');
      expect(section.fields.length).toBeGreaterThan(0);
      for (const field of section.fields) expect(field.label.trim()).not.toBe('');
    }
  });

  it('masks the two access-sensitive fields and nothing operational', () => {
    const secrets = HOUSEHOLD_SECTIONS.flatMap((s) => s.fields.filter((f) => f.secret).map((f) => f.key));
    expect([...secrets].sort()).toEqual(['importantDocumentsLocation', 'securitySystemInfo']);
  });

  it('leaves the emergency read-in-90-seconds fields unmasked', () => {
    // Masking these would put a reveal toggle between a sitter and a vet.
    const emergency = HOUSEHOLD_SECTIONS.find((s) => s.id === 'emergency')!;
    for (const key of ['poisonControlNumber', 'emergencyContactsPriority', 'evacuationPlan']) {
      expect(emergency.fields.find((f) => f.key === key)?.secret).toBeUndefined();
    }
  });
});

describe('validateHouseholdData', () => {
  it('accepts an all-blank record: every field on this form is optional', () => {
    expect(validateHouseholdData(blankHouseholdFields())).toEqual({});
  });

  it('accepts a fully filled, well-formed record', () => {
    const clean = fields({
      primaryVetName: 'Barton Creek Animal Hospital',
      primaryVetPhone: '(512) 555 0134',
      primaryVetAddress: '4900 Bee Cave Rd, Austin TX',
      emergencyVetPhone: '512-555-0199 ext 2',
      poisonControlNumber: '888 426 4435',
      securitySystemInfo: 'Panel by the garage door, code 4417',
      foodLocation: 'Pantry, second shelf',
    });
    expect(validateHouseholdData(clean)).toEqual({});
  });

  it('rejects an em dash with the Voice Bible message, keyed to the field', () => {
    const errors = validateHouseholdData(fields({ householdRules: 'Shoes off—always.' }));
    expect(errors.householdRules).toMatch(/does not use dashes/i);
  });

  it('rejects an en dash used as a pause too', () => {
    expect(validateHouseholdData(fields({ evacuationPlan: 'Side gate – then the park.' })).evacuationPlan).toMatch(
      /dashes/i,
    );
  });

  it('rejects a phone field holding an instruction instead of a number', () => {
    const errors = validateHouseholdData(fields({ emergencyVetPhone: 'ask Marcus' }));
    expect(errors.emergencyVetPhone).toMatch(/dialed/i);
  });

  it('rejects a phone with too few digits to dial', () => {
    expect(validateHouseholdData(fields({ groomerPhone: '555 01' })).groomerPhone).toMatch(/7 digits/);
  });

  it('rejects an over-long single-line field', () => {
    expect(validateHouseholdData(fields({ foodLocation: 'a'.repeat(201) })).foodLocation).toMatch(/200/);
  });

  it('reports only ONE message per field, never a stack', () => {
    // Both too long AND dashed: the operator fixes one thing at a time.
    const errors = validateHouseholdData(fields({ householdRules: `${'a'.repeat(2001)}—` }));
    expect(typeof errors.householdRules).toBe('string');
  });

  it('keys every message to a real field, so nothing renders orphaned', () => {
    const errors = validateHouseholdData(fields({ trainerPhone: 'nope', toysLocation: 'b—c' }));
    for (const key of Object.keys(errors)) expect(HOUSEHOLD_FIELD_KEYS).toContain(key);
  });
});

describe('isDialablePhone', () => {
  it('treats blank as fine: the field is optional', () => {
    expect(isDialablePhone('')).toBe(true);
    expect(isDialablePhone('   ')).toBe(true);
  });

  it('accepts the shapes an operator actually types', () => {
    for (const value of ['5125550134', '(512) 555-0134', '+1 512.555.0134', '512-555-0134 ext 12']) {
      expect(isDialablePhone(value)).toBe(true);
    }
  });

  it('rejects prose and short numbers', () => {
    for (const value of ['call the desk', '911x', '555-01']) {
      expect(isDialablePhone(value)).toBe(false);
    }
  });
});

describe('sectionErrors', () => {
  it('narrows the map to the section, so one dialog never blocks on another section', () => {
    const all = validateHouseholdData(
      fields({ primaryVetPhone: 'nope', securitySystemInfo: 'panel—by the door' }),
    );
    expect(Object.keys(sectionErrors(all, veterinary))).toEqual(['primaryVetPhone']);
    expect(Object.keys(sectionErrors(all, routines))).toEqual(['securitySystemInfo']);
  });

  it('is empty for a clean section', () => {
    expect(sectionErrors(validateHouseholdData(blankHouseholdFields()), veterinary)).toEqual({});
  });
});

describe('sectionFilledCount', () => {
  it('counts only fields carrying a real value', () => {
    expect(sectionFilledCount(veterinary, blankHouseholdFields())).toBe(0);
    expect(
      sectionFilledCount(veterinary, fields({ primaryVetName: 'Barton Creek', primaryVetPhone: '5125550134' })),
    ).toBe(2);
  });

  it('does not count whitespace as filled in', () => {
    expect(sectionFilledCount(veterinary, fields({ primaryVetName: '   ' }))).toBe(0);
  });
});
