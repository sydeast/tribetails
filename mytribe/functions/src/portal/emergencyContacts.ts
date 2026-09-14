import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { hasKinfolkPerm, requireKinfolkPerm } from '../lib/memberGate';
import { isStaff } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { isValidPhone, normalizeE164 } from '../lib/phoneNormalize';
import type { MemberDoc } from '../lib/schema';
import {
  comparablePhone,
  EMERGENCY_CONTACTS_MAX,
  EMERGENCY_CONTACTS_SAME_PHONE_MESSAGE,
  EMERGENCY_CONTACTS_TOO_MANY_MESSAGE,
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE,
  EMERGENCY_CONTACT_NAME_TOO_LONG_MESSAGE,
  EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
  EMERGENCY_CONTACT_PHONE_INVALID_MESSAGE,
  EMERGENCY_CONTACT_PHONE_MAX,
  EMERGENCY_CONTACT_PHONE_REQUIRED_MESSAGE,
  EMERGENCY_CONTACT_PHONE_TOO_LONG_MESSAGE,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX,
  EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG_MESSAGE,
  EMERGENCY_CONTACT_REQUIRED_MESSAGE,
  householdClash,
  householdIdentity,
  mergeEmergencyContacts,
  readStoredEmergencyContacts,
  type EmergencyContactInput,
  type StoredEmergencyContact,
} from '../lib/emergencyContacts';

/**
 * The one write path for Emergency Contacts (#829 section 1), used by all five
 * clients, and its read. Gate is `home_access` (section 3): staff and the
 * PRIMARY pass inside `requireKinfolkPerm`; a SECONDARY needs the flag. Reading
 * is open to any ACTIVE member; `canEdit` tells the portal whether to draw the
 * editor. Never logs a name or a phone.
 */

const ContactZ = z
  .object({
    name: z.string().trim().min(1, EMERGENCY_CONTACT_NAME_REQUIRED_MESSAGE).max(EMERGENCY_CONTACT_NAME_MAX, EMERGENCY_CONTACT_NAME_TOO_LONG_MESSAGE),
    phone: z
      .string()
      .trim()
      .min(1, EMERGENCY_CONTACT_PHONE_REQUIRED_MESSAGE)
      .max(EMERGENCY_CONTACT_PHONE_MAX, EMERGENCY_CONTACT_PHONE_TOO_LONG_MESSAGE)
      .refine((p) => isValidPhone(p), EMERGENCY_CONTACT_PHONE_INVALID_MESSAGE)
      .transform((p) => normalizeE164(p) as string),
    relationship: z
      .union([z.string().max(EMERGENCY_CONTACT_RELATIONSHIP_MAX, EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG_MESSAGE), z.null()])
      .optional()
      .transform((v) => {
        const t = (v ?? '').trim();
        return t === '' ? null : t;
      }),
  })
  .strict();

const SaveArgs = z
  .object({
    kinfolkId: z.string().optional(),
    contacts: z.array(ContactZ).max(EMERGENCY_CONTACTS_MAX, EMERGENCY_CONTACTS_TOO_MANY_MESSAGE),
  })
  .strict();

/** Exported for the callable-contract freeze: five clients hand-build this payload. */
export { SaveArgs as Args };

const ListArgs = z.object({ kinfolkId: z.string().optional() }).strict();

function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data;
  // #829 review: the message alone, never a ` (contacts.0.phone)` path. Clients
  // show it as-is, and a household should not read a field path.
  throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid arguments.');
}

export interface EmergencyContactDTO {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: string | null;
  updatedAt: string | null;
}

function toDto(c: StoredEmergencyContact): EmergencyContactDTO {
  return {
    name: c.name,
    phone: c.phone,
    relationship: c.relationship,
    recordedAt: c.recordedAt ? c.recordedAt.toDate().toISOString() : null,
    updatedAt: c.updatedAt ? c.updatedAt.toDate().toISOString() : null,
  };
}

/**
 * Parses contacts exactly as `saveEmergencyContacts` does, with the same messages
 * and field paths. Exported for saveTribeProfile's old-client path (#829), so an
 * old portal install sees the error a new client would.
 */
export function parseEmergencyContactsInput(contacts: unknown[]): EmergencyContactInput[] {
  return parseArgs(SaveArgs, { contacts }).contacts;
}

/**
 * The rules every Emergency Contact write passes: at least one, two different
 * phones, the household still exists, and nobody from the household. Shared by
 * `saveEmergencyContacts` and saveTribeProfile's old-client path (#829). Reads
 * only: returns the doc to write and the merged list, and throws the same
 * HttpsErrors either caller shows. The caller has already checked home_access.
 */
export async function prepareEmergencyContactsSave(
  firestore: Firestore,
  kinfolkId: string,
  contacts: EmergencyContactInput[],
): Promise<{ ref: DocumentReference; merged: StoredEmergencyContact[] }> {
  const [first, second] = contacts;
  if (!first) {
    throw new HttpsError('failed-precondition', EMERGENCY_CONTACT_REQUIRED_MESSAGE);
  }
  if (second && comparablePhone(first.phone) === comparablePhone(second.phone)) {
    throw new HttpsError('invalid-argument', EMERGENCY_CONTACTS_SAME_PHONE_MESSAGE);
  }

  const ref = firestore.doc(`kinfolk/${kinfolkId}`);
  const [kinSnap, membersSnap] = await Promise.all([ref.get(), firestore.collection(`families/${kinfolkId}/members`).get()]);
  if (!kinSnap.exists) throw new HttpsError('not-found', 'That household no longer exists.');
  const kinfolk = (kinSnap.data() ?? {}) as Record<string, unknown>;
  const who = householdIdentity(kinfolk, membersSnap.docs.map((d) => (d.data() ?? {}) as Record<string, unknown>));
  if (householdClash(contacts, who) !== -1) {
    throw new HttpsError('failed-precondition', EMERGENCY_CONTACT_OUTSIDE_MESSAGE);
  }

  const merged = mergeEmergencyContacts(readStoredEmergencyContacts(kinfolk).contacts, contacts, Timestamp.now());
  return { ref, merged };
}

export async function saveEmergencyContactsHandler(
  req: CallableRequest<unknown>,
): Promise<{ contacts: EmergencyContactDTO[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(SaveArgs, req.data);
  const isAdmin = req.auth?.token?.admin === true;
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, isAdmin, 'saveEmergencyContacts');
  await requireKinfolkPerm(uid, kinfolkId, 'home_access', isAdmin, 'saveEmergencyContacts');

  const { ref, merged } = await prepareEmergencyContactsSave(db(), kinfolkId, args.contacts);
  await ref.update({ emergencyContacts: merged, updatedAt: FieldValue.serverTimestamp() });

  logEvent({
    severity: 'info',
    function: 'saveEmergencyContacts',
    event: 'kinfolk.emergencyContacts.saved',
    uid,
    extra: { kinfolkId, count: merged.length },
  });
  return { contacts: merged.map(toDto) };
}

/**
 * Who may READ a household's Emergency Contacts (#829): staff; a caller with no
 * member doc, who is the legacy single-primary account (the same anti-lockout
 * rule as requireKinfolkPerm); and a member whose doc is ACTIVE. Any other
 * member (INVITED, SUSPENDED) may not. Home access is not needed to read.
 *
 * The one copy of this rule, shared by listEmergencyContacts (which refuses) and
 * getMyTribeProfile's legacy emergencyContact* rows (which it leaves out).
 * The caller has already resolved the household through resolveKinfolkAccess.
 */
export async function canReadEmergencyContacts(
  firestore: Firestore,
  uid: string,
  kinfolkId: string,
  isAdmin: boolean,
  fn: string,
): Promise<boolean> {
  if (isStaff(uid, isAdmin, fn)) return true;
  const memberSnap = await firestore.doc(`families/${kinfolkId}/members/${uid}`).get();
  return !memberSnap.exists || (memberSnap.data() as MemberDoc).status === 'ACTIVE';
}

/** How many served contacts are remembered per caller: enough for a phone and a tablet that loaded at different times. */
const LEGACY_SERVED_MAX = 3;

/**
 * `families/{kinfolkId}/legacyEcServed/{uid}`: the contacts getMyTribeProfile
 * served this caller as legacy rows, newest last, as one-way keys
 * (`legacyServedKey`), never a name or phone.
 *
 * WHY IT EXISTS. saveTribeProfile cannot see what an old client loaded. If the
 * client loaded A and the office then set B, an untouched save re-sends A, which
 * matches neither the families copy nor slot 1, and would overwrite B. A token
 * carried by the client cannot fix that: old portal web shows unreserved rows as
 * fields, and portal Android rebuilds its rows from schema keys. So the server
 * remembers what it served, and a sent contact matching any of it is an echo.
 *
 * SERVER ONLY. No firestore.rules match block covers this path, so every client
 * is denied (pinned in test/rules/families.test.ts), and getMyTribeProfile never
 * puts it in a response.
 */
function legacyServedRef(firestore: Firestore, kinfolkId: string, uid: string): DocumentReference {
  return firestore.doc(`families/${kinfolkId}/legacyEcServed/${uid}`);
}

function servedEntries(data: unknown): Array<{ key: string; at: unknown }> {
  const served = (data as { served?: unknown } | undefined)?.served;
  if (!Array.isArray(served)) return [];
  return served.filter((s): s is { key: string; at: unknown } => typeof s === 'object' && s !== null && typeof (s as { key?: unknown }).key === 'string');
}

/** The keys of the contacts last served to this caller, oldest first. */
export async function readLegacyServedKeys(firestore: Firestore, kinfolkId: string, uid: string): Promise<string[]> {
  const snap = await legacyServedRef(firestore, kinfolkId, uid).get();
  return snap.exists ? servedEntries(snap.data()).map((s) => s.key) : [];
}

/** Remembers that this contact was served to this caller. Writes only when it is not already the newest entry. */
export async function recordLegacyServed(firestore: Firestore, kinfolkId: string, uid: string, key: string): Promise<void> {
  const ref = legacyServedRef(firestore, kinfolkId, uid);
  const snap = await ref.get();
  const served = snap.exists ? servedEntries(snap.data()) : [];
  if (served[served.length - 1]?.key === key) return;
  const next = [...served.filter((s) => s.key !== key), { key, at: Timestamp.now() }].slice(-LEGACY_SERVED_MAX);
  await ref.set({ served: next });
}

export async function listEmergencyContactsHandler(
  req: CallableRequest<unknown>,
): Promise<{ contacts: EmergencyContactDTO[]; canEdit: boolean; legacy: boolean }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(ListArgs, req.data);
  const isAdmin = req.auth?.token?.admin === true;
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, isAdmin, 'listEmergencyContacts');

  const firestore = db();
  if (!(await canReadEmergencyContacts(firestore, uid, kinfolkId, isAdmin, 'listEmergencyContacts'))) {
    throw new HttpsError('permission-denied', 'permission-denied');
  }
  const [kinSnap, canEdit] = await Promise.all([
    firestore.doc(`kinfolk/${kinfolkId}`).get(),
    hasKinfolkPerm(uid, kinfolkId, 'home_access', isAdmin, 'listEmergencyContacts'),
  ]);
  if (!kinSnap.exists) throw new HttpsError('not-found', 'That household no longer exists.');
  const { contacts, legacy } = readStoredEmergencyContacts((kinSnap.data() ?? {}) as Record<string, unknown>);

  logEvent({
    severity: 'info',
    function: 'listEmergencyContacts',
    event: 'kinfolk.emergencyContacts.listed',
    uid,
    extra: { kinfolkId, count: contacts.length, legacy },
  });
  return { contacts: contacts.map(toDto), canEdit, legacy };
}

// AUNTIE_OPERATOR_UIDS because isStaff reads it: without the secret an
// allowlisted operator with no admin claim is denied in production.
const OPTIONS = {
  region: 'us-central1' as const,
  cors: TRIBETAILS_CORS,
  secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
};

export const saveEmergencyContacts = onCall(OPTIONS, wrapCallable('saveEmergencyContacts', saveEmergencyContactsHandler));
export const listEmergencyContacts = onCall(OPTIONS, wrapCallable('listEmergencyContacts', listEmergencyContactsHandler));
