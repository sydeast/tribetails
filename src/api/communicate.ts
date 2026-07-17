import { call } from '../lib/fns';
import { type SendCounts } from '../lib/communicateFormat';

/**
 * One `external_messages` row, as returned by the `listRecentSends` admin
 * callable (MyTribe/functions/src/admin/listRecentSends.ts, confirmed live
 * and deployed; see `listRecentSendsHandler`). Mirrors the wasm
 * `RecentSend`/`SendCounts` (screens/communicate/RecentSends.kt's
 * `decodeRecentSends`) field-for-field.
 *
 * ── ONE-SHOT, not a stream ──────────────────────────────────────────────
 * The Compose reference itself reads this the same way:
 * `FirestoreClient.listRecentSends()` calls
 * `platformInvokeCallable("listRecentSends", "{}")`, NOT a Firestore
 * listener (contrast `notificationsStream()`/`smsStream()`/`emailsStream()`
 * in the same file, which ARE listeners). The reason is structural, not a
 * style choice: `external_messages` has NO client Firestore read rule at all
 * (grepped MyTribe/firestore.rules, no `match /external_messages` anywhere,
 * and the file explicitly warns against a `match /{document=**}` catch-all
 * that would silently open one), so a client-side `onSnapshot` listener could
 * never work here regardless of `useCollection`'s order/limit guard; the
 * callable, which runs with the Admin SDK server-side, is the only read path.
 * The callable itself already does the AO-29-shaped bounding for us
 * server-side (`.collection('external_messages').orderBy('sentAtMs', 'desc')
 * .limit(30)`), so the 30 rows returned are always the newest 30, in order.
 *
 * `sentAtMs` is a plain epoch-ms NUMBER, not a Firestore Timestamp and not an
 * ISO string; format it via `lib/communicateFormat.ts`'s
 * `sendDayKey`/`sendClock`, never a raw `new Date(ms).toISOString().slice(0, 10)`.
 */
export interface RecentSend {
  id: string;
  channel: string;
  recipientRedacted: string;
  subject: string | null;
  sentAtMs: number;
  counts: SendCounts;
  lastEvent: string | null;
}

/**
 * `listRecentSends` (admin-gated via `wrapAdminCallable`): the Communicate
 * "Recent" sent-message history, newest-first (the server already orders by
 * `sentAtMs desc`, capped 30). Throws (via `lib/fns.call`) on auth/network
 * failure; the screen surfaces it fail-loud rather than swallowing it.
 */
export async function listRecentSends(): Promise<RecentSend[]> {
  const res = await call<Record<string, never>, { sends: RecentSend[] }>('listRecentSends', {});
  return res.sends ?? [];
}
