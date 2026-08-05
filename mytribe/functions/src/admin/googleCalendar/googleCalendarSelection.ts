import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../../lib/firestoreAdmin';
import { initSentry } from '../../lib/sentry';
import { logEvent } from '../../lib/logger';
import { wrapAdminCallable } from '../../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../../lib/cors';
import {
  GOOGLE_OAUTH_SECRETS,
  calendarClientForRefreshToken,
  isInvalidGrant,
  revokedError,
} from '../../lib/googleOAuth';
import {
  GOOGLE_CALENDAR_DOC_PATH,
  PublicGoogleCalendarConnection,
  publicConnection,
  readConnection,
  requireConnectedDoc,
} from '../../lib/googleCalendarConnection';
import {
  WRITE_CALENDAR_INVALID_CODE,
  writeCalendarProblem,
} from '../../lib/googleCalendarTargets';
import { readFreeBusyCalendarId } from './googleCalendarAccount';

/**
 * Choosing WHICH calendar on the connected account AuntieOS writes to
 * (Task 7.2).
 *
 * `listGoogleCalendars` exists so the operator picks from their real calendars
 * instead of pasting an id. A pasted id that Google cannot see fails at push
 * time with `notFound`, which is the same silent-looking failure the free/busy
 * sync's shape check was built to prevent; picking from a list removes the
 * class of error entirely.
 *
 * `setGoogleCalendarTargets` enforces the write-target rule server-side. Both
 * clients mirror it (`lib/googleCalendarTargets.ts` explains why the rule
 * differs from the free/busy one), but a mirror is a courtesy: this is the copy
 * that runs no matter which client asked, and the ECHO-LOOP case is the reason
 * it cannot be left to the UI. Writing visits into the calendar the free/busy
 * sync imports FROM would bring every pushed visit back as a BLOCKED slot over
 * its own hour.
 */

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  /** `owner`, `writer`, `reader`, `freeBusyReader`. Only the first two can take an event. */
  accessRole: string;
  primary: boolean;
}

export interface ListCalendarsResult {
  calendars: GoogleCalendarSummary[];
  connection: PublicGoogleCalendarConnection;
  freeBusyCalendarId: string;
}

/**
 * Pure mapping from Google's `calendarList.list` items to what the pickers
 * render. Calendars we cannot write to are KEPT, not filtered out, and marked by
 * their `accessRole`: an operator looking for a calendar that is missing from
 * the list has no way to tell "not shown because read-only" from "not shown
 * because the sync is broken", and the first is a fact they can act on.
 */
export function toCalendarSummaries(
  items: Array<{ id?: string | null; summary?: string | null; accessRole?: string | null; primary?: boolean | null }>,
): GoogleCalendarSummary[] {
  return items
    .filter((i): i is { id: string } & typeof i => typeof i.id === 'string' && i.id !== '')
    .map((i) => ({
      id: i.id,
      summary: typeof i.summary === 'string' && i.summary !== '' ? i.summary : i.id,
      accessRole: typeof i.accessRole === 'string' ? i.accessRole : '',
      primary: i.primary === true,
    }));
}

/** True when Google says we may add events to this calendar. */
export function canWriteToCalendar(accessRole: string): boolean {
  return accessRole === 'owner' || accessRole === 'writer';
}

export async function listGoogleCalendarsHandler(
  req: CallableRequest<unknown>,
): Promise<ListCalendarsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const doc = await requireConnectedDoc(db());
  const freeBusyCalendarId = await readFreeBusyCalendarId(db());

  try {
    const calendar = await calendarClientForRefreshToken(doc.refreshToken);
    const resp = await calendar.calendarList.list({ maxResults: 250, showHidden: false });
    return {
      calendars: toCalendarSummaries(resp.data.items ?? []),
      connection: publicConnection(doc),
      freeBusyCalendarId,
    };
  } catch (err) {
    // A dead grant is not a transient outage. Retrying never fixes it and only
    // reconnecting does, so it gets its own code and its own message.
    if (isInvalidGrant(err)) {
      logEvent({
        severity: 'warn',
        function: 'listGoogleCalendars',
        event: 'gcal.oauth.invalid_grant',
        uid,
      });
      throw revokedError();
    }
    logEvent({
      severity: 'warn',
      function: 'listGoogleCalendars',
      event: 'gcal.calendars.list_failed',
      uid,
      errorMessage: err instanceof Error ? err.message : 'unknown',
    });
    throw new HttpsError(
      'unavailable',
      `Google would not list the calendars on this account: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    );
  }
}

/**
 * Frozen in `test/callableContract.test.ts`. `writeCalendarId` is the calendar
 * visits go to; `enabledCalendarIds` are the calendars the operator ticked as
 * ours to keep in step, which today means the write target must be one of them.
 */
export const SetTargetsArgs = z
  .object({
    writeCalendarId: z.string(),
    enabledCalendarIds: z.array(z.string()).max(50),
  })
  .strict();

export interface SetTargetsResult {
  connection: PublicGoogleCalendarConnection;
}

export async function setGoogleCalendarTargetsHandler(
  req: CallableRequest<unknown>,
): Promise<SetTargetsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = SetTargetsArgs.safeParse(req.data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }

  const doc = await requireConnectedDoc(db());
  const freeBusyCalendarId = await readFreeBusyCalendarId(db());

  const writeCalendarId = parsed.data.writeCalendarId.trim();
  const problem = writeCalendarProblem(writeCalendarId, freeBusyCalendarId, doc.googleAccountEmail);
  if (problem !== null) {
    logEvent({
      severity: 'warn',
      function: 'setGoogleCalendarTargets',
      event: 'gcal.write_target.refused',
      uid,
      extra: { writeCalendarId },
    });
    throw new HttpsError('failed-precondition', problem, { code: WRITE_CALENDAR_INVALID_CODE });
  }

  // The write target is always enabled, whatever the client sent: a target that
  // is not in the enabled set is a state the UI cannot render honestly, and
  // silently pushing to a calendar the operator un-ticked is worse.
  const enabled = Array.from(
    new Set([...parsed.data.enabledCalendarIds.map((c) => c.trim()).filter((c) => c !== ''), writeCalendarId]),
  );

  await db()
    .doc(GOOGLE_CALENDAR_DOC_PATH)
    .set({ writeCalendarId, enabledCalendarIds: enabled }, { merge: true });

  const after = await readConnection(db());
  return { connection: publicConnection(after) };
}

export const listGoogleCalendars = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('listGoogleCalendars', listGoogleCalendarsHandler),
);

export const setGoogleCalendarTargets = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('setGoogleCalendarTargets', setGoogleCalendarTargetsHandler),
);
