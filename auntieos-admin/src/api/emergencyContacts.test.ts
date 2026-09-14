import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  EMERGENCY_CONTACT_OUTSIDE,
  EMERGENCY_CONTACT_REQUIRED,
  draftsEqual,
  emergencyContactsOf,
  hasEmergencyContact,
  isBlankDrafts,
  listEmergencyContacts,
  saveEmergencyContacts,
  toDrafts,
  validateEmergencyContactDrafts,
} from './emergencyContacts';

beforeEach(() => call.mockReset());

const HOUSEHOLD = { names: ['Dana Mercer'], phones: ['(805) 555-0100'] };

describe('emergencyContactsOf', () => {
  it('reads the array in call order, with a Timestamp recordedAt as ISO', () => {
    const ts = { toDate: () => new Date('2026-03-02T10:00:00.000Z') };
    const out = emergencyContactsOf({
      emergencyContacts: [
        { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: ts, updatedAt: ts },
        { name: 'Lee Park', phone: '+18055550177', relationship: null },
      ],
    });
    expect(out.map((c) => c.name)).toEqual(['Rae Mercer', 'Lee Park']);
    expect(out[0]?.recordedAt).toBe('2026-03-02T10:00:00.000Z');
    expect(out[1]?.relationship).toBeNull();
  });

  it('falls back to the legacy flat triple until the migration is verified', () => {
    expect(emergencyContactsOf({ emergencyContactName: 'Rae', emergencyContactPhone: '805', emergencyContactRelation: '' })).toEqual([
      { name: 'Rae', phone: '805', relationship: null, recordedAt: null, updatedAt: null },
    ]);
    expect(hasEmergencyContact({ firstName: 'Dana' })).toBe(false);
    expect(hasEmergencyContact({ emergencyContacts: [], emergencyContactPhone: '805' })).toBe(true);
  });
});

describe('drafts', () => {
  it('toDrafts always yields at least one slot, and blank detection ignores whitespace', () => {
    expect(toDrafts([])).toEqual([{ name: '', phone: '', relationship: '' }]);
    expect(isBlankDrafts([{ name: ' ', phone: '', relationship: '' }])).toBe(true);
    expect(draftsEqual([{ name: 'A', phone: '1', relationship: '' }], [{ name: 'A', phone: '1', relationship: '' }])).toBe(true);
  });
});

describe('validateEmergencyContactDrafts', () => {
  it('requires one', () => {
    expect(validateEmergencyContactDrafts([], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_REQUIRED);
    expect(validateEmergencyContactDrafts([{ name: '', phone: '', relationship: '' }], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_REQUIRED);
  });
  it('needs a name and a phone on every slot', () => {
    expect(validateEmergencyContactDrafts([{ name: 'Rae', phone: '', relationship: '' }], HOUSEHOLD)).toBe('Each Emergency Contact needs a phone number.');
    expect(validateEmergencyContactDrafts([{ name: '', phone: '8055550199', relationship: '' }], HOUSEHOLD)).toBe('Each Emergency Contact needs a name.');
  });
  it('refuses the same phone twice and a household member', () => {
    expect(
      validateEmergencyContactDrafts([{ name: 'Rae', phone: '8055550199', relationship: '' }, { name: 'Lee', phone: '(805) 555-0199', relationship: '' }], HOUSEHOLD),
    ).toBe('The two Emergency Contacts need different phone numbers.');
    expect(validateEmergencyContactDrafts([{ name: 'Rae', phone: '+1 805 555 0100', relationship: '' }], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_OUTSIDE);
    expect(validateEmergencyContactDrafts([{ name: ' dana  MERCER', phone: '8055550199', relationship: '' }], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_OUTSIDE);
    expect(validateEmergencyContactDrafts([{ name: 'Rae', phone: '8055550199', relationship: '' }], HOUSEHOLD)).toBeNull();
  });
});

describe('callables', () => {
  it('list trims the id and decodes the answer', async () => {
    call.mockResolvedValue({ contacts: [{ name: 'Rae', phone: '+18055550199', relationship: null, recordedAt: null, updatedAt: null }], canEdit: true, legacy: false });
    const res = await listEmergencyContacts(' fam1 ');
    expect(call).toHaveBeenCalledWith('listEmergencyContacts', { kinfolkId: 'fam1' });
    expect(res.contacts[0]?.name).toBe('Rae');
  });

  it('save sends name, phone, relationship per slot in order, relationship cleared as null', async () => {
    call.mockResolvedValue({ contacts: [] });
    await saveEmergencyContacts('fam1', [
      { name: ' Rae ', phone: ' 8055550199 ', relationship: '' },
      { name: 'Lee', phone: '8055550177', relationship: ' Neighbour ' },
    ]);
    expect(call).toHaveBeenCalledWith('saveEmergencyContacts', {
      kinfolkId: 'fam1',
      contacts: [
        { name: 'Rae', phone: '8055550199', relationship: null },
        { name: 'Lee', phone: '8055550177', relationship: 'Neighbour' },
      ],
    });
  });

  it('an unreadable answer throws rather than reading as no contacts', async () => {
    call.mockResolvedValue({});
    await expect(listEmergencyContacts('fam1')).rejects.toThrow(/no contacts array/);
  });
});
