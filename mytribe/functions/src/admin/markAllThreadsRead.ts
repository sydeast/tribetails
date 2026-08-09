import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { markMessagesRead, CONVERSATIONS_COLLECTION } from '../lib/conversations';

/**
 * markAllThreadsRead (admin). Clears the admin-side unread flag on EVERY
 * conversation thread that is waiting on a reply, and returns how many it
 * actually cleared.
 *
 * ── WHY IT REUSES markMessagesRead RATHER THAN FLIPPING THE FLAG ──────────
 * "Read" is two pieces of state: `unreadForAdmin` on the thread summary (what
 * the Inbox list and the nav rail count) and `readAt` on each kinfolk message
 * (what the thread view renders, and what the kinfolk's own read receipts
 * would key off). `getConversationThread` advances both, via
 * `markMessagesRead`. A bulk clear that touched only the summary would make
 * "read" mean one thing on the list and another inside the thread, so this
 * calls the same helper per thread. It is idempotent and already tested.
 *
 * ── THE FLAG IS A BOOLEAN ─────────────────────────────────────────────────
 * `appendMessage` writes `unreadForAdmin: senderRole === 'kinfolk'`, a stored
 * BOOLEAN, never a count. The query below is therefore `== true`, not a range
 * predicate. A `> 0` filter would match nothing on real data and would quietly
 * report zero cleared threads on a full inbox.
 *
 * ── BOUNDED ───────────────────────────────────────────────────────────────
 * `conversations` holds one row per household, not one per message, so it is
 * small, but a callable that fans out one read+batch per matched row is still
 * unbounded work if the collection is unbounded. `MAX_THREADS_PER_BULK_READ`
 * caps a single call at the same 200 the client's `CONVERSATIONS_QUERY` uses.
 * Past that the operator presses the button again and the returned count says
 * what really happened, rather than the call timing out halfway with no answer.
 *
 * ── PERMISSION ────────────────────────────────────────────────────────────
 * `wrapAdminCallable` is the gate. Firestore rules are not in this path at all:
 * this runs on the Admin SDK, which bypasses them. (The plan asked to confirm
 * the `conversations` WRITE rule covers `unreadForAdmin`; it is moot, because
 * no client ever writes this field directly: every write goes through a
 * callable.)
 */

/** One call clears at most this many threads. See the bounded note above. */
export const MAX_THREADS_PER_BULK_READ = 200;

/**
 * The callable takes no arguments. Validating that explicitly, rather than
 * ignoring `req.data`, means a caller that thinks it is scoping the clear to
 * one household gets told it is not, instead of silently clearing everything.
 * A callable invoked with no payload arrives as `undefined`/`null`, so both are
 * normalized to the empty object first.
 */
const MarkAllArgs = z.preprocess(
  (v) => (v === undefined || v === null ? {} : v),
  z.strictObject({}),
);

export async function markAllThreadsReadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; cleared: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  try {
    MarkAllArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError(
        'invalid-argument',
        'markAllThreadsRead takes no arguments; use markConversationRead for a single thread.',
      );
    }
    throw err;
  }

  const snap = await db()
    .collection(CONVERSATIONS_COLLECTION)
    .where('unreadForAdmin', '==', true)
    .limit(MAX_THREADS_PER_BULK_READ)
    .get();

  const kinfolkIds = snap.docs.map((d) => d.id);
  if (kinfolkIds.length === 0) {
    // Nothing was waiting. No writes, and nothing to audit: an audit row per
    // idle button press would bury the presses that changed something.
    return { ok: true, cleared: 0 };
  }

  // Bounded fan-out. Sequential would be 200 round trips end to end; unbounded
  // Promise.all would open 200 concurrent batches against one collection.
  const CHUNK = 20;
  let cleared = 0;
  for (let i = 0; i < kinfolkIds.length; i += CHUNK) {
    const chunk = kinfolkIds.slice(i, i + CHUNK);
    try {
      await Promise.all(chunk.map((id) => markMessagesRead(id, 'auntie')));
    } catch (err) {
      // Fail LOUD, and say how far it got: the operator's next move differs
      // depending on whether nothing or almost everything was cleared, and the
      // Inbox reloads from the server either way so the badge stays honest.
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        severity: 'error',
        function: 'markAllThreadsRead',
        event: 'bulk.read.failed',
        uid,
        errorMessage: message,
      });
      throw new HttpsError(
        'internal',
        `markAllThreadsRead cleared ${cleared} of ${kinfolkIds.length} threads before failing: ${message}`,
      );
    }
    cleared += chunk.length;
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CONVERSATIONS_BULK_READ,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: CONVERSATIONS_COLLECTION,
    description: `Auntie marked ${cleared} conversation thread(s) read`,
    payload: { cleared, kinfolkIds },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'markAllThreadsRead',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true, cleared };
}

export const markAllThreadsRead = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('markAllThreadsRead', markAllThreadsReadHandler),
);
