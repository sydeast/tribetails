import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { normalizeE164 } from './phoneNormalize';

/**
 * Emergency Contacts, issue #829 section 1. The person called when no kinfolk
 * answers. Never a recipient of anything (see
 * test/emergencyContactsNeverMessaged.test.ts), never a household member.
 *
 * Stored as `kinfolk/{id}.emergencyContacts`, index 0 called first. Until the
 * operator verifies the migration, a doc with no array still carries the old
 * flat `emergencyContactName/Phone/Relation` triple; `readStoredEmergencyContacts`
 * projects it as one legacy contact so no reader goes blank in between.
 */
export const EMERGENCY_CONTACTS_MAX = 2;
export const EMERGENCY_CONTACT_NAME_MAX = 80;
export const EMERGENCY_CONTACT_PHONE_MAX = 32;
export const EMERGENCY_CONTACT_RELATIONSHIP_MAX = 40;
/**
 * The validation wording, one source (#829 review). All five clients pre-check
 * with these exact strings, so a refusal reads the same whether the client or
 * the server caught it.
 */
export const EMERGENCY_CONTACT_REQUIRED_MESSAGE = 'A household needs at least one Emergency Contact.';
export const EMERGENCY_CONTACT_OUTSIDE_MESSAGE = 'An Emergency Contact has to be someone outside the household.';
export const EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE = 'An Emergency Contact needs a name.';
export const EMERGENCY_CONTACT_PHONE_REQUIRED_MESSAGE = 'An Emergency Contact needs a phone number.';
export const EMERGENCY_CONTACT_PHONE_INVALID_MESSAGE = 'That phone number is not a valid number.';
export const EMERGENCY_CONTACT_NAME_TOO_LONG_MESSAGE = `An Emergency Contact's name can be at most ${EMERGENCY_CONTACT_NAME_MAX} characters.`;
export const EMERGENCY_CONTACT_PHONE_TOO_LONG_MESSAGE = `An Emergency Contact's phone number can be at most ${EMERGENCY_CONTACT_PHONE_MAX} characters.`;
export const EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG_MESSAGE = `A relationship can be at most ${EMERGENCY_CONTACT_RELATIONSHIP_MAX} characters.`;
export const EMERGENCY_CONTACTS_TOO_MANY_MESSAGE = 'A household can have at most two Emergency Contacts.';
export const EMERGENCY_CONTACTS_SAME_PHONE_MESSAGE = 'The two Emergency Contacts need different phone numbers.';

export interface EmergencyContactInput {
  name: string;
  phone: string;
  relationship: string | null;
}

export interface StoredEmergencyContact extends EmergencyContactInput {
  /** When the office first had this person. Null only for a migrated record with no date at all. */
  recordedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface HouseholdIdentity {
  names: string[];
  phones: string[];
}

export function normaliseName(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A phone reduced to digits for comparison. E.164 when libphonenumber accepts
 * it; otherwise bare digits with a US country code added to a 10-digit string.
 * Never throws: a malformed stored member phone must not turn a save into a 500.
 */
export function comparablePhone(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === '') return null;
  try {
    const e164 = normalizeE164(t);
    return e164 === null ? null : e164.replace(/\D/g, '');
  } catch {
    const d = t.replace(/\D/g, '');
    if (d === '') return null;
    return d.length === 10 ? `1${d}` : d;
  }
}

/**
 * The three customFields rows old clients (portal Android before Task 10, cached
 * portal web bundles) show and send for slot 1. getMyTribeProfile serves them;
 * saveTribeProfile reads them back.
 */
export const LEGACY_EMERGENCY_CONTACT_KEYS: ReadonlySet<string> = new Set([
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
]);

/** The one contact a set of legacy rows describes; null when there are no such rows. */
export function legacyContactFromRows(rows: ReadonlyArray<{ key: string; value: string }>): EmergencyContactInput | null {
  const hits = rows.filter((r) => LEGACY_EMERGENCY_CONTACT_KEYS.has(r.key));
  if (hits.length === 0) return null;
  const valueOf = (key: string) => (hits.find((r) => r.key === key)?.value ?? '').trim();
  const relationship = valueOf('emergencyContactRelation');
  return { name: valueOf('emergencyContactName'), phone: valueOf('emergencyContactPhone'), relationship: relationship === '' ? null : relationship };
}

/** Same person, same number: name ignoring case and spacing, phone in any spelling, relationship trimmed. */
export function sameLegacyContact(a: EmergencyContactInput, b: EmergencyContactInput): boolean {
  return (
    normaliseName(a.name) === normaliseName(b.name) &&
    comparablePhone(a.phone) === comparablePhone(b.phone) &&
    (a.relationship ?? '').trim() === (b.relationship ?? '').trim()
  );
}

/**
 * A one-way key for "this contact was served to this caller", so the served
 * record holds no name or phone. Two spellings sameLegacyContact calls equal
 * get the same key.
 */
export function legacyServedKey(c: EmergencyContactInput): string {
  const normalised = `${normaliseName(c.name)}|${comparablePhone(c.phone) ?? ''}|${(c.relationship ?? '').trim()}`;
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

/** The primary (from the kinfolk doc) plus every member doc of the household. */
export function householdIdentity(
  kinfolk: Record<string, unknown>,
  members: Array<Record<string, unknown>>,
): HouseholdIdentity {
  const primaryName = `${str(kinfolk['firstName'])} ${str(kinfolk['lastName'])}`;
  return {
    names: [primaryName, ...members.map((m) => str(m['displayName']))].filter((n) => n.trim() !== ''),
    phones: [str(kinfolk['phoneNumber']), str(kinfolk['secondaryPhone']), ...members.map((m) => str(m['phone']))].filter((p) => p !== ''),
  };
}

/** Index of the first contact who is really a household member, or -1. */
export function householdClash(contacts: EmergencyContactInput[], who: HouseholdIdentity): number {
  const names = new Set(who.names.map(normaliseName).filter((n) => n !== ''));
  const phones = new Set(who.phones.map(comparablePhone).filter((p): p is string => p !== null));
  return contacts.findIndex((c) => {
    const phone = comparablePhone(c.phone);
    return names.has(normaliseName(c.name)) || (phone !== null && phones.has(phone));
  });
}

/**
 * Replace-whole, without losing history. Each incoming contact is matched to a
 * stored one by phone, then by name; a match keeps its `recordedAt`, and keeps
 * its `updatedAt` when name, phone and relationship are all unchanged. A
 * reorder is therefore one write that changes no dates.
 */
export function mergeEmergencyContacts(
  existing: StoredEmergencyContact[],
  incoming: EmergencyContactInput[],
  now: Timestamp,
): StoredEmergencyContact[] {
  const used = new Set<number>();
  return incoming.map((c) => {
    const phone = comparablePhone(c.phone);
    let idx = existing.findIndex((e, i) => !used.has(i) && phone !== null && comparablePhone(e.phone) === phone);
    if (idx === -1) idx = existing.findIndex((e, i) => !used.has(i) && normaliseName(e.name) === normaliseName(c.name));
    if (idx === -1) return { ...c, recordedAt: now, updatedAt: now };
    used.add(idx);
    const prev = existing[idx];
    const unchanged = prev.name === c.name && prev.phone === c.phone && (prev.relationship ?? null) === c.relationship;
    return { ...c, recordedAt: prev.recordedAt, updatedAt: unchanged ? (prev.updatedAt ?? now) : now };
  });
}

/** Timestamp | ISO string | `{_seconds}` | `YYYY-MM-DD` to a Timestamp, else null. */
export function timestampFromStored(v: unknown): Timestamp | null {
  if (v instanceof Timestamp) return v;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['toDate'] === 'function') return Timestamp.fromDate((o['toDate'] as () => Date)());
    if (typeof o['_seconds'] === 'number') return new Timestamp(o['_seconds'] as number, Number(o['_nanoseconds'] ?? 0));
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
  }
  return null;
}

/**
 * The date a legacy flat record gets. The kinfolk doc's own `updatedAt` (the
 * closest real date the old record has, stored as a String on most docs and a
 * Timestamp on some), then `joinDate`, then null. Never the migration time.
 */
export function recordedAtForLegacy(
  kinfolk: Record<string, unknown>,
): { value: Timestamp | null; source: 'updatedAt' | 'joinDate' | null } {
  const fromUpdated = timestampFromStored(kinfolk['updatedAt']);
  if (fromUpdated) return { value: fromUpdated, source: 'updatedAt' };
  const fromJoin = timestampFromStored(kinfolk['joinDate']);
  if (fromJoin) return { value: fromJoin, source: 'joinDate' };
  return { value: null, source: null };
}

export function readStoredEmergencyContacts(
  kinfolk: Record<string, unknown>,
): { contacts: StoredEmergencyContact[]; legacy: boolean } {
  const raw = kinfolk['emergencyContacts'];
  if (Array.isArray(raw) && raw.length > 0) {
    const contacts = raw
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((o) => ({
        name: str(o['name']),
        phone: str(o['phone']),
        relationship: strOrNull(o['relationship']),
        recordedAt: timestampFromStored(o['recordedAt']),
        updatedAt: timestampFromStored(o['updatedAt']),
      }))
      .filter((c) => c.name !== '' || c.phone !== '');
    return { contacts, legacy: false };
  }
  const name = str(kinfolk['emergencyContactName']);
  const phone = str(kinfolk['emergencyContactPhone']);
  if (name === '' && phone === '') return { contacts: [], legacy: false };
  const dated = recordedAtForLegacy(kinfolk).value;
  return {
    contacts: [{ name, phone, relationship: strOrNull(kinfolk['emergencyContactRelation']), recordedAt: dated, updatedAt: dated }],
    legacy: true,
  };
}
