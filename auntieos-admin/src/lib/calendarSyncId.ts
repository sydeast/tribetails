import { formatWhen, type FsTime } from './time';
import type { Timestamp } from 'firebase/firestore';

/**
 * The Google Calendar sync panel's pure logic: what counts as a calendar id,
 * and how the last run reads back to the operator.
 *
 * THE ID RULE IS A MIRROR, not the enforcement. The enforcing copy is
 * `mytribe/functions/src/lib/calendarSyncId.ts`, and it runs on every sync
 * regardless of which client asked (see `CALLABLE_CONTRACT.md`). This copy
 * exists so the operator is told about a typo while the field is still in front
 * of them, instead of after a round trip. Android carries the third copy
 * (`ui/admin/scheduling/CalendarSyncId.kt`). The three are kept in step by
 * `test/callableContract.test.ts`, which asserts the five cases below.
 *
 * WHY VALIDATE AT ALL. The sync hands `calendarSyncId` straight to Google's
 * free/busy query. Google answers an id it cannot see with `notFound` inside a
 * 200 envelope, and answers a calendar that happens to be empty with an empty
 * list. Unchecked, a typo and a genuinely clear calendar both arrive as
 * "Imported 0 busy blocks". Checking the shape first is what keeps "you typed
 * it wrong" from reading as "you have nothing on".
 */

/** The shape every shared Google Calendar id takes. Used in copy, never as a default value. */
export const CALENDAR_ID_EXAMPLE = 'name@group.calendar.google.com';

/** The service account the operator shares the calendar with. Frozen server-side; printed here. */
export const CALENDAR_SYNC_SA_EMAIL =
  'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com';

/** The `details.code` the callable sends when it refuses the stored id. */
export const CALENDAR_ID_INVALID_CODE = 'calendar_id_invalid';

const CALENDAR_ID_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The operator-facing reason `raw` cannot be a calendar id, or `null` when it
 * can be. An id that passes may still be one the service account cannot see;
 * that is the sync's own `notFound` report, not something a text field can know.
 */
export function calendarIdProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === '') {
    return `Enter the shared calendar's ID first. It looks like ${CALENDAR_ID_EXAMPLE}.`;
  }
  if (value.toLowerCase() === 'primary') {
    return (
      '"primary" means the sync service account\'s own calendar, which is always empty, so every ' +
      `sync would import nothing and report success. Paste the shared calendar's ID instead, the ` +
      `one that looks like ${CALENDAR_ID_EXAMPLE}.`
    );
  }
  if (!CALENDAR_ID_PATTERN.test(value)) {
    return (
      `"${value}" is not a Google Calendar ID, so a sync would import nothing and look like an ` +
      `empty calendar. Copy the ID from Google Calendar under Settings, Integrate calendar. It ` +
      `looks like ${CALENDAR_ID_EXAMPLE}, or the calendar owner's email address.`
    );
  }
  return null;
}

// ── The last-run receipt ─────────────────────────────────────────────────────

/**
 * The four fields the callable merges onto `business_settings` after every run,
 * success or failure. Read here, never written here: the client has no business
 * claiming a sync happened.
 */
export interface CalendarSyncRun {
  ranAt: string;
  status: 'ok' | 'error';
  imported: number;
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
 * ONE line describing what the last run did, in LOCAL time (the `lastSavedLabel`
 * convention). The same sentence covers a run the operator just triggered and a
 * run stamped days ago, deliberately: a separate "sync finished" note beside a
 * "last run" line says the same thing twice, and two copies of one fact are how
 * a stale one survives.
 *
 * `null` when no run has ever been stamped, which the panel renders as its own
 * "never run" state rather than as a zero-import success. A sync that imported
 * nothing and a sync that never happened are different facts, and conflating
 * them is exactly how a broken integration goes on looking fine.
 */
export function calendarSyncRunLabel(run: CalendarSyncRun | null): string | null {
  if (run === null) return null;
  const when = isoToFsTime(run.ranAt);
  const stamp = when === null ? 'at an unreadable time' : formatWhen(when);
  if (run.status === 'error') return `Last run ${stamp}, and it failed.`;
  if (run.imported === 0) {
    return `Last run ${stamp}. No busy events in that window, so nothing was blocked out.`;
  }
  const blocks = run.imported === 1 ? '1 busy block' : `${String(run.imported)} busy blocks`;
  return `Last run ${stamp}. Imported ${blocks}.`;
}
