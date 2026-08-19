import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { DISPATCH_COLLECTION } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * "Did it actually go out?" — the read path for the delivery pipeline (#396).
 *
 * `notificationDispatch/{id}` and its `channels/{channel}` subdocs have carried
 * per-channel status, provider message id, skip reason, error text and attempt
 * count since the R5 split, and until now NO screen and NO callable read a
 * single one of them. The operator could see the 44 things the platform can
 * send and nothing at all about whether any of them arrived.
 *
 * ## What "sent" means here, and what it does not
 *
 * `status: 'sent'` means a channel sender returned success — the message was
 * ACCEPTED BY THE PROVIDER. That is smtp2go accepting an email, Twilio queueing
 * an SMS, FCM enqueuing a push. It is not a delivery receipt and it is not an
 * open. The same caveat is already written on the audit entry in
 * `onNotificationChannelCreate`; this callable repeats it in `sentMeaning` so a
 * client cannot render a confident green "delivered" over a fact that only
 * supports "handed over".
 *
 * REAL DELIVERY RECEIPTS EXIST IN THIS REPO AND DO NOT REACH HERE. The smtp2go
 * and Twilio webhooks in `engagementWebhooks.ts` match events back by
 * `providerMessageId` against `external_messages` only — the Communicate
 * one-to-one sends. Catalog notifications write their `providerMessageId` to a
 * channel subdoc that no webhook ever queries, so there is genuinely no receipt
 * to show. Wiring those webhooks to also match channel subdocs is a real piece
 * of work and it is NOT this callable's job to fake it: `receiptAvailable` is
 * reported false, every time, on purpose.
 *
 * ## Shape
 *
 * One row per dispatch, newest first, each carrying its channel attempts. A key
 * filter narrows it to one catalog row (composite index `key` + `createdAt` in
 * firestore.indexes.json). Recipient uid is returned because the operator's own
 * question is "could this reach the wrong person", which is unanswerable
 * without knowing who it went to.
 */

/** What one channel attempt actually tells us. */
export interface DeliveryChannelRow {
  channel: string;
  /** 'pending' | 'sent' | 'skipped' | 'failed', verbatim from the subdoc. */
  status: string;
  /** Provider's id for the message, when the sender returned one. */
  providerMessageId: string | null;
  /** Why a fail-soft skip happened (e.g. recipient has no email on file). */
  skipReason: string | null;
  /** The thrown message on a failure. */
  errorMessage: string | null;
  /** Retry count the trigger has stamped. */
  attempts: number;
  sentAtMs: number | null;
  failedAtMs: number | null;
  skippedAtMs: number | null;
}

export interface DeliveryRow {
  dispatchId: string;
  key: string;
  recipientUid: string;
  /** 'pending' | 'dispatched' | 'no-channels' from the work order. */
  status: string;
  /** trigger / debounced / batched / scheduled. */
  mode: string;
  /** Channels the gate resolved for this recipient. Empty = fully suppressed. */
  channels: string[];
  createdAtMs: number | null;
  attempts: DeliveryChannelRow[];
}

export interface ListDeliveriesResult {
  deliveries: DeliveryRow[];
  /**
   * Plain-English ceiling on what `status: 'sent'` proves, so a client renders
   * the truth rather than a green tick it cannot back up.
   */
  sentMeaning: string;
  /** False until a provider webhook writes back to these channel subdocs. */
  receiptAvailable: boolean;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const Args = z
  .object({
    /** Narrow to one catalog key. Omit for the newest dispatches of any key. */
    key: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

const SENT_MEANING =
  'Sent means the provider accepted the message (smtp2go for email, Twilio for SMS, '
  + 'FCM for push). It is not proof it reached anyone: no delivery receipt is recorded '
  + 'for catalog notifications.';

/**
 * Epoch millis from whatever the field actually holds, or null.
 *
 * A live dispatch carries a Firestore `Timestamp`, but these documents predate
 * the R5 split and have been hand-seeded and backfilled, so a `Date` or a plain
 * millis number turns up too. Null for anything else: a timestamp this cannot
 * read is reported as absent, never as the epoch.
 */
function ms(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return typeof value === 'number' ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function listNotificationDeliveriesHandler(
  req: CallableRequest<unknown>,
): Promise<ListDeliveriesResult> {
  const args = Args.parse(req.data ?? {});
  const limit = args.limit ?? DEFAULT_LIMIT;

  const base = db().collection(DISPATCH_COLLECTION);
  const filtered = args.key ? base.where('key', '==', args.key) : base;
  const snap = await filtered.orderBy('createdAt', 'desc').limit(limit).get();

  const deliveries = await Promise.all(
    snap.docs.map(async (doc): Promise<DeliveryRow> => {
      const d = doc.data() as Record<string, unknown>;
      const channelSnap = await doc.ref.collection('channels').get();
      const attempts: DeliveryChannelRow[] = channelSnap.docs.map((c) => {
        const cd = c.data() as Record<string, unknown>;
        return {
          channel: c.id,
          // No default of 'sent'. A subdoc with no status is a subdoc whose
          // trigger has not run, and saying 'unknown' is the honest render.
          status: str(cd.status) || 'unknown',
          providerMessageId: strOrNull(cd.providerMessageId),
          skipReason: strOrNull(cd.skipReason),
          errorMessage: strOrNull(cd.errorMessage),
          attempts: typeof cd.attempts === 'number' ? cd.attempts : 0,
          sentAtMs: ms(cd.sentAt),
          failedAtMs: ms(cd.failedAt),
          skippedAtMs: ms(cd.skippedAt),
        };
      });
      attempts.sort((a, b) => a.channel.localeCompare(b.channel));
      return {
        dispatchId: doc.id,
        key: str(d.key),
        recipientUid: str(d.recipientUid),
        status: str(d.status) || 'unknown',
        mode: str(d.mode),
        channels: Array.isArray(d.channels) ? d.channels.map((c) => String(c)) : [],
        createdAtMs: ms(d.createdAt),
        attempts,
      };
    }),
  );

  return { deliveries, sentMeaning: SENT_MEANING, receiptAvailable: false };
}

export const listNotificationDeliveries = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listNotificationDeliveries', listNotificationDeliveriesHandler),
);
