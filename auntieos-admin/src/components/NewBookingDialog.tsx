import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createMultiDateBookingRequest,
  type CreateMultiDateBookingResult,
} from '../api/bookingsWrite';
import { KINFOLK_QUERY, SORT_OPTION_DEFAULT, filterSortKinfolk, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import {
  AVAILABILITY_BUSY_SLOTS_QUERY,
  AVAILABILITY_SESSIONS_QUERY,
  type AvailabilityBusySlot,
  type AvailabilitySession,
} from '../api/availability';
import { getBusinessSettings } from '../api/settings';
import { useCollection } from '../lib/firestore';
import {
  WEEKDAY_LABELS,
  WEEKS_OPTIONS,
  expandWeekly,
  visitMsFromDays,
  sortedDays,
  allInFuture,
  serviceChipLabel,
  serviceOptionsFromRates,
  type BookingMode,
  type ServiceOption,
} from '../lib/newBooking';
import {
  blockedWindows,
  businessHoursForDay,
  selectionWarnings,
  shortDayLabel,
  type DayAvailability,
} from '../lib/bookingAvailability';
import { groupBlockedSlotsByDate, sessionsByLocalDay, localDateIso } from '../lib/scheduleFormat';
import { useRovingTabs } from '../lib/useRovingTabs';
import { AuntieDatePicker } from './AuntieDatePicker';
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
 * The Service field is a chip row over the operator's OWN KinCare types
 * (`business_settings.serviceRates`, the map Settings' `KinCareRatesEditor`
 * edits), shortest visit first. It used to be a free-text box with an
 * "e.g. Dog Walk" placeholder, which meant every request carried whatever the
 * operator retyped that day and nothing matched the priced services. A plain
 * text input survives ONLY for a never-configured install, alongside a hint
 * pointing at Settings, so a fresh account can still file a request.
 *
 * The Dates field is a real calendar (`AuntieDatePicker`) plus ONE shared start
 * time, replacing the stack of `<input type="datetime-local">` rows the port
 * shipped. Those rows could not show that a day was blocked or that the
 * business was shut, so the surface looked authoritative while knowing nothing.
 * The calendar marks both, from data this admin already has read access to.
 *
 * ── AVAILABILITY, AND WHAT HAPPENS WHEN IT CANNOT BE READ ───────────────────
 *
 * Three reads feed the marks: `business_settings.businessHours` (via the same
 * one-shot `getBusinessSettings` the service chips already use),
 * `booking_time_slots` (BLOCKED windows and Google Calendar busy imports), and
 * `kin_care_sessions` (visits already scheduled). All three are SECONDARY.
 * Every one of them can fail independently, and when one does this dialog says
 * so in a warning banner and keeps going: the calendar drops the marks it can
 * no longer justify and every day stays pickable. An operator who cannot file a
 * booking because a busy-slot listener was denied is strictly worse off than
 * one who is told availability is unknown, so nothing here gates the submit.
 *
 * For the same reason a day the business is CLOSED for, or that already has
 * blocked time on it, is marked and warned about but never disabled. The
 * operator is the business and is allowed to decide to work a Sunday. Only the
 * PAST is refused outright, and that is the rule `allInFuture` already enforced.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 *
 * The picker works in the OPERATOR'S DEVICE ZONE, and so does everything it
 * produces. `lib/bookingAvailability.ts`'s header carries the full reasoning;
 * the short version is that the `startTimeMs` wire contract and the Android
 * twin are both already local, and `business_settings.timeZone` is a field no
 * surface in this app reads or validates. Rather than convert through it
 * silently, this dialog DISCLOSES the disagreement: when that setting names a
 * zone the device is not in, a note above the calendar says which zone the
 * booking is being written in and which one the business is set to.
 *
 * Writes via `createMultiDateBookingRequest` (admin callable), which stores the
 * ENVELOPE model as `envelopeStatus:'requested'`, i.e. it enters the Incoming-
 * requests queue for approval, NOT the flat `kin_care_sessions` the Bookings
 * list shows. The success copy the caller renders says so, rather than letting
 * the operator wonder why the new request isn't in the list.
 */
export function NewBookingDialog({ onClose, onCreated }: NewBookingDialogProps) {
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);
  const busySlots = useCollection<AvailabilityBusySlot>(AVAILABILITY_BUSY_SLOTS_QUERY);
  const scheduled = useCollection<AvailabilitySession>(AVAILABILITY_SESSIONS_QUERY);

  const [kinfolkId, setKinfolkId] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<BookingMode>('dates');

  // Specific-date mode: a SET of local `YYYY-MM-DD` days, all at `time`.
  const [days, setDays] = useState<ReadonlySet<string>>(() => new Set<string>());

  // Weekly mode.
  const [startDateIso, setStartDateIso] = useState('');
  const [time, setTime] = useState('09:00');
  const [weeklyDays, setWeeklyDays] = useState<number[]>([]);
  const [weeks, setWeeks] = useState(4);

  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The operator's KinCare types. `null` while the one-shot settings read is in
  // flight; `[]` both for a never-configured install and for a failed read, so
  // either way the fallback text input keeps the dialog usable (a settings
  // outage must not make booking impossible). A failure also surfaces its own
  // banner rather than passing as "you have no services".
  const [serviceOptions, setServiceOptions] = useState<ServiceOption[] | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  // The SAME one-shot read also carries businessHours and timeZone. Held apart
  // from the services state because the two degrade differently: no services is
  // a legitimate fresh install, no hours is only ever "we could not tell".
  const [businessHours, setBusinessHours] = useState<Record<string, string> | null>(null);
  const [businessTimeZone, setBusinessTimeZone] = useState('');
  const [hoursError, setHoursError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getBusinessSettings()
      .then((s) => {
        if (!live) return;
        setServiceOptions(serviceOptionsFromRates(s.serviceRates));
        setBusinessHours(s.businessHours);
        setBusinessTimeZone((s.timeZone ?? '').trim());
      })
      .catch((err: unknown) => {
        if (!live) return;
        const detail = err instanceof Error ? err.message : 'Load failed';
        setServiceOptions([]);
        setServicesError(`Couldn't load your KinCare types: ${detail}. Type the service name instead.`);
        setHoursError(detail);
      });
    return () => {
      live = false;
    };
  }, []);

  const hasServiceChips = serviceOptions !== null && serviceOptions.length > 0;
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  const householdOptions = useMemo(() => {
    if (households.status !== 'ready') return [];
    return filterSortKinfolk(households.data, '', SORT_OPTION_DEFAULT).map((kf) => ({
      id: kf._id,
      label: kinfolkDisplayName(kf),
    }));
  }, [households]);

  // ── availability ──────────────────────────────────────────────────────────

  const hoursKnown = businessHours !== null;
  const scheduleKnown = busySlots.status === 'ready' && scheduled.status === 'ready';
  const scheduleError =
    busySlots.status === 'error'
      ? `blocked time (${busySlots.message})`
      : scheduled.status === 'error'
        ? `booked visits (${scheduled.message})`
        : null;

  const blockedByDate = useMemo(
    () => (busySlots.status === 'ready' ? groupBlockedSlotsByDate(busySlots.data) : new Map()),
    [busySlots],
  );
  const sessionsByDay = useMemo(
    () => (scheduled.status === 'ready' ? sessionsByLocalDay(scheduled.data) : new Map()),
    [scheduled],
  );

  const availabilityFor = useCallback(
    (iso: string): DayAvailability => ({
      iso,
      past: iso < todayIso,
      hours: businessHours === null ? { kind: 'closed' } : businessHoursForDay(businessHours, iso),
      hoursKnown,
      blocked: scheduleKnown ? blockedWindows(blockedByDate.get(iso) ?? []) : [],
      sessionCount: scheduleKnown ? (sessionsByDay.get(iso)?.length ?? 0) : 0,
      scheduleKnown,
    }),
    [todayIso, businessHours, hoursKnown, scheduleKnown, blockedByDate, sessionsByDay],
  );

  const selectedIsos = useMemo(
    () => (mode === 'weekly' ? (startDateIso === '' ? [] : [startDateIso]) : sortedDays(days)),
    [mode, days, startDateIso],
  );

  const warnings = useMemo(
    () => selectionWarnings(selectedIsos.map(availabilityFor), time),
    [selectedIsos, availabilityFor, time],
  );

  /**
   * The device zone as the browser reports it, and whether the business setting
   * disagrees. `resolvedOptions()` is available in every browser this admin
   * supports; a runtime that somehow returns nothing simply yields no note,
   * rather than a note naming an empty zone.
   */
  const deviceZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    } catch {
      return '';
    }
  }, []);
  const zoneMismatch =
    businessTimeZone !== '' && deviceZone !== '' && businessTimeZone !== deviceZone;

  // ── validation ────────────────────────────────────────────────────────────

  const startTimesMs = useMemo(() => {
    return mode === 'weekly'
      ? expandWeekly({ startDateIso, time, weeklyDays, weeks })
      : visitMsFromDays(days, time);
  }, [mode, days, startDateIso, time, weeklyDays, weeks]);

  const kinfolkError = touched && kinfolkId === '' ? 'Pick a household.' : null;
  const serviceError =
    touched && serviceName.trim() === ''
      ? hasServiceChips
        ? 'Pick a service.'
        : 'A service name is required.'
      : null;
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

  function toggleDay(iso: string) {
    setTouched(true);
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
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
          {hasServiceChips ? (
            <>
              <span className="new-booking__label" id="new-booking-service-label">
                Service
              </span>
              <div
                className="new-booking__services"
                role="group"
                aria-labelledby="new-booking-service-label"
              >
                {serviceOptions.map((option) => (
                  <button
                    key={option.name}
                    type="button"
                    className={
                      serviceName === option.name
                        ? 'new-booking__service new-booking__service--active'
                        : 'new-booking__service'
                    }
                    aria-pressed={serviceName === option.name}
                    onClick={() => {
                      setTouched(true);
                      setServiceName(option.name);
                    }}
                  >
                    {serviceChipLabel(option)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
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
              {serviceOptions !== null && servicesError === null && (
                <span className="new-booking__hint">
                  No KinCare types yet. Add them in Settings, under KinCare types, and they show up
                  here.
                </span>
              )}
            </>
          )}
          {servicesError !== null && (
            <span className="new-booking__error" role="alert">
              {servicesError}
            </span>
          )}
          {serviceError !== null && (
            <span className="new-booking__error" role="alert">
              {serviceError}
            </span>
          )}
        </div>

        <div className="new-booking__field">
          <span className="new-booking__label">Dates</span>
          <ModeTabs mode={mode} onPick={setMode} />

          {(hoursError !== null || scheduleError !== null) && (
            <Banner tone="warning" title="Availability unknown" className="new-booking__banner">
              {hoursError !== null && (
                <span>Business hours couldn&rsquo;t be read ({hoursError}). </span>
              )}
              {scheduleError !== null && <span>Couldn&rsquo;t read {scheduleError}. </span>}
              Pick your dates anyway. Nothing below is checked against the schedule.
            </Banner>
          )}

          {zoneMismatch && (
            <span className="new-booking__hint">
              Visits are saved in your device&rsquo;s zone ({deviceZone}). Settings has this business
              in {businessTimeZone}.
            </span>
          )}

          <label className="new-booking__subfield new-booking__time">
            <span className="new-booking__sublabel">Start time (every visit)</span>
            <input
              type="time"
              className="new-booking__input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Start time"
            />
          </label>

          {mode === 'dates' ? (
            <div className="new-booking__dates">
              <AuntieDatePicker
                selected={days}
                onToggle={toggleDay}
                todayIso={todayIso}
                availabilityFor={availabilityFor}
                mode="multi"
                label="Visit dates"
              />
              <div className="new-booking__chips" role="group" aria-label="Selected dates">
                {selectedIsos.length === 0 ? (
                  <span className="new-booking__hint">No dates picked yet.</span>
                ) : (
                  selectedIsos.map((iso) => (
                    <button
                      key={iso}
                      type="button"
                      className="new-booking__chip"
                      onClick={() => toggleDay(iso)}
                      aria-label={`Remove ${shortDayLabel(iso)}`}
                    >
                      {shortDayLabel(iso)} <span aria-hidden="true">&times;</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="new-booking__weekly">
              <span className="new-booking__sublabel" id="new-booking-weekly-start">
                Start on
              </span>
              <AuntieDatePicker
                selected={startDateIso === '' ? EMPTY_SELECTION : new Set([startDateIso])}
                onToggle={(iso) => {
                  setTouched(true);
                  setStartDateIso((prev) => (prev === iso ? '' : iso));
                }}
                todayIso={todayIso}
                availabilityFor={availabilityFor}
                mode="single"
                label="Start on"
              />
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
              <WeeksChips weeks={weeks} onPick={setWeeks} />
            </div>
          )}

          {/*
            One live region for the whole date field. It says what is selected,
            not merely how many, because "3 visits" is not enough to catch a
            misplaced click with the keyboard alone. Polite, so it never
            interrupts the operator mid-navigation.
          */}
          <span className="new-booking__preview" role="status">
            {selectionSummary(selectedIsos, mode, visitCount)}
          </span>

          {visitsError !== null && (
            <span className="new-booking__error" role="alert">
              {visitsError}
            </span>
          )}

          {warnings.length > 0 && (
            <Banner tone="warning" title="Check these dates" className="new-booking__banner">
              <ul className="new-booking__warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              You can still send the request.
            </Banner>
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

/** Stable empty set, so the weekly picker does not get a new `selected` identity per render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** What the live region says. Names the days, then the count the button will create. */
function selectionSummary(isos: string[], mode: BookingMode, visitCount: number): string {
  if (isos.length === 0) {
    return mode === 'weekly' ? 'Pick a start date.' : 'No dates picked yet.';
  }
  const listed = isos.map(shortDayLabel).join(', ');
  const prefix = mode === 'weekly' ? `Starting ${listed}.` : `Selected ${listed}.`;
  if (visitCount === 0) {
    return mode === 'weekly' ? `${prefix} Pick at least one weekday.` : prefix;
  }
  return `${prefix} ${visitCount} visit${visitCount === 1 ? '' : 's'} will be requested.`;
}

const MODES: readonly { key: BookingMode; label: string }[] = [
  { key: 'dates', label: 'Specific dates' },
  { key: 'weekly', label: 'Weekly' },
];

/**
 * The Specific-dates / Weekly tablist. Uses the shared `useRovingTabs` rather
 * than a hand-rolled key handler, exactly as the twelve other chip rows in this
 * admin do: it is a one-dimensional tablist over a fixed set of tabs, which is
 * precisely what that helper is for. The CALENDAR is the case that needs its
 * own handling, and `AuntieDatePicker` explains why there.
 */
function ModeTabs({ mode, onPick }: { mode: BookingMode; onPick: (m: BookingMode) => void }) {
  const activeIndex = MODES.findIndex((m) => m.key === mode);
  const { getTabProps } = useRovingTabs({ count: MODES.length, activeIndex });
  return (
    <div className="new-booking__mode" role="tablist" aria-label="Date entry mode">
      {MODES.map((m, i) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={mode === m.key}
          className={mode === m.key ? 'new-booking__mode-tab new-booking__mode-tab--active' : 'new-booking__mode-tab'}
          onClick={() => onPick(m.key)}
          {...getTabProps(i)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Weeks 1 to 12 as a chip row, per the archive, replacing a `type="number"`
 * spinner whose min/max the operator could only discover by overshooting it.
 * Another genuine `useRovingTabs` case.
 */
function WeeksChips({ weeks, onPick }: { weeks: number; onPick: (w: number) => void }) {
  const activeIndex = WEEKS_OPTIONS.indexOf(weeks);
  const { getTabProps } = useRovingTabs({ count: WEEKS_OPTIONS.length, activeIndex });
  return (
    <div className="new-booking__weeks" role="tablist" aria-label="For how many weeks">
      {WEEKS_OPTIONS.map((w, i) => (
        <button
          key={w}
          type="button"
          role="tab"
          aria-selected={weeks === w}
          className={weeks === w ? 'new-booking__week new-booking__week--active' : 'new-booking__week'}
          onClick={() => onPick(w)}
          {...getTabProps(i)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
