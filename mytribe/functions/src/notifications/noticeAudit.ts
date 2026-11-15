import { createHash } from 'node:crypto';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import {
  notificationChannelFailedWords,
  notificationChannelSkippedWords,
  notificationChannelsOffWords,
  notificationHeldUnreadWords,
  notificationHeldWords,
  notificationNoAccountWords,
  notificationTurnedOffWords,
} from '../lib/activityWords';
import { notificationName } from './notificationName';
import type { AudienceStream, Channel } from './types';

/**
 * #1819, #1905: THE ACTIVITY LOG LINE FOR A NOTICE THAT DID NOT GO OUT.
 *
 * Two walk findings, one cause. The log had a line for a copy handed to its
 * channels and a line for a channel that delivered, and nothing else:
 *
 *   - #1819: a clock tap with household notices off wrote "Notification
 *     dispatched", status SUCCESS, for a notice that was held back. Only the
 *     opened payload said so, as a stored reason key.
 *   - #1905: a payment notice goes to the household and to the office. The
 *     household had email off, so their copy went to their notifications list
 *     alone and wrote no line; the office copy wrote "Sent ... by email"
 *     without saying to whom. The log read as an email against the switch.
 *
 * Every outcome now has a line, per channel where the reason is a channel's:
 *
 *   held          the send switch in Settings is off          (dispatcher)
 *   turned_off    the notification is off in Settings         (dispatcher)
 *   channels_off  the household switched these channels off   (dispatcher)
 *   no_account    nobody in the household can sign in         (dispatchVisitNotification)
 *   no_address    the channel has nothing to send to          (onNotificationChannelCreate)
 *   failed        the channel's send threw                    (onNotificationChannelCreate)
 *
 * "Sending" and "Delivered" stay where they were (`onNotificationCreate`,
 * `onNotificationChannelCreate`) and now name who the copy was for.
 *
 * STATUS. `NOT_SENT` for everything but a thrown send, which is `FAILURE`.
 * A notice held by a switch somebody set is not a failure, and the Problems
 * filter stays a list of things that broke. It is never `SUCCESS`: that word
 * on a notice that did not go out is what #1819 reported.
 *
 * Loaded lazily by every caller, so it adds no module to the cold-start graph.
 */

export type NoticeNotSentOutcome = 'held' | 'turned_off' | 'channels_off' | 'no_account' | 'no_address' | 'failed';

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** An address is not a name (no emails-as-names on screen). */
function asName(raw: string): string {
  return raw.includes('@') ? '' : raw;
}

function personName(doc: Record<string, unknown> | undefined): string {
  return (
    asName(text(doc?.['displayName'])) ||
    asName([text(doc?.['firstName']), text(doc?.['lastName'])].filter(Boolean).join(' '))
  );
}

/** The household a notice's merge data names, or ''. */
export function noticeFamilyId(data: Record<string, unknown> | undefined): string {
  return text(data?.['familyId']) || text(data?.['kinfolkId']);
}

/** The audience a work order was written for. Rows from before the field existed have none. */
export function noticeStream(raw: unknown): AudienceStream | null {
  return raw === 'kinfolk' || raw === 'business' || raw === 'staff' ? raw : null;
}

/**
 * Who a copy is for, in the operator's words: the person's own name, else the
 * household's, else "the household"; "the office" for a business copy; the
 * staff member's name, else "your team". Never an id, never an email. '' only
 * when the audience itself is unknown (a work order older than `stream`).
 */
export async function noticeRecipientWords(
  stream: AudienceStream | null,
  recipientUid: string,
  familyId = '',
): Promise<string> {
  if (stream === null) return '';
  if (stream === 'business') return 'the office';
  try {
    if (stream === 'staff') {
      const staff = recipientUid === '' ? undefined : (await db().collection('staff').doc(recipientUid).get()).data();
      return personName(staff as Record<string, unknown> | undefined) || 'your team';
    }
    if (recipientUid !== '') {
      const own = personName((await db().collection('clients').doc(recipientUid).get()).data() as
        | Record<string, unknown>
        | undefined);
      if (own !== '') return own;
    }
    return (await noticeHouseholdName(familyId)) || 'the household';
  } catch {
    return stream === 'staff' ? 'your team' : 'the household';
  }
}

/** The household's name as its record has it, or ''. */
export async function noticeHouseholdName(familyId: string): Promise<string> {
  if (familyId === '') return '';
  try {
    const kinfolk = (await db().collection('kinfolk').doc(familyId).get()).data() as
      | Record<string, unknown>
      | undefined;
    return asName(text(kinfolk?.['kinfolkName'])) || personName(kinfolk);
  } catch {
    return '';
  }
}

/** UTC day, so a line with a coarse identity is written once a day, not once ever. */
function dayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * A fixed id for one line. Hashed: the parts carry caller-supplied ids and a
 * Firestore doc id may not contain `/`.
 */
export function noticeLineId(outcome: NoticeNotSentOutcome, ...parts: string[]): string {
  const digest = createHash('sha256').update([outcome, ...parts].join('\u0000')).digest('hex').slice(0, 40);
  return `noticenotsent__${digest}`;
}

/** The id for a line about an event with an identity but no notification record: once a day. */
export function noticeLineIdForEvent(
  outcome: NoticeNotSentOutcome,
  key: string,
  identity: string,
  recipientUid: string,
): string {
  return noticeLineId(outcome, key, identity, recipientUid, dayKey());
}

export interface NoticeNotSentInput {
  key: string;
  outcome: NoticeNotSentOutcome;
  /** '' for `no_account`: there is no login. */
  recipientUid: string;
  stream: AudienceStream | null;
  /** The channels the line is about. Empty for a copy that did not go at all. */
  channels?: readonly Channel[];
  /** The sender's own reason, for `no_address`. */
  skipReason?: string;
  /** For `held`: the switch could not be read, so the copy was held to be safe. */
  gateUnreadable?: boolean;
  /** The notice's merge data, read for the household only. */
  data?: Record<string, unknown>;
  familyId?: string;
  notificationId?: string;
  docId?: string;
}

/** PURE. The sentence for one outcome. */
export function noticeNotSentWords(
  input: Pick<NoticeNotSentInput, 'key' | 'outcome' | 'channels' | 'skipReason' | 'gateUnreadable'>,
  to: string,
): string {
  const name = notificationName(input.key);
  const channels = input.channels ?? [];
  switch (input.outcome) {
    case 'held':
      return input.gateUnreadable === true ? notificationHeldUnreadWords(name, to) : notificationHeldWords(name, to);
    case 'turned_off':
      return notificationTurnedOffWords(name, to);
    case 'channels_off':
      return notificationChannelsOffWords(name, to, channels);
    case 'no_account':
      return notificationNoAccountWords(name, to);
    case 'no_address':
      return notificationChannelSkippedWords(name, to, channels[0] ?? '', input.skipReason ?? '');
    case 'failed':
      return notificationChannelFailedWords(name, to, channels[0] ?? '');
  }
}

/**
 * Write the line. NEVER THROWS: every caller is on a send path, and a line
 * that cannot be written must not undo or retry the send beside it.
 */
export async function recordNoticeNotSent(input: NoticeNotSentInput): Promise<void> {
  try {
    const familyId = input.familyId ?? noticeFamilyId(input.data);
    const to =
      input.outcome === 'no_account'
        ? await noticeHouseholdName(familyId)
        : await noticeRecipientWords(input.stream, input.recipientUid, familyId);
    const failed = input.outcome === 'failed';
    await writeAuditEntry({
      status: failed ? 'FAILURE' : 'NOT_SENT',
      event: AUDIT_EVENTS.NOTIFICATION_NOT_SENT,
      severity: failed || input.outcome === 'no_address' || input.gateUnreadable === true ? 'warn' : 'info',
      actorRole: 'SYSTEM',
      ...(input.notificationId !== undefined
        ? { targetUid: input.notificationId, targetCollection: 'notifications' }
        : {}),
      ...(familyId !== '' ? { familyId } : {}),
      description: noticeNotSentWords(input, to),
      payload: {
        key: input.key,
        outcome: input.outcome,
        channels: [...(input.channels ?? [])],
        recipientUid: input.recipientUid,
        ...(input.skipReason !== undefined ? { skipReason: input.skipReason } : {}),
        ...(input.gateUnreadable === true ? { reason: 'setting_unreadable' } : {}),
        ...(input.notificationId !== undefined ? { notificationId: input.notificationId } : {}),
      },
      ...(input.docId !== undefined ? { docId: input.docId } : {}),
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'recordNoticeNotSent',
      event: 'notification.not_sent.audit_failed',
      errorMessage: (err as Error)?.message,
      extra: { key: input.key, outcome: input.outcome },
    });
  }
}
