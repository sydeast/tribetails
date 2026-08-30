import { call } from '../lib/fns';

/**
 * Google Calendar over OAuth, as the admin reaches it (Task 7.2). This is the
 * half that WRITES our visits onto a calendar. The free/busy import in
 * `api/calendarSync.ts` is a different feature: it reads availability as a
 * service account and needs no sign-in and no secret.
 *
 * SIX CALLABLES, all admin-gated in `mytribe/functions/src/admin/googleCalendar/`,
 * plus one HTTP endpoint that only Google ever calls (the redirect target). See
 * `mytribe/functions/CALLABLE_CONTRACT.md`.
 *
 * NO REFRESH TOKEN EVER REACHES THIS FILE. The connection document is denied to
 * every client by `firestore.rules`, and the callables answer with a projection
 * that has the token stripped. That is deliberate and worth keeping: a refresh
 * token is a standing credential, and anything holding one can edit the
 * operator's real calendar until the grant is revoked. Nothing here should ever
 * grow a field for it.
 *
 * FAIL LOUD, no mapping. Whatever the callables reject with propagates untouched.
 * The server's messages are the useful ones: they name the two secrets the
 * operator still owes, the exact `firebase functions:secrets:set` command, and
 * the redirect URI to register. A friendly "Could not connect" here would delete
 * the only text that says what to do next.
 */

/** The only shape of the connection any client sees. No token, by construction. */
export interface GoogleCalendarConnection {
  connected: boolean;
  googleAccountEmail: string;
  connectedAt: string;
  scopes: string[];
  writeCalendarId: string;
  enabledCalendarIds: string[];
  disconnectedAt: string;
  disconnectedError: string;
  connectLastAttemptAt: string;
  connectLastStatus: string;
  connectLastError: string;
  calendarPushLastRunAt: string;
  calendarPushLastStatus: string;
  calendarPushLastPushed: number;
  calendarPushLastError: string;
  /**
   * The AUTOMATIC per-visit sync's receipt (issue #397), stamped by the
   * `onKinCareSessionCalendarSync` trigger. Separate from the four
   * `calendarPushLast*` fields above because a trigger has no caller to return
   * an error to: this is the only place a failed automatic sync is ever
   * reported, and a successful manual push must not overwrite it.
   */
  calendarAutoSyncLastRunAt: string;
  calendarAutoSyncLastStatus: string;
  /** `created`, `updated`, `deleted` or `skipped`. */
  calendarAutoSyncLastAction: string;
  calendarAutoSyncLastSessionId: string;
  calendarAutoSyncLastError: string;
}

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  /** `owner`, `writer`, `reader` or `freeBusyReader`. Only the first two can take an event. */
  accessRole: string;
  primary: boolean;
}

export interface StartConnectResult {
  authUrl: string;
  expiresAt: string;
  redirectUri: string;
}

export interface ConnectionResult {
  connection: GoogleCalendarConnection;
  /** The saved free/busy calendar id, so the write-target rule can run client-side. */
  freeBusyCalendarId: string;
  redirectUri: string;
}

export interface ListCalendarsResult {
  calendars: GoogleCalendarSummary[];
  connection: GoogleCalendarConnection;
  freeBusyCalendarId: string;
}

export interface PushResult {
  pushed: number;
  removed: number;
  scanned: number;
  skipped: Array<{ sessionId: string; reason: string }>;
  ranAt: string;
}

export interface DisconnectResult {
  connection: GoogleCalendarConnection;
  /** False means Google did not confirm, so the operator has a manual step left. */
  revoked: boolean;
  revokeError: string;
}

/**
 * Mints a one-time state nonce server-side and hands back the Google consent
 * URL. The URL is opened, never fetched: it is a page a human signs in on.
 */
export async function startGoogleCalendarConnect(): Promise<StartConnectResult> {
  return call<Record<string, never>, StartConnectResult>('startGoogleCalendarConnect', {});
}

/**
 * The poll target while the consent window is open. The callback lands in a
 * different window whose result this app cannot read, so the server's own record
 * of the outcome is the only honest source.
 */
export async function getGoogleCalendarConnection(): Promise<ConnectionResult> {
  return call<Record<string, never>, ConnectionResult>('getGoogleCalendarConnection', {});
}

export async function listGoogleCalendars(): Promise<ListCalendarsResult> {
  return call<Record<string, never>, ListCalendarsResult>('listGoogleCalendars', {});
}

export async function setGoogleCalendarTargets(
  writeCalendarId: string,
  enabledCalendarIds: string[],
): Promise<{ connection: GoogleCalendarConnection }> {
  return call<
    { writeCalendarId: string; enabledCalendarIds: string[] },
    { connection: GoogleCalendarConnection }
  >('setGoogleCalendarTargets', { writeCalendarId, enabledCalendarIds });
}

/**
 * Sends the next `lookAheadDays` of visits to the chosen calendar. NO CALENDAR
 * ID IN THE REQUEST, the same posture as the free/busy sync: the target is the
 * one the operator saved, so no client can aim a household's visits somewhere
 * else.
 */
export async function pushVisitsToGoogleCalendar(lookAheadDays = 30): Promise<PushResult> {
  return call<{ lookAheadDays: number }, PushResult>('pushVisitsToGoogleCalendar', {
    lookAheadDays,
  });
}

export async function disconnectGoogleCalendar(): Promise<DisconnectResult> {
  return call<Record<string, never>, DisconnectResult>('disconnectGoogleCalendar', {});
}
export interface SyncVisitResult {
  sessionId: string;
  action: 'created' | 'updated' | 'deleted' | 'skipped';
  eventId: string;
  reason: string;
  syncedAt: string;
}
/**
 * Brings ONE visit into line with the calendar. The retry for a visit the
 * automatic sync could not write.
 *
 * NO ACTION IN THE REQUEST, and that is the contract rather than an omission:
 * the server decides between create, update and delete from the stored visit,
 * so a client cannot take a live visit off the operator's calendar or put a
 * second copy of one on it. That also makes a second press safe.
 */
export async function syncVisitToGoogleCalendar(sessionId: string): Promise<SyncVisitResult> {
  return call<{ sessionId: string }, SyncVisitResult>('syncVisitToGoogleCalendar', { sessionId });
}
