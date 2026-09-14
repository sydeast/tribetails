/**
 * Emergency Contacts (#829). Read from the kinfolk doc the admin already loads
 * (array first, the old flat triple as a fallback until the migration is
 * verified); written only through `saveEmergencyContacts`. Nothing here
 * catches: a refused save carries the server's message to the screen.
 */
import { call } from '../lib/fns';

export const EMERGENCY_CONTACTS_MAX = 2;
export const EMERGENCY_CONTACT_NAME_MAX = 80;
export const EMERGENCY_CONTACT_PHONE_MAX = 32;
export const EMERGENCY_CONTACT_RELATIONSHIP_MAX = 40;

/**
 * The server's own wording, word for word (`mytribe/functions/src/lib/emergencyContacts.ts`),
 * so a refusal reads the same whether this pre-check or the callable caught it.
 */
export const EMERGENCY_CONTACT_REQUIRED = 'A household needs at least one Emergency Contact.';
export const EMERGENCY_CONTACT_OUTSIDE = 'An Emergency Contact has to be someone outside the household.';
export const EMERGENCY_CONTACT_NAME_REQUIRED = 'An Emergency Contact needs a name.';
export const EMERGENCY_CONTACT_PHONE_REQUIRED = 'An Emergency Contact needs a phone number.';
export const EMERGENCY_CONTACT_NAME_TOO_LONG = `An Emergency Contact's name can be at most ${EMERGENCY_CONTACT_NAME_MAX} characters.`;
export const EMERGENCY_CONTACT_PHONE_TOO_LONG = `An Emergency Contact's phone number can be at most ${EMERGENCY_CONTACT_PHONE_MAX} characters.`;
export const EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG = `A relationship can be at most ${EMERGENCY_CONTACT_RELATIONSHIP_MAX} characters.`;
export const EMERGENCY_CONTACTS_TOO_MANY = 'A household can have at most two Emergency Contacts.';
export const EMERGENCY_CONTACTS_SAME_PHONE = 'The two Emergency Contacts need different phone numbers.';
/** The tip beside the Emergency Contacts title on every client. */
export const EMERGENCY_CONTACT_WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: string | null;
  updatedAt: string | null;
}

export interface EmergencyContactDraft {
  name: string;
  phone: string;
  relationship: string;
}

export const EMPTY_EMERGENCY_CONTACT_DRAFT: EmergencyContactDraft = { name: '', phone: '', relationship: '' };

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function iso(v: unknown): string | null {
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof v === 'string' && v !== '' ? v : null;
}

export function emergencyContactsOf(raw: Record<string, unknown> | null | undefined): EmergencyContact[] {
  const r = raw ?? {};
  const arr = r['emergencyContacts'];
  if (Array.isArray(arr) && arr.length > 0) {
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((o) => ({
        name: s(o['name']),
        phone: s(o['phone']),
        relationship: s(o['relationship']) || null,
        recordedAt: iso(o['recordedAt']),
        updatedAt: iso(o['updatedAt']),
      }))
      .filter((c) => c.name !== '' || c.phone !== '');
  }
  const name = s(r['emergencyContactName']);
  const phone = s(r['emergencyContactPhone']);
  if (name === '' && phone === '') return [];
  return [{ name, phone, relationship: s(r['emergencyContactRelation']) || null, recordedAt: null, updatedAt: null }];
}

export function hasEmergencyContact(raw: Record<string, unknown> | null | undefined): boolean {
  return emergencyContactsOf(raw).length > 0;
}

export function toDrafts(contacts: EmergencyContact[]): EmergencyContactDraft[] {
  const drafts = contacts.map((c) => ({ name: c.name, phone: c.phone, relationship: c.relationship ?? '' }));
  return drafts.length > 0 ? drafts : [{ ...EMPTY_EMERGENCY_CONTACT_DRAFT }];
}

export function isBlankDrafts(drafts: EmergencyContactDraft[]): boolean {
  return drafts.every((d) => d.name.trim() === '' && d.phone.trim() === '' && d.relationship.trim() === '');
}

export function draftsEqual(a: EmergencyContactDraft[], b: EmergencyContactDraft[]): boolean {
  return (
    a.length === b.length &&
    a.every((d, i) => {
      const other = b[i];
      return other !== undefined && d.name.trim() === other.name.trim() && d.phone.trim() === other.phone.trim() && d.relationship.trim() === other.relationship.trim();
    })
  );
}

/** Digits for comparison; a 10-digit number gets the US country code. */
export function comparablePhone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d;
}

function comparableName(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The same checks the server makes, before the round trip. The server stays
 * authoritative: it also knows every member's phone and name, which a client
 * may not.
 */
export function validateEmergencyContactDrafts(
  drafts: EmergencyContactDraft[],
  household: { names: string[]; phones: string[] },
): string | null {
  if (drafts.length === 0 || isBlankDrafts(drafts)) return EMERGENCY_CONTACT_REQUIRED;
  if (drafts.length > EMERGENCY_CONTACTS_MAX) return EMERGENCY_CONTACTS_TOO_MANY;
  if (drafts.some((d) => d.name.trim() === '')) return EMERGENCY_CONTACT_NAME_REQUIRED;
  if (drafts.some((d) => d.phone.trim() === '')) return EMERGENCY_CONTACT_PHONE_REQUIRED;
  if (drafts.some((d) => d.name.trim().length > EMERGENCY_CONTACT_NAME_MAX)) return EMERGENCY_CONTACT_NAME_TOO_LONG;
  if (drafts.some((d) => d.phone.trim().length > EMERGENCY_CONTACT_PHONE_MAX)) return EMERGENCY_CONTACT_PHONE_TOO_LONG;
  if (drafts.some((d) => d.relationship.trim().length > EMERGENCY_CONTACT_RELATIONSHIP_MAX)) return EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG;
  const [first, second] = drafts;
  if (drafts.length === 2 && first !== undefined && second !== undefined && comparablePhone(first.phone) === comparablePhone(second.phone)) {
    return EMERGENCY_CONTACTS_SAME_PHONE;
  }
  const names = new Set(household.names.map(comparableName).filter((n) => n !== ''));
  const phones = new Set(household.phones.map(comparablePhone).filter((p) => p !== ''));
  if (drafts.some((d) => names.has(comparableName(d.name)) || phones.has(comparablePhone(d.phone)))) {
    return EMERGENCY_CONTACT_OUTSIDE;
  }
  return null;
}

function decode(rows: unknown): EmergencyContact[] {
  if (!Array.isArray(rows)) throw new Error('Emergency Contacts: the server returned no contacts array.');
  return rows.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      name: s(o['name']),
      phone: s(o['phone']),
      relationship: s(o['relationship']) || null,
      recordedAt: iso(o['recordedAt']),
      updatedAt: iso(o['updatedAt']),
    };
  });
}

export async function listEmergencyContacts(
  kinfolkId: string,
): Promise<{ contacts: EmergencyContact[]; canEdit: boolean; legacy: boolean }> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('listEmergencyContacts requires a household id');
  const res = await call<{ kinfolkId: string }, { contacts?: unknown; canEdit?: unknown; legacy?: unknown }>(
    'listEmergencyContacts',
    { kinfolkId: id },
  );
  if (!Array.isArray(res.contacts)) throw new Error('listEmergencyContacts returned no contacts array.');
  return { contacts: decode(res.contacts), canEdit: res.canEdit === true, legacy: res.legacy === true };
}

export async function saveEmergencyContacts(
  kinfolkId: string,
  drafts: EmergencyContactDraft[],
): Promise<EmergencyContact[]> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('saveEmergencyContacts requires a household id');
  const contacts = drafts.map((d) => ({
    name: d.name.trim(),
    phone: d.phone.trim(),
    relationship: d.relationship.trim() === '' ? null : d.relationship.trim(),
  }));
  const res = await call<{ kinfolkId: string; contacts: typeof contacts }, { contacts?: unknown }>(
    'saveEmergencyContacts',
    { kinfolkId: id, contacts },
  );
  return decode(res.contacts);
}
