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
  calendarPushRunLabel,
  canWriteToCalendar,
  storedCalendarPushRun,
  writeCalendarProblem,
} from '../../lib/googleCalendarTargets';
import {
  GOOGLE_OAUTH_DECLARING_FUNCTIONS,
  NO_SIGNALS,
  googleOAuthSetupSteps,
  googleOAuthSetupSummary,
  readOAuthFailure,
  type GoogleOAuthSetupSignals,
} from '../../lib/googleOAuthSetup';
import { DenPanel, ServicePill } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import '../SettingsEdit.css';

/**
 * Google Calendar, the half that WRITES (Task 7.2). One of the two sub-areas of
 * the Calendar section; the free/busy import is the other.
 *
 * A SEPARATE COMPONENT from the free/busy import, under one nav item since
 * 2026-07-31. They are one thing to look for and two things that fail: this one
 * puts our visits ON a calendar belonging to a Google account someone signs
 * into, and is the only surface in the app gated on secrets the operator sets by
 * hand. That one imports busy time off a calendar shared with a service account
 * and needs nothing signed in. Merged panels, separate failures, separate
 * receipts.
 *
 * THE SETUP CHECKLIST IS THE POINT OF THIS PANEL until it is connected. The
 * three steps used to live in a commit message and a contract document, and the
 * panel carried one paragraph naming all three at once. An operator who had done
 * step 2 several times had no way to learn that step 3 was the outstanding one,
 * because every unfinished state produced the same sentence. `lib/googleOAuthSetup.ts`
 * derives a state per step from what the server has actually said, and says
 * "only the server can answer this" rather than guessing where it cannot.
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

/** The word next to a step. Spelled out, never colour alone. */
const STATE_WORD = { done: 'done', failing: 'not done', unknown: 'unknown' } as const;

/**
 * The three steps, with what is known about each. Rendered whenever nothing is
 * connected, and folded away once it is: a finished checklist next to a working
 * connection is noise, and the connection itself is the receipt.
 */
function SetupChecklist({ signals }: { signals: GoogleOAuthSetupSignals }) {
  const steps = googleOAuthSetupSteps(signals);
  return (
    <div className="settingsEdit__subsection">
      <p className="settingsEdit__hint">
        Setup is done once, by whoever owns the Google Cloud project. Both secret names are already
        declared in the {GOOGLE_OAUTH_DECLARING_FUNCTIONS.length} functions that read them, so the
        code side is finished and only these three steps are left.
      </p>
      {/* role=status: the summary changes when a Connect attempt answers, and it
          is the one line that says which step to look at. */}
      <p className="settingsEdit__readonlyValue" role="status">
        {googleOAuthSetupSummary(steps)}
      </p>
      <ol className="settingsEdit__checklist">
        {steps.map((step) => (
          <li key={step.id} className="settingsEdit__checklistItem">
            <div>
              <p className="settingsEdit__checklistTitle">
                {step.title}
                <span className={`settingsEdit__checklistState settingsEdit__checklistState--${step.state}`}>
                  {STATE_WORD[step.state]}
                </span>
              </p>
              <p className="settingsEdit__checklistDetail">{step.detail}</p>
              {step.literal !== '' && <pre className="settingsEdit__checklistLiteral">{step.literal}</pre>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
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

  // What the server has said about setup this session. Only ever written from a
  // real answer: `missingSecrets` comes from the server's own `details.missing`,
  // and `consentUrlIssued` from a URL it actually built. Nothing here is
  // inferred from a message string.
  const [observed, setObserved] = useState({
    serverAnswered: true,
    serverFailure: '',
    missingSecrets: [] as string[],
    consentUrlIssued: false,
  });

  /**
   * Records what a rejection proves about setup, and nothing more. A failure
   * that is not `google_oauth_not_configured` says nothing about the secrets, so
   * it CLEARS no earlier finding and claims none: an offline blip must not read
   * as "the secrets are fine now".
   */
  const noteFailure = useCallback((err: unknown) => {
    const { missing } = readOAuthFailure(err);
    if (missing.length > 0) setObserved((prev) => ({ ...prev, missingSecrets: missing }));
  }, []);

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
      // This callable declares no OAuth secret and reads none, so answering
      // proves only that the code is deployed. That is exactly the fact step 3
      // needs, and it is not evidence about the values.
      setObserved((prev) => ({ ...prev, serverAnswered: true, serverFailure: '' }));
      return result.connection;
    } catch (err) {
      // The server's text names the missing secret and the exact command that
      // sets it. Summarising it here would delete the instructions.
      const message = err instanceof Error ? err.message : 'Could not read the Google connection.';
      setLoadError(message);
      setObserved((prev) => ({ ...prev, serverAnswered: false, serverFailure: message }));
      noteFailure(err);
      return null;
    }
  }, [noteFailure]);

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
      // The server refuses to build this URL unless BOTH values are non-empty,
      // so holding one is proof that steps 2 and 3 are done. Nothing else the
      // panel can do proves it.
      setObserved((prev) => ({ ...prev, consentUrlIssued: true, missingSecrets: [] }));
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
      noteFailure(err);
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
      noteFailure(err);
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
      noteFailure(err);
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
      noteFailure(err);
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

  const signals: GoogleOAuthSetupSignals = {
    ...NO_SIGNALS,
    ...observed,
    connected: connection?.connected === true,
    connectedAccount: connection?.googleAccountEmail ?? '',
    lastConnectError: connection?.connectLastError ?? '',
  };

  return (
    <DenPanel
      title="Editable calendars"
      subtitle="Puts scheduled visits onto a Google calendar you sign in to. The import above only reads busy time; this half writes."
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

      {/* Only while there is nothing connected. A connected account IS the
          receipt for all three steps, and leaving a finished checklist above it
          would bury the calendar picker under setup nobody has left to do. */}
      {connection?.connected !== true && <SetupChecklist signals={signals} />}

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
