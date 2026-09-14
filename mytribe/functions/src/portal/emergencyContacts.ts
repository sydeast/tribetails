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
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
  EMERGENCY_CONTACT_PHONE_MAX,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX,
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
    name: z.string().trim().min(1, 'An Emergency Contact needs a name.').max(EMERGENCY_CONTACT_NAME_MAX),
    phone: z
      .string()
      .trim()
      .min(1, 'An Emergency Contact needs a phone number.')
      .max(EMERGENCY_CONTACT_PHONE_MAX)
      .refine((p) => isValidPhone(p), 'That phone number is not a valid number.')
      .transform((p) => normalizeE164(p) as string),
    relationship: z
      .union([z.string().max(EMERGENCY_CONTACT_RELATIONSHIP_MAX), z.null()])
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
    contacts: z.array(ContactZ).max(EMERGENCY_CONTACTS_MAX, 'A household can have at most two Emergency Contacts.'),
  })
  .strict();

/** Exported for the callable-contract freeze: five clients hand-build this payload. */
export { SaveArgs as Args };

const ListArgs = z.object({ kinfolkId: z.string().optional() }).strict();

function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
  throw new HttpsError('invalid-argument', `${issue?.message ?? 'Invalid arguments.'}${where}`);
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
    throw new HttpsError('invalid-argument', 'The two Emergency Contacts need different phone numbers.');
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
