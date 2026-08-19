import { call } from '../lib/fns';
import { arr, str } from '../lib/coerce';

/**
 * "Did it actually go out?" — the read half of #396.
 *
 * The delivery pipeline has recorded per-channel status, provider message id,
 * skip reason, error text and attempt count on
 * `notificationDispatch/{id}/channels/{channel}` since the R5 split, and until
 * now nothing read them: no screen, no callable, on either client. This module
 * is the web side of `listNotificationDeliveries`
 * (mytribe/functions/src/admin/listNotificationDeliveries.ts), a NEW callable
 * added in the same change.
 *
 * WHAT IT DOES NOT DO. It does not tell you a message was delivered, because
 * nothing in this system knows that. `status: 'sent'` means a provider accepted
 * the message. The smtp2go and Twilio webhooks that carry real delivered /
 * bounced events match `external_messages` (the Communicate one-to-one sends)
 * by provider message id and never look at these channel subdocs, so catalog
 * notifications have no receipt to show. The callable says so in `sentMeaning`
 * and pins `receiptAvailable: false`; `lib/notificationProvenance.ts` renders
 * the wording. Do not upgrade any of it to a green "Delivered".
 *
 * `notificationDispatch` has no client read rule for admins (see
 * firestore.rules: reads are scoped to the recipient), so this is a callable
 * rather than a `useCollection` stream.
 */

export interface DeliveryAttempt {
  channel: string;
  /** 'pending' | 'sent' | 'skipped' | 'failed' | 'unknown', verbatim. */
  status: string;
  providerMessageId: string | null;
  skipReason: string | null;
  errorMessage: string | null;
  attempts: number;
  sentAtMs: number | null;
  failedAtMs: number | null;
  skippedAtMs: number | null;
}

export interface DeliveryRow {
  dispatchId: string;
  key: string;
  recipientUid: string;
  status: string;
  mode: string;
  channels: string[];
  createdAtMs: number | null;
  attempts: DeliveryAttempt[];
}

export interface DeliveryEvidence {
  deliveries: DeliveryRow[];
  /** The ceiling on what "sent" proves, in the server's own words. */
  sentMeaning: string;
  /** False until a provider webhook writes back to these channel subdocs. */
  receiptAvailable: boolean;
}

interface RawAttempt {
  channel?: string;
  status?: string;
  providerMessageId?: string | null;
  skipReason?: string | null;
  errorMessage?: string | null;
  attempts?: number;
  sentAtMs?: number | null;
  failedAtMs?: number | null;
  skippedAtMs?: number | null;
}

interface RawDelivery {
  dispatchId?: string;
  key?: string;
  recipientUid?: string;
  status?: string;
  mode?: string;
  channels?: string[];
  createdAtMs?: number | null;
  attempts?: RawAttempt[];
}

interface RawResult {
  deliveries?: RawDelivery[];
  sentMeaning?: string;
  receiptAvailable?: boolean;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function decodeAttempt(raw: RawAttempt): DeliveryAttempt {
  return {
    channel: str(raw.channel),
    // No default of 'sent'. An attempt with no status had no sender run, and
    // the whole point of this screen is that a missing fact reads as missing.
    status: str(raw.status) || 'unknown',
    providerMessageId: nullableStr(raw.providerMessageId),
    skipReason: nullableStr(raw.skipReason),
    errorMessage: nullableStr(raw.errorMessage),
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    sentAtMs: num(raw.sentAtMs),
    failedAtMs: num(raw.failedAtMs),
    skippedAtMs: num(raw.skippedAtMs),
  };
}

function decodeDelivery(raw: RawDelivery): DeliveryRow {
  return {
    dispatchId: str(raw.dispatchId),
    key: str(raw.key),
    recipientUid: str(raw.recipientUid),
    status: str(raw.status) || 'unknown',
    mode: str(raw.mode),
    // `arr` not `?? []`: a non-array `channels` throws on `.map` and blanks the
    // panel behind the error boundary.
    channels: arr<unknown>(raw.channels).map((c) => str(c)),
    createdAtMs: num(raw.createdAtMs),
    attempts: arr<RawAttempt>(raw.attempts).map(decodeAttempt),
  };
}

/**
 * The most recent dispatches, newest first, with their per-channel outcomes.
 * Pass `key` to narrow to one catalog row.
 */
export async function listNotificationDeliveries(
  args: { key?: string; limit?: number } = {},
): Promise<DeliveryEvidence> {
  const raw = await call<{ key?: string; limit?: number }, RawResult>(
    'listNotificationDeliveries',
    args,
  );
  return {
    deliveries: arr<RawDelivery>(raw.deliveries).map(decodeDelivery),
    sentMeaning: str(raw.sentMeaning),
    // Absent means the backend predates the field, and the safe read of an
    // unknown is "we have no receipt", never "we have one".
    receiptAvailable: raw.receiptAvailable === true,
  };
}
