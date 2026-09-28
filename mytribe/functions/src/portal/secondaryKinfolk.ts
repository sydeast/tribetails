import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { householdStaffFlag } from '../lib/staffGate';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { isValidPhone, normalizeE164 } from '../lib/phoneNormalize';
import { comparablePhone, normaliseName, readStoredEmergencyContacts } from '../lib/emergencyContacts';

/**
 * SECONDARY KINFOLK WITHOUT PORTAL ACCESS.
 *
 * Operator rulings 2026-09-27. R1: "SK: contact info optional, portal access
 * optional." Q3: "A Secondary kinfolk can be added to the household but doesn't
 * have portal access unless PK invites them and set access." The earlier
 * ruling stands: the admin invites only the primary; the primary invites the
 * secondary and sets their permissions.
 *
 * STORAGE is the person record from section 2 of the 2026-09-13 household
 * roles spec: `families/{kinfolkId}/secondaryKinfolk/{personId}`, separate from
 * the access grant. `families/{id}/members/{uid}` stays keyed by Firebase uid
 * and every member gate is untouched: a person with no account has no uid, so
 * they are never a member doc until they accept an invite.
 *
 *   { name, phone|null, email|null, access: 'NONE'|'INVITED'|'ACTIVE',
 *     memberUid|null, inviteId|null, createdAt, createdBy, updatedAt, updatedBy }
 *
 * - `saveSecondaryKinfolk` creates one with `access: 'NONE'` (or edits one).
 *   No invite, no email, no account.
 * - Portal access only through the primary: `addSecondaryContact` with
 *   `personId` mints the ordinary invite and moves the record to 'INVITED';
 *   `acceptInvite` creates `members/{uid}` exactly as before and moves the
 *   record to 'ACTIVE' with `memberUid`. Staff cannot call that path.
 * - A no-access secondary receives nothing: the notification dispatcher and
 *   every audience builder read `members` by uid, and this collection is not
 *   one of their inputs.
 *
 * GATE: the PRIMARY or staff (the same `requireKinfolkPrimary` the roster uses).
 * An Auntie may list and save (household information), not remove.
 *
 * `firestore.rules` has no match block for this path, so every client is
 * denied a direct read or write; these callables are the only door.
 *
 * NEVER LOGGED: a name, phone or email.
 */

export const SECONDARY_KINFOLK_NAME_MAX = 80;
export const SECONDARY_KINFOLK_NAME_REQUIRED_MESSAGE = 'A secondary kinfolk needs a name.';
export const SECONDARY_KINFOLK_PHONE_INVALID_MESSAGE = 'That phone number is not a valid number.';
export const SECONDARY_KINFOLK_EMAIL_INVALID_MESSAGE = 'That email address is not valid.';
export const SECONDARY_KINFOLK_IS_PRIMARY_MESSAGE = 'That is the primary kinfolk. A secondary kinfolk is someone else in the household.';
export const SECONDARY_KINFOLK_IS_EMERGENCY_CONTACT_MESSAGE =
  "That is the household's Emergency Contact. An Emergency Contact is someone outside the household.";
export const SECONDARY_KINFOLK_GONE_MESSAGE = 'That secondary kinfolk is no longer on this household.';
export const SECONDARY_KINFOLK_HAS_ACCESS_MESSAGE =
  'This secondary kinfolk has portal access. Remove them from the portal first.';

export type SecondaryKinfolkAccess = 'NONE' | 'INVITED' | 'ACTIVE';

const optionalPhone = z
  .union([z.string().max(32), z.null()])
  .optional()
  .transform((v, ctx) => {
    const t = (v ?? '').trim();
    if (t === '') return null;
    if (!isValidPhone(t)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SECONDARY_KINFOLK_PHONE_INVALID_MESSAGE });
      return z.NEVER;
    }
    return normalizeE164(t) as string;
  });

const optionalEmail = z
  .union([z.string().max(254), z.null()])
  .optional()
  .transform((v, ctx) => {
    const t = (v ?? '').trim().toLowerCase();
    if (t === '') return null;
    if (!z.string().email().safeParse(t).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SECONDARY_KINFOLK_EMAIL_INVALID_MESSAGE });
      return z.NEVER;
    }
    return t;
  });

const SaveArgs = z
  .object({
    kinfolkId: z.string().optional(),
    /** Absent creates; present edits that person in place. */
    personId: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1, SECONDARY_KINFOLK_NAME_REQUIRED_MESSAGE).max(SECONDARY_KINFOLK_NAME_MAX),
    phone: optionalPhone,
    email: optionalEmail,
  })
  .strict();

/** Exported for the callable-contract freeze: five clients hand-build this payload. */
export { SaveArgs as Args };

const ListArgs = z.object({ kinfolkId: z.string().optional() }).strict();

const RemoveArgs = z
  .object({ kinfolkId: z.string().optional(), personId: z.string().trim().min(1).max(200) })
  .strict();

/** The message alone, never a field path: every client shows it as-is. */
function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data;
  throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid arguments.');
}

export interface SecondaryKinfolkDTO {
  personId: string;
  name: string;
  phone: string | null;
  email: string | null;
  access: SecondaryKinfolkAccess;
  memberUid: string | null;
  createdAt: string | null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asAccess(v: unknown): SecondaryKinfolkAccess {
  return v === 'INVITED' || v === 'ACTIVE' ? v : 'NONE';
}

function toIsoOrNull(v: unknown): string | null {
  if (v !== null && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return typeof v === 'string' && v !== '' ? v : null;
}

export function toSecondaryKinfolkDto(personId: string, d: Record<string, unknown>): SecondaryKinfolkDTO {
  return {
    personId,
    name: text(d['name']) ?? '(no name)',
    phone: text(d['phone']),
    email: text(d['email']),
    access: asAccess(d['access']),
    memberUid: text(d['memberUid']),
    createdAt: toIsoOrNull(d['createdAt']),
  };
}

async function gate(
  req: CallableRequest<unknown>,
  kinfolkIdArg: string | undefined,
  fn: string,
): Promise<{ uid: string; kinfolkId: string }> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isStaff = householdStaffFlag(req.auth, fn);
  const { kinfolkId } = await resolveKinfolkAccess(uid, kinfolkIdArg, isStaff, fn);
  await requireKinfolkPrimary(uid, kinfolkId, isStaff, fn);
  return { uid, kinfolkId };
}

export async function listSecondaryKinfolkHandler(req: CallableRequest<unknown>): Promise<{ people: SecondaryKinfolkDTO[] }> {
  initSentry();
  const args = parseArgs(ListArgs, req.data);
  const { uid, kinfolkId } = await gate(req, args.kinfolkId, 'listSecondaryKinfolk');
  const snap = await db().collection(`families/${kinfolkId}/secondaryKinfolk`).get();
  const people = snap.docs
    .map((d) => toSecondaryKinfolkDto(d.id, (d.data() ?? {}) as Record<string, unknown>))
    .sort((a, b) => a.name.localeCompare(b.name));
  logEvent({
    severity: 'info',
    function: 'listSecondaryKinfolk',
    event: 'portal.secondaryKinfolk.listed',
    uid,
    extra: { kinfolkId, count: people.length },
  });
  return { people };
}

/**
 * Creates (no `personId`) or edits one secondary kinfolk. Never an invite.
 *
 * DIFF, NOT REBUILD, on edit: only the three editable fields and
 * `updatedAt/updatedBy` are written, every one of them sent (a cleared phone
 * lands as null). `access`, `memberUid`, `inviteId` and the provenance fields
 * are never written here, so an edit cannot grant, revoke or re-date anything.
 *
 * Refuses the primary's own name, phone or email, and the household's
 * Emergency Contact (who is never a household member, 2026-09-13).
 */
export async function saveSecondaryKinfolkHandler(
  req: CallableRequest<unknown>,
): Promise<{ person: SecondaryKinfolkDTO; created: boolean }> {
  initSentry();
  const args = parseArgs(SaveArgs, req.data);
  const { uid, kinfolkId } = await gate(req, args.kinfolkId, 'saveSecondaryKinfolk');

  const firestore = db();
  const kinSnap = await firestore.doc(`kinfolk/${kinfolkId}`).get();
  const kin = (kinSnap.data() ?? {}) as Record<string, unknown>;
  const name = normaliseName(args.name);
  const phone = comparablePhone(args.phone);
  const primaryName = normaliseName(`${text(kin['firstName']) ?? ''} ${text(kin['lastName']) ?? ''}`);
  const primaryPhones = [kin['phoneNumber'], kin['secondaryPhone']].map((p) => comparablePhone(text(p))).filter((p) => p !== null);
  const primaryEmail = (text(kin['email']) ?? '').toLowerCase();
  if (
    (primaryName !== '' && name === primaryName) ||
    (phone !== null && primaryPhones.includes(phone)) ||
    (args.email !== null && primaryEmail !== '' && args.email === primaryEmail)
  ) {
    throw new HttpsError('failed-precondition', SECONDARY_KINFOLK_IS_PRIMARY_MESSAGE);
  }
  const ecs = readStoredEmergencyContacts(kin).contacts;
  if (ecs.some((c) => normaliseName(c.name) === name || (phone !== null && comparablePhone(c.phone) === phone))) {
    throw new HttpsError('failed-precondition', SECONDARY_KINFOLK_IS_EMERGENCY_CONTACT_MESSAGE);
  }

  const collection = firestore.collection(`families/${kinfolkId}/secondaryKinfolk`);
  const editable = { name: args.name, phone: args.phone, email: args.email };

  if (args.personId !== undefined) {
    const ref = collection.doc(args.personId);
    const existing = await ref.get();
    if (!existing.exists) throw new HttpsError('not-found', SECONDARY_KINFOLK_GONE_MESSAGE);
    await ref.update({ ...editable, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    logEvent({
      severity: 'info',
      function: 'saveSecondaryKinfolk',
      event: 'portal.secondaryKinfolk.updated',
      uid,
      extra: { kinfolkId, personId: args.personId },
    });
    const before = (existing.data() ?? {}) as Record<string, unknown>;
    return { person: toSecondaryKinfolkDto(args.personId, { ...before, ...editable }), created: false };
  }

  const ref = await collection.add({
    ...editable,
    access: 'NONE',
    memberUid: null,
    inviteId: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  });
  logEvent({
    severity: 'info',
    function: 'saveSecondaryKinfolk',
    event: 'portal.secondaryKinfolk.created',
    uid,
    extra: { kinfolkId, personId: ref.id },
  });
  return {
    person: { personId: ref.id, ...editable, access: 'NONE', memberUid: null, createdAt: null },
    created: true,
  };
}

/**
 * Deletes a secondary kinfolk who has no portal access. One with access
 * ('ACTIVE', a member doc exists) is refused, so this never strands a member.
 *
 * 'INVITED' is allowed on purpose: nothing resets a person whose invite was
 * revoked or expired, so refusing it would leave that record stuck forever. A
 * still-live invite for a deleted person can still be accepted; acceptInvite
 * creates the member as it always has and skips the missing person record.
 */
export async function removeSecondaryKinfolkHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const args = parseArgs(RemoveArgs, req.data);
  const { uid, kinfolkId } = await gate(req, args.kinfolkId, 'removeSecondaryKinfolk');
  const ref = db().doc(`families/${kinfolkId}/secondaryKinfolk/${args.personId}`);
  const existing = await ref.get();
  if (!existing.exists) throw new HttpsError('not-found', SECONDARY_KINFOLK_GONE_MESSAGE);
  if (asAccess((existing.data() ?? {})['access']) === 'ACTIVE') {
    throw new HttpsError('failed-precondition', SECONDARY_KINFOLK_HAS_ACCESS_MESSAGE);
  }
  await ref.delete();
  logEvent({
    severity: 'info',
    function: 'removeSecondaryKinfolk',
    event: 'portal.secondaryKinfolk.removed',
    uid,
    extra: { kinfolkId, personId: args.personId },
  });
  return { ok: true };
}

// AUNTIE_OPERATOR_UIDS because isOwner reads it inside requireKinfolkPrimary.
const OPTIONS = {
  region: 'us-central1' as const,
  cors: TRIBETAILS_CORS,
  secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
};

export const listSecondaryKinfolk = onCall(OPTIONS, wrapCallable('listSecondaryKinfolk', listSecondaryKinfolkHandler));
export const saveSecondaryKinfolk = onCall(OPTIONS, wrapCallable('saveSecondaryKinfolk', saveSecondaryKinfolkHandler));
export const removeSecondaryKinfolk = onCall(OPTIONS, wrapCallable('removeSecondaryKinfolk', removeSecondaryKinfolkHandler));
