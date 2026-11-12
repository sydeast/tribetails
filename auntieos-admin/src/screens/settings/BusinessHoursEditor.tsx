import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DAYS_OF_WEEK } from '../../lib/settingsFormat';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import { HOURS_RANGE_INVALID, dayHoursError, hoursRangeError, settingsRefusalsOf } from '../../lib/settingsChecks';
import { FieldError, blockingErrors, fieldErrorAttrs } from './sections';
import '../SettingsEdit.css';
import './BusinessHoursEditor.css';

/**
 * The Business Hours sub-editor, one of the three DEFERRED editors this port
 * fills in (see `Settings.tsx`'s header). Edits `BusinessSettings.businessHours`,
 * a `Record<day, "HH:MM-HH:MM">` keyed by the SAME `DAYS_OF_WEEK` the read-only
 * overview's `businessHoursRows` (`lib/settingsFormat.ts`) already renders from,
 * and writes the SAME wire format that reader expects: a blank entry means
 * closed, a missing one is not set, a non-blank entry is shown verbatim. Verified against the wasm
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
 * writes `""` (closed) at save time. One combined Save/Cancel bar for the
 * whole week, matching `MyTribePortalSection` in `settings/sections.tsx` (the whole
 * map is one saveable doc field, so there is no per-day independence to
 * expose: a per-day save would still round-trip the other six days).
 *
 * #1978: NO HOURS ARE EVER INVENTED. Toggling a day on used to seed 09:00 to
 * 17:00 with Save lit, so one more press published hours nobody chose. A day
 * switched on now shows the hours it had: the times still in this editor's
 * state when it was closed in this visit, or after a reload the range the
 * server kept in `closedDayHours` when the closing save landed. A day with no
 * earlier hours opens with both boxes empty, the "Enter both..." sentence
 * beside it and Save off until the operator picks them.
 *
 * A day with NO KEY in the map is "Not set", not "Closed". The server reads a
 * missing day as "cannot tell" and only a present blank one as Closed
 * (`businessHoursForDayName`), and the Android panel says the same. A day that
 * is not set writes nothing until its toggle is touched.
 */

const HOURS_RANGE_REGEX = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;

interface BusinessHoursEditorProps {
  data: Pick<BusinessSettings, 'businessHours' | 'closedDayHours'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

type DayState =
  | {
      mode: 'structured';
      /** False only for a day with no stored entry whose toggle has not been touched. */
      set: boolean;
      open: boolean;
      start: string;
      end: string;
    }
  | { mode: 'fallback'; raw: string };

/** A stored value as a string: raw document data can hold anything. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The two times of a readable "HH:MM-HH:MM", two-digit hours as a time box needs them, or null. */
function splitRange(raw: string): { start: string; end: string } | null {
  if (!HOURS_RANGE_REGEX.test(raw) || hoursRangeError(raw) !== null) return null;
  const [start = '', end = ''] = raw.split('-').map((s) => s.trim().padStart(5, '0'));
  return { start, end };
}

/**
 * One day's edit state from what is stored: `stored` is the day's entry in
 * `businessHours` (undefined when it has none), `kept` its entry in
 * `closedDayHours`. A closed or unset day carries the kept range in its hidden
 * boxes when there is a readable one, and empty boxes otherwise.
 */
function initialDayState(stored: unknown, kept: unknown): DayState {
  const trimmed = text(stored);
  if (trimmed === '') {
    const range = splitRange(text(kept));
    return {
      mode: 'structured',
      set: stored !== undefined,
      open: false,
      start: range?.start ?? '',
      end: range?.end ?? '',
    };
  }
  if (!HOURS_RANGE_REGEX.test(trimmed)) return { mode: 'fallback', raw: trimmed };
  const [start = '', end = ''] = trimmed.split('-').map((s) => s.trim());
  return { mode: 'structured', set: true, open: true, start, end };
}

/** The wire value this day currently represents, or undefined for a day that is not set. */
function wireValue(state: DayState): string | undefined {
  if (state.mode === 'fallback') return state.raw;
  if (!state.set) return undefined;
  return state.open ? `${state.start}-${state.end}` : '';
}

/**
 * #1593: why this day cannot be saved, or null. An open day needs both times,
 * closing after opening (#1978: an open day with both boxes empty is refused
 * too, it is not Closed); a hand-typed fallback is held to the same range, and
 * a cleared one reads as Closed. Every day shows its sentence; only a day that
 * changed blocks Save (#1783), because the server checks the days it is sent.
 */
function dayError(state: DayState): string | null {
  if (state.mode === 'fallback') return state.raw.trim() === '' ? null : hoursRangeError(state.raw);
  if (!state.open) return null;
  if (state.start.trim() === '' && state.end.trim() === '') return HOURS_RANGE_INVALID;
  return dayHoursError(state.start, state.end);
}

/** The day a server refusal names (`"Monday: ..."`), with the sentence after it. */
function refusalByDay(err: unknown): { day: string; message: string } | null {
  for (const r of settingsRefusalsOf(err)) {
    if (r.field !== 'businessHours') continue;
    const day = DAYS_OF_WEEK.find((d) => r.message.startsWith(`${d}: `));
    if (day) return { day, message: r.message.slice(day.length + 2) };
  }
  return null;
}

export function BusinessHoursEditor({ data, onSave }: BusinessHoursEditorProps) {
  // Seeded ONCE from `data` at mount, per day, into its own edit state.
  const [days, setDays] = useState<Record<string, DayState>>(() => {
    const seed: Record<string, DayState> = {};
    for (const day of DAYS_OF_WEEK) seed[day] = initialDayState(data.businessHours[day], data.closedDayHours[day]);
    return seed;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // #1593: a server refusal that names a day, beside that day until it is edited.
  const [serverError, setServerError] = useState<{ day: string; message: string } | null>(null);

  // #1783: the patch is ONLY the days that changed this session. The server
  // merges `businessHours` day by day and checks only the days it is sent, so a
  // day nobody touched keeps its exact stored string (including a malformed
  // legacy one) and never rides along. An untouched bad day shows its sentence
  // beside it on open and does not block Save.
  const changedHours: Record<string, string> = {};
  for (const day of DAYS_OF_WEEK) {
    const current = wireValue(days[day]!);
    const stored: unknown = data.businessHours[day];
    // A day that is not set and was never touched has nothing to write.
    if (current === undefined) continue;
    if (stored === undefined || current !== text(stored)) changedHours[day] = current;
  }
  const dirty = Object.keys(changedHours).length > 0;
  const dayErrors: Record<string, string> = {};
  for (const day of DAYS_OF_WEEK) {
    const message = dayError(days[day]!);
    if (message !== null) dayErrors[day] = message;
  }
  const invalid = Object.keys(blockingErrors(dayErrors, Object.keys(changedHours))).length > 0;
  function patchDay(day: string, next: DayState) {
    setDays((d) => ({ ...d, [day]: next }));
    setServerError((e) => (e?.day === day ? null : e));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy || invalid) return;
    setBusy(true);
    setError(null);
    setServerError(null);
    try {
      await onSave({ businessHours: changedHours });
      setJustSaved(true);
    } catch (err) {
      const byDay = refusalByDay(err);
      if (byDay) setServerError(byDay);
      else setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    const seed: Record<string, DayState> = {};
    for (const day of DAYS_OF_WEEK) seed[day] = initialDayState(data.businessHours[day], data.closedDayHours[day]);
    setDays(seed);
    setError(null);
    setServerError(null);
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
          const message = dayErrors[day] ?? (serverError?.day === day ? serverError.message : null);
          const errorId = `businessHours-${day}`;
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
                          ? { ...state, set: true, open: true }
                          : { ...state, set: true, open: false },
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
                          {...fieldErrorAttrs(errorId, message)}
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
                          {...fieldErrorAttrs(errorId, message)}
                        />
                      </label>
                    </span>
                  ) : (
                    <span className="businessHours__closed">{state.set ? 'Closed' : 'Not set'}</span>
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
                    {...fieldErrorAttrs(errorId, message)}
                  />
                  <span className="businessHours__warning">Check format</span>
                </span>
              )}
              <FieldError id={errorId} message={message} />
            </li>
          );
        })}
      </ul>

      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || invalid}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
