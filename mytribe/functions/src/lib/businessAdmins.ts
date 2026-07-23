import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * Who the business-facing notifications go to, and who a visit is assigned to
 * when nobody picks an Auntie.
 *
 * Source of truth is `businessSettings/admins.uids`. That document had two
 * readers (this one's callers) and NO writer anywhere in the codebase, and in
 * prod it did not exist. 16 catalog keys name `businessAdmins` as their PRIMARY
 * resolver, including `kincare.requested`, `message.received` and
 * `rating.submitted.bad`, so every one of them threw "cannot dispatch" and the
 * operator was never told a booking had been requested. The same document backs
 * `resolveDefaultAssignee`, so every portal-created visit was also written
 * `assignedAuntieUid: null`.
 *
 * Resolution order:
 *   1. `businessSettings/admins.uids`, the explicit roster. Always wins.
 *   2. `AUNTIE_OPERATOR_UIDS`, the operator allowlist `lib/staffGate.ts`
 *      already treats as a trusted operator signal. When this arm is used the
 *      roster is written back, so the fallback is needed once rather than on
 *      every dispatch. The env var is a Secret Manager secret, so it only
 *      resolves inside functions that bind it; a function that does not is not
 *      silently wrong, it falls through to (3).
 *   3. Throw, naming the fix. `provisionBusinessAdmins` seeds the roster.
 *
 * Deliberately NOT a silent empty: a business notification nobody receives is
 * the failure this whole module exists to make impossible.
 */

const DOC_PATH = { collection: 'businessSettings', doc: 'admins' } as const;

interface AdminsDoc {
  uids?: string[];
  defaultAssigneeUid?: string;
}

function envOperatorUids(): string[] {
  return (process.env.AUNTIE_OPERATOR_UIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readAdminsDoc(): Promise<AdminsDoc | undefined> {
  const snap = await db().collection(DOC_PATH.collection).doc(DOC_PATH.doc).get();
  return snap.data() as AdminsDoc | undefined;
}

/**
 * Seed or update the roster. Idempotent, merge-only, and never narrows an
 * existing roster: `uids` is the union of what is stored and what is passed.
 */
export async function writeBusinessAdminUids(
  uids: string[],
  opts: { defaultAssigneeUid?: string; reason: string },
): Promise<string[]> {
  const existing = await readAdminsDoc();
  const merged = [...new Set([...(existing?.uids ?? []), ...uids])].filter(Boolean);
  if (merged.length === 0) return [];

  const payload: Record<string, unknown> = {
    uids: merged,
    updatedAt: FieldValue.serverTimestamp(),
  };
  // Only ever SET a default assignee, never overwrite one the operator chose.
  const nextDefault = existing?.defaultAssigneeUid ?? opts.defaultAssigneeUid ?? merged[0];
  if (nextDefault) payload['defaultAssigneeUid'] = nextDefault;

  await db().collection(DOC_PATH.collection).doc(DOC_PATH.doc).set(payload, { merge: true });
  logEvent({
    severity: 'info',
    function: 'businessAdmins',
    event: 'businessAdmins.roster.written',
    extra: { count: merged.length, reason: opts.reason },
  });
  return merged;
}

/**
 * The business admin uids. Throws (never returns empty) so a caller cannot
 * mistake "no admins configured" for "delivered to nobody, fine".
 */
export async function resolveBusinessAdminUids(context: string): Promise<string[]> {
  const data = await readAdminsDoc();
  const stored = (data?.uids ?? []).filter(Boolean);
  if (stored.length > 0) return stored;

  const fromEnv = envOperatorUids();
  if (fromEnv.length > 0) {
    logEvent({
      severity: 'warn',
      function: 'businessAdmins',
      event: 'businessAdmins.roster.healed',
      extra: {
        context,
        count: fromEnv.length,
        note: 'businessSettings/admins was empty; seeded from AUNTIE_OPERATOR_UIDS',
      },
    });
    return writeBusinessAdminUids(fromEnv, { reason: `self-heal:${context}` });
  }

  logEvent({
    severity: 'error',
    function: 'businessAdmins',
    event: 'businessAdmins.roster.missing',
    extra: {
      context,
      note: 'businessSettings/admins.uids is empty and AUNTIE_OPERATOR_UIDS is unset in this function',
    },
  });
  throw new Error(
    `${context}: businessSettings/admins.uids is empty, so this business notification has no recipient. `
      + 'Seed the roster by calling the provisionBusinessAdmins callable as an operator, '
      + 'or bind AUNTIE_OPERATOR_UIDS on this function to let it self-heal.',
  );
}

/** The stored default-assignee uid, or the first admin. Null when unset. */
export async function resolveDefaultAssigneeUid(): Promise<string | null> {
  const data = await readAdminsDoc();
  const explicit = typeof data?.defaultAssigneeUid === 'string' ? data.defaultAssigneeUid : '';
  if (explicit) return explicit;
  const stored = (data?.uids ?? []).filter(Boolean);
  if (stored.length > 0) return stored[0] ?? null;
  // Unlike the notification path this one is allowed to come back empty: an
  // unassigned visit is a working booking, so it must not fail the booking.
  return envOperatorUids()[0] ?? null;
}
