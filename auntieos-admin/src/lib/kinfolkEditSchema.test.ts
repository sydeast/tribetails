import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  isValidPhone,
  phoneOkOrBlank,
  emailOkOrBlank,
  validateKinfolkEdit,
  KINFOLK_STATUS_OPTIONS,
  KINFOLK_ARCHIVED_STATUS,
  type KinfolkEditInput,
} from './kinfolkEditSchema';

function form(over: Partial<KinfolkEditInput> = {}): KinfolkEditInput {
  return {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'jamie@example.com',
    status: 'active',
    joinDate: '2026-01-04',
    secondaryPhone: '',
    secondaryEmail: '',
    serviceAddress: '123 Bark Ave',
    gateCode: '',
    parkingInstructions: '',
    entryNotes: '',
    wifiName: '',
    wifiPassword: '',
    ...over,
  };
}

describe('isValidPhone', () => {
  it('accepts 10 digits in any common separator style', () => {
    expect(isValidPhone('5125551234')).toBe(true);
    expect(isValidPhone('(512) 555-1234')).toBe(true);
    expect(isValidPhone('512.555.1234')).toBe(true);
  });

  it('accepts 11 digits with a leading 1', () => {
    expect(isValidPhone('+1 512 555 1234')).toBe(true);
  });

  it('rejects the 9 digit case the Kotlin source calls out, and anything with letters', () => {
    expect(isValidPhone('719390420')).toBe(false);
    expect(isValidPhone('512-555-CATS')).toBe(false);
  });

  it('rejects blank, and 11 digits that do not start with 1', () => {
    expect(isValidPhone('')).toBe(false);
    expect(isValidPhone('25125551234')).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidEmail('jamie@example.com')).toBe(true);
    expect(isValidEmail('jamie.b+dogs@sub.example.co')).toBe(true);
  });

  it('rejects a missing domain, a missing tld, and blank', () => {
    expect(isValidEmail('jamie@')).toBe(false);
    expect(isValidEmail('jamie@example')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  it('rejects an address past the 254 character limit', () => {
    expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('the blank-tolerant variants', () => {
  it('treat blank as fine but still check a real value', () => {
    expect(phoneOkOrBlank('')).toBe(true);
    expect(phoneOkOrBlank('   ')).toBe(true);
    expect(phoneOkOrBlank('nope')).toBe(false);
    expect(emailOkOrBlank('')).toBe(true);
    expect(emailOkOrBlank('nope')).toBe(false);
  });
});

describe('validateKinfolkEdit', () => {
  it('returns an empty map for a complete household', () => {
    expect(validateKinfolkEdit(form())).toEqual({});
  });

  it('flags each required field by name', () => {
    const errors = validateKinfolkEdit(
      form({ firstName: '  ', lastName: '', serviceAddress: '' }),
    );
    expect(errors.firstName).toMatch(/first name/i);
    expect(errors.lastName).toMatch(/last name/i);
    expect(errors.serviceAddress).toMatch(/service address/i);
  });

  it('requires a valid primary phone', () => {
    const errors = validateKinfolkEdit(form({ phoneNumber: '123' }));
    expect(errors.phoneNumber).toMatch(/10 digit/i);
  });

  it('lets the optional contact fields be blank but not wrong', () => {
    expect(validateKinfolkEdit(form({ secondaryPhone: '', secondaryEmail: '' }))).toEqual({});
    const errors = validateKinfolkEdit(form({ secondaryPhone: '123', secondaryEmail: 'nope' }));
    expect(errors.secondaryPhone).toBeDefined();
    expect(errors.secondaryEmail).toBeDefined();
  });
  /**
   * The vet fields stopped being typed by hand: VetClinicPicker writes them
   * from a catalog row. The rule loosened deliberately, so this pins WHY rather
   * than leaving the removal looking like an oversight. A legacy household can
   * hold "after hours line" or a number with an extension in vetClinicPhone,
   * and that must not become a blocking error on a screen opened to fix a
   * phone number somewhere else on the form.
   */
  it('accepts whatever a legacy household already stored in the vet fields', () => {
    expect(
      validateKinfolkEdit(
        form({
        }),
      ),
    ).toEqual({});
  });
  it('accepts a household linked to a catalog clinic, with an emergency vet too', () => {
    expect(
      validateKinfolkEdit(
        form({
        }),
      ),
    ).toEqual({});
  });

  it('does not enforce the no-dashes voice rule on household facts', () => {
    // A real street address or clinic name may carry a dash. This form holds
    // facts, not copy Auntie speaks, so the KinTale rule deliberately does not
    // apply here.
    expect(validateKinfolkEdit(form({ serviceAddress: '123 Bark Ave, Apt 4-B' }))).toEqual({});
  });

  it('accepts an already-archived household so it can still be loaded and restored', () => {
    expect(validateKinfolkEdit(form({ status: KINFOLK_ARCHIVED_STATUS }))).toEqual({});
  });

  it('does not offer archived as a pickable status', () => {
    // Archiving carries when/why/by-whom, which a bare status flip cannot record.
    expect(KINFOLK_STATUS_OPTIONS).toEqual(['active', 'prospect', 'inactive']);
    expect(KINFOLK_STATUS_OPTIONS as readonly string[]).not.toContain(KINFOLK_ARCHIVED_STATUS);
  });

  it('reports only the first message per field', () => {
    const errors = validateKinfolkEdit(form({ email: 'nope' }));
    expect(Object.keys(errors)).toEqual(['email']);
  });

  it('takes a join date as a calendar day, or blank', () => {
    expect(validateKinfolkEdit(form({ joinDate: '2026-07-24' }))).toEqual({});
    expect(validateKinfolkEdit(form({ joinDate: '' }))).toEqual({});
  });

  it('rejects the formats the picker cannot produce', () => {
    // The field is an `<input type="date">`, so the only values it can emit are
    // YYYY-MM-DD and blank. Anything else reached the form from a legacy document
    // and has to be replaced rather than saved forward.
    expect(validateKinfolkEdit(form({ joinDate: '07/24/2026' })).joinDate).toBeDefined();
    expect(validateKinfolkEdit(form({ joinDate: '2026-07-24T12:34:56.789Z' })).joinDate).toBeDefined();
    expect(validateKinfolkEdit(form({ joinDate: 'sometime in the spring' })).joinDate).toBeDefined();
  });

  it('rejects a well shaped day that never happened', () => {
    expect(validateKinfolkEdit(form({ joinDate: '2026-02-30' })).joinDate).toBeDefined();
  });
});
