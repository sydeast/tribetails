import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  contactMetaLine,
  listHouseholdContacts,
  removeHouseholdContact,
  saveHouseholdContact,
  type HouseholdContact,
} from './householdContacts';

beforeEach(() => {
  call.mockReset();
});

function contact(over: Partial<HouseholdContact> = {}): HouseholdContact {
  return {
    contactId: 'c1',
    name: 'Ada Rivera',
    label: 'Sister',
    phone: '805 555 0143',
    email: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}

/**
 * RULING (2026-09-12): "a secondary contact does not have to be a portal user.
 * primary kinfolk user will invite a second kinfolk to the household to manage
 * and receive notifications."
 *
 * These three callables are the first half of that, and the cases that matter
 * are the ones that keep it from growing back into the second: a contact
 * carries no permission set, no role and no invite, and a save is a diff of the
 * four editable fields rather than a rebuild of the stored document.
 */
describe('listHouseholdContacts', () => {
  it('reads the rows and drops one with no id, which nothing could act on', async () => {
    call.mockResolvedValue({
      contacts: [
        { contactId: 'c1', name: 'Ada Rivera', label: 'Sister', phone: '805 555 0143' },
        { name: 'no id' },
      ],
    });

    const rows = await listHouseholdContacts(' fam1 ');

    expect(call).toHaveBeenCalledWith('listHouseholdContacts', { kinfolkId: 'fam1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(contact());
  });

  it('completes a half-written row instead of hiding it', async () => {
    call.mockResolvedValue({ contacts: [{ contactId: 'c1', phone: '' }] });

    const [row] = await listHouseholdContacts('fam1');

    // The operator has to be able to see a broken record to fix or delete it.
    expect(row).toMatchObject({ name: '(unnamed contact)', label: 'Folk', phone: null });
  });

  it('THROWS on a payload it cannot read, rather than reporting an empty household', async () => {
    call.mockResolvedValue({ contacts: 'not an array' });

    await expect(listHouseholdContacts('fam1')).rejects.toThrow(/no contacts array/);
  });

  it('refuses a blank household id before it costs a round trip', async () => {
    await expect(listHouseholdContacts('   ')).rejects.toThrow(/requires a household id/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('saveHouseholdContact', () => {
  it('creates with the four editable fields and NOTHING else', async () => {
    call.mockResolvedValue({ contactId: 'c9', created: true });

    await expect(
      saveHouseholdContact('fam1', {
        name: '  Ada Rivera ',
        label: ' Sister ',
        phone: ' 805 555 0143 ',
        email: '',
      }),
    ).resolves.toEqual({ contactId: 'c9', created: true });

    const [name, payload] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('saveHouseholdContact');
    expect(payload).toEqual({
      kinfolkId: 'fam1',
      name: 'Ada Rivera',
      label: 'Sister',
      phone: '805 555 0143',
      email: '',
    });
    // No invite, no role, no permission set: a contact is none of those, and
    // the server's schema is strict and would refuse them anyway.
    expect(payload).not.toHaveProperty('permissions');
    expect(payload).not.toHaveProperty('proposedRole');
    expect(payload).not.toHaveProperty('invitedEmail');
  });

  it('EDIT IS A DIFF: the id goes, the cleared fields go empty, createdAt never goes', async () => {
    call.mockResolvedValue({ contactId: 'c1', created: false });

    await saveHouseholdContact('fam1', {
      contactId: ' c1 ',
      name: 'Ada Rivera',
      label: 'Sister',
      phone: '',
      email: '',
    });

    const payload = call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.contactId).toBe('c1');
    // Sent empty, not omitted. A field that cannot be emptied is not editable.
    expect(payload.phone).toBe('');
    expect(payload.email).toBe('');
    expect(payload).not.toHaveProperty('createdAt');
    expect(payload).not.toHaveProperty('createdBy');
  });

  it('refuses a nameless contact before the call', async () => {
    await expect(
      saveHouseholdContact('fam1', { name: '  ', label: '', phone: '', email: '' }),
    ).rejects.toThrow(/needs a name/);
    expect(call).not.toHaveBeenCalled();
  });

  it('a response with no contact id is a failure, not a success', async () => {
    call.mockResolvedValue({ created: true });

    await expect(
      saveHouseholdContact('fam1', { name: 'Ada', label: '', phone: '', email: '' }),
    ).rejects.toThrow(/no contact id/);
  });
});

describe('removeHouseholdContact', () => {
  it('sends both ids', async () => {
    call.mockResolvedValue({ ok: true });
    await removeHouseholdContact(' fam1 ', ' c1 ');
    expect(call).toHaveBeenCalledWith('removeHouseholdContact', {
      kinfolkId: 'fam1',
      contactId: 'c1',
    });
  });

  it('refuses a blank contact id', async () => {
    await expect(removeHouseholdContact('fam1', ' ')).rejects.toThrow(/requires a contact id/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('contactMetaLine', () => {
  it('joins what there is and skips what there is not', () => {
    expect(contactMetaLine(contact())).toBe('Sister · 805 555 0143');
    expect(contactMetaLine(contact({ email: 'ada@example.com' }))).toBe(
      'Sister · 805 555 0143 · ada@example.com',
    );
    expect(contactMetaLine(contact({ phone: null, email: null }))).toBe('Sister');
  });
});
