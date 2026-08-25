import { useCallback, useMemo, useState } from 'react';
import {
  createKinCareSession,
  overridableScheduleRefusal,
  overrideHint,
} from '../api/scheduleWrite';
import { buildRescheduleTimes } from '../lib/bookingDetailFormat';
import { serviceChipLabel, serviceOptionsFromRates, type ServiceOption } from '../lib/newBooking';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './NewVisitDialog.css';

export interface HouseholdOption {
  id: string;
  label: string;
}

interface NewVisitDialogProps {
  /** Every household this visit could be for. Passed in, not re-subscribed: the caller already streams `kinfolk`. */
  households: HouseholdOption[];
  /** `business_settings.serviceRates` — the operator's real catalog, keyed by service NAME. */
  serviceRates: Record<string, string>;
  /** `business_settings.serviceDurations`, the stated length per service name. Sparse; the name parse is the fallback. */
  serviceDurations: Record<string, string>;
  /** `YYYY-MM-DD` the Schedule screen currently has selected. */
  initialDate: string;
  onClose: () => void;
  /** Fired once the visit is really written. `kin_care_sessions` is a live stream, so the caller only has to close. */
  onCreated: (sessionId: string) => void;
}

/**
 * "New visit" on the admin Schedule (#397 M12): put a one-off visit straight on
 * the calendar.
 *
 * IT IS NOT THE BOOKING WIZARD, and an operator can tell the difference.
 * `NewBookingDialog` mints a REQUEST that has to be approved before it becomes
 * anything; this writes a `SCHEDULED` visit through `createKinCareSession`,
 * which is what "add something to today" means when the office is the one
 * saying it. Both surfaces stay, because both are real jobs.
 *
 * SERVICE IS A PICKER OVER `serviceRates`, NEVER A TEXT BOX, and that is a
 * billing decision rather than a convenience. A session document carries no
 * price at all: `listUninvoicedSessions` prices a completed visit by looking its
 * `serviceType` string up in `business_settings.serviceRates`, and a string the
 * card does not carry comes back `unpriceable` — real work that has to be
 * priced by hand later, or missed. Typing "dog walk" where the card says
 * "30Minute" is exactly how that happens, so the control does not allow it.
 * This is the same `serviceRates`-first catalog PR #569 taught the server's
 * `resolveService` to read for the booking-request path; the flat session model
 * has no `serviceId` to resolve, so the canonical NAME is what carries it.
 *
 * DURATION FOLLOWS THE SERVICE and stays editable. Picking a type prefills the
 * minutes from `serviceOptionsFromRates` (the operator's stated
 * `serviceDurations` value first, the length parsed out of the name as
 * fallback); a type that states no length leaves the field at its default rather
 * than inventing one. The end time is always start + duration, computed by
 * `buildRescheduleTimes`, the same function the detail sheet's Reschedule and
 * the grid drag use, so all three write the same shape.
 *
 * KIN ARE NOT PICKED HERE (operator ruling R1: a KinCare covers every Kin in the
 * household). `kinIds: []` tells the server to materialize the whole roster,
 * which is what it stores; the desktop `NewVisitDialog.kt` sends the same.
 */
export function NewVisitDialog({
  households,
  serviceRates,
  serviceDurations,
  initialDate,
  onClose,
  onCreated,
}: NewVisitDialogProps) {
  const options = useMemo(
    () => serviceOptionsFromRates(serviceRates, serviceDurations),
    [serviceRates, serviceDurations],
  );

  const [kinfolkId, setKinfolkId] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState('09:00');
  const [durationText, setDurationText] = useState('30');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overridable, setOverridable] = useState<'visit' | 'busy' | null>(null);
  const [overrode, setOverrode] = useState(false);

  const durationMinutes = Number.parseInt(durationText, 10);
  const durationOk = Number.isFinite(durationMinutes) && durationMinutes > 0;
  const canSave =
    kinfolkId !== '' && serviceType !== '' && date.trim() !== '' && time.trim() !== '' && durationOk && !saving;

  function pickService(option: ServiceOption) {
    setServiceType(option.name);
    // A type that states no length leaves whatever is in the box: an invented
    // duration would silently decide how long a real visit is.
    if (option.durationMinutes !== null) setDurationText(String(option.durationMinutes));
  }

  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function submit(override: 'visit' | 'busy' | null) {
    if (!canSave) return;
    const times = buildRescheduleTimes(date.trim(), time.trim(), durationMinutes);
    if (times === null) {
      setError('Enter a real date and a time of day before scheduling.');
      return;
    }
    setSaving(true);
    setError(null);
    setOverridable(null);
    try {
      const res = await createKinCareSession({
        kinfolkId,
        kinIds: [],
        serviceType,
        startTime: times.startTime,
        endTime: times.endTime,
        serviceDurationMinutes: durationMinutes,
        ...(notes.trim() !== '' && { notes: notes.trim() }),
        ...(override === 'visit' && { overrideVisitConflict: true }),
        ...(override === 'busy' && { overrideBusyConflict: true }),
      });
      setSaving(false);
      onCreated(res.sessionId);
    } catch (err) {
      setSaving(false);
      if (override !== null) setOverrode(true);
      setOverridable(overridableScheduleRefusal(err, override !== null || overrode));
      setError(err instanceof Error ? err.message : 'Could not schedule that visit.');
    }
  }

  return (
    <Dialog
      title="New visit"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Scheduling…' : 'Schedule visit'}
            onClick={() => void submit(null)}
            disabled={!canSave}
            busy={saving}
          />
        </>
      }
    >
      <p className="new-visit__hint">
        Puts a confirmed visit on the calendar now. To send a household a request they approve, use New
        booking on Bookings.
      </p>

      <fieldset className="new-visit__fields" disabled={saving}>
        <legend className="new-visit__legend">Visit details</legend>

        <div className="new-visit__field">
          <label className="new-visit__label" htmlFor="new-visit-household">
            Household
          </label>
          <select
            id="new-visit-household"
            className="new-visit__select"
            value={kinfolkId}
            onChange={(e) => setKinfolkId(e.target.value)}
          >
            <option value="">Pick a household…</option>
            {households.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
          {households.length === 0 && (
            <p className="new-visit__error" role="alert">
              No households on file to schedule for.
            </p>
          )}
        </div>

        <div className="new-visit__field">
          <label className="new-visit__label" htmlFor="new-visit-service">
            Service
          </label>
          <select
            id="new-visit-service"
            className="new-visit__select"
            value={serviceType}
            onChange={(e) => {
              const picked = options.find((o) => o.name === e.target.value);
              if (picked) pickService(picked);
              else setServiceType('');
            }}
          >
            <option value="">Pick a service…</option>
            {options.map((o) => (
              <option key={o.name} value={o.name}>
                {serviceChipLabel(o)}
              </option>
            ))}
          </select>
          {options.length === 0 && (
            <p className="new-visit__error" role="alert">
              No KinCare types are configured yet. Add them in Settings, so the visit can be priced.
            </p>
          )}
        </div>

        <div className="new-visit__row">
          <div className="new-visit__field">
            <label className="new-visit__label" htmlFor="new-visit-date">
              Date
            </label>
            <input
              id="new-visit-date"
              className="new-visit__input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="new-visit__field">
            <label className="new-visit__label" htmlFor="new-visit-time">
              Start
            </label>
            <input
              id="new-visit-time"
              className="new-visit__input"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div className="new-visit__field">
            <label className="new-visit__label" htmlFor="new-visit-duration">
              Minutes
            </label>
            <input
              id="new-visit-duration"
              className="new-visit__input"
              type="number"
              min={1}
              max={1440}
              value={durationText}
              onChange={(e) => setDurationText(e.target.value)}
              aria-invalid={!durationOk}
            />
          </div>
        </div>

        <div className="new-visit__field">
          <label className="new-visit__label" htmlFor="new-visit-notes">
            Notes (optional)
          </label>
          <textarea
            id="new-visit-notes"
            className="new-visit__textarea"
            rows={2}
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </fieldset>

      {error !== null && (
        <Banner tone="error" title="Couldn’t schedule the visit">
          <p>{error}</p>
          {overridable !== null && (
            <>
              <p>{overrideHint(overridable)}</p>
              <GhostButton
                label="Schedule anyway"
                onClick={() => void submit(overridable)}
                disabled={saving}
              />
            </>
          )}
        </Banner>
      )}
    </Dialog>
  );
}
