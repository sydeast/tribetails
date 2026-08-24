import { useState } from 'react';
import type { BusinessSettings, TimeBlockDefinition } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import {
  BOOKING_MODES,
  CALENDAR_VIEWS,
  NUMBER_FIELDS,
  defaultBlockEnd,
  optionsIncluding,
  parseWholeNumber,
  slugifyBlockId,
  timeBlockDraft,
  validateTimeBlocks,
  type TimeBlockDraft,
} from '../../lib/businessOperations';
import '../SettingsEdit.css';
import './BookingRulesSection.css';

/**
 * ISSUE #519: the booking configuration block — seven fields the three admin
 * clients decoded and defaulted, and that no React or desktop surface offered a
 * control for.
 *
 * WHAT EACH ONE ACTUALLY DOES, because "persists but changes nothing" is the
 * same defect one step along, and this panel is honest about which is which:
 *
 *  - `defaultBookingMode`   seeds the scheduling screen's mode on Android
 *                           (`EnhancedSchedulingViewModel`, via
 *                           `defaultBookingModeEnum`). Its only writer was an
 *                           orphaned view-model method with no caller.
 *  - `defaultCalendarView`  seeds that screen's calendar view. Wired to a
 *                           consumer in this same change.
 *  - `allowTimeBlockBooking` / `allowSpecificTimeBooking`
 *                           which of the two modes may be chosen. Already
 *                           editable on Android (Service management -> Settings
 *                           -> Business Settings); this is their first home on
 *                           the web admin, and the picker above now offers only
 *                           the modes they allow.
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
 * ONE SAVE for the whole panel, not per-flip: the two allow-flags and the mode
 * picker are one decision (you cannot default to a mode you have turned off),
 * and saving each flip separately would let the doc pass through the state this
 * panel refuses.
 */

interface BookingRulesSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface Draft {
  defaultBookingMode: string;
  defaultCalendarView: string;
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
  defaultTimeBlockDurationHours: string;
  travelBufferMinutes: string;
  enableAutoReminder24h: boolean;
  blocks: TimeBlockDraft[];
}

function seed(data: BusinessSettings): Draft {
  return {
    defaultBookingMode: data.defaultBookingMode,
    defaultCalendarView: data.defaultCalendarView,
    allowTimeBlockBooking: data.allowTimeBlockBooking,
    allowSpecificTimeBooking: data.allowSpecificTimeBooking,
    defaultTimeBlockDurationHours: String(data.defaultTimeBlockDurationHours),
    travelBufferMinutes: String(data.travelBufferMinutes),
    // Absent reads as ON, matching the server gate. See `enableAutoReminder24h`
    // in `api/settings.ts` and `mytribe/functions/src/lib/autoReminder.ts`.
    enableAutoReminder24h: data.enableAutoReminder24h !== false,
    blocks: data.timeBlocks.map(timeBlockDraft),
  };
}

/** The patch this draft would write, or the first thing the operator has to fix. */
export function bookingRulesPatch(
  draft: Draft,
): { patch: Partial<BusinessSettings> } | { error: string } {
  if (!draft.allowTimeBlockBooking && !draft.allowSpecificTimeBooking) {
    return { error: 'Leave at least one booking mode on, or nothing can be booked at all.' };
  }
  if (draft.defaultBookingMode === 'TIME_BLOCK' && !draft.allowTimeBlockBooking) {
    return { error: 'Time blocks are turned off, so they cannot be the default. Pick the other mode.' };
  }
  if (draft.defaultBookingMode === 'SPECIFIC_TIME' && !draft.allowSpecificTimeBooking) {
    return { error: 'Specific times are turned off, so they cannot be the default. Pick the other mode.' };
  }
  const duration = parseWholeNumber(
    draft.defaultTimeBlockDurationHours,
    NUMBER_FIELDS.defaultTimeBlockDurationHours,
  );
  if ('error' in duration) return { error: `Default block length: ${duration.error}` };
  const buffer = parseWholeNumber(draft.travelBufferMinutes, NUMBER_FIELDS.travelBufferMinutes);
  if ('error' in buffer) return { error: `Travel buffer: ${buffer.error}` };
  const blocks = validateTimeBlocks(draft.blocks);
  if ('error' in blocks) return { error: blocks.error };
  if (draft.allowTimeBlockBooking && blocks.value.every((b) => !b.active)) {
    return { error: 'Time-block booking is on but no block is active, so there is nothing to book into.' };
  }
  return {
    patch: {
      defaultBookingMode: draft.defaultBookingMode,
      defaultCalendarView: draft.defaultCalendarView,
      allowTimeBlockBooking: draft.allowTimeBlockBooking,
      allowSpecificTimeBooking: draft.allowSpecificTimeBooking,
      defaultTimeBlockDurationHours: duration.value,
      travelBufferMinutes: buffer.value,
      enableAutoReminder24h: draft.enableAutoReminder24h,
      timeBlocks: blocks.value,
    },
  };
}

/** Does this draft differ from what is loaded? Compared on the SAVED shape, so retyping "04" over "4" is not a change. */
function isDirty(draft: Draft, data: BusinessSettings): boolean {
  const built = bookingRulesPatch(draft);
  if ('error' in built) return true;
  const p = built.patch;
  return (
    p.defaultBookingMode !== data.defaultBookingMode ||
    p.defaultCalendarView !== data.defaultCalendarView ||
    p.allowTimeBlockBooking !== data.allowTimeBlockBooking ||
    p.allowSpecificTimeBooking !== data.allowSpecificTimeBooking ||
    p.defaultTimeBlockDurationHours !== data.defaultTimeBlockDurationHours ||
    p.travelBufferMinutes !== data.travelBufferMinutes ||
    p.enableAutoReminder24h !== (data.enableAutoReminder24h !== false) ||
    !sameBlocks(p.timeBlocks ?? [], data.timeBlocks)
  );
}

function sameBlocks(a: readonly TimeBlockDefinition[], b: readonly TimeBlockDefinition[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.label === other.label &&
      row.startTime === other.startTime &&
      row.endTime === other.endTime &&
      row.active === other.active
    );
  });
}

export function BookingRulesSection({ data, onSave }: BookingRulesSectionProps) {
  const [draft, setDraft] = useState<Draft>(() => seed(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const built = bookingRulesPatch(draft);
  const problem = 'error' in built ? built.error : null;
  const dirty = isDirty(draft, data);

  function edit(next: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...next }));
    setJustSaved(false);
  }

  function editBlock(index: number, next: Partial<TimeBlockDraft>) {
    setDraft((d) => ({
      ...d,
      blocks: d.blocks.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }));
    setJustSaved(false);
  }

  function addBlock() {
    setDraft((d) => {
      const hours = parseWholeNumber(
        d.defaultTimeBlockDurationHours,
        NUMBER_FIELDS.defaultTimeBlockDurationHours,
      );
      const label = 'New block';
      const taken = d.blocks.map((b) => b.id);
      const start = '09:00';
      return {
        ...d,
        blocks: [
          ...d.blocks,
          {
            id: slugifyBlockId(`${label} ${taken.length + 1}`, taken),
            label: '',
            startTime: start,
            endTime: defaultBlockEnd(start, 'value' in hours ? hours.value : 4),
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
    try {
      await onSave(built.patch);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
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
      {problem ? (
        <Banner tone="warning" title="Not ready to save" className="settingsEdit__sectionBanner">
          {problem}
        </Banner>
      ) : null}

      <ul className="settingsEdit__toggleList">
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Offer specific times</span>
          <Toggle
            label="Toggle booking at a specific time"
            checked={draft.allowSpecificTimeBooking}
            disabled={busy}
            onChange={(next) => edit({ allowSpecificTimeBooking: next })}
          />
        </li>
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Offer time blocks</span>
          <Toggle
            label="Toggle booking into a time block"
            checked={draft.allowTimeBlockBooking}
            disabled={busy}
            onChange={(next) => edit({ allowTimeBlockBooking: next })}
          />
        </li>
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Remind kinfolk 24 hours before a visit</span>
          <Toggle
            label="Toggle the 24-hour visit reminder"
            checked={draft.enableAutoReminder24h}
            disabled={busy}
            onChange={(next) => edit({ enableAutoReminder24h: next })}
          />
        </li>
      </ul>

      <div className="settingsEdit__fields">
        <div className="settingsEdit__fieldGroup">
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">New bookings start as</span>
            <select
              className="settingsEdit__input"
              value={draft.defaultBookingMode}
              disabled={busy}
              onChange={(e) => edit({ defaultBookingMode: e.target.value })}
            >
              {optionsIncluding(BOOKING_MODES, draft.defaultBookingMode).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

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
              aria-describedby="blockLength-hint"
              onChange={(e) => edit({ defaultTimeBlockDurationHours: e.target.value })}
            />
          </label>
          <span id="blockLength-hint" className="settingsEdit__hint">
            How long a block runs when you add one below.
          </span>
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
              aria-describedby="travelBuffer-hint"
              onChange={(e) => edit({ travelBufferMinutes: e.target.value })}
            />
          </label>
          <span id="travelBuffer-hint" className="settingsEdit__hint">
            Room kept between two visits in the same block, so a full block still leaves you time to
            drive.
          </span>
        </div>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__fieldLabel">Time blocks</span>
        <p className="settingsEdit__hint">
          The named windows a block booking lands in. A visit inside one is shown by its block name
          on the schedule.
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
