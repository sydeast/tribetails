import { call } from '../lib/fns';
import type { CalendarSyncRun } from '../lib/calendarSyncId';
import type { BusinessSettings } from './settings';

/**
 * The Google Calendar free/busy sync, as the admin reaches it.
 *
 * ONE callable, `syncGoogleCalendarBusyEvents`
 * (`mytribe/functions/src/admin/syncGoogleCalendarBusyEvents.ts`, deployed,
 * admin-gated by `wrapAdminCallable`). It authenticates as the pinned service
 * account through Application Default Credentials, so no OAuth, no token
 * storage, and no secret is involved on any client. It reads the shared
 * calendar, then upserts every busy interval into `booking_time_slots` as a
 * private BLOCKED slot that kinfolk see as "unavailable" with no event details.
 *
 * NO CALENDAR ID IN THE REQUEST, deliberately. The callable resolves it
 * server-side from `business_settings.calendarSyncId`, so the operator's saved
 * value is the only calendar any client can sync, and a caller cannot point the
 * sync at someone else's calendar. Saving the id is therefore a separate step
 * (the ordinary settings write, `api/settingsWrite.ts`), not a parameter here.
 *
 * FAIL LOUD, no mapping. Whatever the callable rejects with propagates
 * untouched: the server's messages are the useful ones (they name the exact
 * service account to share with, the calendar id, and the share level), and a
 * generic "Sync failed" here would throw away the only text that tells the
 * operator what to do next. `lib/fns.ts` already converts a hung call into a
 * readable timeout.
 */

/** What the callable answers with. `ranAt` matches the receipt it just stamped. */
export interface CalendarSyncResult {
  imported: number;
  scanned: number;
  ranAt: string;
}

/**
 * Runs the sync now. `lookAheadDays` is clamped to 1..90 server-side; 30 is the
 * window the panel asks for and the value the archive's Run Sync button used.
 */
export async function runCalendarSync(lookAheadDays = 30): Promise<CalendarSyncResult> {
  return call<{ lookAheadDays: number }, CalendarSyncResult>('syncGoogleCalendarBusyEvents', {
    lookAheadDays,
  });
}

/** Just the receipt half of the settings doc, so callers pass what they use. */
export type CalendarSyncReceiptFields = Pick<
  BusinessSettings,
  | 'calendarSyncLastRunAt'
  | 'calendarSyncLastStatus'
  | 'calendarSyncLastImported'
  | 'calendarSyncLastError'
>;

/**
 * The stored receipt, read off the settings doc the screen already loaded.
 * `null` when no run has ever been stamped, so the panel can say "never run"
 * instead of showing a zero-import success that never happened.
 *
 * A doc carrying a `calendarSyncLastRunAt` but no recognized status is treated
 * as an ERROR rather than a success: an unreadable receipt is not evidence a
 * sync worked, and the safe reading of "something is off" is to say so.
 */
export function storedCalendarSyncRun(data: CalendarSyncReceiptFields): CalendarSyncRun | null {
  if (data.calendarSyncLastRunAt.trim() === '') return null;
  const ok = data.calendarSyncLastStatus === 'ok';
  return {
    ranAt: data.calendarSyncLastRunAt,
    status: ok ? 'ok' : 'error',
    imported: data.calendarSyncLastImported,
    error: ok ? '' : data.calendarSyncLastError,
  };
}
