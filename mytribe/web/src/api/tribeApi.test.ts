import { describe, expect, it } from 'vitest';
import {
  blameUnfinishedHalf,
  buildSaveContactPayload,
  clinicAlreadyOnList,
  contactMetaLine,
  isDisplayableField,
  memberStatusLabel,
  newMapboxSessionToken,
  normalizeClinicName,
  pageSaveOutcome,
  resolveMapboxAddress,
  schemaPlaceholder,
  type HouseholdContactDto,
  type SaveHalf,
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

/**
 * #868. The page Save is two callables. Either can be refused on its own, and
 * the row building around them can throw before either is reached, so what the
 * kinfolk is told has to say which half landed.
 */
describe('#868 the page Save reports each half on its own', () => {
  const boom = new Error('nope');
  const saved: SaveHalf = { kind: 'saved' };
  const skipped: SaveHalf = { kind: 'skipped' };
  const failed: SaveHalf = { kind: 'failed', error: boom };

  it('a clean save says so, and a home half that was never sent does not make it partial', () => {
    expect(pageSaveOutcome(saved, skipped, false)).toEqual({ text: 'Saved.', ok: true });
    expect(pageSaveOutcome(saved, saved, false)).toEqual({ text: 'Saved.', ok: true });
    expect(pageSaveOutcome(saved, skipped, true)).toEqual({
      text: 'Profile saved. Your Emergency Contacts are not saved yet: use Save Emergency Contacts.',
      ok: true,
    });
  });

  it('a partial result is a failure, names the half that did not save, and never starts "Save failed"', () => {
    for (const partial of [pageSaveOutcome(saved, failed, false), pageSaveOutcome(failed, saved, false)]) {
      expect(partial.ok).toBe(false);
      expect(partial.text.startsWith('Save failed')).toBe(false);
      expect(partial.text).toContain('did not save');
      expect(partial.text).toContain('Your edits there are still on this page.');
    }
  });

  it('only the profile half failing keeps the plain "Save failed" line', () => {
    expect(pageSaveOutcome(failed, skipped, false)).toEqual({ text: 'Save failed: nope', ok: false });
  });

  it('#930: both halves failing for different reasons names both, not just the profile half\'s', () => {
    const failedHome: SaveHalf = { kind: 'failed', error: new Error('kaput') };
    const outcome = pageSaveOutcome(failed, failedHome, false);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('Family and Vet Clinic did not save: nope.');
    expect(outcome.text).toContain('Home Information and the after-hours clinic did not save: kaput.');
  });

  it('#930: both halves failing for the SAME reason (a Save click rate-limits both callables together) states it once', () => {
    const sameBoom = new Error('nope');
    const outcome = pageSaveOutcome({ kind: 'failed', error: sameBoom }, { kind: 'failed', error: sameBoom }, false);
    expect(outcome).toEqual({ text: 'Save failed: nope. Press Save Changes to try again. Your edits are still on this page.', ok: false });
    // The reason is not named twice.
    expect(outcome.text.match(/Press Save Changes to try again/g)).toHaveLength(1);
  });

  it('a throw between the callables is blamed on the half it was building for', () => {
    // Before either call: the profile half never happened.
    expect(blameUnfinishedHalf(skipped, skipped, boom)).toEqual({ profile: failed, home: skipped });
    // After the profile saved: the home half never happened.
    expect(blameUnfinishedHalf(saved, skipped, boom)).toEqual({ profile: saved, home: failed });
    // Both settled already: nothing left to blame.
    expect(blameUnfinishedHalf(saved, saved, boom)).toEqual({ profile: saved, home: saved });
    expect(blameUnfinishedHalf(failed, saved, boom)).toEqual({ profile: failed, home: saved });
  });

  it('a throw before the profile call reads as a plain failure, not a silent "Saved."', () => {
    const blamed = blameUnfinishedHalf(skipped, skipped, boom);
    expect(pageSaveOutcome(blamed.profile, blamed.home, false)).toEqual({ text: 'Save failed: nope', ok: false });
  });
});

/**
 * #901. A schema `defaultValue` is a HINT, never a stored value: the screen used
 * to show it as a value while the save sent nothing for that key. Mirrors
 * `schemaPlaceholder` in portal Android `components/SchemaFormRenderer.kt`.
 */
describe('schemaPlaceholder', () => {
  const field = (placeholder: string | null, defaultValue: string | null) => ({ placeholder, defaultValue });
  it("prefers the schema's own placeholder", () => {
    expect(schemaPlaceholder(field('e.g. twice a day', 'Twice a day'))).toBe('e.g. twice a day');
  });

  it('falls back to the default when there is no placeholder', () => {
    expect(schemaPlaceholder(field(null, 'Twice a day'))).toBe('Twice a day');
  });

  it('is null when neither is set', () => {
    expect(schemaPlaceholder(field(null, null))).toBeNull();
  });

  it('falls through a blank placeholder rather than painting an empty hint', () => {
    expect(schemaPlaceholder(field('   ', 'Twice a day'))).toBe('Twice a day');
  });

  it('is null when the default is blank', () => {
    expect(schemaPlaceholder(field(null, '  '))).toBeNull();
  });
});
