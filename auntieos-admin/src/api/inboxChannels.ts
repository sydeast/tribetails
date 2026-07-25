import { type CollectionSpec } from '../lib/firestore';
import type { ChannelKey } from '../lib/inboxChannels';

/**
 * The four external communication channels: voicemails, calls, SMS and email.
 *
 * ── NO CALLABLE, AND NO NEW ONE NEEDED ──────────────────────────────────────
 * All four collections are `allow read, write: if isAuntie()` in
 * `mytribe/firestore.rules` (calls_log:674, emails:698, sms_messages:735,
 * voicemails:745, mirrored byte-for-byte in `auntieos-admin/web/firestore.rules`),
 * so an operator reads them directly. `api/recipientContext.ts` already reads
 * these exact four for the Communicate panel and this module reuses that
 * finding rather than re-deriving it. The difference is the QUESTION: the
 * recipient panel asks "what has happened with THIS household", so it filters
 * by `kinfolkId` and orders by `__name__` to avoid a composite index. The Inbox
 * asks "what came in most recently, from anyone", so it carries NO filter and
 * orders by `timestamp` descending, which a single-field automatic index
 * already serves. Neither query needs anything deployed.
 *
 * ── `timestamp` IS AN ISO STRING, NOT A Timestamp ───────────────────────────
 * Every writer stamps `new Date().toISOString()`: `twilioInboundSms` /
 * `twilioInboundVoicemail` / `twilioInboundCall` in
 * `mytribe/functions/src/twilio/twilioInbound.ts`, and the Android writers they
 * replace (`AuntieRepository.createInboundSmsLog` and siblings). Firestore
 * orders EVERY Timestamp after EVERY string, so a Timestamp bound against this
 * field matches nothing and does not error. Ordering lexically is correct for
 * ISO-8601 UTC and is exactly what Android's `observeCalls` /
 * `observeVoicemails` / `observeSmsMessages` already do.
 *
 * A second, quieter consequence of ordering on `timestamp`: Firestore's ORDER
 * BY skips documents that LACK the field, the same way an equality does. Every
 * writer above sets it unconditionally, so nothing is dropped today, and a
 * future writer that forgets it would make its rows invisible here rather than
 * raise an error. Named so it is not re-learned from an empty screen.
 *
 * ── A SANDBOX ACCOUNT TAKES NO DENIED READ ──────────────────────────────────
 * All four are already in `SUPPRESSED_IN_TEST_MODE` (`lib/testScope.ts`), which
 * `useCollection` honours CENTRALLY: for a test admin the listener is never
 * opened and the state resolves `ready` with an empty list. That only holds
 * because every read below goes through `useCollection`. A raw `getDocs` here
 * would bypass the suppression and put four red permission banners on the Inbox
 * for a sandbox operator, which is the exact failure that set exists to
 * prevent.
 */

/**
 * Rows fetched per channel. The same 200 the rail's `CONVERSATIONS_QUERY` and
 * `NOTIFICATIONS_QUERY` use. These collections grow one row per message rather
 * than one row per household, so the cap is doing real work here: it is the
 * difference between a bounded listener and AO-29.
 */
export const CHANNEL_MAX = 200;

/**
 * One `voicemails` document, narrowed to what the Inbox renders.
 *
 * A CAST over Firestore data, not a validation of it, so every field is
 * optional and read through `lib/coerce`'s `str`/`arr` at the point of use
 * (`lib/inboxChannels.ts`). `kinfolkId` is explicitly `string | null` because
 * `twilioInboundVoicemail` writes a literal `null` when the caller's number
 * matches no household, which is the common case for a first-time caller.
 */
export interface VoicemailRow {
  _id: string;
  kinfolkId?: string | null;
  kinfolkName?: string;
  callerNumber?: string;
  transcript?: string;
  audioUrl?: string;
  durationSec?: number;
  timestamp?: string;
  /** unread | read | replied | dismissed. Casing is unenforced; normalize in memory. */
  replyStatus?: string;
}

/** One `calls_log` document, narrowed to what the Inbox renders. */
export interface CallRow {
  _id: string;
  kinfolkId?: string | null;
  kinfolkName?: string;
  counterpartNumber?: string;
  direction?: string;
  /** answered | missed | declined | voicemail, plus whatever Twilio's CallStatus sends. */
  status?: string;
  transcript?: string;
  recordingUrl?: string;
  durationSec?: number;
  timestamp?: string;
}

/** One `sms_messages` document, narrowed to what the Inbox renders. */
export interface SmsRow {
  _id: string;
  kinfolkId?: string | null;
  kinfolkName?: string;
  counterpartNumber?: string;
  direction?: string;
  subType?: string;
  body?: string;
  mediaUrls?: string[];
  timestamp?: string;
  status?: string;
}

/** One `emails` document, narrowed to what the Inbox renders. */
export interface EmailRow {
  _id: string;
  kinfolkId?: string | null;
  kinfolkName?: string;
  fromAddress?: string;
  toAddresses?: string[];
  subject?: string;
  body?: string;
  attachmentUrls?: string[];
  direction?: string;
  timestamp?: string;
}

function channelSpec(path: string): CollectionSpec {
  return { path, order: ['timestamp', 'desc'], max: CHANNEL_MAX };
}

export const VOICEMAILS_QUERY: CollectionSpec = channelSpec('voicemails');
export const CALLS_QUERY: CollectionSpec = channelSpec('calls_log');
export const SMS_QUERY: CollectionSpec = channelSpec('sms_messages');
export const EMAILS_QUERY: CollectionSpec = channelSpec('emails');

/**
 * The four streams, in the order their filter chips appear, so the screen
 * cannot list a chip it has no listener for or open a listener with no chip.
 * `what` is the noun `AsyncRegion` prints in "Couldn't load ___", which is why
 * each is lower-case and plural.
 */
export const CHANNEL_STREAMS: readonly { channel: ChannelKey; spec: CollectionSpec; what: string }[] = [
  { channel: 'voicemail', spec: VOICEMAILS_QUERY, what: 'voicemails' },
  { channel: 'call', spec: CALLS_QUERY, what: 'calls' },
  { channel: 'sms', spec: SMS_QUERY, what: 'text messages' },
  { channel: 'email', spec: EMAILS_QUERY, what: 'emails' },
];
