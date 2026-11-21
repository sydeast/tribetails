import { db } from '../lib/firestoreAdmin';
import { getNotificationDef } from './catalog';
import { loadHouseholdSendGate, passesHouseholdSendSwitch, type HouseholdSendGate } from './householdSendGate';

/**
 * #2478: A HOUSEHOLD COPY QUEUED FOR LATER IS ASKED ABOUT THE SEND SWITCH AGAIN
 * WHEN ITS TIME COMES.
 *
 * The dispatcher asks "Send notices to households" (`householdNotificationsLive`)
 * once, when it writes a copy. A copy it writes to one of the three queues
 * (`scheduledNotifications`, `pendingNotifications`, `notificationBatch`) is
 * sent later by a sweep, and until this change the sweep never asked again. So
 * an invoice reminder, a visit reminder or a KinTale comment digest queued
 * while the switch was on still went out at its time if the switch was turned
 * off in between.
 *
 * Now each sweep asks this module before it promotes a household copy:
 *
 *   send   not a household copy, a single message that passes the switch
 *          (`passesHouseholdSendSwitch`), or the switch is on.
 *   hold   the switch is off (or absent). The sweep takes the copy off the
 *          queue and it is NEVER SENT LATER, like a broadcast or a blast held
 *          at its send time (#1834, PR #2480). The run writes one Activity Log
 *          line with the count and no names (`withHeldNoticeBatch`, `final`).
 *   skip   the switch could not be read. The copy is neither sent nor taken off
 *          the queue, and the next tick asks again: a held copy is gone for
 *          good, so one failed read must not decide that.
 *
 * The household copy is decided by the row's `stream`, not by a list of keys,
 * so the confirmations locked on for Kinfolk (#2382 ruling, PR #2484) obey the
 * switch at their send time like every other notice, and a key added later
 * needs nothing here. A row queued before rows carried `stream` (#1898) is a
 * household's when its key reaches households only.
 *
 * Why the reminder that is held is not raised again: the reminder jobs stamp
 * the invoice or the visit when they queue it (`reminderNotifiedAtMs`,
 * `overdueNotifiedAtMs`, `upcomingReminderNotifiedAtMs`), so they do not queue
 * the same copy a second time. That is the "never sent later" of the ruling.
 *
 * #2515 (lead decision 2026-11-21): THE HELD REMINDER STAYS GONE, AND THE
 * INVOICE OR VISIT SAYS IT WAS HELD. The sent stamp stays, because it is the
 * once-ever gate that keeps the reminder from coming back in a burst when
 * notices are turned on at launch. Beside it the sweep writes the hold's time
 * (`heldStampOf`): `reminderHeldAtMs`, `overdueHeldAtMs`,
 * `upcomingReminderHeldAtMs`. A sent stamp no later than its held stamp is a
 * reminder that never went out, and every "Last reminder" row reads it as
 * "held, not sent". A real reminder sent afterwards stamps a later time, so
 * it reads as sent again with nothing to clear.
 */

/** The reminder keys whose source document carries a held stamp, and where. */
export interface HeldStamp {
  /** The document path: an invoice, or a household's booking. */
  path: string;
  field: 'reminderHeldAtMs' | 'overdueHeldAtMs' | 'upcomingReminderHeldAtMs';
}

function idOf(v: unknown): string {
  return typeof v === 'string' && v !== '' && !v.includes('/') ? v : '';
}

/** #2515: where a held reminder row records that it was held, or null for any other row. */
export function heldStampOf(row: Record<string, unknown>): HeldStamp | null {
  const key = row.key;
  const data = (row.data ?? {}) as Record<string, unknown>;
  if (key === 'invoice.reminder' || key === 'invoice.overdue') {
    const invoiceId = idOf(data.invoiceId) || (row.targetType === 'invoice' ? idOf(row.targetId) : '');
    if (invoiceId === '') return null;
    return {
      path: `invoices/${invoiceId}`,
      field: key === 'invoice.reminder' ? 'reminderHeldAtMs' : 'overdueHeldAtMs',
    };
  }
  if (key === 'kincare.upcoming.reminder') {
    const kinfolkId = idOf(data.kinfolkId);
    const bookingId = idOf(data.bookingId);
    if (kinfolkId === '' || bookingId === '') return null;
    return { path: `families/${kinfolkId}/bookings/${bookingId}`, field: 'upcomingReminderHeldAtMs' };
  }
  return null;
}

/** True when a queued row is a household's copy. */
export function isQueuedHouseholdCopy(key: string, stream: unknown): boolean {
  if (stream === 'kinfolk') return true;
  if (stream !== undefined && stream !== null && stream !== '') return false;
  try {
    const { audiences } = getNotificationDef(key);
    return audiences.kinfolk === true && audiences.staff !== true && audiences.business !== true;
  } catch {
    // A key no longer in the catalog: nothing says whose copy it is.
    return false;
  }
}

/** What a sweep does with one due copy. */
export type QueuedCopyVerdict = 'send' | 'hold' | 'skip';

/** The switch, read at most once per sweep run and only when a household copy is due. */
export type QueuedCopyGate = () => Promise<HouseholdSendGate>;

export function startQueuedCopyGate(): QueuedCopyGate {
  let gate: Promise<HouseholdSendGate> | null = null;
  // `loadHouseholdSendGate` never throws: a failed read comes back as `read-failed`.
  return () => (gate ??= loadHouseholdSendGate(db()));
}

/** The verdict for one due copy of `key` written for `stream`. */
export async function queuedCopyVerdict(key: string, stream: unknown, gate: QueuedCopyGate): Promise<QueuedCopyVerdict> {
  if (!isQueuedHouseholdCopy(key, stream) || passesHouseholdSendSwitch(key)) return 'send';
  const { live, state } = await gate();
  if (live) return 'send';
  return state === 'read-failed' ? 'skip' : 'hold';
}
