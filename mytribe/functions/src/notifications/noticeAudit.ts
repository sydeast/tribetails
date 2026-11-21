import { createHash } from 'node:crypto';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { auditHashableDoc, readAuditChain, stageAuditEntry, writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import {
  notificationChannelFailedWords,
  notificationChannelSkippedWords,
  notificationChannelsOffWords,
  notificationHeldUnreadWords,
  notificationHeldWords,
  notificationNoAccountWords,
  notificationTurnedOffWords,
  notificationsHeldSummaryWords,
  notificationsTurnedOffSummaryWords,
  notSentLaterWords,
} from '../lib/activityWords';
import { notificationName } from './notificationName';
import { HELD_NOTICE_REASONS, heldNoticeTotal, type HeldNoticeBatch, type HeldNoticeReason } from './heldNoticeBatch';
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
 * #2331: INSIDE A TIMED JOB, `held` IS ONE LINE FOR THE RUN, NOT ONE PER COPY
 * (`recordHeldNoticeSummary` below, counted by `heldNoticeBatch.ts`), and so,
 * since #2341, is `turned_off`; a marketing blast's fan-out counts the same
 * way (#2340). Every other outcome, and every notice a person pressed, is one
 * line each as above.
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

/** UTC day: the last resort when no business zone resolves at all. */
function utcDayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * #2346: the BUSINESS day, so a line with a coarse identity is written once a
 * day as the business counts days, not once ever and not once a UTC day (which
 * turns over at 6 or 7 PM in Chicago). Read on the business's own clock
 * (`businessTodayIso`, which falls back to the ruled America/Chicago); the UTC
 * day stands in only when no zone resolves or the settings read throws.
 */
async function businessDayKey(nowMs: number = Date.now()): Promise<string> {
  try {
    const { businessTodayIso } = await import('../lib/quoteDecision.js');
    const day = await businessTodayIso(db(), nowMs);
    if (day !== '') return day;
  } catch {
    // The UTC day below: a line id must never fail the send beside it.
  }
  return utcDayKey(nowMs);
}

/**
 * A fixed id for one line. Hashed: the parts carry caller-supplied ids and a
 * Firestore doc id may not contain `/`.
 */
export function noticeLineId(outcome: NoticeNotSentOutcome, ...parts: string[]): string {
  const digest = createHash('sha256').update([outcome, ...parts].join('\u0000')).digest('hex').slice(0, 40);
  return `noticenotsent__${digest}`;
}

/** The id for a line about an event with an identity but no notification record: once a business day. */
export async function noticeLineIdForEvent(
  outcome: NoticeNotSentOutcome,
  key: string,
  identity: string,
  recipientUid: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return noticeLineId(outcome, key, identity, recipientUid, await businessDayKey(nowMs));
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

/**
 * Where a timed job keeps what it has already counted today: one small
 * document per job, beside the job's own run marker and under the same rule
 * (`scheduled_runs/{jobId}`, denied to every client). It holds one business
 * day at a time and is overwritten when the day changes, so it never grows
 * past a day's held copies and nothing has to clean it up.
 */
export function heldMarkerPath(job: string): string {
  return `scheduled_runs/${job}__held`;
}

/** A held copy as the marker stores it: short, and with no id in the clear. */
function heldCopyId(copy: string): string {
  return createHash('sha256').update(copy).digest('hex').slice(0, 20);
}

function storedIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The business day a run belongs to. The invoice jobs already resolved it; the
 * visit job has only its tick, so the day is read here, on the business's own
 * clock (`businessTodayIso`, which falls back to the ruled America/Chicago),
 * and only in a run that held something. The UTC day stands in only when no
 * zone resolves at all.
 */
async function heldDay(batch: HeldNoticeBatch): Promise<string> {
  if (batch.day !== undefined && batch.day !== '') return batch.day;
  const { businessTodayIso } = await import('../lib/quoteDecision.js');
  const day = await businessTodayIso(db(), batch.atMs);
  return day !== '' ? day : utcDayKey(batch.atMs);
}

/** The summary line's sentence, outcome and severity for one reason. */
function summaryLine(
  reason: HeldNoticeReason,
  kinds: Parameters<typeof notificationsHeldSummaryWords>[0],
  /** #2478: the batch's copies came off the queue for good (`HeldNoticeBatch.final`). */
  final: { count: number } | null = null,
): { description: string; outcome: 'held' | 'turned_off'; severity: 'info' | 'warn' } {
  const tail = final === null ? '' : `. ${notSentLaterWords(final.count)}`;
  if (reason === 'turnedOff') {
    return { description: notificationsTurnedOffSummaryWords(kinds) + tail, outcome: 'turned_off', severity: 'info' };
  }
  return {
    description: notificationsHeldSummaryWords(kinds, reason === 'unreadable') + tail,
    outcome: 'held',
    severity: reason === 'unreadable' ? 'warn' : 'info',
  };
}

/**
 * #2331: ONE LINE FOR WHAT THE SEND SWITCH HELD BACK IN ONE RUN OF A TIMED
 * JOB. `Held back 14 visit reminders: notices to households are turned off`.
 *
 * No household and no person is named, so nothing is read to write it: the
 * per-copy line cost a `clients` read, a `kinfolk` read and a hash-chain
 * transaction for each copy, and this is one transaction for the run.
 *
 * The count is household COPIES, one per member the notice was addressed to,
 * which is what the per-copy lines counted.
 *
 * EACH COPY IS COUNTED ONCE A BUSINESS DAY. Nothing is stamped while a notice
 * is held, so the hourly visit job holds the same reminders every hour: 24
 * identical lines a day if every run wrote its whole count. The job's marker
 * (`heldMarkerPath`) remembers the copies already counted today, and a run's
 * line counts only the ones that are new since. A run with nothing new writes
 * nothing. The next business day counts everything still held once more.
 *
 * THE MARKER AND THE LINE COMMIT TOGETHER, in one transaction, so the marker
 * is what makes a retry safe: a retried run finds its copies counted and
 * writes no second line; a run that failed half way wrote the count it had
 * reached, and its retry writes a line for the rest only. A line that could
 * not be written leaves the marker as it was, so the next run counts those
 * copies. The Activity Log is an append-only hash chain and no line is ever
 * corrected; the lines of a day add up.
 *
 * A run whose copies were held because the switch could not be read gets its
 * own line, at `warn`: nobody turned anything off. #2341: a run's copies of a
 * notification turned off in Settings get their own line too, `Did not send
 * 14 invoice reminders: this notification is turned off in Settings`, outcome
 * `turned_off`. The reasons are counted apart, so a copy already counted under
 * one reason still shows in another reason's line.
 * NEVER THROWS.
 */
export async function recordHeldNoticeSummary(batch: HeldNoticeBatch): Promise<void> {
  for (const reason of HELD_NOTICE_REASONS) {
    if (heldNoticeTotal(batch, reason) === 0) continue;
    try {
      const day = await heldDay(batch);
      const timestampIso = new Date().toISOString();
      const markerRef = db().doc(heldMarkerPath(batch.job));
      await db().runTransaction(async (tx) => {
        const stored = (await tx.get(markerRef)).data() as Record<string, unknown> | undefined;
        // A late retry of an earlier day's run, landing after today's count
        // began: what it held is counted today, by today's runs. Writing it
        // would wipe today's marker and count everything twice.
        const storedDay = stored?.['dayIso'];
        if (typeof storedDay === 'string' && storedDay > day) return;
        // Yesterday's marker counts for nothing today.
        const today = stored !== undefined && stored['dayIso'] === day ? stored : {};
        const seen = new Set(storedIds(today[reason]));

        const perKind = new Map<string, number>();
        const fresh: string[] = [];
        for (const [copy, key] of batch.held[reason]) {
          const id = heldCopyId(copy);
          if (seen.has(id)) continue;
          seen.add(id);
          fresh.push(id);
          perKind.set(key, (perKind.get(key) ?? 0) + 1);
        }
        for (const [key, n] of batch.unnamed[reason]) perKind.set(key, (perKind.get(key) ?? 0) + n);

        const kinds = [...perKind.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, n]) => ({ key, name: notificationName(key), count: n }));
        const count = kinds.reduce((sum, k) => sum + k.count, 0);
        if (count === 0) return;

        const line = summaryLine(reason, kinds, batch.final === true ? { count } : null);
        const chain = await readAuditChain(db(), tx);
        stageAuditEntry(
          db(),
          tx,
          auditHashableDoc(
            {
              status: 'NOT_SENT',
              event: AUDIT_EVENTS.NOTIFICATION_NOT_SENT,
              severity: line.severity,
              actorRole: 'SYSTEM',
              description: line.description,
              payload: {
                outcome: line.outcome,
                summary: true,
                job: batch.job,
                day,
                count,
                kinds: Object.fromEntries(kinds.map((k) => [k.key, k.count])),
                ...(reason === 'unreadable' ? { reason: 'setting_unreadable' } : {}),
              },
            },
            timestampIso,
          ),
          chain,
        );
        if (fresh.length > 0) {
          // Every reason's list is carried over, so writing one never wipes another's.
          const lists = Object.fromEntries(HELD_NOTICE_REASONS.map((r) => [r, storedIds(today[r])]));
          tx.set(markerRef, {
            dayIso: day,
            ...lists,
            [reason]: [...seen],
            updatedAtMs: Date.now(),
          });
        }
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'recordHeldNoticeSummary',
        event: 'notification.not_sent.audit_failed',
        errorMessage: (err as Error)?.message,
        extra: { job: batch.job, reason, count: heldNoticeTotal(batch, reason) },
      });
    }
  }
}
