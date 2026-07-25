import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import {
  runCalendarSync,
  storedCalendarSyncRun,
  type CalendarSyncReceiptFields,
} from '../../api/calendarSync';
import {
  CALENDAR_ID_EXAMPLE,
  CALENDAR_SYNC_SA_EMAIL,
  calendarIdProblem,
  calendarSyncRunLabel,
  type CalendarSyncRun,
} from '../../lib/calendarSyncId';
import { DenPanel, ServicePill } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import '../SettingsEdit.css';

/**
 * Google Calendar sync: the Calendar ID the sync reads, a Run Sync action, and
 * what the last run actually did.
 *
 * This panel was read-only from the port until 2026-07-25, on the stated
 * grounds that syncing needed "a Google sign-in that isn't wired into this
 * admin". That was wrong about the feature that exists. There are two different
 * things here, and only one of them needs a sign-in:
 *
 *   - FREE/BUSY IMPORT (this panel). A service account,
 *     `auntieos-admin-calendar-sync@…`, reads a calendar the operator shares
 *     with it and writes busy blocks. It authenticates through Application
 *     Default Credentials inside the Cloud Function. No OAuth, no token, no
 *     secret, nothing for a client to sign into. The callable
 *     (`syncGoogleCalendarBusyEvents`) has been deployed the whole time; the
 *     Compose admin and android both call it. Only this surface stopped.
 *   - EDITABLE CALENDARS (writing our visits back to Google). THAT needs an
 *     OAuth client, and it is a separate, not-yet-built thing. Nothing here
 *     depends on it.
 *
 * TWO STEPS, NOT ONE, and the panel is explicit about the order. The callable
 * takes no calendar id: it resolves the id server-side from the saved
 * `business_settings.calendarSyncId`, so a client cannot aim the sync at a
 * calendar the operator never saved. That means Run Sync acts on the SAVED
 * value, not on what is currently in the text box, so the button stays disabled
 * while the field is dirty and says why. A Run Sync that quietly used the old
 * id after an edit is the exact "did that work?" confusion this panel exists to
 * end.
 *
 * THE ID IS CHECKED BEFORE IT IS SENT. Google answers a mistyped id with
 * `notFound` inside a success envelope, and answers an empty calendar with an
 * empty list. Both would land here as "Imported 0 busy blocks", which reads as
 * "nothing on the calendar" rather than "wrong id". `calendarIdProblem`
 * (`lib/calendarSyncId.ts`) refuses the shapes that cannot work, and the
 * callable enforces the same rule server-side for every other client.
 */

interface CalendarSyncSectionProps {
  data: Pick<BusinessSettings, 'calendarSyncId'> & CalendarSyncReceiptFields;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

export function CalendarSyncSection({ data, onSave }: CalendarSyncSectionProps) {
  // Seeded once at mount, the `TextFieldsSection` convention: a sibling
  // section's save round-trips through the same `data` prop, and re-deriving
  // this from `data` would wipe an id half-typed here.
  const [draft, setDraft] = useState(() => data.calendarSyncId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // The last-run receipt. Starts from what the server stamped on the doc, then
  // follows this session's own runs, so the panel is correct both on a cold
  // load and immediately after a click without re-reading Firestore.
  const [run, setRun] = useState<CalendarSyncRun | null>(() => storedCalendarSyncRun(data));

  const trimmed = draft.trim();
  const dirty = trimmed !== data.calendarSyncId.trim();
  // Only complain about the shape once the operator has typed something. An
  // empty field on a never-configured install is a starting state, not a fault.
  const draftProblem = trimmed === '' ? null : calendarIdProblem(trimmed);
  const savedProblem = calendarIdProblem(data.calendarSyncId);

  async function handleSave() {
    if (!dirty || saving) return;
    const problem = calendarIdProblem(trimmed);
    if (problem !== null) {
      setSaveError(problem);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ calendarSyncId: trimmed });
      setJustSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRunSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await runCalendarSync(30);
      // The receipt line IS the report. It carries the new timestamp, so it
      // changes on every run even when the count does not.
      setRun({ ranAt: result.ranAt, status: 'ok', imported: result.imported, error: '' });
    } catch (err) {
      // The server's own message names the service account, the calendar id and
      // the share level. Passing it through verbatim is the whole point; a
      // friendlier summary here would delete the instructions.
      const message = err instanceof Error ? err.message : 'Calendar sync failed.';
      setSyncError(message);
      setRun({ ranAt: new Date().toISOString(), status: 'error', imported: 0, error: message });
    } finally {
      setSyncing(false);
    }
  }

  const runLabel = calendarSyncRunLabel(run);

  return (
    <DenPanel
      title="Google Calendar sync"
      subtitle="Busy time on a shared Google calendar blocks out the same time here. Kinfolk see the block, never the event."
      trailing={<ServicePill serviceType="server sync" tone="teal" />}
    >
      {saveError !== null && (
        <Banner tone="error" title="Calendar ID not saved" className="settingsEdit__sectionBanner">
          {saveError}
        </Banner>
      )}

      <p className="settingsEdit__hint">
        In Google Calendar, share the calendar with{' '}
        <strong>{CALENDAR_SYNC_SA_EMAIL}</strong> at the &ldquo;See only free/busy (hide
        details)&rdquo; level, then paste that calendar&rsquo;s ID below. Nothing signs in and no
        event details ever leave Google.
      </p>

      <label className="settingsEdit__field">
        <span className="settingsEdit__fieldLabel">Calendar ID</span>
        <input
          type="text"
          className="settingsEdit__input"
          value={draft}
          placeholder={CALENDAR_ID_EXAMPLE}
          disabled={saving}
          aria-invalid={draftProblem !== null}
          onChange={(e) => {
            setDraft(e.target.value);
            setJustSaved(false);
            setSaveError(null);
          }}
        />
      </label>
      {draftProblem !== null && (
        <p className="settingsEdit__hint" role="alert">
          {draftProblem}
        </p>
      )}

      <div className="settingsEdit__saveRow">
        <GhostButton
          label="Cancel"
          onClick={() => {
            setDraft(data.calendarSyncId);
            setSaveError(null);
            setJustSaved(false);
          }}
          disabled={!dirty || saving}
        />
        <PrimaryButton
          label={saving ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || saving || draftProblem !== null}
          busy={saving}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>

      <div className="settingsEdit__subsection">
        {syncError !== null && (
          <Banner tone="error" title="Sync failed" className="settingsEdit__sectionBanner">
            {syncError}
          </Banner>
        )}

        {runLabel === null ? (
          <p className="settingsEdit__hint">This calendar has never been synced from here.</p>
        ) : run?.status === 'error' && syncError === null ? (
          <Banner tone="error" title="The last sync failed" className="settingsEdit__sectionBanner">
            {run.error === '' ? runLabel : `${runLabel} ${run.error}`}
          </Banner>
        ) : (
          // `role="status"` so a run that finishes with the same count as the
          // last one is still announced: the timestamp changed, and a screen
          // reader user has no other cue that the button did anything.
          <p className="settingsEdit__readonlyValue" role="status">
            {runLabel}
          </p>
        )}

        <div className="settingsEdit__saveRow">
          <PrimaryButton
            label={syncing ? 'Syncing…' : 'Run sync'}
            onClick={() => void handleRunSync()}
            disabled={syncing || dirty || savedProblem !== null}
            busy={syncing}
          />
        </div>
        {dirty ? (
          <p className="settingsEdit__hint">
            Save the calendar ID first. The sync runs on the server and reads the saved value, not
            what is in the box.
          </p>
        ) : savedProblem !== null ? (
          // The full explanation only when the field above is not already
          // showing it. Printing the same three lines twice makes the second
          // copy look like a second, different fault.
          <p className="settingsEdit__hint">
            Nothing to sync yet. {draftProblem === null ? savedProblem : 'Fix the calendar ID above.'}
          </p>
        ) : (
          <p className="settingsEdit__hint">
            Imports the next 30 days of busy time. Running it again is safe: blocks already imported
            are updated in place, not duplicated.
          </p>
        )}
      </div>
    </DenPanel>
  );
}
