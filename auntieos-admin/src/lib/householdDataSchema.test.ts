import { describe, it, expect } from 'vitest';
import {
  EDITABLE_HOUSEHOLD_SECTIONS,
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
  it('carries exactly the schema keys, no more and no fewer', () => {
    // HOUSEHOLD_FIELD_KEYS is schema-derived, not catalog-derived (2026-08-04),
    // precisely so a field can lose its rendered SECTION without losing its
    // place in the read/write round trip. This still pins the two lists
    // together; it stops a field added to the schema and forgotten here from
    // silently failing to round-trip through getHouseholdData/saveHouseholdSection.
    expect([...HOUSEHOLD_FIELD_KEYS].sort()).toEqual(Object.keys(householdDataSchema.shape).sort());
  });

  it('drops the emergency and provider sections from the rendered catalog without dropping their fields from the round trip', () => {
    // Operator, 2026-08-04, looking at this screen's modal-edit sections: "I
    // dont need this Emergency & Safety or Service Provider boxes." The
    // sections are gone; the data is not, because a future family-page
    // "Emergency Must Knows" section is meant to read it (see the removal
    // comment on HOUSEHOLD_SECTIONS in householdDataSchema.ts).
    expect(HOUSEHOLD_SECTIONS.some((s) => s.id === 'emergency')).toBe(false);
    expect(HOUSEHOLD_SECTIONS.some((s) => s.id === 'providers')).toBe(false);
    for (const key of [
      'poisonControlNumber',
      'emergencyContactsPriority',
      'evacuationPlan',
      'importantDocumentsLocation',
      'groomerName',
      'groomerPhone',
      'trainerName',
      'trainerPhone',
      'petSitterBackup',
      'dogWalkerBackup',
    ] as const) {
      expect(HOUSEHOLD_FIELD_KEYS).toContain(key);
    }
  });

  /**
   * The 30 stored fields, plus the two canonical vet CLINIC IDS added
   * 2026-08-01 when `household_data` became the household vet's owner (operator
   * ruling). The seven free-text vet fields stay in the count: they are the
   * legacy fallback for a household that predates the catalog link, still read,
   * never written.
   */
  it('catalogues all 32 HouseholdData fields, each exactly once', () => {
    expect(HOUSEHOLD_FIELD_KEYS).toHaveLength(32);
    expect(new Set(HOUSEHOLD_FIELD_KEYS).size).toBe(32);
  });
  it('carries the two catalog link fields, so the vet is not free text', () => {
    expect(HOUSEHOLD_FIELD_KEYS).toContain('primaryVetClinicId');
    expect(HOUSEHOLD_FIELD_KEYS).toContain('emergencyVetClinicId');
  });
  /**
   * A clinic id is chosen by search, never typed. If the generic text dialog
   * could render one, an operator could paste an arbitrary document id and
   * point a household at a clinic nobody chose.
   */
  it('keeps the vet section out of the generic text editor', () => {
    expect(veterinary.editor).toBe('vetPicker');
    expect(EDITABLE_HOUSEHOLD_SECTIONS.some((s) => s.id === 'veterinary')).toBe(false);
  });

  it('gives every field a label and every section a title', () => {
    for (const section of HOUSEHOLD_SECTIONS) {
      expect(section.title.trim()).not.toBe('');
      expect(section.fields.length).toBeGreaterThan(0);
      for (const field of section.fields) expect(field.label.trim()).not.toBe('');
    }
  });

  it('masks the one access-sensitive field left in the catalog, and nothing operational', () => {
    // `importantDocumentsLocation` was masked too, until "Emergency and
    // safety" (its only section) was removed 2026-08-04. It is still in the
    // schema and still not secret there; there is just no rendered field left
    // for a mask to apply to.
    const secrets = HOUSEHOLD_SECTIONS.flatMap((s) => s.fields.filter((f) => f.secret).map((f) => f.key));
    expect([...secrets].sort()).toEqual(['securitySystemInfo']);
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
