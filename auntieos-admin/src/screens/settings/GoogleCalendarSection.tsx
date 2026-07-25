import { useCallback, useEffect, useRef, useState } from 'react';
import {
  disconnectGoogleCalendar,
  getGoogleCalendarConnection,
  listGoogleCalendars,
  pushVisitsToGoogleCalendar,
  setGoogleCalendarTargets,
  startGoogleCalendarConnect,
  type GoogleCalendarConnection,
  type GoogleCalendarSummary,
} from '../../api/googleCalendar';
import {
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_SECRET_NAMES,
  calendarPushRunLabel,
  canWriteToCalendar,
  storedCalendarPushRun,
  writeCalendarProblem,
} from '../../lib/googleCalendarTargets';
import { DenPanel, ServicePill } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import '../SettingsEdit.css';

/**
 * Google Calendar, the half that WRITES (Task 7.2).
 *
 * A separate panel from Calendar sync on purpose, because they are separate
 * features that fail separately. That one imports busy time off a calendar
 * shared with a service account and needs nothing signed in. This one puts our
 * visits ON a calendar belonging to a Google account someone signs into, and is
 * the only surface in the app gated on secrets the operator sets by hand.
 *
 * THE CONSENT WINDOW IS NOT READABLE FROM HERE. Google redirects to a Cloud
 * Function, in a window this page cannot inspect (different origin, and the
 * operator may well close it before it finishes). So the panel does not guess:
 * it polls `getGoogleCalendarConnection` and believes only what the server says.
 * When the poll window ends with nothing connected, the panel says the attempt
 * did not complete and prints the server's own `connectLastError`, which the
 * callback stamps on failure INCLUDING a declined consent. Claiming success we
 * have not observed, or silently going back to "not connected" with no reason,
 * are the two failures this arrangement exists to avoid.
 *
 * NO TOKEN COMES BACK HERE, ever. `firestore.rules` denies the connection
 * document to every client, and the callables answer with a projection that has
 * the refresh token stripped. That is why "connected" is a fact this panel has
 * to ask the server for rather than something it could read itself.
 */

/** How long the panel keeps asking after the consent window opens, and how often. */
const POLL_EVERY_MS = 3_000;
const POLL_FOR_MS = 120_000;

interface Loaded {
  connection: GoogleCalendarConnection;
  freeBusyCalendarId: string;
}

export function GoogleCalendarSection() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [calendars, setCalendars] = useState<GoogleCalendarSummary[] | null>(null);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [draftCalendarId, setDraftCalendarId] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const [waitingForConsent, setWaitingForConsent] = useState(false);
  const [consentTimedOut, setConsentTimedOut] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [disconnectNote, setDisconnectNote] = useState<string | null>(null);

  // Cleared on unmount so a poll started by a connect attempt cannot go on
  // firing (and setting state) after the operator leaves the section.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await getGoogleCalendarConnection();
      setLoaded({ connection: result.connection, freeBusyCalendarId: result.freeBusyCalendarId });
      setDraftCalendarId(result.connection.writeCalendarId);
      return result.connection;
    } catch (err) {
      // The server's text names the missing secret and the exact command that
      // sets it. Summarising it here would delete the instructions.
      setLoadError(err instanceof Error ? err.message : 'Could not read the Google connection.');
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    return stopPolling;
  }, [load, stopPolling]);

  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setConsentTimedOut(false);
    try {
      const { authUrl } = await startGoogleCalendarConnect();
      // A new window rather than a redirect: the admin is a single-page app and
      // sending it away mid-flow would lose whatever else is half-edited.
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      setWaitingForConsent(true);
      const startedAt = Date.now();
      stopPolling();
      pollTimer.current = setInterval(() => {
        void (async () => {
          const connection = await load();
          if (connection?.connected === true) {
            stopPolling();
            setWaitingForConsent(false);
            return;
          }
          if (Date.now() - startedAt > POLL_FOR_MS) {
            stopPolling();
            setWaitingForConsent(false);
            setConsentTimedOut(true);
          }
        })();
      }, POLL_EVERY_MS);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not start the connection.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadCalendars() {
    if (busy) return;
    setBusy(true);
    setCalendarsError(null);
    try {
      const result = await listGoogleCalendars();
      setCalendars(result.calendars);
      setLoaded({ connection: result.connection, freeBusyCalendarId: result.freeBusyCalendarId });
    } catch (err) {
      setCalendarsError(err instanceof Error ? err.message : 'Could not list the calendars.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveTarget() {
    if (busy || loaded === null) return;
    const problem = writeCalendarProblem(
      draftCalendarId,
      loaded.freeBusyCalendarId,
      loaded.connection.googleAccountEmail,
    );
    if (problem !== null) {
      setActionError(problem);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await setGoogleCalendarTargets(draftCalendarId, [draftCalendarId]);
      setLoaded({ connection: result.connection, freeBusyCalendarId: loaded.freeBusyCalendarId });
      setJustSaved(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not save the calendar.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePush() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setPushNote(null);
    try {
      const result = await pushVisitsToGoogleCalendar(30);
      const skipped =
        result.skipped.length === 0
          ? ''
          : ` ${String(result.skipped.length)} skipped: ${result.skipped
              .map((s) => `${s.sessionId} (${s.reason})`)
              .join(' ')}`;
      const sent = result.pushed === 1 ? '1 visit' : `${String(result.pushed)} visits`;
      const removed =
        result.removed === 1 ? '1 cancelled visit' : `${String(result.removed)} cancelled visits`;
      setPushNote(`Sent ${sent}, removed ${removed}.${skipped}`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The push failed.');
      // The receipt the server stamped on the failure outlives this message, so
      // re-read it: after a reload it is the only record left.
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setDisconnectNote(null);
    try {
      const result = await disconnectGoogleCalendar();
      setLoaded((prev) =>
        prev === null ? prev : { connection: result.connection, freeBusyCalendarId: prev.freeBusyCalendarId },
      );
      setCalendars(null);
      setDraftCalendarId('');
      setDisconnectNote(
        result.revoked
          ? 'Disconnected. Visits already written to Google stay on that calendar; remove any you do not want by hand.'
          : `Disconnected here, but Google did not confirm it: ${result.revokeError}`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  const connection = loaded?.connection ?? null;
  const pushLabel = connection === null ? null : calendarPushRunLabel(storedCalendarPushRun(connection));
  const draftProblem =
    loaded === null || draftCalendarId === ''
      ? null
      : writeCalendarProblem(draftCalendarId, loaded.freeBusyCalendarId, loaded.connection.googleAccountEmail);

  return (
    <DenPanel
      title="Google Calendar (editable)"
      subtitle="Puts scheduled visits onto a Google calendar you sign in to. Separate from Calendar sync, which only reads busy time."
      trailing={<ServicePill serviceType="OAuth" tone="teal" />}
    >
      {loadError !== null && (
        <Banner tone="error" title="Google Calendar is not ready" className="settingsEdit__sectionBanner">
          {loadError}
        </Banner>
      )}
      {actionError !== null && (
        <Banner tone="error" title="That did not work" className="settingsEdit__sectionBanner">
          {actionError}
        </Banner>
      )}

      {/* Outside the connected / not-connected branches on purpose. Disconnect
          flips the panel to its not-connected state, so a note rendered inside
          the connected half would unmount at the exact moment it had something
          to say, and the operator would be left looking at a blank panel unable
          to tell a disconnect that worked from one that never ran. */}
      {disconnectNote !== null && (
        <p className="settingsEdit__readonlyValue" role="status">
          {disconnectNote}
        </p>
      )}

      <p className="settingsEdit__hint">
        Setup is done once, by whoever owns the Google Cloud project: create an OAuth client ID of
        type Web application for project auntieos-ttpc, with the redirect URI{' '}
        <strong>{GOOGLE_OAUTH_REDIRECT_URI}</strong>, then set{' '}
        <strong>{GOOGLE_OAUTH_SECRET_NAMES.join(' and ')}</strong> as function secrets and redeploy.
        Until that is done, Connect will say which piece is missing.
      </p>

      {connection === null ? (
        <p className="settingsEdit__hint" role="status">
          Reading the connection…
        </p>
      ) : connection.connected ? (
        <>
          <p className="settingsEdit__readonlyValue">
            Connected as <strong>{connection.googleAccountEmail}</strong>.
          </p>

          <div className="settingsEdit__subsection">
            {calendarsError !== null && (
              <Banner tone="error" title="Could not list calendars" className="settingsEdit__sectionBanner">
                {calendarsError}
              </Banner>
            )}

            {calendars === null ? (
              <div className="settingsEdit__saveRow">
                <GhostButton
                  label="Load calendars"
                  onClick={() => void handleLoadCalendars()}
                  disabled={busy}
                />
              </div>
            ) : (
              <label className="settingsEdit__field">
                <span className="settingsEdit__fieldLabel">Write visits to</span>
                <select
                  className="settingsEdit__input"
                  value={draftCalendarId}
                  disabled={busy}
                  onChange={(e) => {
                    setDraftCalendarId(e.target.value);
                    setJustSaved(false);
                    setActionError(null);
                  }}
                >
                  <option value="">Pick a calendar</option>
                  {calendars.map((c) => (
                    // Read-only calendars are listed and disabled rather than
                    // hidden: a calendar missing from this list would otherwise
                    // read as "the connection is broken".
                    <option key={c.id} value={c.id} disabled={!canWriteToCalendar(c.accessRole)}>
                      {canWriteToCalendar(c.accessRole)
                        ? c.summary
                        : `${c.summary} (read only, cannot take events)`}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {draftProblem !== null && (
              <p className="settingsEdit__hint" role="alert">
                {draftProblem}
              </p>
            )}

            <div className="settingsEdit__saveRow">
              <PrimaryButton
                label={busy ? 'Saving…' : 'Save calendar'}
                onClick={() => void handleSaveTarget()}
                disabled={busy || draftCalendarId === '' || draftProblem !== null}
                busy={busy}
              />
              {justSaved ? <span className="settingsEdit__savedNote">Saved</span> : null}
            </div>
          </div>

          <div className="settingsEdit__subsection">
            {pushLabel === null ? (
              <p className="settingsEdit__hint">No visits have been sent to this calendar yet.</p>
            ) : connection.calendarPushLastStatus !== 'ok' ? (
              <Banner tone="error" title="The last push failed" className="settingsEdit__sectionBanner">
                {connection.calendarPushLastError === ''
                  ? pushLabel
                  : `${pushLabel} ${connection.calendarPushLastError}`}
              </Banner>
            ) : (
              // role=status so a push that sends the same count as last time is
              // still announced: the timestamp changed, and a screen reader user
              // has no other cue that the button did anything.
              <p className="settingsEdit__readonlyValue" role="status">
                {pushLabel}
              </p>
            )}

            {pushNote !== null && (
              <p className="settingsEdit__readonlyValue" role="status">
                {pushNote}
              </p>
            )}

            <div className="settingsEdit__saveRow">
              <PrimaryButton
                label={busy ? 'Sending…' : 'Push next 30 days'}
                onClick={() => void handlePush()}
                disabled={busy || connection.writeCalendarId === ''}
                busy={busy}
              />
            </div>
            {connection.writeCalendarId === '' ? (
              <p className="settingsEdit__hint">
                Pick and save a calendar first. The push runs on the server and writes to the saved
                calendar, not to what is in the box.
              </p>
            ) : (
              <p className="settingsEdit__hint">
                Sends the next 30 days of visits. Running it again is safe: visits already sent are
                updated in place, and a cancelled visit is taken off the calendar.
              </p>
            )}
          </div>

          <div className="settingsEdit__subsection">
            <div className="settingsEdit__saveRow">
              <GhostButton label="Disconnect" onClick={() => void handleDisconnect()} disabled={busy} />
            </div>
            <p className="settingsEdit__hint">
              Disconnecting removes the access AuntieOS holds. Visits already written stay on the
              Google calendar; they are not deleted.
            </p>
          </div>
        </>
      ) : (
        <div className="settingsEdit__subsection">
          {waitingForConsent ? (
            <p className="settingsEdit__readonlyValue" role="status">
              Waiting for the Google window. Finish signing in there, then this panel updates on its
              own.
            </p>
          ) : consentTimedOut ? (
            <Banner tone="error" title="Not connected" className="settingsEdit__sectionBanner">
              {connection.connectLastError === ''
                ? 'The Google window never came back with an answer. Try Connect again.'
                : connection.connectLastError}
            </Banner>
          ) : connection.connectLastStatus === 'error' && connection.connectLastError !== '' ? (
            <Banner tone="error" title="The last attempt failed" className="settingsEdit__sectionBanner">
              {connection.connectLastError}
            </Banner>
          ) : connection.disconnectedAt !== '' ? (
            <p className="settingsEdit__hint">
              Disconnected. Connect again to start writing visits to Google.
              {connection.disconnectedError === '' ? '' : ` ${connection.disconnectedError}`}
            </p>
          ) : (
            <p className="settingsEdit__hint">No Google account is connected yet.</p>
          )}

          <div className="settingsEdit__saveRow">
            <PrimaryButton
              label={busy ? 'Opening Google…' : 'Connect Google Calendar'}
              onClick={() => void handleConnect()}
              disabled={busy || waitingForConsent}
              busy={busy}
            />
          </div>
        </div>
      )}
    </DenPanel>
  );
}
