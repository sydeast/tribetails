import { useCallback, useState } from 'react';
import {
  createBlockedTimeSlot,
  overridableScheduleRefusal,
  overrideHint,
} from '../api/scheduleWrite';
import { localDayTimeToMs } from '../lib/newBooking';
import { isValidHHmm } from '../lib/scheduleFormat';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './BlockTimeDialog.css';

interface BlockTimeDialogProps {
  /** `YYYY-MM-DD` the Schedule screen currently has selected; the operator can change it. */
  initialDate: string;
  onClose: () => void;
  /** Fired once a slot is really written. `booking_time_slots` is a live stream, so the caller only has to close. */
  onBlocked: () => void;
}

/**
 * "Block time" on the admin Schedule (#397 M11): mark a window unavailable so
 * kinfolk cannot book it, and so the operator's own calendar says why.
 *
 * The callable has been deployed the whole time (`createBlockedTimeSlot`); this
 * web app was simply the one admin surface that never called it. The desktop
 * admin's `BlockTimeDialog.kt` is the reference, and this form collects the same
 * four things it does, with the same `HH:mm` regex on both clock fields and the
 * same lexical start-before-end check — which is safe precisely because the
 * regex forces two-digit, zero-padded hours.
 *
 * IT SENDS ONE MORE THING THAN THE DESKTOP DOES, and that is the point of the
 * server change behind this: the window a SECOND time, as epoch ms. The stored
 * document is zoneless wall clock, so the server could never tell whether a
 * block landed on a visit; the browser can, because it is the one place the
 * operator's zone is known. See `api/scheduleWrite.ts#BlockTimeArgs`.
 *
 * WHAT THE OPERATOR SEES WHEN A VISIT IS IN THE WAY: the server's own sentence,
 * naming the window, plus a "Block anyway" button — because that clash is a
 * judgement call (an Auntie may be covering it, the visit may be about to be
 * cancelled) and the server audits the override rather than pretending it did
 * not happen. A company closure is refused with no such offer, and that
 * asymmetry is deliberate; see `overridableScheduleRefusal`.
 */
export function BlockTimeDialog({ initialDate, onClose, onBlocked }: BlockTimeDialogProps) {
  const [date, setDate] = useState(initialDate);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('12:00');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the operator may go past this refusal. Narrowed to the VISIT clash
   * on purpose: `createBlockedTimeSlot` has no busy-import guard and therefore
   * no `overrideBusyConflict` argument, so offering a retry for that code would
   * be a button that re-sends the identical request and fails identically.
   */
  const [overridable, setOverridable] = useState<'visit' | null>(null);
  /** True once "Block anyway" has been used, so the same losing move is never offered twice. */
  const [overrode, setOverrode] = useState(false);

  const startOk = isValidHHmm(startTime.trim());
  const endOk = isValidHHmm(endTime.trim());
  const orderOk = startOk && endOk && startTime.trim() < endTime.trim();
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date.trim());
  const canSave = dateOk && orderOk && !saving;

  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function submit(overrideVisitConflict: boolean) {
    if (!canSave) return;
    const startTimeMs = localDayTimeToMs(date.trim(), startTime.trim());
    const endTimeMs = localDayTimeToMs(date.trim(), endTime.trim());
    if (startTimeMs === null || endTimeMs === null) {
      // Reachable only for a date the regex accepts but the calendar does not
      // (2026-02-30). Fail loud rather than send a window nobody meant.
      setError('That is not a real date. Pick a day that exists.');
      return;
    }
    setSaving(true);
    setError(null);
    setOverridable(null);
    try {
      await createBlockedTimeSlot({
        date: date.trim(),
        startTime: startTime.trim(),
        endTime: endTime.trim(),
        notes: notes.trim(),
        startTimeMs,
        endTimeMs,
        ...(overrideVisitConflict && { overrideVisitConflict: true }),
      });
      setSaving(false);
      onBlocked();
    } catch (err) {
      setSaving(false);
      if (overrideVisitConflict) setOverrode(true);
      const kind = overridableScheduleRefusal(err, overrideVisitConflict || overrode);
      setOverridable(kind === 'visit' ? 'visit' : null);
      setError(err instanceof Error ? err.message : 'Could not block that time.');
    }
  }

  return (
    <Dialog
      title="Block time"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Blocking…' : 'Block time'}
            onClick={() => void submit(false)}
            disabled={!canSave}
            busy={saving}
          />
        </>
      }
    >
      <p className="block-time__hint">Mark a window unavailable so kinfolk can&rsquo;t book it.</p>

      <fieldset className="block-time__fields" disabled={saving}>
        <legend className="block-time__legend">Blocked window</legend>

        <div className="block-time__field">
          <label className="block-time__label" htmlFor="block-time-date">
            Date
          </label>
          <input
            id="block-time-date"
            className="block-time__input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="block-time__row">
          <div className="block-time__field">
            <label className="block-time__label" htmlFor="block-time-start">
              Start
            </label>
            <input
              id="block-time-start"
              className="block-time__input"
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              aria-invalid={!startOk}
            />
          </div>
          <div className="block-time__field">
            <label className="block-time__label" htmlFor="block-time-end">
              End
            </label>
            <input
              id="block-time-end"
              className="block-time__input"
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              aria-invalid={!endOk}
            />
          </div>
        </div>

        {startOk && endOk && !orderOk && (
          <p className="block-time__error" role="alert">
            The end has to come after the start.
          </p>
        )}

        <div className="block-time__field">
          <label className="block-time__label" htmlFor="block-time-notes">
            Reason (optional)
          </label>
          <textarea
            id="block-time-notes"
            className="block-time__textarea"
            rows={2}
            maxLength={500}
            placeholder="e.g. Vacation, appointment"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </fieldset>

      {error !== null && (
        <Banner tone="error" title="Couldn’t block the time">
          <p>{error}</p>
          {overridable !== null && (
            <>
              <p>{overrideHint(overridable)}</p>
              <GhostButton label="Block anyway" onClick={() => void submit(true)} disabled={saving} />
            </>
          )}
        </Banner>
      )}
    </Dialog>
  );
}
