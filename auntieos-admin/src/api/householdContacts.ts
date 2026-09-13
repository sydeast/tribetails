/**
 * Household secondary CONTACTS: the people a household can be reached through
 * who hold no portal account.
 *
 * OPERATOR RULING (2026-09-12): "a secondary contact does not have to be a
 * portal user. primary kinfolk user will invite a second kinfolk to the
 * household to manage and receive notifications."
 *
 * Two actions, two outcomes, and this file is the first one only. Nothing here
 * mints an invite, sends mail, or creates an account. The second one is
 * `inviteKinfolkToPortal` in `membersWrite.ts` (the admin's one invite, the
 * primary claim) and `addSecondaryContact` on MyTribe (the primary inviting a
 * second kinfolk). The #755 Members sweep read the two as one gesture and
 * replaced the mock's "Add secondary contact" with the invite; this restores the
 * missing half rather than trading one for the other.
 *
 * READ AND WRITE IN ONE FILE, unlike `members.ts` / `membersWrite.ts`. That
 * split is load-bearing there: the read half documents why a callable and not a
 * direct Firestore query (an absent index, expiry reconciled server-side), and
 * the write half documents an audit trail and a mail send. A contact has
 * neither. Three small callables over one closed subcollection read better
 * together than as two files that must be opened in pairs.
 *
 * Nothing here catches. A failed call propagates so the screen can name what
 * broke, per the fail-loud rule.
 */

import { call } from '../lib/fns';

/** `CONTACT_NAME_MAX` in `mytribe/functions/src/portal/householdContacts.ts`. */
export const CONTACT_NAME_MAX = 80;
/** `CONTACT_PHONE_MAX`, same file. */
export const CONTACT_PHONE_MAX = 32;
/** `SECONDARY_LABEL_MAX` in `mytribe/functions/src/lib/schema.ts`. */
export const CONTACT_LABEL_MAX = 24;
/** `DEFAULT_CONTACT_LABEL`. What a contact is called when nobody says. */
export const DEFAULT_CONTACT_LABEL = 'Folk';

export interface HouseholdContact {
  contactId: string;
  name: string;
  label: string;
  /** Null means there is none, never "unknown". */
  phone: string | null;
  /**
   * An address to reach this person, and nothing more. It grants no account and
   * sends no invite; the server writes no `inviteRequests` row for a contact.
   */
  email: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HouseholdContactInput {
  /** Absent creates. Present edits that contact in place. */
  contactId?: string;
  name: string;
  label: string;
  phone: string;
  email: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asContact(raw: unknown): HouseholdContact | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const contactId = str(c['contactId']);
  // No id means no row the screen could edit or delete, so it is dropped rather
  // than drawn as an unactionable one.
  if (contactId === null) return null;
  return {
    contactId,
    name: str(c['name']) ?? '(unnamed contact)',
    label: str(c['label']) ?? DEFAULT_CONTACT_LABEL,
    phone: str(c['phone']),
    email: str(c['email']),
    createdAt: str(c['createdAt']),
    updatedAt: str(c['updatedAt']),
  };
}

/** Every contact on this household. Order is the server's: by name. */
export async function listHouseholdContacts(kinfolkId: string): Promise<HouseholdContact[]> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('listHouseholdContacts requires a household id');
  const res = await call<{ kinfolkId: string }, { contacts?: unknown }>('listHouseholdContacts', {
    kinfolkId: id,
  });
  const rows = res?.contacts;
  // A shape we cannot read is not an empty household. Saying "no contacts" off
  // an unreadable payload is the fabricated-success failure the repo forbids.
  if (!Array.isArray(rows)) throw new Error('listHouseholdContacts returned no contacts array.');
  return rows.map(asContact).filter((c): c is HouseholdContact => c !== null);
}

/**
 * Creates or edits one contact. No portal account is created either way.
 *
 * EVERY EDITABLE FIELD IS SENT, including the empty ones. The server writes
 * `null` for a cleared phone or email rather than leaving the old value in
 * place, so a stale number can actually be removed. `createdAt` / `createdBy`
 * are the server's and are never sent from here, so an edit cannot rewrite a
 * record's provenance.
 */
export async function saveHouseholdContact(
  kinfolkId: string,
  input: HouseholdContactInput,
): Promise<{ contactId: string; created: boolean }> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('saveHouseholdContact requires a household id');
  const name = input.name.trim();
  if (name === '') throw new Error('A contact needs a name.');

  const payload: {
    kinfolkId: string;
    name: string;
    label: string;
    phone: string;
    email: string;
    contactId?: string;
  } = {
    kinfolkId: id,
    name,
    label: input.label.trim(),
    phone: input.phone.trim(),
    email: input.email.trim(),
  };
  const contactId = input.contactId?.trim();
  if (contactId !== undefined && contactId !== '') payload.contactId = contactId;

  const res = await call<typeof payload, { contactId?: unknown; created?: unknown }>(
    'saveHouseholdContact',
    payload,
  );
  const savedId = str(res?.contactId);
  if (savedId === null) throw new Error('saveHouseholdContact returned no contact id.');
  return { contactId: savedId, created: res?.created === true };
}

/**
 * Deletes one contact. HARD, unlike `removeMember`: there is no account to
 * suspend and no sign-in history to keep, so the row is gone.
 */
export async function removeHouseholdContact(
  kinfolkId: string,
  contactId: string,
): Promise<void> {
  const id = kinfolkId.trim();
  const cid = contactId.trim();
  if (id === '') throw new Error('removeHouseholdContact requires a household id');
  if (cid === '') throw new Error('removeHouseholdContact requires a contact id');
  await call<{ kinfolkId: string; contactId: string }, { ok: true }>('removeHouseholdContact', {
    kinfolkId: id,
    contactId: cid,
  });
}

/** "Sister · 805 555 0143 · ada@example.com", skipping what is absent. */
export function contactMetaLine(contact: HouseholdContact): string {
  return [contact.label, contact.phone, contact.email]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' · ');
}
