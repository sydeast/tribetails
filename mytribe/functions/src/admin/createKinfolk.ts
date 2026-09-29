import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { KINFOLK_DUPLICATE_WINDOW_MS, duplicateMatch, type DuplicateMatch } from '../lib/kinfolkDuplicate';

/**
 * #890: the one way an admin client creates a household (`kinfolk/{id}`).
 *
 * WHY A CALLABLE NOW. Admin web, admin Android and the desktop console used to
 * `add()` the document directly (rules-backed). Add Kinfolk creates the household
 * and then saves its Emergency Contact through `saveEmergencyContacts`. When that
 * second save failed and the operator left the screen, web and desktop lost the
 * created id, and the next Add made a second household for the same family. The
 * clients now keep the pending household, and this callable is the safety net
 * behind them: a create that looks like the one this operator just made returns
 * that household instead of a new one.
 *
 * THE DUPLICATE RULE (`lib/kinfolkDuplicate.ts`): created by the SAME operator uid,
 * within the last 10 minutes, with the same primary phone or the same primary
 * email (normalised; a blank never matches). The answer is then
 * `{ kinfolkId: <existing>, duplicateOf: <existing> }` and nothing is written.
 *
 * WHAT THE CALLER SENDS. `{ kinfolk: {...} }`, the fields each client already
 * wrote directly: web's six, and the whole Android and desktop models. The fields
 * pass through as sent, apart from SERVER_OWNED_KEYS, which are dropped: the
 * Emergency Contact keys (only saveEmergencyContacts writes those, as the rules
 * say), a document id, and the stamps this callable owns.
 *
 * WHAT IT STAMPS. `createdAt` (server time), `createdAtSource: 'live'` (see
 * mytribe/scripts/createdAtProvenance.ts) and `createdByUid`. `updatedAt` is left
 * exactly as sent: desktop decodes it as a String on this collection.
 *
 * THE ONLY WAY IN (#909). `firestore.rules` refuses a staff client's direct
 * create of a kinfolk doc, so every household an admin makes passes the duplicate
 * check. The one direct create left is a sandbox test admin's own
 * `kinfolk/{testTribeId}`, which this callable refuses them anyway.
 *
 * AUDIT (#909). A created household writes one `CREATE_KINFOLK` entry to
 * `activity_log`, here and nowhere else. Android and desktop used to write it
 * from the client after the create, and admin web wrote none. A `duplicateOf`
 * answer creates nothing and writes no entry: the household was audited when it
 * was made.
 */

const EMERGENCY_CONTACT_KEYS = ['emergencyContacts', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'];

export const SERVER_OWNED_KEYS: readonly string[] = [
  ...EMERGENCY_CONTACT_KEYS,
  'id',
  '_id',
  'createdAt',
  'createdAtSource',
  'createdByUid',
  'myTribeLinkedAt',
  'isTestData',
];

export const Args = z
  .object({
    kinfolk: z.record(z.string(), z.unknown()),
    /**
     * #907 review: the household the operator just chose to Discard on the Add
     * prompt. Discard means "this is a new household", so the duplicate check
     * skips THIS id. Only the caller's own households are candidates at all, so
     * an id created by another operator changes nothing.
     */
    ignoreDuplicateOf: z.string().optional(),
  })
  .strict();

export const Result = z
  .object({
    kinfolkId: z.string(),
    duplicateOf: z.string().nullable(),
  })
  .strict();

export type CreateKinfolkResult = z.infer<typeof Result>;

export const FIRST_NAME_REQUIRED_MESSAGE = 'A household needs a first name.';

/**
 * #829, operator ruling 2026-09-27: "PK: contact info required". The primary
 * kinfolk is the household's one required person, so a household cannot be
 * created with no way to reach them. A phone OR an email is enough; the ruling
 * says contact info, not both. Checked on create only: households that already
 * exist with neither keep saving, the same way a missing Emergency Contact
 * never blocks an edit.
 */
export const PRIMARY_CONTACT_REQUIRED_MESSAGE = 'The primary kinfolk needs a phone number or an email.';

/** The keys that count as a way to reach the primary. */
export const PRIMARY_CONTACT_KEYS: readonly string[] = ['phoneNumber', 'secondaryPhone', 'email'];

export function hasPrimaryContact(kinfolk: Record<string, unknown>): boolean {
  return PRIMARY_CONTACT_KEYS.some((k) => {
    const v = kinfolk[k];
    return typeof v === 'string' && v.trim() !== '';
  });
}

function millisOf(v: unknown): number {
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis();
  }
  return 0;
}

/** "First Last" as the admin clients display it, or "Kinfolk" when both are blank. */
export function householdName(kinfolk: Record<string, unknown>): string {
  const part = (k: string) => (typeof kinfolk[k] === 'string' ? (kinfolk[k] as string).trim() : '');
  return [part('firstName'), part('lastName')].filter((p) => p !== '').join(' ') || 'Kinfolk';
}
export async function createKinfolkHandler(req: CallableRequest<unknown>): Promise<CreateKinfolkResult> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const parsed = Args.safeParse(req.data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'createKinfolk takes { kinfolk: { ...household fields } }.');
  }
  const firstName = parsed.data.kinfolk['firstName'];
  if (typeof firstName !== 'string' || firstName.trim() === '') {
    throw new HttpsError('invalid-argument', FIRST_NAME_REQUIRED_MESSAGE);
  }
  if (!hasPrimaryContact(parsed.data.kinfolk)) {
    throw new HttpsError('invalid-argument', PRIMARY_CONTACT_REQUIRED_MESSAGE);
  }
  const body = Object.fromEntries(Object.entries(parsed.data.kinfolk).filter(([k]) => !SERVER_OWNED_KEYS.includes(k)));
  const ignoreDuplicateOf = parsed.data.ignoreDuplicateOf?.trim() || null;

  const firestore = db();
  const since = Timestamp.fromMillis(Date.now() - KINFOLK_DUPLICATE_WINDOW_MS);
  const recent = firestore.collection('kinfolk').where('createdAt', '>=', since);

  // One transaction, so the lookup and the create share a snapshot: two presses
  // racing each other cannot both find nothing and both write.
  const outcome = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(recent);
    let found: { id: string; match: DuplicateMatch; at: number } | null = null;
    for (const doc of snap.docs) {
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      if (data['createdByUid'] !== uid) continue;
      // After the uid filter on purpose: only the caller's own household can be skipped.
      if (doc.id === ignoreDuplicateOf) continue;
      const match = duplicateMatch(body, data);
      if (match === null) continue;
      const at = millisOf(data['createdAt']);
      if (found === null || at > found.at) found = { id: doc.id, match, at };
    }
    if (found !== null) return { kinfolkId: found.id, duplicateOf: found.id, match: found.match };

    const ref = firestore.collection('kinfolk').doc();
    tx.create(ref, {
      ...body,
      createdAt: FieldValue.serverTimestamp(),
      createdAtSource: 'live',
      createdByUid: uid,
    });
    return { kinfolkId: ref.id, duplicateOf: null, match: null };
  });

  // Ids and the kind of match only: never a name, a phone or an email.
  if (outcome.duplicateOf !== null) {
    logEvent({
      severity: 'warn',
      function: 'createKinfolk',
      event: 'kinfolk.create.duplicate',
      uid,
      extra: { kinfolkId: outcome.kinfolkId, match: outcome.match },
    });
  } else {
    logEvent({ severity: 'info', function: 'createKinfolk', event: 'kinfolk.created', uid, extra: { kinfolkId: outcome.kinfolkId } });
    // After the create's own transaction: writeAuditEntry runs a transaction of its
    // own on the chain head, and nesting the two is not possible. The description
    // is the wording the desktop console wrote from the client.
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.CREATE_KINFOLK,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: outcome.kinfolkId,
      targetCollection: 'kinfolk',
      description: `Added Kinfolk ${householdName(body)}`,
    });
  }
  return { kinfolkId: outcome.kinfolkId, duplicateOf: outcome.duplicateOf };
}

// AUNTIE_OPERATOR_UIDS because isOwner (inside wrapAdminCallable) reads it.
export const createKinfolk = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('createKinfolk', createKinfolkHandler),
);
