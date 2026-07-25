import { formatWhen, type FsTime } from './time';
import type { Timestamp } from 'firebase/firestore';

/**
 * The write-target rule for Google Calendar over OAuth, and how the last push
 * reads back to the operator.
 *
 * THE RULE IS A MIRROR, not the enforcement. The enforcing copy is
 * `mytribe/functions/src/lib/googleCalendarTargets.ts`, and it runs on every
 * save and every push regardless of which client asked. This copy exists so the
 * operator is told while the picker is still in front of them instead of after a
 * round trip. Android carries the third copy
 * (`ui/admin/scheduling/GoogleCalendarTargets.kt`). The six cases the three must
 * agree on are asserted in `mytribe/functions/test/callableContract.test.ts`.
 *
 * IT IS NOT THE SAME RULE AS THE FREE/BUSY ONE next door in `calendarSyncId.ts`,
 * and the differences are the point:
 *
 *   - `primary` IS ALLOWED HERE. Under the free/busy service account, `primary`
 *     means the sync robot's own calendar, which is permanently empty, so it
 *     would import nothing forever. Under OAuth it means the calendar of the
 *     account the operator just signed in with, which is a real writable
 *     calendar and a sensible target.
 *   - THE WRITE TARGET MUST NOT BE THE FREE/BUSY CALENDAR. Visits written into
 *     the calendar the free/busy sync imports FROM come straight back as
 *     imported BLOCKED slots over their own hour, so the Schedule shows one
 *     booking and one unavailable block for the same time. Nothing can untangle
 *     that after the fact: `freebusy.query` answers with start and end and
 *     nothing else, so an imported block cannot be traced to the event that
 *     produced it. Refusing the overlap up front is the only guard that works.
 */

/** The literal Google accepts for "the signed-in account's own calendar". */
export const PRIMARY_CALENDAR_ID = 'primary';

/** The `details.code`s the callables send, so this app branches on them, not on message text. */
export const GOOGLE_OAUTH_NOT_CONFIGURED_CODE = 'google_oauth_not_configured';
export const GOOGLE_CALENDAR_NOT_CONNECTED_CODE = 'google_calendar_not_connected';
export const GOOGLE_OAUTH_REVOKED_CODE = 'google_oauth_revoked';
export const WRITE_CALENDAR_INVALID_CODE = 'write_calendar_invalid';

/**
 * The two secrets the operator sets, and the redirect URI they register. Printed
 * verbatim in the setup copy: all three are typed by a human into Google Cloud
 * Console and the firebase CLI, and Google refuses the whole flow if the URI
 * differs by so much as a trailing slash.
 */
export const GOOGLE_OAUTH_SECRET_NAMES = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
export const GOOGLE_OAUTH_REDIRECT_URI =
  'https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback';

const CALENDAR_ID_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What `primary` actually points at, so one calendar spelled two ways is not
 * mistaken for two calendars. Case-folded, because Google treats calendar ids
 * (they are addresses) case-insensitively while string equality does not.
 */
export function resolveCalendarId(rawId: string, connectedAccountEmail: string): string {
  const value = rawId.trim().toLowerCase();
  if (value === PRIMARY_CALENDAR_ID) return connectedAccountEmail.trim().toLowerCase();
  return value;
}

/**
 * The operator-facing reason `writeCalendarId` cannot be the calendar we write
 * visits to, or `null` when it can be. `freeBusyCalendarId` is the saved
 * `calendarSyncId`, empty when the free/busy sync is not set up, in which case
 * there is nothing to collide with.
 */
export function writeCalendarProblem(
  writeCalendarId: string,
  freeBusyCalendarId: string,
  connectedAccountEmail: string,
): string | null {
  const value = writeCalendarId.trim();
  if (value === '') {
    return 'Pick the calendar AuntieOS should write visits to.';
  }
  if (value.toLowerCase() !== PRIMARY_CALENDAR_ID && !CALENDAR_ID_PATTERN.test(value)) {
    return (
      `"${value}" is not a Google Calendar ID. Pick one from the list of calendars on the ` +
      `connected account rather than typing it, so the ID matches what Google expects.`
    );
  }
  const freeBusy = freeBusyCalendarId.trim().toLowerCase();
  if (freeBusy === '') return null;
  if (resolveCalendarId(value, connectedAccountEmail) === freeBusy) {
    return (
      'That is the calendar the free/busy sync already imports from, so every visit written to ' +
      'it would come straight back as blocked-out time and the Schedule would show the same hour ' +
      'twice. Pick a different calendar for visits, or clear the Calendar ID above first.'
    );
  }
  return null;
}

/** Google's own answer for what we may do with a calendar. Only two of them can take an event. */
export function canWriteToCalendar(accessRole: string): boolean {
  return accessRole === 'owner' || accessRole === 'writer';
}

// ── The last-push receipt ────────────────────────────────────────────────────

/** The four fields the push callable stamps, success or failure. Read here, never written here. */
export interface CalendarPushRun {
  ranAt: string;
  status: 'ok' | 'error';
  pushed: number;
  error: string;
}

function isoToFsTime(iso: string): FsTime {
  const trimmed = iso.trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/**
 * ONE line describing what the last push did, in local time, matching the
 * `calendarSyncRunLabel` convention next door.
 *
 * `null` when nothing has ever been pushed, which the panel renders in its own
 * words. A push that had nothing to send and a push that never happened are
 * different facts, and conflating them is how a broken integration goes on
 * looking fine.
 */
export function calendarPushRunLabel(run: CalendarPushRun | null): string | null {
  if (run === null) return null;
  const when = isoToFsTime(run.ranAt);
  const stamp = when === null ? 'at an unreadable time' : formatWhen(when);
  if (run.status === 'error') return `Last push ${stamp}, and it failed.`;
  if (run.pushed === 0) {
    return `Last push ${stamp}. Nothing needed sending, so the calendar was already up to date.`;
  }
  const visits = run.pushed === 1 ? '1 visit' : `${String(run.pushed)} visits`;
  return `Last push ${stamp}. Sent ${visits}.`;
}

/**
 * The stored receipt read off the connection the screen already loaded. `null`
 * when nothing has ever been stamped. An unreadable status reads as an ERROR
 * rather than a success: a receipt we cannot parse is not evidence a push worked.
 */
export function storedCalendarPushRun(connection: {
  calendarPushLastRunAt: string;
  calendarPushLastStatus: string;
  calendarPushLastPushed: number;
  calendarPushLastError: string;
}): CalendarPushRun | null {
  if (connection.calendarPushLastRunAt.trim() === '') return null;
  const ok = connection.calendarPushLastStatus === 'ok';
  return {
    ranAt: connection.calendarPushLastRunAt,
    status: ok ? 'ok' : 'error',
    pushed: ok ? connection.calendarPushLastPushed : 0,
    error: ok ? '' : connection.calendarPushLastError,
  };
}
