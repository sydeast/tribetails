import { str, arr } from './coerce';
import { sessionTimeOf } from './sessionFormat';
import { formatWhen, machineWhen } from './time';
import type { CallRow, EmailRow, SmsRow, VoicemailRow } from '../api/inboxChannels';

/**
 * Pure classification and merge logic for the Inbox's four external channels,
 * kept out of the screen so every rule has direct vitest coverage (the
 * `inboxFormat.ts` / `sessionFormat.ts` / `invoiceFormat.ts` convention).
 *
 * The unified row shape below is a deliberate port of Android's `InboxEntry`
 * (`ui/inbox/InboxScreen.kt`), field for field, so the two clients describe the
 * same voicemail the same way rather than each inventing a preview rule.
 *
 * ── THE WORD "UNREAD" IS NOT USED HERE, AND THAT IS THE POINT ───────────────
 * The nav rail carries ONE app-wide number, unread kinfolk message threads, off
 * ONE bounded listener on `conversations` (`lib/useUnreadInbox.ts`), and the
 * Inbox header badge sums the same thread count with the notifications count.
 * Channels deliberately contribute NOTHING to either, for two reasons that
 * stand on their own:
 *
 *  1. Feeding channels into the rail means a SECOND app-wide listener for a
 *     badge, on collections that grow one document per message rather than one
 *     per household. That is the cost `useUnreadInbox` was written to avoid.
 *  2. Feeding channels into the SCREEN badge but not the rail is worse: the
 *     same word would print two different numbers on two surfaces, and an
 *     operator has no way to tell which one is lying.
 *
 * So a voicemail nobody has answered is counted here under a DIFFERENT NOUN,
 * `awaitingReplyCount`, rendered as "N waiting on a reply" inside the Channels
 * panel where it is actionable. Two different claims, no collision, and no
 * second listener. A voicemail's `replyStatus` is genuinely a different fact
 * from a thread's `unreadForAdmin`: one asks whether the operator has WRITTEN
 * BACK, the other whether they have LOOKED.
 */

export type ChannelKey = 'voicemail' | 'call' | 'sms' | 'email';

/** `all` plus one per channel. Mirrors Android's `Channel` enum, same order. */
export type ChannelFilterKey = 'all' | ChannelKey;

export interface ChannelFilterDef {
  readonly key: ChannelFilterKey;
  readonly label: string;
}

/**
 * "All channels", not "All". The Messages section on the same screen already
 * has an "All" tab, and two controls sharing one accessible name is how a
 * screen-reader user (and every `getByRole('tab', { name: 'All' })` in the
 * suite) loses track of which list is being filtered.
 */
export const CHANNEL_FILTERS: readonly ChannelFilterDef[] = [
  { key: 'all', label: 'All channels' },
  { key: 'voicemail', label: 'Voicemails' },
  { key: 'call', label: 'Calls' },
  { key: 'sms', label: 'SMS' },
  { key: 'email', label: 'Emails' },
];

// ── normalizers: every one is a POSITIVE match, with an honest unknown ──────
//
// `status`, `direction` and `replyStatus` casing is unenforced on all four
// collections (the Android writers, the Twilio webhooks and the python
// reconcile pipeline each write their own), so every check below lower-cases in
// MEMORY and matches the literal it wants. None of it is expressible as a
// server equality: `where('status','==','missed')` would invisibly drop every
// row stored as `Missed`, and on this screen a dropped row is a call the
// operator never learns about.

export type ChannelDirection = 'inbound' | 'outbound' | 'unknown';

export function channelDirection(raw: string | null | undefined): ChannelDirection {
  switch (str(raw).trim().toLowerCase()) {
    case 'inbound':
      return 'inbound';
    case 'outbound':
      return 'outbound';
    default:
      return 'unknown';
  }
}

/** Every state `voicemails.replyStatus` can honestly report. */
export type VoicemailReplyState = 'unread' | 'read' | 'replied' | 'dismissed' | 'unknown';

/**
 * A voicemail with NO `replyStatus` reads as `unknown`, not as `unread`.
 *
 * The distinction pays for itself in `awaitingReplyCount`: only a row that
 * really says `unread` is counted as waiting, so a legacy voicemail written
 * before the field existed cannot inflate a number the operator is expected to
 * act on.
 */
export function voicemailReplyState(raw: string | null | undefined): VoicemailReplyState {
  switch (str(raw).trim().toLowerCase()) {
    case 'unread':
      return 'unread';
    case 'read':
      return 'read';
    case 'replied':
      return 'replied';
    case 'dismissed':
      return 'dismissed';
    default:
      return 'unknown';
  }
}

/** Every outcome `calls_log.status` can honestly report. */
export type CallOutcome = 'answered' | 'missed' | 'declined' | 'voicemail' | 'unknown';

export function callOutcome(raw: string | null | undefined): CallOutcome {
  switch (str(raw).trim().toLowerCase()) {
    case 'answered':
    case 'completed':
      return 'answered';
    case 'missed':
    case 'no-answer':
      return 'missed';
    case 'declined':
    case 'busy':
      return 'declined';
    case 'voicemail':
      return 'voicemail';
    default:
      return 'unknown';
  }
}

// ── the unified row ────────────────────────────────────────────────────────

/**
 * One row of the merged channel list. Ported from Android's `InboxEntry`.
 *
 * `replyPhone` and `replyEmail` are separate rather than one `replyTo`, because
 * the action they unlock is different (a text versus an email) and a single
 * field would need a second field to say which kind it held.
 */
export interface InboxEntry {
  id: string;
  channel: ChannelKey;
  /** ISO-8601 UTC, or `''` when the document carries none. Compared lexically. */
  timestamp: string;
  kinfolkName: string;
  /** The other party: a phone number or an email address. */
  counterpart: string;
  preview: string;
  direction: ChannelDirection;
  /** A short state word for the row's pill, or `''` when the row has nothing to flag. */
  statusHint: string;
  mediaCount: number;
  replyPhone: string;
  replyEmail: string;
  kinfolkId: string;
  /** Voicemail audio (or a call recording), for the in-row player. */
  playbackUrl: string;
  /** Non-empty only for a voicemail, whose reply state this screen can write. */
  voicemailId: string;
}

/** Longest preview a row renders. Android takes 120 to 160 by channel; one number here. */
export const PREVIEW_MAX = 140;

function preview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, PREVIEW_MAX).trimEnd()}…`;
}

/** `kinfolkId` is written as a literal `null` on a no-match, so read it defensively. */
function idOf(raw: string | null | undefined): string {
  return str(raw).trim();
}

export function voicemailEntry(row: VoicemailRow): InboxEntry {
  const state = voicemailReplyState(row.replyStatus);
  return {
    id: row._id,
    channel: 'voicemail',
    timestamp: str(row.timestamp).trim(),
    kinfolkName: str(row.kinfolkName).trim(),
    counterpart: str(row.callerNumber).trim(),
    // A voicemail with no transcription yet is NOT an empty message; it is a
    // recording nobody has transcribed. Saying so beats a blank line, and the
    // player below is still the real content.
    preview: preview(str(row.transcript)) || '(no transcript yet)',
    // Voicemails are inbound by definition; Android drops the pip for the same
    // reason rather than printing "received" on every row.
    direction: 'inbound',
    statusHint: state === 'unread' ? 'unread' : state === 'replied' ? 'replied' : '',
    mediaCount: 0,
    replyPhone: str(row.callerNumber).trim(),
    replyEmail: '',
    kinfolkId: idOf(row.kinfolkId),
    playbackUrl: str(row.audioUrl).trim(),
    voicemailId: row._id,
  };
}

export function callEntry(row: CallRow): InboxEntry {
  const outcome = callOutcome(row.status);
  const transcript = preview(str(row.transcript));
  const fallback =
    outcome === 'missed'
      ? 'Missed call'
      : outcome === 'voicemail'
        ? 'Left a voicemail'
        : outcome === 'declined'
          ? 'Call declined'
          : outcome === 'answered'
            ? `Call (${callDuration(row.durationSec)})`
            : // An unrecognized status is still the news. Printing it verbatim
              // beats printing nothing, and beats guessing which bucket it is.
              str(row.status).trim() !== ''
              ? `Call · ${str(row.status).trim()}`
              : 'Call';
  return {
    id: row._id,
    channel: 'call',
    timestamp: str(row.timestamp).trim(),
    kinfolkName: str(row.kinfolkName).trim(),
    counterpart: str(row.counterpartNumber).trim(),
    preview: transcript !== '' ? transcript : fallback,
    direction: channelDirection(row.direction),
    statusHint: outcome === 'missed' ? 'missed' : '',
    mediaCount: 0,
    replyPhone: str(row.counterpartNumber).trim(),
    replyEmail: '',
    kinfolkId: idOf(row.kinfolkId),
    playbackUrl: str(row.recordingUrl).trim(),
    voicemailId: '',
  };
}

export function smsEntry(row: SmsRow): InboxEntry {
  return {
    id: row._id,
    channel: 'sms',
    timestamp: str(row.timestamp).trim(),
    kinfolkName: str(row.kinfolkName).trim(),
    counterpart: str(row.counterpartNumber).trim(),
    preview: preview(str(row.body)),
    direction: channelDirection(row.direction),
    statusHint: '',
    mediaCount: arr<string>(row.mediaUrls).length,
    replyPhone: str(row.counterpartNumber).trim(),
    replyEmail: '',
    kinfolkId: idOf(row.kinfolkId),
    playbackUrl: '',
    voicemailId: '',
  };
}

export function emailEntry(row: EmailRow): InboxEntry {
  const direction = channelDirection(row.direction);
  // On an outbound email the interesting party is the RECIPIENT; on an inbound
  // one it is the sender. An `unknown` direction falls back to the sender,
  // because that is the field an inbound row (the common case) always carries.
  const person =
    direction === 'outbound' ? str(arr<string>(row.toAddresses)[0]).trim() : str(row.fromAddress).trim();
  const subject = str(row.subject).trim();
  const body = str(row.body).trim();
  return {
    id: row._id,
    channel: 'email',
    timestamp: str(row.timestamp).trim(),
    kinfolkName: str(row.kinfolkName).trim(),
    counterpart: person,
    preview: preview([subject, body].filter((p) => p !== '').join(' · ')),
    direction,
    statusHint: '',
    mediaCount: arr<string>(row.attachmentUrls).length,
    replyPhone: '',
    replyEmail: person,
    kinfolkId: idOf(row.kinfolkId),
    playbackUrl: '',
    voicemailId: '',
  };
}

/** Answered-call duration, as Android's `formatDuration` renders it. */
export function callDuration(sec: number | null | undefined): string {
  const n = typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m ${n % 60}s`;
}

// ── merge and filter ───────────────────────────────────────────────────────

/**
 * Merge the four streams into one list, newest first.
 *
 * The comparison is a LEXICAL string compare, which is valid and exact for
 * ISO-8601 UTC and needs no Date parse per row. An UNDATED row sorts LAST
 * rather than being dropped: unlike `latestCommunication` in
 * `lib/recipientContext.ts`, which must name one newest message and so cannot
 * use a row with no date, this list shows everything and an undated voicemail
 * is still a voicemail somebody left.
 *
 * Ties break on `id` ascending so the order is stable across re-renders. Four
 * live listeners deliver their snapshots independently, and without a total
 * order two rows sharing a timestamp could swap places under the operator's
 * cursor every time any one of the four fired.
 */
export function mergeChannelEntries(groups: readonly (readonly InboxEntry[])[]): InboxEntry[] {
  const all = groups.flat();
  return [...all].sort((a, b) => {
    if (a.timestamp === b.timestamp) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (a.timestamp === '') return 1;
    if (b.timestamp === '') return -1;
    return a.timestamp < b.timestamp ? 1 : -1;
  });
}

/** Positive membership test against the enumerated channel, never a negation. */
export function filterChannelEntries(
  entries: readonly InboxEntry[],
  key: ChannelFilterKey,
): InboxEntry[] {
  if (key === 'all') return [...entries];
  return entries.filter((e) => e.channel === key);
}

/**
 * Voicemails nobody has written back to yet.
 *
 * Counted only from rows that really say `unread` (see `voicemailReplyState`),
 * and rendered under the words "waiting on a reply", never "unread", so it can
 * never be mistaken for, or compared against, the rail's thread count.
 */
export function awaitingReplyCount(rows: readonly VoicemailRow[]): number {
  return rows.filter((r) => voicemailReplyState(r.replyStatus) === 'unread').length;
}

// ── row display ────────────────────────────────────────────────────────────

/** The name a row leads with: the household when known, else the raw contact. */
export function entryTitle(entry: InboxEntry): string {
  if (entry.kinfolkName !== '') return entry.kinfolkName;
  if (entry.counterpart !== '') return entry.counterpart;
  // Neither a matched household nor a number Twilio passed through. Honest, and
  // the row still carries its timestamp, preview and channel.
  return 'Unknown contact';
}

/** LOCAL `MM-DD HH:mm` for a row's ISO timestamp (the AO-18 local-time rule). */
export function entryWhen(iso: string): string {
  return formatWhen(sessionTimeOf(iso));
}

/** Machine-readable local datetime for a row's `<time dateTime={…}>`. */
export function entryMachineWhen(iso: string): string | undefined {
  return machineWhen(sessionTimeOf(iso));
}

export interface EntryLaunchers {
  /** `tel:` for a row with a usable phone number, else null. */
  tel: string | null;
  /** `sms:` for a row with a usable phone number, else null. */
  sms: string | null;
  /** `mailto:` for a row with a usable email address, else null. */
  mailto: string | null;
}

/**
 * The native launchers a row can offer.
 *
 * `null` rather than a `#` href on purpose: a dead link that looks live is the
 * dead-control anti-pattern `components/Buttons.tsx` exists to make
 * inexpressible, and an email row genuinely cannot be phoned.
 *
 * The value is URI-encoded because a counterpart is untrusted inbound data. A
 * number Twilio passed through with a space, or an address containing a `?`,
 * would otherwise change the meaning of the URL rather than sit inside it.
 */
export function entryLaunchers(entry: InboxEntry): EntryLaunchers {
  const phone = entry.replyPhone.trim();
  const email = entry.replyEmail.trim();
  return {
    tel: phone === '' ? null : `tel:${encodeURIComponent(phone)}`,
    sms: phone === '' ? null : `sms:${encodeURIComponent(phone)}`,
    mailto: email === '' ? null : `mailto:${encodeURIComponent(email)}`,
  };
}
