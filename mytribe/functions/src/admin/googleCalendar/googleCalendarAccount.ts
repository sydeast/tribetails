import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../lib/firestoreAdmin';
import { initSentry } from '../../lib/sentry';
import { logEvent } from '../../lib/logger';
import { wrapAdminCallable } from '../../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../../lib/cors';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';
import {
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_SECRETS,
  revokeRefreshToken,
} from '../../lib/googleOAuth';
import {
  GOOGLE_CALENDAR_DOC_PATH,
  PublicGoogleCalendarConnection,
  publicConnection,
  readConnection,
} from '../../lib/googleCalendarConnection';

/**
 * Reading and dropping the Google Calendar connection (Task 7.2).
 *
 * `getGoogleCalendarConnection` is what both clients POLL after opening the
 * consent window, because the callback lands in a different window that they
 * cannot read the result of. It answers with `publicConnection`, which is the
 * only projection of that document any client ever sees and which carries no
 * refresh token under any key.
 *
 * `disconnectGoogleCalendar` REVOKES FIRST, THEN CLEARS. Clearing our copy of a
 * token that is still live at Google would leave a grant on the operator's
 * account that nothing in this app can see or take back, and the panel would say
 * "not connected" while AuntieOS still held write access in principle. If the
 * revoke fails the disconnect still happens (the operator asked for it, and
 * refusing would strand them), but the failure is RECORDED on the doc and
 * surfaced, with the manual fix named.
 *
 * THE DOC IS CLEARED, NOT DELETED. A deleted doc and a connection that was never
 * made read identically, so an operator who pressed Disconnect could not tell
 * whether it worked. Same reasoning as `logoRemovedAt` in the branding slice:
 * cleared and never-set have to look different or the button reports nothing.
 */

export interface GetConnectionResult {
  connection: PublicGoogleCalendarConnection;
  /**
   * The free/busy calendar id (Task 7.1's `business_settings.calendarSyncId`),
   * so the client can apply the same write-target conflict rule the server
   * enforces without a second read.
   */
  freeBusyCalendarId: string;
  /** Named here so the setup copy can print the exact URI the OAuth client needs. */
  redirectUri: string;
}

const BUSINESS_SETTINGS_COLLECTION = 'business_settings';
const FEATURE_FLAGS_DOC_ID = 'feature_flags';

/**
 * The saved free/busy calendar id, read the same forgiving way
 * `syncGoogleCalendarBusyEvents.pickCalendarIdFromDocs` reads it: the doc id is
 * NOT consistent across clients (web writes `singleton`, android writes
 * `business_settings`), so a fixed id would miss it on half the installs.
 */
export async function readFreeBusyCalendarId(
  database: FirebaseFirestore.Firestore,
): Promise<string> {
  const snap = await database.collection(BUSINESS_SETTINGS_COLLECTION).get();
  for (const doc of snap.docs) {
    if (doc.id === FEATURE_FLAGS_DOC_ID) continue;
    const raw = (doc.data() as { calendarSyncId?: unknown } | undefined)?.calendarSyncId;
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return '';
}

export async function getGoogleCalendarConnectionHandler(
  req: CallableRequest<unknown>,
): Promise<GetConnectionResult> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const [doc, freeBusyCalendarId] = await Promise.all([
    readConnection(db()),
    readFreeBusyCalendarId(db()),
  ]);
  return {
    connection: publicConnection(doc),
    freeBusyCalendarId,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
  };
}

export interface DisconnectResult {
  connection: PublicGoogleCalendarConnection;
  /** True when Google confirmed the grant is gone. False means the operator must finish it. */
  revoked: boolean;
  /** Empty when `revoked`; otherwise what Google said, verbatim. */
  revokeError: string;
}

/** The instruction that follows a failed revoke, in one place so it cannot drift. */
export const MANUAL_REVOKE_HINT =
  'AuntieOS has forgotten the connection, but Google may still list Tribe Tails as having ' +
  'access. Remove it at myaccount.google.com/permissions to be sure.';

export async function disconnectGoogleCalendarHandler(
  req: CallableRequest<unknown>,
): Promise<DisconnectResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const existing = await readConnection(db());
  if (!existing.connected && existing.refreshToken.trim() === '') {
    // Nothing to revoke and nothing to clear. Answering with the current state
    // rather than an error keeps Disconnect idempotent, which matters because
    // the button is exactly the thing an operator presses twice when unsure.
    return { connection: publicConnection(existing), revoked: true, revokeError: '' };
  }

  let revoked = true;
  let revokeError = '';
  try {
    // Reads both secrets: revocation is a call to Google as this OAuth client.
    await revokeRefreshToken(existing.refreshToken);
  } catch (err) {
    revoked = false;
    revokeError = err instanceof Error ? err.message : 'Google did not confirm the revoke.';
    logEvent({
      severity: 'warn',
      function: 'disconnectGoogleCalendar',
      event: 'gcal.oauth.revoke_failed',
      uid,
      extra: { reason: revokeError },
    });
  }

  const disconnectedAt = new Date().toISOString();
  await db()
    .doc(GOOGLE_CALENDAR_DOC_PATH)
    .set(
      {
        connected: false,
        // The credential goes, whatever Google said. Keeping a token we have
        // been asked to forget is the one outcome with no defence.
        refreshToken: '',
        scopes: [],
        googleAccountEmail: '',
        connectedAt: '',
        connectedByUid: '',
        writeCalendarId: '',
        enabledCalendarIds: [],
        disconnectedAt,
        disconnectedError: revoked ? '' : `${revokeError} ${MANUAL_REVOKE_HINT}`,
      },
      { merge: true },
    );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.INTEGRATION_CALENDAR_DISCONNECTED,
    severity: revoked ? 'info' : 'warn',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'integrations_config',
    description: revoked
      ? `Disconnected Google Calendar account ${existing.googleAccountEmail}`
      : `Disconnected Google Calendar account ${existing.googleAccountEmail}, revoke not confirmed`,
    payload: { googleAccountEmail: existing.googleAccountEmail, revoked },
  });

  const after = await readConnection(db());
  return { connection: publicConnection(after), revoked, revokeError };
}

export const getGoogleCalendarConnection = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapAdminCallable('getGoogleCalendarConnection', getGoogleCalendarConnectionHandler),
);

export const disconnectGoogleCalendar = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('disconnectGoogleCalendar', disconnectGoogleCalendarHandler),
);
