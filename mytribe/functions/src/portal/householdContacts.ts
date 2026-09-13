import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { SECONDARY_LABEL_MAX } from '../lib/schema';

/**
 * Household secondary CONTACTS: people a household can be reached through who
 * hold no portal account at all.
 *
 * OPERATOR RULING (2026-09-12): "a secondary contact does not have to be a
 * portal user. primary kinfolk user will invite a second kinfolk to the
 * household to manage and receive notifications."
 *
 * Those are two actions with two outcomes, and until this file the codebase had
 * only the second one. `addSecondaryContact` is named for the first and does
 * the second: it takes an `invitedEmail`, mints an `inviteRequests` document
 * and hands the recipient a portal account with a `MemberPermissions` set. A
 * household whose second contact will never sign in — the other pet parent who
 * does not use apps, the neighbour with the key, the daughter who answers the
 * phone — had nowhere to be recorded.
 *
 * So the concepts are kept apart HERE, in the argument schemas, not only in the
 * screens:
 *
 *   - A contact has a name, a label, a phone and an optional email. It has NO
 *     permission set, NO role, NO uid and NO invite. There is nothing for it to
 *     sign in to, so there is nothing to authorise.
 *   - Every schema below is `.strict()`. A caller that sends `permissions`,
 *     `invitedEmail`, `role` or `uid` is refused with `invalid-argument` naming
 *     the key, rather than having it silently stripped. A stripped key is how
 *     the two concepts would grow back together.
 *
 * The invite half is unchanged and lives where it always has:
 * `addSecondaryContact.ts` (the PRIMARY inviting a second kinfolk from MyTribe)
 * and `admin/inviteKinfolkToPortal.ts` (the admin's one invite, the primary
 * claim). Nothing here mints, sends, or accepts anything.
 *
 * AUTHORITY IS NOT WIDENED. All three callables gate exactly as
 * `addSecondaryContact` and `listMembers` do: `resolveKinfolkAccess` picks the
 * household (an operator may target any; a kinfolk is held to their own
 * `clients/{uid}.kinfolkIds`, and a cross-tenant resolution is audit-logged
 * inside it), then `requireKinfolkPrimary` requires the PRIMARY or staff. An
 * ACTIVE SECONDARY is denied, as they are for the roster itself.
 *
 * STORAGE is `families/{kinfolkId}/contacts/{contactId}`, beside `members`.
 * `firestore.rules` closes that subcollection to every client (read and write),
 * so these callables are the only door; the Admin SDK bypasses rules. A
 * subcollection document does not need its parent to exist, so a household with
 * no `families/{id}` envelope yet (never invited, never provisioned) can still
 * hold contacts.
 *
 * WHAT IS NEVER LOGGED: a contact's name, phone or email. `listMembers` refuses
 * to surface `displayName` for the same reason, and a log line is a wider
 * audience than a callable response. `logEvent` carries the household id, the
 * contact id and counts.
 */

/** Longest contact name stored. Long enough for "Maria de los Ángeles Rivera". */
export const CONTACT_NAME_MAX = 80;
/** Longest phone string stored. Free text: extensions and country codes vary. */
export const CONTACT_PHONE_MAX = 32;
/** What a contact is called when the caller offers no label. */
export const DEFAULT_CONTACT_LABEL = 'Folk';

/**
 * Optional free text: a trimmed value, or null for "there is none".
 *
 * `''` and `null` mean the same thing on the way IN and both persist as `null`,
 * because a field the operator can fill and cannot empty again is the defect
 * "persisted fields must be editable" describes from the other side. Clearing a
 * stale phone number has to stick.
 */
const optionalText = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((v) => {
      if (v == null) return null;
      const t = v.trim();
      return t === '' ? null : t;
    });

const ContactFields = {
  kinfolkId: z.string().optional(),
  name: z.string().trim().min(1, 'A contact needs a name.').max(CONTACT_NAME_MAX),
  label: z
    .union([z.string().max(SECONDARY_LABEL_MAX), z.null()])
    .optional()
    .transform((v) => {
      const t = (v ?? '').trim();
      return t === '' ? DEFAULT_CONTACT_LABEL : t;
    }),
  phone: optionalText(CONTACT_PHONE_MAX),
  /**
   * OPTIONAL, and it grants nothing. An address here is somewhere to reach this
   * person, not an invitation: no `inviteRequests` document is written and no
   * account is created. The invite lives in `addSecondaryContact.ts`.
   */
  email: z
    .union([z.string().email(), z.literal(''), z.null()])
    .optional()
    .transform((v) => {
      if (v == null || v === '') return null;
      return v.trim().toLowerCase();
    }),
};

const SaveArgs = z
  .object({
    ...ContactFields,
    /** Absent creates; present updates that contact in place. */
    contactId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const ListArgs = z.object({ kinfolkId: z.string().optional() }).strict();

const RemoveArgs = z
  .object({
    kinfolkId: z.string().optional(),
    contactId: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * `invalid-argument` with the offending path, not the `internal` a raw ZodError
 * becomes in `wrapCallable`.
 *
 * A strict schema only keeps the two concepts apart if the refusal is legible:
 * "Unrecognized key: permissions" tells a caller they reached for the invite
 * through the contact door, and "internal" tells them the server is broken.
 */
function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
  throw new HttpsError('invalid-argument', `${issue?.message ?? 'Invalid arguments.'}${where}`);
}

export interface HouseholdContactDTO {
  contactId: string;
  name: string;
  label: string;
  phone: string | null;
  email: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Firestore Timestamp | Date | string -> ISO-8601, else null. Never throws. */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The caller's household, once they have proved they may manage its roster. */
async function gate(
  req: CallableRequest<unknown>,
  kinfolkIdArg: string | undefined,
  functionName: string,
): Promise<{ uid: string; kinfolkId: string }> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = req.auth?.token?.admin === true;
  const { kinfolkId } = await resolveKinfolkAccess(uid, kinfolkIdArg, isAdmin, functionName);
  // Same gate as addSecondaryContact and listMembers: PRIMARY or staff. A
  // SECONDARY manages nobody, not even a contact who cannot sign in.
  await requireKinfolkPrimary(uid, kinfolkId, isAdmin, functionName);
  return { uid, kinfolkId };
}

export async function listHouseholdContactsHandler(
  req: CallableRequest<unknown>,
): Promise<{ contacts: HouseholdContactDTO[] }> {
  initSentry();
  const args = parseArgs(ListArgs, req.data ?? {});
  const { uid, kinfolkId } = await gate(req, args.kinfolkId, 'listHouseholdContacts');

  const snap = await db().collection(`families/${kinfolkId}/contacts`).get();
  const contacts: HouseholdContactDTO[] = snap.docs.map((d) => {
    const data = (d.data() ?? {}) as Record<string, unknown>;
    return {
      contactId: d.id,
      // A stored row with no name still renders as a row: dropping it would
      // hide a record the operator has to be able to fix or delete.
      name: text(data['name']) ?? '(unnamed contact)',
      label: text(data['label']) ?? DEFAULT_CONTACT_LABEL,
      phone: text(data['phone']),
      email: text(data['email']),
      createdAt: toIsoOrNull(data['createdAt']),
      updatedAt: toIsoOrNull(data['updatedAt']),
    };
  });
  contacts.sort((a, b) => a.name.localeCompare(b.name));

  logEvent({
    severity: 'info',
    function: 'listHouseholdContacts',
    event: 'portal.contacts.listed',
    uid,
    extra: { kinfolkId, count: contacts.length },
  });
  return { contacts };
}

/**
 * Creates or edits one contact. No invite, no account, no permissions.
 *
 * DIFF, NOT REBUILD, on the update path: the write carries the four editable
 * fields and `updatedAt`/`updatedBy` only. `createdAt` and `createdBy` are
 * never resent, so an edit cannot rewrite a record's provenance, and every
 * editable field IS sent — including the ones the caller cleared, which land as
 * `null`. Omitting an empty field would leave a stale phone number on the
 * document forever.
 */
export async function saveHouseholdContactHandler(
  req: CallableRequest<unknown>,
): Promise<{ contactId: string; created: boolean }> {
  initSentry();
  const args = parseArgs(SaveArgs, req.data);
  const { uid, kinfolkId } = await gate(req, args.kinfolkId, 'saveHouseholdContact');

  const firestore = db();
  const collection = firestore.collection(`families/${kinfolkId}/contacts`);
  const editable = {
    name: args.name,
    label: args.label,
    phone: args.phone,
    email: args.email,
  };

  if (args.contactId !== undefined) {
    const ref = collection.doc(args.contactId);
    const existing = await ref.get();
    if (!existing.exists) {
      throw new HttpsError('not-found', 'That contact is no longer on this household.');
    }
    await ref.update({
      ...editable,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
    logEvent({
      severity: 'info',
      function: 'saveHouseholdContact',
      event: 'portal.contact.updated',
      uid,
      extra: { kinfolkId, contactId: args.contactId },
    });
    return { contactId: args.contactId, created: false };
  }

  const ref = await collection.add({
    ...editable,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  });
  logEvent({
    severity: 'info',
    function: 'saveHouseholdContact',
    event: 'portal.contact.created',
    uid,
    extra: { kinfolkId, contactId: ref.id },
  });
  return { contactId: ref.id, created: true };
}

/**
 * Deletes one contact outright.
 *
 * HARD, unlike `removeMember`, and that is the point of the difference: a
 * member's removal is soft because their account, their sign-ins and their
 * history survive the gesture. A contact is a phone number on a household. It
 * has no account to suspend and no audit trail to preserve, so "remove" means
 * the row is gone.
 */
export async function removeHouseholdContactHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  initSentry();
  const args = parseArgs(RemoveArgs, req.data);
  const { uid, kinfolkId } = await gate(req, args.kinfolkId, 'removeHouseholdContact');

  const ref = db().doc(`families/${kinfolkId}/contacts/${args.contactId}`);
  const existing = await ref.get();
  if (!existing.exists) {
    throw new HttpsError('not-found', 'That contact is no longer on this household.');
  }
  await ref.delete();

  logEvent({
    severity: 'info',
    function: 'removeHouseholdContact',
    event: 'portal.contact.removed',
    uid,
    extra: { kinfolkId, contactId: args.contactId },
  });
  return { ok: true };
}

// `AUNTIE_OPERATOR_UIDS` is not optional on any of the three: `isStaff` inside
// `requireKinfolkPrimary` reads it, so without the secret an allowlisted
// operator (one with no `admin` custom claim) is denied in production while
// every unit test passes.
const OPTIONS = {
  region: 'us-central1' as const,
  cors: TRIBETAILS_CORS,
  secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
};

export const listHouseholdContacts = onCall(
  OPTIONS,
  wrapCallable('listHouseholdContacts', listHouseholdContactsHandler),
);

export const saveHouseholdContact = onCall(
  OPTIONS,
  wrapCallable('saveHouseholdContact', saveHouseholdContactHandler),
);

export const removeHouseholdContact = onCall(
  OPTIONS,
  wrapCallable('removeHouseholdContact', removeHouseholdContactHandler),
);
