import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { US_HOLIDAYS, parseDatedEntry } from '../../lib/settingsFormat';
import {
  US_HOLIDAY_PRESETS,
  parseClosureEntry,
  formatClosureEntry,
  describeClosureRecurrence,
  closureEntryFromPreset,
  type ClosureRecurrenceKind,
} from '../../lib/closureRecurrence';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import '../SettingsEdit.css';
import './TimeOffEditor.css';

/**
 * The Time Off sub-editor, one of the three DEFERRED editors this port fills
 * in (see `Settings.tsx`'s header). Edits three doc fields as one saveable
 * unit, exactly the grouping the wasm `TimeOffPanel` uses (`SettingsScreen.kt`):
 *   - `observedUsHolidays: string[]` -- ids from the fixed `US_HOLIDAYS` catalog
 *     (`lib/settingsFormat.ts`, ported verbatim from the wasm panel's private
 *     list so the checklist here shows the SAME eleven holidays, in the SAME
 *     order, as the read-only overview's `observedHolidayLabels`).
 *   - `companyHolidays: string[]` -- closure entries, decoded/encoded through
 *     `lib/closureRecurrence.ts` (`parseClosureEntry` / `formatClosureEntry`).
 *     PER THE 2026-07-31 OPERATOR RULING, an entry is no longer always a bare
 *     `"YYYY-MM-DD|Name"`: it carries a RECURRENCE, and a yearly one (a real US
 *     holiday, an owner's recurring closure) is entered ONCE with no year at
 *     all -- see `closureRecurrence.ts`'s header for the full wire grammar and
 *     why `once` (the pre-existing shape) decodes completely unchanged.
 *   - `specialHours: string[]` -- `"YYYY-MM-DD|hours"` entries, read by
 *     `specialHourRows`/`parseDatedEntry` exactly as before. Distinct from a
 *     full closure: a special-hours day is still open, just on modified hours
 *     (a short day, late open). The operator ruling this recurrence support
 *     answers was specifically about CLOSURES; special hours stays dated-only
 *     on purpose (a "short day" tied to a recurring holiday would still need
 *     recurrence, but nothing has asked for that yet, and inventing it here
 *     would be answering a question nobody raised).
 *
 * Add-row validation mirrors the wasm gates exactly for the unchanged paths: a
 * special-hours entry needs a `YYYY-MM-DD` date and non-blank hours with no `|`
 * (`specialHoursAddEnabled`). A company holiday's gate now branches on
 * recurrence (see `holidayAddEnabled` below), but a `once` entry needs exactly
 * what it always did: a `YYYY-MM-DD` date and a non-blank name with no `|`.
 * Both lists are append/remove-by-index locally, same as the wasm panel's
 * local `companyHolidays`/`specialHours` state, and only reach Firestore on
 * this panel's own Save.
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

const RECURRENCE_OPTIONS: ReadonlyArray<readonly [ClosureRecurrenceKind, string]> = [
  ['once', 'One time (pick a date)'],
  ['yearly-fixed', 'Every year, same date'],
  ['yearly-nth-weekday', 'Every year, same week and day (e.g. 4th Thursday)'],
  ['yearly-last-weekday', 'Every year, last weekday of the month (e.g. last Monday)'],
];

const MONTH_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [1, 'January'],
  [2, 'February'],
  [3, 'March'],
  [4, 'April'],
  [5, 'May'],
  [6, 'June'],
  [7, 'July'],
  [8, 'August'],
  [9, 'September'],
  [10, 'October'],
  [11, 'November'],
  [12, 'December'],
];

const WEEKDAY_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [7, 'Sunday'],
];

const NTH_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [1, '1st'],
  [2, '2nd'],
  [3, '3rd'],
  [4, '4th'],
];

const DAY_OPTIONS: readonly number[] = Array.from({ length: 31 }, (_, i) => i + 1);

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

  // The company-holiday add-row. `newHolidayRecurrence` gates which of the
  // fields below are shown/required: `once` uses `newHolidayDate` (a full
  // YYYY-MM-DD, unchanged); every `yearly-*` kind uses `newHolidayMonth` plus
  // whichever of day/weekday/nth its shape needs, and NEVER a year -- that is
  // the entire point of the 2026-07-31 ruling this UI answers. `0` means
  // "not yet picked" for every numeric field, matching the placeholder "Pick a
  // ..." option's value.
  const [newHolidayRecurrence, setNewHolidayRecurrence] = useState<ClosureRecurrenceKind>('once');
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayMonth, setNewHolidayMonth] = useState(0);
  const [newHolidayDay, setNewHolidayDay] = useState(0);
  const [newHolidayWeekday, setNewHolidayWeekday] = useState(0);
  const [newHolidayNth, setNewHolidayNth] = useState(0);

  const [newSpecialDate, setNewSpecialDate] = useState('');
  const [newSpecialHours, setNewSpecialHours] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Catalog order, not insertion order, so the saved list is stable across
  // reloads (a `Set` has no guaranteed iteration order tied to the catalog).
  // Plus any stored id NOT in the fixed catalog, carried forward verbatim: a
  // legacy or hand-edited observed-holiday id must never be silently dropped on
  // save (this also keeps the panel from mounting spuriously dirty).
  const observedList = [
    ...US_HOLIDAYS.filter(([id]) => observed.has(id)).map(([id]) => id),
    ...data.observedUsHolidays.filter((id) => !US_HOLIDAYS.some(([h]) => h === id)),
  ];

  const dirty =
    !sameIdSet(observedList, data.observedUsHolidays) ||
    JSON.stringify(companyHolidays) !== JSON.stringify(data.companyHolidays) ||
    JSON.stringify(specialHours) !== JSON.stringify(data.specialHours);

  const holidayNameValid = newHolidayName.trim() !== '' && !newHolidayName.includes('|');

  /**
   * The Add-company-holiday gate, branched on the selected recurrence. `once`
   * is the exact pre-existing rule (a valid `YYYY-MM-DD` plus a clean name).
   * Every `yearly-*` kind needs its date-defining fields ACTUALLY picked (not
   * left at the `0` "Pick a ..." placeholder) instead of a date string,
   * because there is no date to type: that is what "no year input" means.
   */
  const holidayAddEnabled = (() => {
    if (!holidayNameValid) return false;
    switch (newHolidayRecurrence) {
      case 'once':
        return HOLIDAY_DATE_REGEX.test(newHolidayDate);
      case 'yearly-fixed':
        return newHolidayMonth >= 1 && newHolidayMonth <= 12 && newHolidayDay >= 1 && newHolidayDay <= 31;
      case 'yearly-nth-weekday':
        return (
          newHolidayMonth >= 1 &&
          newHolidayMonth <= 12 &&
          newHolidayWeekday >= 1 &&
          newHolidayWeekday <= 7 &&
          newHolidayNth >= 1 &&
          newHolidayNth <= 4
        );
      case 'yearly-last-weekday':
        return newHolidayMonth >= 1 && newHolidayMonth <= 12 && newHolidayWeekday >= 1 && newHolidayWeekday <= 7;
    }
  })();

  const specialAddEnabled =
    HOLIDAY_DATE_REGEX.test(newSpecialDate) && newSpecialHours.trim() !== '' && !newSpecialHours.includes('|');

  // Every preset's wire string, computed once per render so the "already
  // added" check below and the click handler encode the identical value --
  // never two independent calls to `formatClosureEntry` that could drift.
  const presetEntries = US_HOLIDAY_PRESETS.map((preset) => ({
    preset,
    wire: formatClosureEntry(closureEntryFromPreset(preset)),
  }));

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

  function resetHolidayAddRow() {
    setNewHolidayRecurrence('once');
    setNewHolidayDate('');
    setNewHolidayName('');
    setNewHolidayMonth(0);
    setNewHolidayDay(0);
    setNewHolidayWeekday(0);
    setNewHolidayNth(0);
  }

  function addCompanyHoliday() {
    if (!holidayAddEnabled) return;
    const wire = formatClosureEntry({
      recurrence: newHolidayRecurrence,
      name: newHolidayName,
      date: newHolidayDate,
      month: newHolidayMonth,
      day: newHolidayDay,
      weekday: newHolidayWeekday,
      nth: newHolidayNth,
    });
    setCompanyHolidays((prev) => [...prev, wire]);
    resetHolidayAddRow();
    markDirtyEdit();
  }

  /** One-click preset add: no intermediate form fill, matches the "one-click list" the ruling asked for. */
  function addPresetHoliday(wire: string) {
    setCompanyHolidays((prev) => [...prev, wire]);
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
    resetHolidayAddRow();
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
              const parsed = parseClosureEntry(entry);
              return (
                <li key={`${entry}-${i}`} className="timeOff__datedRow">
                  <span className="timeOff__datedText">
                    <span className="timeOff__datedName">{parsed.name || 'Holiday'}</span>
                    <span className="timeOff__datedDate">{describeClosureRecurrence(parsed)}</span>
                  </span>
                  <GhostButton label="Remove" onClick={() => removeCompanyHoliday(i)} disabled={busy} />
                </li>
              );
            })}
          </ul>
        )}

        <div className="timeOff__presetRow">
          <span className="settingsEdit__hint">Add a US holiday with one click. It already repeats every year.</span>
          <div className="timeOff__presetButtons">
            {presetEntries.map(({ preset, wire }) => (
              <GhostButton
                key={preset.id}
                label={preset.name}
                onClick={() => addPresetHoliday(wire)}
                disabled={busy || companyHolidays.includes(wire)}
              />
            ))}
          </div>
        </div>

        <div className="timeOff__addRow">
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Recurrence</span>
            <select
              className="settingsEdit__input"
              value={newHolidayRecurrence}
              disabled={busy}
              onChange={(e) => {
                setNewHolidayRecurrence(e.target.value as ClosureRecurrenceKind);
                markDirtyEdit();
              }}
            >
              {RECURRENCE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          {newHolidayRecurrence === 'once' ? (
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
          ) : (
            <>
              <label className="settingsEdit__field">
                <span className="settingsEdit__fieldLabel">Month</span>
                <select
                  className="settingsEdit__input"
                  value={newHolidayMonth}
                  disabled={busy}
                  onChange={(e) => {
                    setNewHolidayMonth(Number(e.target.value));
                    markDirtyEdit();
                  }}
                >
                  <option value={0}>Pick a month</option>
                  {MONTH_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              {newHolidayRecurrence === 'yearly-fixed' ? (
                <label className="settingsEdit__field">
                  <span className="settingsEdit__fieldLabel">Day</span>
                  <select
                    className="settingsEdit__input"
                    value={newHolidayDay}
                    disabled={busy}
                    onChange={(e) => {
                      setNewHolidayDay(Number(e.target.value));
                      markDirtyEdit();
                    }}
                  >
                    <option value={0}>Pick a day</option>
                    {DAY_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="settingsEdit__field">
                    <span className="settingsEdit__fieldLabel">Weekday</span>
                    <select
                      className="settingsEdit__input"
                      value={newHolidayWeekday}
                      disabled={busy}
                      onChange={(e) => {
                        setNewHolidayWeekday(Number(e.target.value));
                        markDirtyEdit();
                      }}
                    >
                      <option value={0}>Pick a weekday</option>
                      {WEEKDAY_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {newHolidayRecurrence === 'yearly-nth-weekday' ? (
                    <label className="settingsEdit__field">
                      <span className="settingsEdit__fieldLabel">Occurrence</span>
                      <select
                        className="settingsEdit__input"
                        value={newHolidayNth}
                        disabled={busy}
                        onChange={(e) => {
                          setNewHolidayNth(Number(e.target.value));
                          markDirtyEdit();
                        }}
                      >
                        <option value={0}>Pick</option>
                        {NTH_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </>
              )}
            </>
          )}

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
