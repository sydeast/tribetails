import { describe, expect, it } from 'vitest';
import {
  clinicAlreadyOnList,
  isDisplayableField,
  memberStatusLabel,
  mergeReservedFields,
  newMapboxSessionToken,
  normalizeClinicName,
  resolveMapboxAddress,
  type CustomFieldDto,
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
