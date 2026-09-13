import { describe, expect, it } from 'vitest';
import {
  buildSaveContactPayload,
  clinicAlreadyOnList,
  contactMetaLine,
  isDisplayableField,
  memberStatusLabel,
  mergeReservedFields,
  newMapboxSessionToken,
  normalizeClinicName,
  resolveMapboxAddress,
  type CustomFieldDto,
  type HouseholdContactDto,
  type VetClinicDto,
} from './tribeApi';

function clinic(overrides: Partial<VetClinicDto> = {}): VetClinicDto {
  return {
    id: 'c1',
    name: 'Cedar Street Animal Hospital',
    phone: '',
    address: '',
    website: '',
    googleMapsUrl: '',
    isEmergency: false,
    ...overrides,
  };
}

describe('normalizeClinicName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeClinicName('  Cedar   Street  Animal Hospital ')).toBe('cedar street animal hospital');
  });
});

describe('clinicAlreadyOnList', () => {
  it('is true for a blank name (nothing to add yet)', () => {
    expect(clinicAlreadyOnList('  ', [])).toBe(true);
  });

  it('is true when a case/space-insensitive match exists in the catalog', () => {
    expect(clinicAlreadyOnList('cedar street  animal hospital', [clinic()])).toBe(true);
  });

  it('is false for a genuinely novel name', () => {
    expect(clinicAlreadyOnList('Bay Area 24hr Pet ER', [clinic()])).toBe(false);
  });
});

describe('resolveMapboxAddress', () => {
  it('prefers full_address', () => {
    const feature = { properties: { full_address: '318 Cedar Street, Oakland, CA', name: 'Cedar Street' } };
    expect(resolveMapboxAddress(feature)).toBe('318 Cedar Street, Oakland, CA');
  });

  it('falls back to name when full_address is blank', () => {
    const feature = { properties: { full_address: '', name: 'Cedar Street' } };
    expect(resolveMapboxAddress(feature)).toBe('Cedar Street');
  });

  it('returns empty string for a null/malformed feature', () => {
    expect(resolveMapboxAddress(null)).toBe('');
    expect(resolveMapboxAddress({})).toBe('');
    expect(resolveMapboxAddress({ properties: null })).toBe('');
  });
});

describe('newMapboxSessionToken', () => {
  it('is 32 lowercase hex characters and varies per call', () => {
    const a = newMapboxSessionToken();
    const b = newMapboxSessionToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('mergeReservedFields', () => {
  it('replaces reserved keys and preserves everything else', () => {
    const base: CustomFieldDto[] = [
      { key: 'vetClinicName', label: 'Vet Clinic', value: 'Old Clinic' },
      { key: 'notReserved', label: 'Something', value: 'kept' },
    ];
    const next: CustomFieldDto[] = [{ key: 'vetClinicName', label: 'Vet Clinic', value: 'New Clinic' }];
    const merged = mergeReservedFields(base, next, ['vetClinicName', 'vetClinicPhone']);
    expect(merged).toEqual([
      { key: 'notReserved', label: 'Something', value: 'kept' },
      { key: 'vetClinicName', label: 'Vet Clinic', value: 'New Clinic' },
    ]);
  });
});

describe('isDisplayableField', () => {
  it('is false when both label and value are blank', () => {
    expect(isDisplayableField({ key: 'k', label: '', value: '  ' })).toBe(false);
  });

  it('is true when either label or value has content', () => {
    expect(isDisplayableField({ key: 'k', label: 'Label', value: '' })).toBe(true);
    expect(isDisplayableField({ key: 'k', label: '', value: 'Value' })).toBe(true);
  });
});

describe('memberStatusLabel', () => {
  it('maps every known status to its friendly label', () => {
    expect(memberStatusLabel('ACTIVE')).toBe('Active');
    expect(memberStatusLabel('SUSPENDED')).toBe('Suspended');
    expect(memberStatusLabel('INVITED')).toBe('Invite pending');
  });
});

/**
 * THE WALL, on the client side of it (#818).
 *
 * The server refuses `permissions` / `role` / `invitedEmail` with a `.strict()`
 * schema and names the key — `functions/test/householdContacts.test.ts` pins
 * that in three cases. What no server test can pin is whether the PORTAL ever
 * reaches for the invite through the contact door, and a spec that only checks
 * the four fields it does send would still pass with a fifth smuggled in beside
 * them. So these assert the KEY SET, exactly.
 */
describe('buildSaveContactPayload', () => {
  const input = { name: '  Ada Rivera ', label: ' Sister ', phone: ' 805 555 0143 ', email: ' ADA@example.com ' };

  it('sends exactly the four editable fields when creating, and no household id the portal was not given', () => {
    const payload = buildSaveContactPayload(input);
    expect(Object.keys(payload).sort()).toEqual(['email', 'label', 'name', 'phone']);
    expect(payload).toEqual({ name: 'Ada Rivera', label: 'Sister', phone: '805 555 0143', email: 'ADA@example.com' });
  });

  it('carries no permissions, role, uid or invitedEmail — a contact has nothing to authorise', () => {
    const payload = buildSaveContactPayload(input, 'kin-fam-1') as Record<string, unknown>;
    for (const forbidden of ['permissions', 'role', 'uid', 'invitedEmail', 'secondaryLabel', 'status']) {
      expect(payload[forbidden]).toBeUndefined();
    }
    expect(Object.keys(payload).sort()).toEqual(['email', 'kinfolkId', 'label', 'name', 'phone']);
  });

  it('adds contactId only when editing, so a create can never land on somebody else’s row', () => {
    expect(Object.keys(buildSaveContactPayload({ ...input, contactId: '  ' })).sort()).toEqual([
      'email',
      'label',
      'name',
      'phone',
    ]);
    expect(buildSaveContactPayload({ ...input, contactId: ' c7 ' })).toMatchObject({ contactId: 'c7' });
  });

  it('SENDS THE EMPTY ONES: a cleared phone or email goes as "" so the server can null it', () => {
    const payload = buildSaveContactPayload({ name: 'Ada', label: '', phone: '', email: '' });
    expect(payload).toEqual({ name: 'Ada', label: '', phone: '', email: '' });
  });

  it('refuses a nameless contact here rather than spending a round-trip on it', () => {
    expect(() => buildSaveContactPayload({ name: '   ', label: '', phone: '', email: '' })).toThrow(/needs a name/i);
  });
});

describe('contactMetaLine', () => {
  function contact(overrides: Partial<HouseholdContactDto> = {}): HouseholdContactDto {
    return {
      contactId: 'c1',
      name: 'Ada Rivera',
      label: 'Sister',
      phone: '805 555 0143',
      email: 'ada@example.com',
      createdAt: null,
      updatedAt: null,
      ...overrides,
    };
  }

  it('joins what is there and skips what is not', () => {
    expect(contactMetaLine(contact())).toBe('Sister · 805 555 0143 · ada@example.com');
    expect(contactMetaLine(contact({ phone: null, email: null }))).toBe('Sister');
  });
});
