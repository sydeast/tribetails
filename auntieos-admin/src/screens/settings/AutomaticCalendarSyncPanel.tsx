import { useState } from 'react';
import {
  syncVisitToGoogleCalendar,
  type GoogleCalendarConnection,
} from '../../api/googleCalendar';
import {
  calendarAutoSyncRunLabel,
  retryableSessionId,
  storedCalendarAutoSyncRun,
} from '../../lib/calendarAutoSync';
import { Banner } from '../../components/Banner';
import { PrimaryButton } from '../../components/Buttons';

/**
 * What automatic calendar sync last did, and the way to retry it when it failed
 * (issue #397).
 *
 * ── WHY THIS IS A PANEL AND NOT A TOGGLE ──────────────────────────────────
 *
 * There is no on/off switch here, on purpose. Automatic sync is on exactly when
 * a calendar has been chosen, because choosing one is already a deliberate act
 * and already means "put our visits here". A second switch would let the
 * operator arrive at a state where a calendar is selected and visits silently
 * do not reach it, which is the exact complaint this feature exists to fix.
 * Disconnecting is the off switch.
 *
 * ── WHY A FAILED SYNC NEEDS A BUTTON AT ALL ───────────────────────────────
 *
 * The trigger deliberately does not rethrow: Firestore would retry it, and
 * retrying a calendar write whose first attempt may already have created an
 * event is how one visit becomes four. So recovery is a human act, and this is
 * where it lives. Without it the only way to retry would be to edit the booking
 * into re-triggering itself, which is asking an operator to fake a change to a
 * real visit to work around our plumbing.
 */

export function AutomaticCalendarSyncPanel({
  connection,
  onSynced,
}: {
  connection: GoogleCalendarConnection;
  /**
   * Re-reads the connection so the receipt on screen is the SERVER's, not a
   * guess assembled from what the retry returned. Its resolved value is ignored
   * on purpose — this panel renders the `connection` prop it is handed on the
   * next render, so anything it kept from here would be a second, staler copy
   * of the same fact.
   */
  onSynced: () => unknown | Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);

  const run = storedCalendarAutoSyncRun(connection);
  const label = calendarAutoSyncRunLabel(run);
  const retryId = retryableSessionId(run);
  const armed = connection.connected && connection.writeCalendarId !== '';

  async function handleRetry() {
    if (retryId === null) return;
    setBusy(true);
    setRetryError(null);
    setRetryNote(null);
    try {
      const result = await syncVisitToGoogleCalendar(retryId);
      setRetryNote(
        result.action === 'skipped'
          ? `Nothing was written for that visit. ${result.reason}`
          : `That visit is on the calendar now (${result.action}).`,
      );
      await onSynced();
    } catch (err) {
      // FAIL LOUD. The server's message names the actual remedy — reconnect,
      // pick a different calendar, add an end time — and a friendly "Could not
      // sync" here would delete the only text that says what to do next.
      setRetryError(err instanceof Error ? err.message : 'Could not sync that visit.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settingsEdit__subsection">
      <h4 className="settingsEdit__checklistTitle">Automatic sync</h4>

      {!armed ? (
        <p className="settingsEdit__hint">
          Once a calendar is chosen above, confirming a visit puts it on that calendar, moving a
          visit moves it, and cancelling one takes it off. No pushing required.
        </p>
      ) : (
        <>
          <p className="settingsEdit__hint">
            Confirming a visit puts it on this calendar, moving a visit moves it, and cancelling one
            takes it off.
          </p>

          {label === null ? (
            <p className="settingsEdit__readonlyValue">
              No visit has changed since this calendar was chosen, so automatic sync has not needed
              to run yet.
            </p>
          ) : run?.status === 'error' ? (
            <Banner
              tone="error"
              title="The last automatic sync failed"
              className="settingsEdit__sectionBanner"
            >
              {run.error === '' ? label : `${label} ${run.error}`}
            </Banner>
          ) : (
            // role=status so a run that reports the same action as last time is
            // still announced: the timestamp changed, and a screen reader user
            // has no other cue.
            <p className="settingsEdit__readonlyValue" role="status">
              {label}
            </p>
          )}

          {retryError !== null && (
            <Banner tone="error" title="Retry failed" className="settingsEdit__sectionBanner">
              {retryError}
            </Banner>
          )}

          {retryNote !== null && (
            <p className="settingsEdit__readonlyValue" role="status">
              {retryNote}
            </p>
          )}

          {retryId !== null && (
            <div className="settingsEdit__saveRow">
              <PrimaryButton
                label={busy ? 'Retrying…' : 'Retry that visit'}
                onClick={() => void handleRetry()}
                disabled={busy}
                busy={busy}
              />
              <span className="settingsEdit__savedNote">Visit {retryId}</span>
            </div>
          )}

          {run?.status === 'error' && retryId === null && (
            <p className="settingsEdit__hint">
              That failure was about the connection rather than one visit, so there is nothing to
              retry on its own. Fix the problem above, then use Push to catch the calendar up.
            </p>
          )}
        </>
      )}
    </div>
  );
}
