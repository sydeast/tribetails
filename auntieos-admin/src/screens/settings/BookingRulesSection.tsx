import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import {
  CALENDAR_VIEWS,
  HHMM_REGEX,
  NUMBER_FIELDS,
  VISIT_REMINDER_TIMING,
  blockOverlaps,
  compareBlocksByStart,
  defaultBlockEnd,
  optionsIncluding,
  overlapNote,
  parseWholeNumber,
  slugifyBlockId,
  timeBlockDraft,
  validateTimeBlocks,
  type TimeBlockDraft,
} from '../../lib/businessOperations';
import { splitSettingsRefusal } from '../../lib/settingsChecks';
import { bookingModeFields, storedHouseholdTimeMode, type HouseholdTimeMode } from '../../lib/householdVisitTime';
import { FieldError, fieldErrorAttrs } from './sections';
import '../SettingsEdit.css';
import './BookingRulesSection.css';

/**
 * ISSUE #519: the booking configuration block. Seven fields the three admin
 * clients decoded and defaulted, and that no React or desktop surface offered a
 * control for.
 *
 * WHAT EACH ONE ACTUALLY DOES, because "persists but changes nothing" is the
 * same defect one step along, and this panel is honest about which is which:
 *
 *  - Time Blocks | Exact times (#1863, operator ruling 2026-11-12): the ONE
 *                           mode. Time Blocks: Kinfolk book and see only
 *                           blocks; Exact times: they pick and see a clock
 *                           time. Written as `defaultBookingMode` plus the two
 *                           allow switches, all three in step
 *                           (`lib/householdVisitTime.ts#bookingModeFields`),
 *                           which `saveBusinessSettings` insists on.
 *  - `defaultCalendarView`  seeds that screen's calendar view. Wired to a
 *                           consumer in this same change.
 *  - `defaultTimeBlockDurationHours`
 *                           how long a NEW block runs when you add one below.
 *  - `travelBufferMinutes`  minutes Android's availability check keeps between
 *                           two visits in one block (`BookingRepository`).
 *  - `enableAutoReminder24h`
 *                           whether `kincareReminderCron` sends the 24-hour
 *                           reminder. That cron used to send it whatever this
 *                           said; it now reads it, and an absent value still
 *                           means ON so nothing goes quiet on deploy.
 *
 * ONE SAVE for the whole panel, not per-flip: the mode and the blocks are one
 * decision (Time Blocks needs a block turned on), and saving each flip
 * separately would let the doc pass through the state this panel refuses.
 */

/** #1863: the two modes, in the operator's own words. The tooltip says what each one means for a household. */
const TIME_MODE_OPTIONS: ReadonlyArray<{ value: HouseholdTimeMode; label: string; tooltip: string }> = [
  {
    value: 'TIME_BLOCK',
    label: 'Time Blocks',
    tooltip: 'Kinfolk pick a block and see blocks everywhere. Exact times show only on KinTale check-in and check-out.',
  },
  {
    value: 'SPECIFIC_TIME',
    label: 'Exact times',
    tooltip: 'Kinfolk pick a specific time and see it everywhere.',
  },
];
interface BookingRulesSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface Draft {
  /** #1863: the one mode, as stored (a pre-#1863 document reads through `storedHouseholdTimeMode`). */
  timeMode: HouseholdTimeMode;
  defaultCalendarView: string;
  defaultTimeBlockDurationHours: string;
  travelBufferMinutes: string;
  enableAutoReminder24h: boolean;
  blocks: TimeBlockDraft[];
}

function seed(data: BusinessSettings): Draft {
  return {
    timeMode: storedHouseholdTimeMode(data),
    defaultCalendarView: data.defaultCalendarView,
    defaultTimeBlockDurationHours: String(data.defaultTimeBlockDurationHours),
    travelBufferMinutes: String(data.travelBufferMinutes),
    // Absent reads as ON, matching the server gate. See `enableAutoReminder24h`
    // in `api/settings.ts` and `mytribe/functions/src/lib/autoReminder.ts`.
    enableAutoReminder24h: data.enableAutoReminder24h !== false,
    // Sorted on the way in, matching how they are stored. Rows are NOT re-sorted
    // while the operator types: moving a row out from under a cursor because a
    // start time is momentarily "0" is worse than a list briefly out of order.
    // The save sorts again, so what is stored is always start-ordered.
    blocks: [...data.timeBlocks].sort(compareBlocksByStart).map(timeBlockDraft),
  };
}

/** The settings this panel writes, by the name each one has on the document. */
type BookingField =
  | 'timeMode'
  | 'defaultCalendarView'
  | 'defaultTimeBlockDurationHours'
  | 'travelBufferMinutes'
  | 'enableAutoReminder24h'
  | 'timeBlocks';
/**
 * #1783: which fields the operator has changed from what is stored. Only these
 * are written, and only these can stop a Save: `saveBusinessSettings` checks the
 * fields in the save, so a stored value this panel would refuse (two modes both
 * off, a block with no end) shows its sentence and leaves a different edit alone.
 */
export function editedBookingFields(draft: Draft, data: BusinessSettings): ReadonlySet<BookingField> {
  const out = new Set<BookingField>();
  const base = seed(data);
  if (draft.timeMode !== base.timeMode) out.add('timeMode');
  if (draft.defaultCalendarView !== base.defaultCalendarView) out.add('defaultCalendarView');
  if (draft.enableAutoReminder24h !== base.enableAutoReminder24h) out.add('enableAutoReminder24h');
  for (const key of NUMBER_FIELD_KEYS) {
    const parsed = parseWholeNumber(draft[key], NUMBER_FIELDS[key]);
    const changed = 'value' in parsed ? parsed.value !== data[key] : draft[key].trim() !== base[key];
    if (changed) out.add(key);
  }
  if (JSON.stringify(draft.blocks) !== JSON.stringify(base.blocks)) out.add('timeBlocks');
  return out;
}
/**
 * The patch this draft would write, or the first thing the operator has to fix.
 * With [only] (#1783) it checks and writes just those fields; without it, all.
 */
export function bookingRulesPatch(
  draft: Draft,
  only?: ReadonlySet<BookingField>,
): { patch: Partial<BusinessSettings> } | { error: string } {
  const has = (...fields: BookingField[]) => only === undefined || fields.some((f) => only.has(f));
  const patch: Partial<BusinessSettings> = {};
  if (has('defaultTimeBlockDurationHours')) {
    const duration = parseWholeNumber(
      draft.defaultTimeBlockDurationHours,
      NUMBER_FIELDS.defaultTimeBlockDurationHours,
    );
    if ('error' in duration) return { error: `Default block length: ${duration.error}` };
    patch.defaultTimeBlockDurationHours = duration.value;
  }
  if (has('travelBufferMinutes')) {
    const buffer = parseWholeNumber(draft.travelBufferMinutes, NUMBER_FIELDS.travelBufferMinutes);
    if ('error' in buffer) return { error: `Travel buffer: ${buffer.error}` };
    patch.travelBufferMinutes = buffer.value;
  }
  if (has('timeBlocks', 'timeMode')) {
    const blocks = validateTimeBlocks(draft.blocks);
    if ('error' in blocks) return { error: blocks.error };
    if (draft.timeMode === 'TIME_BLOCK' && blocks.value.every((b) => !b.active)) {
      return { error: TIME_BLOCKS_NEED_A_BLOCK };
    }
    if (has('timeBlocks')) patch.timeBlocks = blocks.value;
  }
  // #1863: the mode is always written as all three of its fields.
  if (has('timeMode')) Object.assign(patch, bookingModeFields(draft.timeMode));
  if (has('defaultCalendarView')) patch.defaultCalendarView = draft.defaultCalendarView;
  if (has('enableAutoReminder24h')) patch.enableAutoReminder24h = draft.enableAutoReminder24h;
  return { patch };
}
/** #1863: the same sentence `saveBusinessSettings` refuses with. */
export const TIME_BLOCKS_NEED_A_BLOCK =
  'Time Blocks needs at least one block turned on. Turn one on, or pick Exact times.';
/** The two number fields of this panel, by the setting each one writes. */
type NumberField = 'defaultTimeBlockDurationHours' | 'travelBufferMinutes';
const NUMBER_FIELD_KEYS: readonly NumberField[] = ['defaultTimeBlockDurationHours', 'travelBufferMinutes'];

/**
 * #1593: what is wrong with each number field, for the line under it. The same
 * parser `bookingRulesPatch` runs, without the field-name lead: the field's
 * own label already says which one it is.
 */
export function bookingRulesFieldErrors(draft: Draft): Partial<Record<NumberField, string>> {
  const out: Partial<Record<NumberField, string>> = {};
  for (const key of NUMBER_FIELD_KEYS) {
    const parsed = parseWholeNumber(draft[key], NUMBER_FIELDS[key]);
    if ('error' in parsed) out[key] = parsed.error;
  }
  return out;
}

/**
 * The panel-wide problem, the one the banner shows: the booking modes and the
 * time blocks, which have no single field to sit under. The number fields are
 * stood in with legal values so a refusal of theirs, already under its own
 * field, is not said twice and does not hide one of these.
 */
function bookingRulesPanelProblem(draft: Draft, only?: ReadonlySet<BookingField>): string | null {
  const built = bookingRulesPatch(
    {
      ...draft,
      defaultTimeBlockDurationHours: String(NUMBER_FIELDS.defaultTimeBlockDurationHours.min),
      travelBufferMinutes: String(NUMBER_FIELDS.travelBufferMinutes.min),
    },
    only,
  );
  return 'error' in built ? built.error : null;
}

export function BookingRulesSection({ data, onSave }: BookingRulesSectionProps) {
  const [draft, setDraft] = useState<Draft>(() => seed(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // #1593: a server refusal for a number field, under that field until it is
  // edited again.
  const [serverErrors, setServerErrors] = useState<Partial<Record<string, string>>>({});

  const edited = editedBookingFields(draft, data);
  const built = bookingRulesPatch(draft, edited);
  const problem = 'error' in built ? built.error : null;
  const panelProblem = bookingRulesPanelProblem(draft);
  // #1783: a problem in a field nobody changed still shows, but it is not what
  // holds Save back; `problem` is.
  const gatingPanelProblem = bookingRulesPanelProblem(draft, edited);
  const numberErrors = bookingRulesFieldErrors(draft);
  const fieldError = (key: NumberField): string | undefined => numberErrors[key] ?? serverErrors[key];
  const dirty = edited.size > 0;
  const overlaps = blockOverlaps(draft.blocks);

  function edit(next: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...next }));
    setServerErrors((e) => {
      const kept = { ...e };
      for (const key of Object.keys(next)) delete kept[key];
      return kept;
    });
    setJustSaved(false);
  }

  /**
   * ISSUE #1612: a start typed into a row whose end is still empty fills the
   * end from "Default block length". That is the operator's own setting doing
   * what its hint says; the app never picks the start.
   */
  function editBlock(index: number, next: Partial<TimeBlockDraft>) {
    setDraft((d) => ({
      ...d,
      blocks: d.blocks.map((row, i) => {
        if (i !== index) return row;
        const merged = { ...row, ...next };
        if (next.startTime !== undefined && merged.endTime === '' && HHMM_REGEX.test(merged.startTime)) {
          const hours = parseWholeNumber(
            d.defaultTimeBlockDurationHours,
            NUMBER_FIELDS.defaultTimeBlockDurationHours,
          );
          merged.endTime = defaultBlockEnd(merged.startTime, 'value' in hours ? hours.value : 4);
        }
        return merged;
      }),
    }));
    setJustSaved(false);
  }

  /**
   * ISSUE #1612: a new row opens with no start and no end. It used to open at
   * 09:00, an hour the app chose, which landed on top of Midday with nothing on
   * screen saying so. Blank, the HH:mm check asks for both times, and the
   * operator's own default length fills the end once a start is in.
   */
  function addBlock() {
    setDraft((d) => {
      const label = 'New block';
      const taken = d.blocks.map((b) => b.id);
      return {
        ...d,
        blocks: [
          ...d.blocks,
          {
            id: slugifyBlockId(`${label} ${taken.length + 1}`, taken),
            label: '',
            startTime: '',
            endTime: '',
            active: true,
          },
        ],
      };
    });
    setJustSaved(false);
  }

  function removeBlock(index: number) {
    setDraft((d) => ({ ...d, blocks: d.blocks.filter((_, i) => i !== index) }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy || 'error' in built) return;
    setBusy(true);
    setError(null);
    setServerErrors({});
    try {
      await onSave(built.patch);
      setJustSaved(true);
    } catch (err) {
      const split = splitSettingsRefusal(err, NUMBER_FIELD_KEYS);
      setServerErrors(split.byField);
      setError(split.banner);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DenPanel
      title="Booking rules"
      subtitle="How visits may be booked, how long a block runs, and how much room to leave between two visits."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      {panelProblem ? (
        <Banner
          tone="warning"
          title={gatingPanelProblem ? 'Not ready to save' : 'Check this setting'}
          className="settingsEdit__sectionBanner"
        >
          {panelProblem}
        </Banner>
      ) : null}

      {/* ISSUE #708 mark 38: this panel used to run as one flat column of
          toggles, dropdowns and the block editor with no visible break between
          them. It is now three named groups: which booking modes are on,
          what a new booking defaults to, and the named windows kinfolk book
          into. */}
      {/* #1863: ONE mode for the business. Time Blocks: Kinfolk book and see
          only blocks, and see an exact time only on a KinTale's check-in and
          check-out. Exact times: they pick and see a clock time. */}
      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading" id="booking-time-mode-heading">
          Kinfolk book and see
        </span>
        <div className="settingsEdit__toggleList" role="radiogroup" aria-labelledby="booking-time-mode-heading">
          {TIME_MODE_OPTIONS.map((o) => (
            <label key={o.value} className="settingsEdit__toggleRow">
              <input
                type="radio"
                name="booking-time-mode"
                value={o.value}
                checked={draft.timeMode === o.value}
                disabled={busy}
                onChange={() => edit({ timeMode: o.value })}
              />
              <span className="settingsEdit__toggleLabel" title={o.tooltip}>
                {o.label}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">Defaults</span>
        <ul className="settingsEdit__toggleList">
          <li className="settingsEdit__toggleRow">
            <span className="settingsEdit__toggleLabel">Remind kinfolk {VISIT_REMINDER_TIMING} a visit</span>
            <Toggle
              label="Toggle the visit reminder"
              checked={draft.enableAutoReminder24h}
              disabled={busy}
              onChange={(next) => edit({ enableAutoReminder24h: next })}
            />
          </li>
        </ul>

        <div className="settingsEdit__fields">
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Calendar opens on</span>
              <select
                className="settingsEdit__input"
                value={draft.defaultCalendarView}
                disabled={busy}
                onChange={(e) => edit({ defaultCalendarView: e.target.value })}
              >
                {optionsIncluding(CALENDAR_VIEWS, draft.defaultCalendarView).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Default block length (hours)</span>
              <input
                type="text"
                inputMode="numeric"
                className="settingsEdit__input"
                value={draft.defaultTimeBlockDurationHours}
                disabled={busy}
                onChange={(e) => edit({ defaultTimeBlockDurationHours: e.target.value })}
                {...fieldErrorAttrs('blockLength', fieldError('defaultTimeBlockDurationHours'), 'blockLength-hint')}
              />
            </label>
            <span id="blockLength-hint" className="settingsEdit__hint">
              How long a new block runs from the start time you give it.
            </span>
            <FieldError id="blockLength" message={fieldError('defaultTimeBlockDurationHours')} />
          </div>

          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Travel buffer (minutes)</span>
              <input
                type="text"
                inputMode="numeric"
                className="settingsEdit__input"
                value={draft.travelBufferMinutes}
                disabled={busy}
                onChange={(e) => edit({ travelBufferMinutes: e.target.value })}
                {...fieldErrorAttrs('travelBuffer', fieldError('travelBufferMinutes'), 'travelBuffer-hint')}
              />
            </label>
            <span id="travelBuffer-hint" className="settingsEdit__hint">
              Room kept between two visits in the same block, so a full block still leaves you time
              to drive.
            </span>
            <FieldError id="travelBuffer" message={fieldError('travelBufferMinutes')} />
          </div>
        </div>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">Time blocks</span>
        <p className="settingsEdit__hint">
          The windows kinfolk book into. They pick one of these by name rather than typing a clock
          time, so this list is what is on offer. Turn a block off to stop offering it without
          losing its hours. Two blocks that are both on cannot overlap.
        </p>
        {draft.blocks.length === 0 ? (
          <p className="settingsEdit__hint">No blocks yet. Add one below.</p>
        ) : null}
        <ul className="bookingRules__blocks">
          {draft.blocks.map((block, index) => (
            <li key={block.id} className="bookingRules__block">
              <label className="settingsEdit__field bookingRules__blockName">
                <span className="settingsEdit__fieldLabel">Name</span>
                <input
                  type="text"
                  className="settingsEdit__input"
                  value={block.label}
                  placeholder="Midday"
                  disabled={busy}
                  onChange={(e) => editBlock(index, { label: e.target.value })}
                />
              </label>
              <label className="settingsEdit__field">
                <span className="settingsEdit__fieldLabel">Starts</span>
                <input
                  type="time"
                  className="settingsEdit__input"
                  aria-label={`${block.label || 'Block'} start time`}
                  value={block.startTime}
                  disabled={busy}
                  onChange={(e) => editBlock(index, { startTime: e.target.value })}
                />
              </label>
              <label className="settingsEdit__field">
                <span className="settingsEdit__fieldLabel">Ends</span>
                <input
                  type="time"
                  className="settingsEdit__input"
                  aria-label={`${block.label || 'Block'} end time`}
                  value={block.endTime}
                  disabled={busy}
                  onChange={(e) => editBlock(index, { endTime: e.target.value })}
                />
              </label>
              <div className="bookingRules__blockActions">
                <Toggle
                  label={`Offer ${block.label || 'this block'}`}
                  checked={block.active}
                  disabled={busy}
                  onChange={(next) => editBlock(index, { active: next })}
                />
                <GhostButton label="Remove" onClick={() => removeBlock(index)} disabled={busy} />
              </div>
              {/* ISSUE #1612: on the row itself, named or not, so the clash is
                  seen where it is fixed. The banner above still names the
                  first thing blocking the save. */}
              {(overlaps[index] ?? []).length > 0 ? (
                <p className="settingsEdit__hint bookingRules__overlap" role="alert">
                  {overlapNote(overlaps[index] ?? [])}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <GhostButton label="Add a block" onClick={addBlock} disabled={busy} />
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton
          label="Cancel"
          onClick={() => {
            setDraft(seed(data));
            setServerErrors({});
            setError(null);
            setJustSaved(false);
          }}
          disabled={!dirty || busy}
        />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || problem !== null}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
