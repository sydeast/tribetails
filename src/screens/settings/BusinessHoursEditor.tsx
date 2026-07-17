import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DAYS_OF_WEEK } from '../../lib/settingsFormat';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import '../SettingsEdit.css';
import './BusinessHoursEditor.css';

/**
 * The Business Hours sub-editor, one of the three DEFERRED editors this port
 * fills in (see `SettingsEdit.tsx`'s header). Edits `BusinessSettings.businessHours`,
 * a `Record<day, "HH:MM-HH:MM">` keyed by the SAME `DAYS_OF_WEEK` the read-only
 * overview's `businessHoursRows` (`lib/settingsFormat.ts`) already renders from,
 * and writes the SAME wire format that reader expects: a blank/missing entry
 * means closed, a non-blank entry is shown verbatim. Verified against the wasm
 * source directly (`SettingsScreen.kt`'s `BusinessHoursPanel`): the range regex
 * (`HOURS_RANGE_REGEX` below) and the "09:00-17:00 or leave blank if closed"
 * placeholder copy are ported from there, so a value this editor writes reads
 * back identically in the wasm app.
 *
 * Each day's edit state is seeded ONCE from `data.businessHours[day]` at mount
 * (the `TextFieldsSection` non-clobbering convention) into its OWN `open` /
 * `start` / `end` slots, NOT re-derived by re-splitting a combined
 * "HH:MM-HH:MM" string on every keystroke. That distinction matters: an
 * earlier version drove the two `<input type="time">` fields straight off a
 * regex split of the day's current wire value, so clearing the open-time
 * field to retype it produced a transient "-17:00" that failed the range
 * regex and flipped the WHOLE row into the malformed-fallback branch below,
 * silently discarding the still-valid close time and yanking focus out from
 * under the operator mid-edit. Keeping `start`/`end` as their own state means
 * a transient empty value while retyping never touches the sibling field or
 * changes which control renders; the two are combined into the wire string
 * only when computing `hours` (for Save/dirty), not for what the inputs show.
 *
 * A day whose LOADED value doesn't match "HH:MM-HH:MM" (a legacy or
 * hand-edited doc) is never silently coerced or discarded: `dayMode` fixes
 * that day to a plain text fallback for the life of this mount, with a "Check
 * format" pill, exactly the malformed-value affordance the wasm panel shows,
 * so the operator can see and fix it by hand rather than have this editor
 * quietly replace it with a default range on the next save.
 *
 * One instant per-day "Open" toggle, not a per-day Save: toggling a day off
 * writes `""` (closed) at save time; toggling it on seeds `DEFAULT_RANGE`
 * ("09:00-17:00") into that day's `start`/`end` so the two time pickers have
 * something valid to show right away. One combined Save/Cancel bar for the
 * whole week, matching `MyTribePortalSection` in `SettingsEdit.tsx` (the whole
 * map is one saveable doc field, so there is no per-day independence to
 * expose: a per-day save would still round-trip the other six days).
 */

const HOURS_RANGE_REGEX = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';

interface BusinessHoursEditorProps {
  data: Pick<BusinessSettings, 'businessHours'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

type DayState =
  | { mode: 'structured'; open: boolean; start: string; end: string }
  | { mode: 'fallback'; raw: string };

function initialDayState(raw: string): DayState {
  const trimmed = raw.trim();
  if (trimmed === '') return { mode: 'structured', open: false, start: DEFAULT_START, end: DEFAULT_END };
  const match = HOURS_RANGE_REGEX.test(trimmed);
  if (!match) return { mode: 'fallback', raw: trimmed };
  const [start = DEFAULT_START, end = DEFAULT_END] = trimmed.split('-').map((s) => s.trim());
  return { mode: 'structured', open: true, start, end };
}

/** The wire value this day currently represents, folded from its edit state. */
function wireValue(state: DayState): string {
  if (state.mode === 'fallback') return state.raw;
  return state.open ? `${state.start}-${state.end}` : '';
}

export function BusinessHoursEditor({ data, onSave }: BusinessHoursEditorProps) {
  // Seeded ONCE from `data` at mount, per day, into its own edit state.
  const [days, setDays] = useState<Record<string, DayState>>(() => {
    const seed: Record<string, DayState> = {};
    for (const day of DAYS_OF_WEEK) seed[day] = initialDayState(data.businessHours[day] ?? '');
    return seed;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // The patch: the ORIGINAL map (whatever keys the doc actually had, same
  // sparse shape `getBusinessSettings` returned), with ONLY the days that
  // actually changed this session overlaid. Never invents a key for an
  // untouched day, matching the wasm panel's own local state (seeded from
  // the full loaded map, only the day being typed into ever changes) --
  // critically, this means a day nobody touched keeps its EXACT original
  // string (including any malformed legacy value) rather than this editor
  // re-writing all seven days dense on every save.
  const hours: Record<string, string> = { ...data.businessHours };
  let dirty = false;
  for (const day of DAYS_OF_WEEK) {
    const current = wireValue(days[day]!);
    const original = (data.businessHours[day] ?? '').trim();
    if (current !== original) {
      hours[day] = current;
      dirty = true;
    }
  }

  function patchDay(day: string, next: DayState) {
    setDays((d) => ({ ...d, [day]: next }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ businessHours: hours });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    const seed: Record<string, DayState> = {};
    for (const day of DAYS_OF_WEEK) seed[day] = initialDayState(data.businessHours[day] ?? '');
    setDays(seed);
    setError(null);
    setJustSaved(false);
  }

  return (
    <DenPanel
      title="Business hours"
      subtitle="When the Den is open for visits. Toggle a day open, then set its hours."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <ul className="businessHours__list">
        {DAYS_OF_WEEK.map((day) => {
          const state = days[day]!;
          return (
            <li key={day} className="businessHours__row">
              <span className="businessHours__day">{day}</span>
              {state.mode === 'structured' ? (
                <>
                  <Toggle
                    label={`Toggle ${day} open`}
                    checked={state.open}
                    disabled={busy}
                    onChange={(next) =>
                      patchDay(
                        day,
                        next
                          ? { mode: 'structured', open: true, start: state.start, end: state.end }
                          : { ...state, open: false },
                      )
                    }
                  />
                  {state.open ? (
                    <span className="businessHours__times">
                      <label className="businessHours__timeField">
                        <span className="businessHours__timeLabel">Open</span>
                        <input
                          type="time"
                          className="settingsEdit__input"
                          aria-label={`${day} open time`}
                          value={state.start}
                          disabled={busy}
                          onChange={(e) => patchDay(day, { ...state, start: e.target.value })}
                        />
                      </label>
                      <label className="businessHours__timeField">
                        <span className="businessHours__timeLabel">Close</span>
                        <input
                          type="time"
                          className="settingsEdit__input"
                          aria-label={`${day} close time`}
                          value={state.end}
                          disabled={busy}
                          onChange={(e) => patchDay(day, { ...state, end: e.target.value })}
                        />
                      </label>
                    </span>
                  ) : (
                    <span className="businessHours__closed">Closed</span>
                  )}
                </>
              ) : (
                <span className="businessHours__fallback">
                  <input
                    type="text"
                    className="settingsEdit__input"
                    aria-label={`${day} hours`}
                    value={state.raw}
                    disabled={busy}
                    onChange={(e) => patchDay(day, { mode: 'fallback', raw: e.target.value })}
                  />
                  <span className="businessHours__warning">Check format</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>

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
