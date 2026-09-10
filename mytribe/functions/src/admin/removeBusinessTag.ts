import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * removeBusinessTag (admin). Deletes ONE tag from a vocabulary and strips that
 * tag off every record carrying it.
 *
 * ── WHY THIS EXISTS (issue #713) ──────────────────────────────────────────
 * Removing a tag used to be a client-side filter of the vocabulary list on
 * `business_settings`, and nothing else. Every household and kin already
 * carrying the name kept it, rendering as a neutral chip. The operator ruled
 * that wrong: "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY." So a
 * delete is now a cascade, and it has to run on the server: the two clients
 * (React admin, android admin) would each have to fan out over the whole
 * directory otherwise, and a fan-out that half-finishes on a flaky phone is
 * the state this callable exists to prevent.
 *
 * ── EXACTLY WHAT IT TOUCHES ───────────────────────────────────────────────
 *   scope 'household' -> `kinfolk/{id}.tags`  + `business_settings.householdTags`
 *   scope 'pet'       -> `kin/{id}.tags`      + `business_settings.petTags`
 *
 * Nothing else. The two vocabularies are independent lists and the same name
 * may legitimately exist in both ("Meds Needed" on a household and on a pet),
 * so a household delete must never reach into `kin`. There is no third copy of
 * an assignment: the nested `families/{kinfolkId}/kin/{kinId}` doc carries no
 * `tags` field (grepped every writer under functions/src), and
 * `onFamilyKinWrite`'s flat-mirror payload does not include one, so the flat
 * `kin/{id}` doc is the only home a pet tag has.
 *
 * ── ORDER: ASSIGNMENTS FIRST, VOCABULARY LAST ─────────────────────────────
 * A failure partway through leaves the tag still in the vocabulary, so the
 * operator sees the row, presses Remove again, and the retry finishes the job.
 * The reverse order would drop the vocabulary entry first and leave orphaned
 * assignments with nothing in the editor to remove them by, which is precisely
 * the bug being fixed.
 *
 * ── MATCHING IS CASE-INSENSITIVE, SO THE SCAN IS IN MEMORY ────────────────
 * `resolveTag` on both clients treats "vip" and "VIP" as one tag, and the
 * profile assign field stores whatever casing was canonical at the time. A
 * `where('tags', 'array-contains', name)` query is exact-case and would leave
 * the odd-cased assignments behind, which reads to the operator as the delete
 * having silently not worked. The collection is read and filtered here
 * instead. `kinfolk` and `kin` are the directory's own collections, already
 * read whole by the admin Directory screen (KINFOLK_QUERY caps at 500), so
 * this is the same order of work that screen does on every load.
 *
 * The write is a WHOLE-LIST replace, matching `updateKinfolkTags` /
 * `updateKinTags` on the client. `FieldValue.arrayRemove` was rejected for the
 * same reason as `array-contains`: it matches elements exactly and would skip
 * "vip".
 *
 * ── IDEMPOTENT ────────────────────────────────────────────────────────────
 * A name that is not in the vocabulary is not an error. It is exactly the
 * state a half-finished earlier run leaves behind, and refusing it would
 * strand the assignments forever. The strip runs regardless and
 * `vocabRemoved` reports whether a vocabulary row was actually dropped.
 */

/** Which vocabulary, and therefore which collection, this delete acts on. */
const SCOPES = {
  household: { collection: 'kinfolk', vocabField: 'householdTags', noun: 'household' },
  pet: { collection: 'kin', vocabField: 'petTags', noun: 'kin' },
} as const;

export const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/**
 * Firestore caps a batch at 500 writes. 400 leaves room without needing a
 * second constant if a stamp is ever added to these writes.
 */
export const TAG_STRIP_BATCH_SIZE = 400;

/**
 * 40 matches `MAX_TAG_NAME_LENGTH` in the React model and the Kotlin twin, so a
 * name that can be authored can always be deleted.
 */
const MAX_TAG_NAME_LENGTH = 40;

// Exported so `test/callableContract.test.ts` can freeze the request shape: two
// clients (React admin, android admin) hand-mirror this payload.
export const Args = z.object({
  scope: z.enum(['household', 'pet']),
  name: z.string().trim().min(1, 'A tag name is required.').max(MAX_TAG_NAME_LENGTH),
});

export const Result = z
  .object({
    ok: z.literal(true),
    scope: z.enum(['household', 'pet']),
    /** The name as matched, echoed back so a toast can name it. */
    name: z.string().min(1),
    /** How many kinfolk (or kin) docs had the tag stripped off them. */
    recordsTouched: z.number().int().min(0),
    /** False when the vocabulary did not carry the name (an already-part-done delete). */
    vocabRemoved: z.boolean(),
  })
  .strict();

/** Trim and collapse whitespace runs, mirroring `normalizeTagName` on both clients. */
function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** The comparison key every match here uses: normalized, then lowercased. */
function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/** Keep only the string entries; a legacy or malformed `tags` never yields a non-string row. */
function readTagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string');
}

/** A vocabulary row keeps its shape; only the matching entry is dropped. */
function filterVocab(raw: unknown, key: string): { next: unknown[]; removed: boolean } {
  if (!Array.isArray(raw)) return { next: [], removed: false };
  const next = raw.filter((entry) => {
    if (entry === null || typeof entry !== 'object') return true;
    const name = (entry as Record<string, unknown>)['name'];
    return typeof name !== 'string' || tagKey(name) !== key;
  });
  return { next, removed: next.length !== raw.length };
}

export async function removeBusinessTagHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'removeBusinessTag validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const scope = SCOPES[args.scope];
  const name = normalizeTagName(args.name);
  const key = tagKey(name);
  const firestore = db();

  // ── 1. Strip the tag off every record carrying it ───────────────────────
  const snap = await firestore.collection(scope.collection).get();
  const carriers = snap.docs
    .map((d) => ({ id: d.id, tags: readTagNames((d.data() ?? {})['tags']) }))
    .filter((row) => row.tags.some((t) => tagKey(t) === key));

  let recordsTouched = 0;
  for (let i = 0; i < carriers.length; i += TAG_STRIP_BATCH_SIZE) {
    const chunk = carriers.slice(i, i + TAG_STRIP_BATCH_SIZE);
    const batch = firestore.batch();
    for (const row of chunk) {
      batch.set(
        firestore.collection(scope.collection).doc(row.id),
        {
          tags: row.tags.filter((t) => tagKey(t) !== key),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    try {
      await batch.commit();
    } catch (err) {
      // Fail LOUD and say how far it got. The vocabulary row is deliberately
      // still there, so pressing Remove again finishes what this started.
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        severity: 'error',
        function: 'removeBusinessTag',
        event: 'tag.strip.failed',
        uid,
        errorMessage: message,
        extra: { scope: args.scope, name, recordsTouched, carriers: carriers.length },
      });
      throw new HttpsError(
        'internal',
        `removeBusinessTag stripped '${name}' from ${recordsTouched} of ${carriers.length} ${scope.noun} record(s) before failing: ${message}`,
      );
    }
    recordsTouched += chunk.length;
  }

  // ── 2. Drop the vocabulary entry ────────────────────────────────────────
  const settingsRef = firestore.doc(BUSINESS_SETTINGS_DOC);
  const settingsSnap = await settingsRef.get();
  const stored = (settingsSnap.data() ?? {}) as Record<string, unknown>;
  const { next, removed } = filterVocab(stored[scope.vocabField], key);
  if (removed) {
    await settingsRef.set(
      { [scope.vocabField]: next, updatedAt: new Date().toISOString(), updatedBy: uid },
      { merge: true },
    );
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BUSINESS_TAG_REMOVED,
    // A delete that touched records is the one worth finding later: the
    // assignments it cleared are not recoverable from the vocabulary row.
    severity: recordsTouched > 0 ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: scope.collection,
    description: `Tag '${name}' deleted from the ${args.scope} vocabulary and stripped from ${recordsTouched} ${scope.noun} record(s)`,
    payload: {
      scope: args.scope,
      name,
      recordsTouched,
      vocabRemoved: removed,
      recordIds: carriers.map((c) => c.id),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'removeBusinessTag',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'removeBusinessTag',
    event: 'admin.tag.removed',
    uid,
    extra: { scope: args.scope, name, recordsTouched, vocabRemoved: removed },
  });

  return { ok: true, scope: args.scope, name, recordsTouched, vocabRemoved: removed };
}

export const removeBusinessTag = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('removeBusinessTag', removeBusinessTagHandler),
);
