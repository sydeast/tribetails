import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createMultiDateBookingRequest,
  type CreateMultiDateBookingResult,
} from '../api/bookingsWrite';
import {
  KINFOLK_QUERY,
  KIN_QUERY,
  SORT_OPTION_DEFAULT,
  activeKinByKinfolk,
  filterSortKinfolk,
  kinfolkDisplayName,
  type Kin,
  type Kinfolk,
} from '../api/directory';
import {
  AVAILABILITY_BUSY_SLOTS_QUERY,
  AVAILABILITY_SESSIONS_QUERY,
  type AvailabilityBusySlot,
  type AvailabilitySession,
} from '../api/availability';
import { getBusinessSettings } from '../api/settings';
import { useCollection } from '../lib/firestore';
import { serviceOptionsFromRates, type ServiceOption } from '../lib/newBooking';
import {
  blockedWindows,
  businessHoursForDay,
  holidayNameForDay,
  selectionWarnings,
  type DayAvailability,
} from '../lib/bookingAvailability';
import { parseClosureEntry, type ClosureEntry } from '../lib/closureRecurrence';
import {
  WIZARD_STEPS,
  buildVisits,
  firstBlockedStep,
  initialWizardState,
  plannedDayIsos,
  selectedDays,
  stepBlocker,
  stepIndex,
  toggleDay,
  type StepKey,
  type WizardState,
} from '../lib/bookingWizard';
import { groupBlockedSlotsByDate, sessionsByLocalDay, localDateIso } from '../lib/scheduleFormat';
import { AuntieDatePicker } from './AuntieDatePicker';
import {
  ClientStep,
  DatesStep,
  InvoiceStep,
  ReviewStep,
  ServiceStep,
  Stepper,
} from './NewBookingWizardSteps';
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
 * The admin "New booking request" surface, as the five-step wizard the
 * operator's PNGs specify (`ui-ideas/BookingWorkFlow/`):
 *
 *   1 Select Kinfolk & Kin   2 Choose Service   3 Schedule Dates
 *   4 Invoice Options        5 Review & Confirm
 *
 * It replaces the single page that shipped for AO-25, which asked for a
 * household, one service, one shared start time and a set of dates, all at
 * once. That form could not express what the mock's third screen is entirely
 * about: a DIFFERENT time, service and place per visit, and more than one visit
 * on the same day. The backend always could (`visits[]` has been per-visit
 * since it was written); only the clients flattened it.
 *
 * WHAT MOVED, and what deliberately did not:
 *  - The step bodies are `NewBookingWizardSteps.tsx`, so this file stays the
 *    one place the data reads, the availability logic and the submit live.
 *  - The wizard's state and every transition are `lib/bookingWizard.ts`, unit
 *    tested without rendering five steps.
 *  - THE AVAILABILITY LOGIC IS UNCHANGED, on purpose. It exceeds the mock (the
 *    PNGs' calendar marks nothing) and losing it in a redesign would be a
 *    regression dressed as a feature. The same three reads feed the same marks,
 *    every one of them still degrades independently with a visible banner, and
 *    a closed or blocked day is still marked and warned about rather than
 *    disabled: the operator is the business and may decide to work a Sunday.
 *    Only the PAST is refused outright.
 *
 * ── WARNINGS ACROSS MANY TIMES ──────────────────────────────────────────────
 *
 * `selectionWarnings` takes ONE time, because the old form had one. A wizard
 * visit carries its own, so this calls it once per distinct time in the plan
 * and de-duplicates. Same function, same rules, no second implementation to
 * drift.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 *
 * Unchanged: everything is the OPERATOR'S DEVICE ZONE (AO-18), and when
 * `business_settings.timeZone` names a different one, the mismatch is disclosed
 * above the calendar rather than silently converted through.
 *
 * Writes via `createMultiDateBookingRequest`, which stores the ENVELOPE model
 * as `envelopeStatus:'requested'`: the request enters the Incoming-requests
 * queue for approval, NOT the flat `kin_care_sessions` the Bookings list shows.
 * The caller's success copy says so.
 */
export function NewBookingDialog({ onClose, onCreated }: NewBookingDialogProps) {
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);
  const allKin = useCollection<Kin>(KIN_QUERY);
  const busySlots = useCollection<AvailabilityBusySlot>(AVAILABILITY_BUSY_SLOTS_QUERY);
  const scheduled = useCollection<AvailabilitySession>(AVAILABILITY_SESSIONS_QUERY);

  const [state, setState] = useState<WizardState>(initialWizardState);
  const [step, setStep] = useState<StepKey>('client');
  /** Set when Next is pressed on a blocked step, so the reason is shown then and not before. */
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The operator's KinCare types. `null` while the one-shot settings read is in
  // flight; `[]` both for a never-configured install and for a failed read, so
  // either way the Service step falls back to a text input and a fresh account
  // can still file a request. A failure also surfaces its own message rather
  // than passing as "you have no services".
  const [serviceOptions, setServiceOptions] = useState<ServiceOption[] | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  // The SAME one-shot read also carries businessHours and timeZone. Held apart
  // from the services state because the two degrade differently: no services is
  // a legitimate fresh install, no hours is only ever "we could not tell".
  const [businessHours, setBusinessHours] = useState<Record<string, string> | null>(null);
  const [businessTimeZone, setBusinessTimeZone] = useState('');
  const [hoursError, setHoursError] = useState<string | null>(null);
  // C1: decoded `companyHolidays`, the same read as businessHours/timeZone
  // above (same doc, same one-shot fetch) so a closure appears on the
  // calendar without a second round trip. `[]` both while loading and on a
  // failed read -- see `hoursError`/`servicesError` for why a shared failure
  // signal already covers this without a fourth error state.
  const [closureEntries, setClosureEntries] = useState<ClosureEntry[]>([]);

  useEffect(() => {
    let live = true;
    getBusinessSettings()
      .then((s) => {
        if (!live) return;
        setServiceOptions(serviceOptionsFromRates(s.serviceRates));
        setBusinessHours(s.businessHours);
        setBusinessTimeZone((s.timeZone ?? '').trim());
        setClosureEntries((s.companyHolidays ?? []).map(parseClosureEntry));
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

  const todayIso = useMemo(() => localDateIso(new Date()), []);

  const householdOptions = useMemo(() => {
    if (households.status !== 'ready') return [];
    return filterSortKinfolk(households.data, '', SORT_OPTION_DEFAULT).map((kf) => ({
      id: kf._id,
      label: kinfolkDisplayName(kf),
    }));
  }, [households]);

  const kinForHousehold = useMemo(() => {
    if (state.kinfolkId === '' || allKin.status !== 'ready') return null;
    return activeKinByKinfolk(allKin.data).get(state.kinfolkId) ?? [];
  }, [allKin, state.kinfolkId]);

  // ── availability (unchanged from the single-page dialog) ──────────────────

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
      holidayName: holidayNameForDay(closureEntries, iso),
    }),
    [todayIso, businessHours, hoursKnown, scheduleKnown, blockedByDate, sessionsByDay, closureEntries],
  );

  const selectedIsos = useMemo(() => plannedDayIsos(state), [state]);

  /**
   * One warning list over every distinct visit TIME in the plan.
   *
   * `selectionWarnings` still takes a single time (its rules are per day and
   * per time), so it is called once per time and the results de-duplicated. A
   * second implementation that walked the visits itself would be the drift this
   * avoids, and the closed-day line would then appear once per visit.
   */
  const warnings = useMemo(() => {
    const days = selectedIsos.map(availabilityFor);
    const times = [
      ...new Set(
        state.mode === 'weekly'
          ? state.template.map((slot) => slot.time)
          : state.plans.flatMap((plan) => plan.visits.map((v) => v.time)),
      ),
    ];
    return [...new Set(times.flatMap((time) => selectionWarnings(days, time)))];
  }, [selectedIsos, availabilityFor, state]);

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

  // ── step movement ─────────────────────────────────────────────────────────

  const index = stepIndex(step);
  const isLast = index === WIZARD_STEPS.length - 1;
  const blocker = stepBlocker(state, step, Date.now());

  /** Steps already satisfied, so a completed circle in the rail is a live control. */
  const reachable = useMemo(() => {
    const out: StepKey[] = [];
    const now = Date.now();
    for (const s of WIZARD_STEPS) {
      out.push(s.key);
      if (stepBlocker(state, s.key, now) !== null) break;
    }
    return out;
  }, [state]);

  function goNext() {
    if (blocker !== null) {
      setBlockedNotice(blocker);
      return;
    }
    setBlockedNotice(null);
    const next = WIZARD_STEPS[index + 1];
    if (next) setStep(next.key);
  }

  function goBack() {
    setBlockedNotice(null);
    const prev = WIZARD_STEPS[index - 1];
    if (prev) setStep(prev.key);
  }

  function jumpTo(target: StepKey) {
    setBlockedNotice(null);
    setStep(target);
  }

  function update(next: WizardState) {
    setBlockedNotice(null);
    setState(next);
  }

  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  // ── submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (saving) return;
    // Re-checked from the FIRST step, not just this one. Editing the household
    // after picking dates can empty the plan, and a Back-then-forward path would
    // otherwise reach this button with a hole three steps back.
    const blocked = firstBlockedStep(state, Date.now());
    if (blocked !== null) {
      setStep(blocked);
      setBlockedNotice(stepBlocker(state, blocked, Date.now()));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createMultiDateBookingRequest({
        kinfolkId: state.kinfolkId,
        ...(state.kinIds.length > 0 && { kinIds: state.kinIds }),
        ...(state.notes.trim() !== '' && { notes: state.notes.trim() }),
        pattern: state.mode === 'weekly' ? 'weekly' : 'individual',
        ...(state.mode === 'weekly' && { weeklyDays: state.weeklyDays }),
        visits: buildVisits(state),
        billing: state.billing,
        communication: state.communication,
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

  const visitCount = buildVisits(state).length;
  const householdLabel =
    householdOptions.find((h) => h.id === state.kinfolkId)?.label ?? 'This household';
  const kinLabels = (kinForHousehold ?? [])
    .filter((k) => state.kinIds.includes(k._id))
    .map((k) => ((k.name ?? '').trim() === '' ? 'Unnamed Kin' : (k.name ?? '')));

  return (
    <Dialog
      title="New booking request"
      onClose={closeUnlessSaving}
      variant="sheet"
      footer={
        <>
          {index === 0 ? (
            <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          ) : (
            <GhostButton label="Back" onClick={goBack} disabled={saving} />
          )}
          {isLast ? (
            <PrimaryButton
              label={
                saving
                  ? 'Creating…'
                  : visitCount > 0
                    ? `Create ${visitCount} visit${visitCount === 1 ? '' : 's'}`
                    : 'Create booking'
              }
              onClick={() => void handleSubmit()}
              disabled={saving}
              busy={saving}
            />
          ) : (
            // Enabled even when the step is incomplete: pressing it says WHAT is
            // missing, which a greyed-out button never does.
            <PrimaryButton label="Next" onClick={goNext} disabled={saving} />
          )}
        </>
      }
    >
      <Stepper current={step} reachable={reachable} onJump={jumpTo} />

      {error !== null && (
        <Banner tone="error" title="Couldn&rsquo;t create the request" className="new-booking__banner">
          {error}
        </Banner>
      )}

      {blockedNotice !== null && (
        <Banner tone="warning" title="One thing first" className="new-booking__banner">
          {blockedNotice}
        </Banner>
      )}

      <fieldset className="new-booking__fields" disabled={saving}>
        <legend className="new-booking__sr-legend">New booking request</legend>

        {step === 'client' && (
          <ClientStep
            state={state}
            onChange={update}
            households={householdOptions}
            householdsLoading={households.status !== 'ready'}
            householdsError={households.status === 'error' ? households.message : null}
            kin={kinForHousehold}
            kinError={allKin.status === 'error' ? allKin.message : null}
          />
        )}

        {step === 'service' && (
          <ServiceStep
            state={state}
            onChange={update}
            options={serviceOptions}
            optionsError={servicesError}
          />
        )}

        {step === 'dates' && (
          <DatesStep
            state={state}
            onChange={update}
            options={serviceOptions}
            calendar={
              <>
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
                    Visits are saved in your device&rsquo;s zone ({deviceZone}). Settings has this
                    business in {businessTimeZone}.
                  </span>
                )}

                {state.mode === 'dates' ? (
                  <AuntieDatePicker
                    selected={selectedDays(state)}
                    onToggle={(iso) => update(toggleDay(state, iso))}
                    todayIso={todayIso}
                    availabilityFor={availabilityFor}
                    mode="multi"
                    label="Visit dates"
                  />
                ) : (
                  <AuntieDatePicker
                    selected={
                      state.startDateIso === '' ? EMPTY_SELECTION : new Set([state.startDateIso])
                    }
                    onToggle={(iso) =>
                      update({ ...state, startDateIso: state.startDateIso === iso ? '' : iso })
                    }
                    todayIso={todayIso}
                    availabilityFor={availabilityFor}
                    mode="single"
                    label="Start on"
                  />
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
              </>
            }
          />
        )}

        {step === 'invoice' && <InvoiceStep state={state} onChange={update} />}

        {step === 'review' && (
          <ReviewStep
            state={state}
            onChange={update}
            options={serviceOptions ?? []}
            householdLabel={householdLabel}
            kinLabels={kinLabels}
            onEditStep={jumpTo}
          />
        )}
      </fieldset>
    </Dialog>
  );
}

/** Stable empty set, so the weekly picker does not get a new `selected` identity per render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();
