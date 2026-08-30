import { formatWhen, type FsTime } from './time';
import type { Timestamp } from 'firebase/firestore';

/**
 * Reading the AUTOMATIC per-visit calendar sync's receipt (issue #397).
 *
 * The trigger that writes visits to Google Calendar as they are confirmed,
 * moved and cancelled has nobody to return an error to. Its only report is five
 * fields stamped on the connection document, which every admin surface already
 * loads to answer "is Google connected". This turns those five fields into one
 * sentence and one decision: is there a visit the operator needs to retry.
 *
 * PURE, and separate from the panel, for the reason the sibling
 * `calendarPushRunLabel` is: the wording is the part worth testing, and a test
 * that has to mount a component to check a sentence tests the mounting.
 */

export type CalendarAutoSyncStatus = 'ok' | 'error';

export interface CalendarAutoSyncRun {
  ranAt: string;
  status: CalendarAutoSyncStatus;
  /** `created`, `updated`, `deleted`, `skipped`, or empty on a failure. */
  action: string;
  /** The visit the run was about. What a retry is aimed at. */
  sessionId: string;
  error: string;
}

export interface AutoSyncConnectionFields {
  calendarAutoSyncLastRunAt: string;
  calendarAutoSyncLastStatus: string;
  calendarAutoSyncLastAction: string;
  calendarAutoSyncLastSessionId: string;
  calendarAutoSyncLastError: string;
}

function isoToFsTime(iso: string): FsTime {
  const trimmed = iso.trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/**
 * The stored receipt, or `null` when the automatic sync has never run.
 *
 * An UNREADABLE status reads as an ERROR, matching `storedCalendarPushRun`
 * next door and for the same reason: a receipt we cannot parse is not evidence
 * that anything worked, and reporting it as a success is how a broken
 * integration goes unnoticed.
 */
export function storedCalendarAutoSyncRun(
  connection: AutoSyncConnectionFields,
): CalendarAutoSyncRun | null {
  if (connection.calendarAutoSyncLastRunAt.trim() === '') return null;
  const ok = connection.calendarAutoSyncLastStatus === 'ok';
  return {
    ranAt: connection.calendarAutoSyncLastRunAt,
    status: ok ? 'ok' : 'error',
    action: ok ? connection.calendarAutoSyncLastAction : '',
    sessionId: connection.calendarAutoSyncLastSessionId,
    error: ok ? '' : connection.calendarAutoSyncLastError,
  };
}

/** What each action did, in the operator's words rather than the API's. */
function actionSentence(action: string): string {
  switch (action) {
    case 'created':
      return 'put a visit on the calendar';
    case 'updated':
      return 'moved a visit already on the calendar';
    case 'deleted':
      return 'took a cancelled visit off the calendar';
    case 'skipped':
      return 'found nothing to change';
    default:
      // A value we do not recognise is REPORTED, not hidden behind a guess. A
      // panel that silently renders an unknown action as "nothing to change"
      // would be inventing reassurance.
      return `finished with an unrecognised result (${action === '' ? 'blank' : action})`;
  }
}

/**
 * ONE line saying what automatic sync last did, in local time.
 *
 * `null` when it has never run, which the panel renders in its own words: "not
 * yet" and "it failed" are different states and must not share a sentence.
 */
export function calendarAutoSyncRunLabel(run: CalendarAutoSyncRun | null): string | null {
  if (run === null) return null;
  const when = isoToFsTime(run.ranAt);
  const stamp = when === null ? 'at an unreadable time' : formatWhen(when);
  if (run.status === 'error') {
    return `Automatic sync last ran ${stamp}, and it failed.`;
  }
  return `Automatic sync last ran ${stamp} and ${actionSentence(run.action)}.`;
}

/**
 * The visit a Retry button should be aimed at, or `null` when there is nothing
 * to retry.
 *
 * A failed run with NO session id is deliberately not retryable. That happens
 * when the failure was about the connection rather than about one visit — the
 * chosen calendar became the free/busy calendar, say — and offering a Retry
 * that reruns the same refusal would waste the operator's time on the wrong
 * fix. The panel shows the error and the real remedy instead.
 */
export function retryableSessionId(run: CalendarAutoSyncRun | null): string | null {
  if (run === null || run.status !== 'error') return null;
  const id = run.sessionId.trim();
  return id === '' ? null : id;
}
