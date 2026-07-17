import { useCallback, useMemo, useState } from 'react';
import {
  createMultiDateBookingRequest,
  type CreateMultiDateBookingResult,
} from '../api/bookingsWrite';
import { KINFOLK_QUERY, SORT_OPTION_DEFAULT, filterSortKinfolk, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { useCollection } from '../lib/firestore';
import {
  WEEKDAY_LABELS,
  expandWeekly,
  visitMsFromRows,
  allInFuture,
  type BookingMode,
  type DateRow,
} from '../lib/newBooking';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import { Banner } from './Banner';
import './NewBookingDialog.css';

interface NewBookingDialogProps {
  onClose: () => void;
  /** Called with the created envelope result once the request lands. */
  onCreated: (result: CreateMultiDateBookingResult) => void;
}

/**
 * AO-25: admin "New booking request" surface. Ports the never-built
 * BookingCreateScreen (household picker + service + date/time), and extends it
 * to what the wasm single-date create could not do: non-consecutive multiple
 * dates, or a weekly recurrence.
 *
 * Writes via `createMultiDateBookingRequest` (admin callable), which stores the
 * ENVELOPE model as `envelopeStatus:'requested'`, i.e. it enters the Incoming-
 * requests queue for approval, NOT the flat `kin_care_sessions` the Bookings
 * list shows. The success copy the caller renders says so, rather than letting
 * the operator wonder why the new request isn't in the list.
 *
 * All times are LOCAL (AO-18): the date/time inputs are wall-clock, converted
 * to epoch ms in the operator's own zone (see lib/newBooking.ts).
 */
export function NewBookingDialog({ onClose, onCreated }: NewBookingDialogProps) {
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);

  const [kinfolkId, setKinfolkId] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<BookingMode>('dates');

  // Specific-date mode: one or more datetime-local rows.
  const [dateRows, setDateRows] = useState<DateRow[]>([{ dateTimeLocal: '' }]);

  // Weekly mode.
  const [startDateIso, setStartDateIso] = useState('');
  const [time, setTime] = useState('09:00');
  const [weeklyDays, setWeeklyDays] = useState<number[]>([]);
  const [weeks, setWeeks] = useState(4);

  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const householdOptions = useMemo(() => {
    if (households.status !== 'ready') return [];
    return filterSortKinfolk(households.data, '', SORT_OPTION_DEFAULT).map((kf) => ({
      id: kf._id,
      label: kinfolkDisplayName(kf),
    }));
  }, [households]);

  const startTimesMs = useMemo(() => {
    return mode === 'weekly'
      ? expandWeekly({ startDateIso, time, weeklyDays, weeks })
      : visitMsFromRows(dateRows);
  }, [mode, dateRows, startDateIso, time, weeklyDays, weeks]);

  const kinfolkError = touched && kinfolkId === '' ? 'Pick a household.' : null;
  const serviceError = touched && serviceName.trim() === '' ? 'A service name is required.' : null;
  const visitsError =
    touched && startTimesMs.length === 0
      ? 'Add at least one valid date.'
      : touched && !allInFuture(startTimesMs, Date.now())
        ? 'Every visit must be in the future.'
        : null;

  const canSubmit =
    kinfolkId !== '' &&
    serviceName.trim() !== '' &&
    startTimesMs.length > 0 &&
    allInFuture(startTimesMs, Date.now()) &&
    !saving;

  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  function toggleWeekday(day: number) {
    setWeeklyDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)));
  }

  function updateRow(idx: number, value: string) {
    setDateRows((prev) => prev.map((r, i) => (i === idx ? { dateTimeLocal: value } : r)));
  }
  function addRow() {
    setDateRows((prev) => [...prev, { dateTimeLocal: '' }]);
  }
  function removeRow(idx: number) {
    setDateRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function handleSubmit() {
    setTouched(true);
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createMultiDateBookingRequest({
        kinfolkId,
        ...(notes.trim() !== '' && { notes: notes.trim() }),
        pattern: mode === 'weekly' ? 'weekly' : 'individual',
        ...(mode === 'weekly' && { weeklyDays }),
        visits: startTimesMs.map((ms) => ({ startTimeMs: ms, serviceName: serviceName.trim() })),
      });
      setSaving(false);
      onCreated(result);
    } catch (err) {
      setSaving(false);
      setError(
        `createMultiDateBookingRequest failed: ${err instanceof Error ? err.message : 'Create failed'}`,
      );
    }
  }

  const visitCount = startTimesMs.length;

  return (
    <Dialog
      title="New booking request"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Creating…' : visitCount > 0 ? `Create ${visitCount} visit${visitCount === 1 ? '' : 's'}` : 'Create request'}
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            busy={saving}
          />
        </>
      }
    >
      {error !== null && (
        <Banner tone="error" title="Couldn&rsquo;t create the request" className="new-booking__banner">
          {error}
        </Banner>
      )}

      <fieldset className="new-booking__fields" disabled={saving}>
        <legend className="new-booking__sr-legend">New booking request</legend>

        <div className="new-booking__field">
          <label className="new-booking__label" htmlFor="new-booking-household">
            Household
          </label>
          <select
            id="new-booking-household"
            className="new-booking__input"
            value={kinfolkId}
            onChange={(e) => setKinfolkId(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={kinfolkError !== null}
          >
            <option value="">
              {households.status === 'ready' ? 'Choose a household…' : 'Loading households…'}
            </option>
            {householdOptions.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
          {kinfolkError !== null && (
            <span className="new-booking__error" role="alert">
              {kinfolkError}
            </span>
          )}
          {households.status === 'error' && (
            <span className="new-booking__error" role="alert">
              Households failed to load: {households.message}
            </span>
          )}
        </div>

        <div className="new-booking__field">
          <label className="new-booking__label" htmlFor="new-booking-service">
            Service
          </label>
          <input
            id="new-booking-service"
            type="text"
            className="new-booking__input"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. Dog Walk"
            aria-invalid={serviceError !== null}
          />
          {serviceError !== null && (
            <span className="new-booking__error" role="alert">
              {serviceError}
            </span>
          )}
        </div>

        <div className="new-booking__field">
          <span className="new-booking__label">Dates</span>
          <div className="new-booking__mode" role="tablist" aria-label="Date entry mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'dates'}
              className={mode === 'dates' ? 'new-booking__mode-tab new-booking__mode-tab--active' : 'new-booking__mode-tab'}
              onClick={() => setMode('dates')}
            >
              Specific dates
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'weekly'}
              className={mode === 'weekly' ? 'new-booking__mode-tab new-booking__mode-tab--active' : 'new-booking__mode-tab'}
              onClick={() => setMode('weekly')}
            >
              Weekly
            </button>
          </div>

          {mode === 'dates' ? (
            <div className="new-booking__dates">
              {dateRows.map((row, idx) => (
                <div key={idx} className="new-booking__date-row">
                  <input
                    type="datetime-local"
                    className="new-booking__input"
                    value={row.dateTimeLocal}
                    onChange={(e) => updateRow(idx, e.target.value)}
                    onBlur={() => setTouched(true)}
                    aria-label={`Visit ${idx + 1} date and time`}
                  />
                  <GhostButton
                    label="Remove"
                    onClick={() => removeRow(idx)}
                    disabled={dateRows.length <= 1}
                  />
                </div>
              ))}
              <GhostButton label="Add another date" onClick={addRow} />
            </div>
          ) : (
            <div className="new-booking__weekly">
              <div className="new-booking__weekly-row">
                <label className="new-booking__subfield">
                  <span className="new-booking__sublabel">Start on</span>
                  <input
                    type="date"
                    className="new-booking__input"
                    value={startDateIso}
                    onChange={(e) => setStartDateIso(e.target.value)}
                    onBlur={() => setTouched(true)}
                  />
                </label>
                <label className="new-booking__subfield">
                  <span className="new-booking__sublabel">Time</span>
                  <input
                    type="time"
                    className="new-booking__input"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </label>
                <label className="new-booking__subfield">
                  <span className="new-booking__sublabel">For how many weeks</span>
                  <input
                    type="number"
                    className="new-booking__input"
                    min={1}
                    max={12}
                    value={weeks}
                    onChange={(e) => setWeeks(Math.max(1, Math.min(12, Number.parseInt(e.target.value, 10) || 1)))}
                  />
                </label>
              </div>
              <div className="new-booking__weekdays" role="group" aria-label="Repeat on">
                {WEEKDAY_LABELS.map((label, day) => (
                  <label key={day} className="new-booking__weekday">
                    <input
                      type="checkbox"
                      checked={weeklyDays.includes(day)}
                      onChange={() => {
                        setTouched(true);
                        toggleWeekday(day);
                      }}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {visitsError !== null && (
            <span className="new-booking__error" role="alert">
              {visitsError}
            </span>
          )}
          {visitCount > 0 && visitsError === null && (
            <span className="new-booking__preview">
              {visitCount} visit{visitCount === 1 ? '' : 's'} will be requested.
            </span>
          )}
        </div>

        <div className="new-booking__field">
          <label className="new-booking__label" htmlFor="new-booking-notes">
            Notes (optional)
          </label>
          <textarea
            id="new-booking-notes"
            className="new-booking__input new-booking__textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Anything the Auntie should know"
          />
        </div>
      </fieldset>
    </Dialog>
  );
}
