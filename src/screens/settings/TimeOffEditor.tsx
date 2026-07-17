import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { US_HOLIDAYS, parseDatedEntry } from '../../lib/settingsFormat';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import '../SettingsEdit.css';
import './TimeOffEditor.css';

/**
 * The Time Off sub-editor, one of the three DEFERRED editors this port fills
 * in (see `SettingsEdit.tsx`'s header). Edits three doc fields as one saveable
 * unit, exactly the grouping the wasm `TimeOffPanel` uses (`SettingsScreen.kt`):
 *   - `observedUsHolidays: string[]` -- ids from the fixed `US_HOLIDAYS` catalog
 *     (`lib/settingsFormat.ts`, ported verbatim from the wasm panel's private
 *     list so the checklist here shows the SAME eleven holidays, in the SAME
 *     order, as the read-only overview's `observedHolidayLabels`).
 *   - `companyHolidays: string[]` -- `"YYYY-MM-DD|Name"` entries, the exact
 *     wire format `parseDatedEntry`/`companyHolidayRows` in settingsFormat.ts
 *     already read (a `limit=2` split on the first `|`, so a pipe inside the
 *     name still round-trips, though the add-row below refuses to create one).
 *   - `specialHours: string[]` -- `"YYYY-MM-DD|hours"` entries, same format,
 *     read by `specialHourRows`. Distinct from a full closure: a special-hours
 *     day is still open, just on modified hours (a short day, late open).
 *
 * Add-row validation mirrors the wasm gates exactly: a company holiday needs a
 * `YYYY-MM-DD` date and a non-blank name with no `|` (`HOLIDAY_DATE_REGEX` +
 * the `enabled =` check on the wasm "Add" button); special hours needs the same
 * date shape and non-blank hours with no `|` (`specialHoursAddEnabled`). Both
 * lists are append/remove-by-index locally, same as the wasm panel's local
 * `companyHolidays`/`specialHours` state, and only reach Firestore on this
 * panel's own Save.
 *
 * One combined Save/Cancel bar for the whole panel, matching the wasm
 * `TimeOffPanel`'s single "Save Time Off Settings" button, which bundles the
 * SAME three fields (there it also re-sends the business-profile fields and
 * `businessHours`, because its local state holds those too; here each of
 * those already has its OWN section with its OWN save, so this Save sends only
 * the three Time Off fields -- safe under `saveBusinessSettings`'s
 * `merge: true`, which never touches a sibling section's fields).
 */

const HOLIDAY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

interface TimeOffEditorProps {
  data: Pick<BusinessSettings, 'observedUsHolidays' | 'companyHolidays' | 'specialHours'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

export function TimeOffEditor({ data, onSave }: TimeOffEditorProps) {
  const [observed, setObserved] = useState<Set<string>>(() => new Set(data.observedUsHolidays));
  const [companyHolidays, setCompanyHolidays] = useState<string[]>(() => [...data.companyHolidays]);
  const [specialHours, setSpecialHours] = useState<string[]>(() => [...data.specialHours]);

  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newSpecialDate, setNewSpecialDate] = useState('');
  const [newSpecialHours, setNewSpecialHours] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Catalog order, not insertion order, so the saved list is stable across
  // reloads (a `Set` has no guaranteed iteration order tied to the catalog).
  const observedList = US_HOLIDAYS.filter(([id]) => observed.has(id)).map(([id]) => id);

  const dirty =
    !sameIdSet(observedList, data.observedUsHolidays) ||
    JSON.stringify(companyHolidays) !== JSON.stringify(data.companyHolidays) ||
    JSON.stringify(specialHours) !== JSON.stringify(data.specialHours);

  const holidayAddEnabled =
    HOLIDAY_DATE_REGEX.test(newHolidayDate) && newHolidayName.trim() !== '' && !newHolidayName.includes('|');

  const specialAddEnabled =
    HOLIDAY_DATE_REGEX.test(newSpecialDate) && newSpecialHours.trim() !== '' && !newSpecialHours.includes('|');

  function markDirtyEdit() {
    setJustSaved(false);
  }

  function toggleHoliday(id: string, on: boolean) {
    setObserved((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    markDirtyEdit();
  }

  function addCompanyHoliday() {
    if (!holidayAddEnabled) return;
    setCompanyHolidays((prev) => [...prev, `${newHolidayDate}|${newHolidayName}`]);
    setNewHolidayDate('');
    setNewHolidayName('');
    markDirtyEdit();
  }

  function removeCompanyHoliday(index: number) {
    setCompanyHolidays((prev) => prev.filter((_, i) => i !== index));
    markDirtyEdit();
  }

  function addSpecialHours() {
    if (!specialAddEnabled) return;
    setSpecialHours((prev) => [...prev, `${newSpecialDate}|${newSpecialHours}`]);
    setNewSpecialDate('');
    setNewSpecialHours('');
    markDirtyEdit();
  }

  function removeSpecialHours(index: number) {
    setSpecialHours((prev) => prev.filter((_, i) => i !== index));
    markDirtyEdit();
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ observedUsHolidays: observedList, companyHolidays, specialHours });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setObserved(new Set(data.observedUsHolidays));
    setCompanyHolidays([...data.companyHolidays]);
    setSpecialHours([...data.specialHours]);
    setNewHolidayDate('');
    setNewHolidayName('');
    setNewSpecialDate('');
    setNewSpecialHours('');
    setError(null);
    setJustSaved(false);
  }

  return (
    <DenPanel title="Time off" subtitle="Holidays the Den observes and your own closures.">
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <div className="settingsEdit__subsection timeOff__subsection--first">
        <span className="timeOff__groupLabel">US holidays observed</span>
        <ul className="timeOff__holidayList">
          {US_HOLIDAYS.map(([id, name]) => (
            <li key={id} className="timeOff__holidayRow">
              <span className="timeOff__holidayName">{name}</span>
              <Toggle
                label={`Toggle ${name} observed`}
                checked={observed.has(id)}
                disabled={busy}
                onChange={(next) => toggleHoliday(id, next)}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="settingsEdit__subsection">
        <span className="timeOff__groupLabel">Company holidays</span>
        {companyHolidays.length === 0 ? (
          <p className="settingsEdit__hint">No company holidays added yet.</p>
        ) : (
          <ul className="timeOff__datedList">
            {companyHolidays.map((entry, i) => {
              const { date, label } = parseDatedEntry(entry);
              return (
                <li key={`${entry}-${i}`} className="timeOff__datedRow">
                  <span className="timeOff__datedText">
                    <span className="timeOff__datedName">{label || 'Holiday'}</span>
                    <span className="timeOff__datedDate">{date}</span>
                  </span>
                  <GhostButton label="Remove" onClick={() => removeCompanyHoliday(i)} disabled={busy} />
                </li>
              );
            })}
          </ul>
        )}
        <div className="timeOff__addRow">
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Date (YYYY-MM-DD)</span>
            <input
              type="text"
              className="settingsEdit__input"
              placeholder="2026-12-25"
              value={newHolidayDate}
              disabled={busy}
              onChange={(e) => {
                setNewHolidayDate(e.target.value);
                markDirtyEdit();
              }}
            />
          </label>
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Name</span>
            <input
              type="text"
              className="settingsEdit__input"
              placeholder="Christmas closure"
              value={newHolidayName}
              disabled={busy}
              onChange={(e) => {
                setNewHolidayName(e.target.value);
                markDirtyEdit();
              }}
            />
          </label>
          <GhostButton label="Add" onClick={addCompanyHoliday} disabled={busy || !holidayAddEnabled} />
        </div>
      </div>

      <div className="settingsEdit__subsection">
        <span className="timeOff__groupLabel">Special hours</span>
        <p className="settingsEdit__hint timeOff__hint">
          Modified operating hours for a specific date (a short day, late open). Not a full closure.
        </p>
        {specialHours.length === 0 ? (
          <p className="settingsEdit__hint">No special hours added yet.</p>
        ) : (
          <ul className="timeOff__datedList">
            {specialHours.map((entry, i) => {
              const { date, label } = parseDatedEntry(entry);
              return (
                <li key={`${entry}-${i}`} className="timeOff__datedRow">
                  <span className="timeOff__datedText">
                    <span className="timeOff__datedName">{label || 'Special hours'}</span>
                    <span className="timeOff__datedDate">{date}</span>
                  </span>
                  <GhostButton label="Remove" onClick={() => removeSpecialHours(i)} disabled={busy} />
                </li>
              );
            })}
          </ul>
        )}
        <div className="timeOff__addRow">
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Date (YYYY-MM-DD)</span>
            <input
              type="text"
              className="settingsEdit__input"
              placeholder="2026-12-24"
              value={newSpecialDate}
              disabled={busy}
              onChange={(e) => {
                setNewSpecialDate(e.target.value);
                markDirtyEdit();
              }}
            />
          </label>
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Hours (e.g. 08:00-12:00)</span>
            <input
              type="text"
              className="settingsEdit__input"
              placeholder="08:00-12:00"
              value={newSpecialHours}
              disabled={busy}
              onChange={(e) => {
                setNewSpecialHours(e.target.value);
                markDirtyEdit();
              }}
            />
          </label>
          <GhostButton label="Add" onClick={addSpecialHours} disabled={busy || !specialAddEnabled} />
        </div>
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
