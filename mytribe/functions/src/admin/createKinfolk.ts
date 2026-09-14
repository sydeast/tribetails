import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
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
 * NOT CLOSED HERE. `firestore.rules` still lets staff create a kinfolk doc
 * directly, so an old client install goes around this check. Tightening that rule
 * is a separate change.
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

function millisOf(v: unknown): number {
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis();
  }
  return 0;
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
  const body = Object.fromEntries(Object.entries(parsed.data.kinfolk).filter(([k]) => !SERVER_OWNED_KEYS.includes(k)));

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
  }
  return { kinfolkId: outcome.kinfolkId, duplicateOf: outcome.duplicateOf };
}

// AUNTIE_OPERATOR_UIDS because isStaff (inside wrapAdminCallable) reads it.
export const createKinfolk = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('createKinfolk', createKinfolkHandler),
);
