import { HttpsError } from 'firebase-functions/v2/https';
import { GOOGLE_CALENDAR_NOT_CONNECTED_CODE } from './googleCalendarTargets';

/**
 * Where the Google Calendar OAuth connection lives, what is safe to hand a
 * client, and the receipts every action leaves behind.
 *
 * WHERE THE REFRESH TOKEN LIVES, AND WHO CAN READ IT. One Firestore document,
 * `integrations_config/googleCalendar`, whose path is DENIED to every client in
 * `firestore.rules` (`allow read, write: if false`), including a signed-in
 * Auntie. The only readers are these Cloud Functions, which reach it through
 * the Admin SDK and bypass rules by design. That is the whole access model, and
 * each part of it is deliberate:
 *
 *   - A refresh token is a standing credential. It does not expire on its own,
 *     and whoever holds it can create, edit and delete events on the operator's
 *     real calendar until the grant is revoked. Handing one to a client is not
 *     leaking data ABOUT the calendar, it is handing over the calendar.
 *   - So no callable returns it. `publicConnection` below is the ONLY shape any
 *     client is given, and `test/googleCalendarConnection.test.ts` asserts that
 *     shape carries no token under any key.
 *   - Rules deny WRITE too, not just read. A client that could write this doc
 *     could point the connection at a token it owns, and the next push would
 *     put our households' visits on a calendar someone else controls.
 *   - Disconnect REVOKES at Google before it clears our copy. Deleting only our
 *     copy would leave a live grant on the operator's account that nothing in
 *     this app can see or take back.
 *
 * What this does NOT claim: the token is not encrypted with a key of our own on
 * top of Firestore's own at-rest encryption. That would need a third
 * operator-managed secret whose loss would strand a connection no code path
 * could then revoke, and it would not defend against the threat that matters
 * here, since anything able to run inside these functions can read that key too.
 * Project owners can read the document in the Firebase console; that is the same
 * console that can mint fresh credentials outright.
 */

export const INTEGRATIONS_COLLECTION = 'integrations_config';
export const GOOGLE_CALENDAR_DOC_ID = 'googleCalendar';
export const GOOGLE_CALENDAR_DOC_PATH = `${INTEGRATIONS_COLLECTION}/${GOOGLE_CALENDAR_DOC_ID}`;

/**
 * One-time OAuth `state` nonces. Also denied to every client: a caller who could
 * read this collection could take a pending nonce and complete someone else's
 * flow against their own Google account.
 */
export const OAUTH_STATE_COLLECTION = 'google_oauth_states';

/** How long a started connect flow stays completable. Long enough to sign in and consent. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/** The stored document. `refreshToken` never leaves the server. */
export interface GoogleCalendarConnectionDoc {
  connected: boolean;
  /** The Google account that consented, read back from its own primary calendar entry. */
  googleAccountEmail: string;
  connectedAt: string;
  connectedByUid: string;
  scopes: string[];
  /** SERVER ONLY. Never in a callable response, never readable by a client. */
  refreshToken: string;
  /** The calendar visits are written to. Empty until the operator picks one. */
  writeCalendarId: string;
  /** Calendars the operator ticked as ours to keep in step. */
  enabledCalendarIds: string[];
  disconnectedAt: string;
  /** Set when revoking at Google failed, so a half-done disconnect is visible. */
  disconnectedError: string;
  connectLastAttemptAt: string;
  connectLastStatus: string;
  connectLastError: string;
  calendarPushLastRunAt: string;
  calendarPushLastStatus: string;
  calendarPushLastPushed: number;
  calendarPushLastError: string;
  /**
   * The automatic per-visit sync's receipt (issue #397). Deliberately a
   * SEPARATE set from the bulk push's four fields: "the button I pressed
   * failed" and "the visit I just confirmed never reached the calendar" are
   * different sentences, and folding them together would let a successful
   * manual push erase the evidence that automatic sync is broken.
   */
  calendarAutoSyncLastRunAt: string;
  calendarAutoSyncLastStatus: string;
  /** `created`, `updated`, `deleted` or `skipped`, so the panel says what happened. */
  calendarAutoSyncLastAction: string;
  calendarAutoSyncLastSessionId: string;
  calendarAutoSyncLastError: string;
}

/**
 * The ONLY shape a client is ever given. Built by naming each field rather than
 * by deleting `refreshToken` off a spread, so a field added to the stored doc
 * later cannot leak through a projection nobody remembered to narrow.
 */
export interface PublicGoogleCalendarConnection {
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
  calendarAutoSyncLastRunAt: string;
  calendarAutoSyncLastStatus: string;
  calendarAutoSyncLastAction: string;
  calendarAutoSyncLastSessionId: string;
  calendarAutoSyncLastError: string;
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

function strArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function num(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** Normalizes a raw snapshot (or its absence) into the stored shape. */
export function connectionFromDoc(
  raw: Record<string, unknown> | undefined,
): GoogleCalendarConnectionDoc {
  const r = raw ?? {};
  return {
    // `connected` is true only when a token is actually held. A doc claiming
    // connected with no token is a disconnect that half-failed, and reporting it
    // as connected would send the operator hunting for a calendar problem.
    connected: r.connected === true && str(r.refreshToken).trim() !== '',
    googleAccountEmail: str(r.googleAccountEmail),
    connectedAt: str(r.connectedAt),
    connectedByUid: str(r.connectedByUid),
    scopes: strArray(r.scopes),
    refreshToken: str(r.refreshToken),
    writeCalendarId: str(r.writeCalendarId),
    enabledCalendarIds: strArray(r.enabledCalendarIds),
    disconnectedAt: str(r.disconnectedAt),
    disconnectedError: str(r.disconnectedError),
    connectLastAttemptAt: str(r.connectLastAttemptAt),
    connectLastStatus: str(r.connectLastStatus),
    connectLastError: str(r.connectLastError),
    calendarPushLastRunAt: str(r.calendarPushLastRunAt),
    calendarPushLastStatus: str(r.calendarPushLastStatus),
    calendarPushLastPushed: num(r.calendarPushLastPushed),
    calendarPushLastError: str(r.calendarPushLastError),
    calendarAutoSyncLastRunAt: str(r.calendarAutoSyncLastRunAt),
    calendarAutoSyncLastStatus: str(r.calendarAutoSyncLastStatus),
    calendarAutoSyncLastAction: str(r.calendarAutoSyncLastAction),
    calendarAutoSyncLastSessionId: str(r.calendarAutoSyncLastSessionId),
    calendarAutoSyncLastError: str(r.calendarAutoSyncLastError),
  };
}

/** Strips the credential. The one function every callable response goes through. */
export function publicConnection(doc: GoogleCalendarConnectionDoc): PublicGoogleCalendarConnection {
  return {
    connected: doc.connected,
    googleAccountEmail: doc.googleAccountEmail,
    connectedAt: doc.connectedAt,
    scopes: doc.scopes,
    writeCalendarId: doc.writeCalendarId,
    enabledCalendarIds: doc.enabledCalendarIds,
    disconnectedAt: doc.disconnectedAt,
    disconnectedError: doc.disconnectedError,
    connectLastAttemptAt: doc.connectLastAttemptAt,
    connectLastStatus: doc.connectLastStatus,
    connectLastError: doc.connectLastError,
    calendarPushLastRunAt: doc.calendarPushLastRunAt,
    calendarPushLastStatus: doc.calendarPushLastStatus,
    calendarPushLastPushed: doc.calendarPushLastPushed,
    calendarPushLastError: doc.calendarPushLastError,
    calendarAutoSyncLastRunAt: doc.calendarAutoSyncLastRunAt,
    calendarAutoSyncLastStatus: doc.calendarAutoSyncLastStatus,
    calendarAutoSyncLastAction: doc.calendarAutoSyncLastAction,
    calendarAutoSyncLastSessionId: doc.calendarAutoSyncLastSessionId,
    calendarAutoSyncLastError: doc.calendarAutoSyncLastError,
  };
}

/** Reads the connection doc as stored, whether or not anything is connected. */
export async function readConnection(
  database: FirebaseFirestore.Firestore,
): Promise<GoogleCalendarConnectionDoc> {
  const snap = await database.doc(GOOGLE_CALENDAR_DOC_PATH).get();
  return connectionFromDoc(snap.data() as Record<string, unknown> | undefined);
}

/** Reads the connection, or rejects with the code clients branch on. */
export async function requireConnectedDoc(
  database: FirebaseFirestore.Firestore,
): Promise<GoogleCalendarConnectionDoc> {
  const doc = await readConnection(database);
  if (!doc.connected) {
    throw new HttpsError(
      'failed-precondition',
      'No Google account is connected. Connect Google Calendar in Settings first.',
      { code: GOOGLE_CALENDAR_NOT_CONNECTED_CODE },
    );
  }
  return doc;
}

/**
 * The connect receipt, stamped on the SUCCESS and on the FAILURE of a returning
 * OAuth callback.
 *
 * The callback runs in a window the operator opened and will close, and the
 * panel that started the flow learns the outcome by polling. Without a stamped
 * failure, a denied consent and a callback that never ran look identical from
 * that panel: still not connected, no reason given. The operator's next move is
 * to press Connect again, which is exactly the "pressed it twice" that 7.1's
 * receipt exists to stop.
 */
export interface ConnectStamp {
  connectLastAttemptAt: string;
  connectLastStatus: 'ok' | 'error';
  connectLastError: string;
}

export function connectStamp(
  outcome: { status: 'ok' } | { status: 'error'; error: string },
  nowIso: string,
): ConnectStamp {
  return {
    connectLastAttemptAt: nowIso,
    connectLastStatus: outcome.status,
    connectLastError: outcome.status === 'ok' ? '' : outcome.error,
  };
}

/**
 * The push receipt: same four-field shape and same reasoning as 7.1's
 * `calendarSyncStamp`. An integration action whose only record is a return value
 * dies with the page, and both clients read these fields straight off a document
 * they already load.
 */
export interface CalendarPushStamp {
  calendarPushLastRunAt: string;
  calendarPushLastStatus: 'ok' | 'error';
  calendarPushLastPushed: number;
  calendarPushLastError: string;
}

export function calendarPushStamp(
  outcome: { status: 'ok'; pushed: number } | { status: 'error'; error: string },
  nowIso: string,
): CalendarPushStamp {
  return {
    calendarPushLastRunAt: nowIso,
    calendarPushLastStatus: outcome.status,
    calendarPushLastPushed: outcome.status === 'ok' ? outcome.pushed : 0,
    calendarPushLastError: outcome.status === 'ok' ? '' : outcome.error,
  };
}

/**
 * The automatic-sync receipt (issue #397), stamped by the lifecycle trigger.
 *
 * WHY THE TRIGGER STAMPS THE CONNECTION DOCUMENT AND NOT ONLY THE VISIT. A
 * trigger has nobody to return an error to. The visit row carries what went
 * wrong with THAT visit, which is only findable by someone who already suspects
 * that visit — and the operator's symptom is the opposite shape: the calendar
 * looks fine and one visit is quietly missing from it. All three admin surfaces
 * already poll `getGoogleCalendarConnection` for connection status, so a
 * revoked grant or a failing calendar surfaces on the panel the operator opens
 * anyway, without any of them learning a new query.
 *
 * `calendarAutoSyncLastAction` carries the SUCCESS shape too, not just
 * failures. A panel that only ever shows automatic sync when it breaks gives
 * the operator no way to confirm it is working, which is how a feature ends up
 * being pressed manually forever by someone who does not trust it.
 */
export interface CalendarAutoSyncStamp {
  calendarAutoSyncLastRunAt: string;
  calendarAutoSyncLastStatus: 'ok' | 'error';
  calendarAutoSyncLastAction: string;
  calendarAutoSyncLastSessionId: string;
  calendarAutoSyncLastError: string;
}

export function calendarAutoSyncStamp(
  outcome:
    | { status: 'ok'; sessionId: string; action: string }
    | { status: 'error'; sessionId: string; error: string },
  nowIso: string,
): CalendarAutoSyncStamp {
  return {
    calendarAutoSyncLastRunAt: nowIso,
    calendarAutoSyncLastStatus: outcome.status,
    calendarAutoSyncLastAction: outcome.status === 'ok' ? outcome.action : '',
    calendarAutoSyncLastSessionId: outcome.sessionId,
    calendarAutoSyncLastError: outcome.status === 'ok' ? '' : outcome.error,
  };
}
