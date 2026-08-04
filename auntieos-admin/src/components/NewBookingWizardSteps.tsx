import { useMemo, useState } from 'react';
import { KIN_ROSTER_MAX, type Kin } from '../api/directory';
import {
  type ServiceOption,
  WEEKDAY_LABELS,
  WEEKS_OPTIONS,
  serviceChipLabel,
  type BookingMode,
} from '../lib/newBooking';
import {
  WIZARD_STEPS,
  addDayVisit,
  addTemplateSlot,
  applyServiceToTemplate,
  clearDays,
  formatCents,
  plannedDayCount,
  plannedServiceNames,
  removeDayVisit,
  removeTemplateSlot,
  updateDayVisit,
  updateTemplateSlot,
  wizardTotal,
  buildVisits,
  type StepKey,
  type VisitSlot,
  type WizardState,
} from '../lib/bookingWizard';
import { shortDayLabel } from '../lib/bookingAvailability';
import { useRovingTabs } from '../lib/useRovingTabs';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';

/**
 * The five step bodies of the New Booking wizard, split out of
 * `NewBookingDialog.tsx` so that file stays the one place the DATA reads, the
 * availability logic and the submit live. Each export here is presentational
 * plus its own local UI state (a search box, an expanded row); the wizard's own
 * state is owned by the dialog and threaded through `state`/`onChange`.
 *
 * The step order, the labels, and what each step contains come from the three
 * PNGs in `ui-ideas/BookingWorkFlow/`. Where the mock shows a value it is
 * sample data, never a literal: the services, prices, and totals below are all
 * read from `business_settings.serviceRates`.
 */

// ── stepper ──────────────────────────────────────────────────────────────────

export interface StepperProps {
  current: StepKey;
  /** Steps the operator has satisfied, so a completed circle can be revisited. */
  reachable: readonly StepKey[];
  onJump: (step: StepKey) => void;
}

/**
 * The numbered rail across the top of every PNG. A completed step is a real
 * control (the mock draws it as a filled tick, and an operator who wants to
 * change the household should not have to press Back four times); a step not
 * yet reached is static text, not a disabled button, so there is no dead
 * control to tab through.
 */
export function Stepper({ current, reachable, onJump }: StepperProps) {
  return (
    <ol className="nbw__steps" aria-label="Booking steps">
      {WIZARD_STEPS.map((step, index) => {
        const isCurrent = step.key === current;
        const canJump = !isCurrent && reachable.includes(step.key);
        const done = reachable.includes(step.key) && !isCurrent;
        return (
          <li
            key={step.key}
            className={
              isCurrent ? 'nbw__step nbw__step--current' : done ? 'nbw__step nbw__step--done' : 'nbw__step'
            }
          >
            {canJump ? (
              <button type="button" className="nbw__step-button" onClick={() => onJump(step.key)}>
                <span className="nbw__step-num" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="nbw__step-label">{step.label}</span>
              </button>
            ) : (
              <span className="nbw__step-button nbw__step-button--static">
                <span className="nbw__step-num" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="nbw__step-label" aria-current={isCurrent ? 'step' : undefined}>
                  {step.label}
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ── step 1: kinfolk and kin ──────────────────────────────────────────────────

/** One Kin's display name, never blank. */
export function kinLabel(k: Kin): string {
  const name = (k.name ?? '').trim();
  return name === '' ? 'Unnamed Kin' : name;
}

/**
 * The household's whole roster on one line, so "All Kin in this home" names the
 * animals instead of asserting a coverage the operator cannot check.
 */
export function kinRosterLabel(kin: readonly Kin[]): string {
  return kin.map(kinLabel).join(', ');
}

export interface ClientStepProps {
  state: WizardState;
  onChange: (next: WizardState) => void;
  households: { id: string; label: string }[];
  householdsLoading: boolean;
  householdsError: string | null;
  /** Active Kin for the chosen household. Null while the roster is still loading. */
  kin: Kin[] | null;
  kinError: string | null;
  /**
   * The roster read came back AT its cap, so there may be Kin it did not return.
   * Said out loud rather than swallowed: a truncated read that renders as a
   * short list, or worse as "no Kin on this household yet", is the silent-cap
   * failure this repo treats as a bug wherever it appears.
   */
  kinTruncated: boolean;
}

export function ClientStep({
  state,
  onChange,
  households,
  householdsLoading,
  householdsError,
  kin,
  kinError,
  kinTruncated,
}: ClientStepProps) {
  return (
    <div className="nbw__body">
      <h3 className="nbw__title">Select Kinfolk &amp; Kin</h3>
      <p className="nbw__sub">Whose household is this booking for.</p>

      <div className="new-booking__field">
        <label className="new-booking__label" htmlFor="new-booking-household">
          Household
        </label>
        <select
          id="new-booking-household"
          className="new-booking__input"
          value={state.kinfolkId}
          onChange={(e) =>
            // Changing household clears the Kin AND returns to the R1 default:
            // the previous household's Kin are not this one's, and a narrowing
            // decision made about one home says nothing about another.
            onChange({ ...state, kinfolkId: e.target.value, allKinMode: true, kinIds: [] })
          }
        >
          <option value="">{householdsLoading ? 'Loading households…' : 'Choose a household…'}</option>
          {households.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
            </option>
          ))}
        </select>
        {householdsError !== null && (
          <span className="new-booking__error" role="alert">
            Households failed to load: {householdsError}
          </span>
        )}
      </div>

      {state.kinfolkId !== '' && (
        <div className="new-booking__field">
          <span className="new-booking__label" id="new-booking-kin-label">
            Kin covered
          </span>
          {kinError !== null ? (
            <span className="new-booking__error" role="alert">
              The Kin roster could not be read ({kinError}). The booking still covers the whole
              household.
            </span>
          ) : kin === null ? (
            <span className="new-booking__hint">Loading this household&rsquo;s Kin…</span>
          ) : kin.length === 0 ? (
            <span className="new-booking__hint">
              No Kin on this household yet. The booking covers the household.
            </span>
          ) : (
            <div role="group" aria-labelledby="new-booking-kin-label">
              {/* R1, the operator's ruling: KinCare covers EVERY Kin in the home.
                  "I wouldn't go into a home and care for one kin while ignoring
                  the other." So all of them is the default and takes no click;
                  narrowing to a subset is the thing you have to ask for. Same
                  shape the Kinfolk portal's wizard has always had
                  (mytribe/web/src/screens/BookingWizard.tsx Step1KinSelect). */}
              <div className="nbw__allkin">
                <div className="nbw__allkin-title">All Kin in this home</div>
                <span className="nbw__allkin-names">{kinRosterLabel(kin)}</span>
              </div>

              <GhostButton
                label={state.allKinMode ? 'Choose specific Kin' : 'Cover all Kin instead'}
                onClick={() =>
                  // Leaving specific-Kin mode drops the partial pick rather than
                  // parking it: a selection that is not on the wire must not sit
                  // in the UI looking like it is.
                  onChange({ ...state, allKinMode: !state.allKinMode, kinIds: [] })
                }
                className="nbw__allkin-toggle"
              />

              {!state.allKinMode && (
                <div className="nbw__kin">
                  {kin.map((k) => {
                    const picked = state.kinIds.includes(k._id);
                    return (
                      <label
                        key={k._id}
                        className={picked ? 'nbw__kin-chip nbw__kin-chip--on' : 'nbw__kin-chip'}
                      >
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={() =>
                            onChange({
                              ...state,
                              kinIds: picked
                                ? state.kinIds.filter((id) => id !== k._id)
                                : [...state.kinIds, k._id],
                            })
                          }
                        />
                        <span>{kinLabel(k)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {kinTruncated && (
            <Banner tone="warning" title="More Kin than fit">
              This household&rsquo;s roster hit the {KIN_ROSTER_MAX}-row read limit, so Kin may be
              missing above and &ldquo;All Kin in this home&rdquo; can only cover the ones it read.
              Check the household&rsquo;s Kin list before booking.
            </Banner>
          )}
          {!state.allKinMode && kin !== null && kin.length > 0 && state.kinIds.length === 0 && (
            <span className="new-booking__hint">
              No Kin picked yet. Pick at least one, or go back to covering all of them.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── step 2: service ──────────────────────────────────────────────────────────

export interface ServiceStepProps {
  state: WizardState;
  onChange: (next: WizardState) => void;
  /** Null while the settings read is in flight. */
  options: ServiceOption[] | null;
  optionsError: string | null;
}

/**
 * The mock groups this list under a heading ("Held Down at Home") and offers a
 * search box. `business_settings.serviceRates` is a FLAT map of name to rate
 * with no category field anywhere on it, so there is one group here, headed by
 * what these actually are, rather than an invented taxonomy that would put
 * every service under a category the operator never chose. The search box is
 * real and does what the mock's does.
 */
export function ServiceStep({ state, onChange, options, optionsError }: ServiceStepProps) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    if (options === null) return [];
    const q = query.trim().toLowerCase();
    return q === '' ? options : options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="nbw__body">
      <h3 className="nbw__title">Select a Service</h3>
      <p className="nbw__sub">Choose the service this booking is for.</p>

      {optionsError !== null && (
        <span className="new-booking__error" role="alert">
          {optionsError}
        </span>
      )}

      {options !== null && options.length === 0 ? (
        <div className="new-booking__field">
          <label className="new-booking__label" htmlFor="new-booking-service">
            Service
          </label>
          <input
            id="new-booking-service"
            type="text"
            className="new-booking__input"
            value={state.serviceName}
            onChange={(e) =>
              onChange(
                applyServiceToTemplate(state, {
                  name: e.target.value,
                  rate: '',
                  durationMinutes: null,
                }),
              )
            }
            placeholder="e.g. Dog Walk"
          />
          <span className="new-booking__hint">
            No KinCare types yet. Add them in Settings, under KinCare types, and they show up here
            with their prices.
          </span>
        </div>
      ) : (
        <>
          <label className="new-booking__field">
            <span className="new-booking__label">Search services</span>
            <input
              type="search"
              className="new-booking__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search services by name"
            />
          </label>

          <div className="nbw__services" role="group" aria-label="Services">
            {options === null ? (
              <span className="new-booking__hint">Loading your KinCare types…</span>
            ) : visible.length === 0 ? (
              <span className="new-booking__hint">Nothing matches &ldquo;{query.trim()}&rdquo;.</span>
            ) : (
              visible.map((option) => (
                <button
                  key={option.name}
                  type="button"
                  className={
                    state.serviceName === option.name
                      ? 'nbw__service nbw__service--on'
                      : 'nbw__service'
                  }
                  aria-pressed={state.serviceName === option.name}
                  onClick={() => onChange(applyServiceToTemplate(state, option))}
                >
                  <span className="nbw__service-name">{option.name}</span>
                  <span className="nbw__service-price">
                    {option.rate === '' ? 'No price set' : `$${option.rate}`}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── step 3: dates ────────────────────────────────────────────────────────────

const MODES: readonly { key: BookingMode; title: string; blurb: string }[] = [
  { key: 'dates', title: 'Individual Dates', blurb: 'One-time bookings on specific dates' },
  { key: 'weekly', title: 'Repeating Schedule', blurb: 'Recurring visits on a weekly pattern' },
];

export function ModeCards({ mode, onPick }: { mode: BookingMode; onPick: (m: BookingMode) => void }) {
  const activeIndex = MODES.findIndex((m) => m.key === mode);
  const { getTabProps } = useRovingTabs({ count: MODES.length, activeIndex });
  return (
    <div className="nbw__modes" role="tablist" aria-label="Date entry mode">
      {MODES.map((m, i) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={mode === m.key}
          className={mode === m.key ? 'nbw__mode nbw__mode--on' : 'nbw__mode'}
          onClick={() => onPick(m.key)}
          {...getTabProps(i)}
        >
          <span className="nbw__mode-title">{m.title}</span>
          <span className="nbw__mode-blurb">{m.blurb}</span>
        </button>
      ))}
    </div>
  );
}

export interface VisitRowsProps {
  visits: readonly VisitSlot[];
  options: ServiceOption[] | null;
  /** Label prefix for the accessible names, e.g. "Visit 1" or "Aug 3 visit 1". */
  scope: string;
  onPatch: (slotId: string, patch: Partial<Omit<VisitSlot, 'id'>>) => void;
  onAdd: () => void;
  onRemove: (slotId: string) => void;
}

/**
 * The mock's "VISIT 1" card: a time, a place, and a service, with "Add another
 * visit" underneath. Used twice, for the Daily Visit Schedule template and for
 * each picked day's own copy, because they are the same three fields and two
 * near-identical blocks is how the two drift apart.
 */
export function VisitRows({ visits, options, scope, onPatch, onAdd, onRemove }: VisitRowsProps) {
  return (
    <div className="nbw__visits">
      {visits.map((slot, index) => {
        const name = `${scope} visit ${index + 1}`;
        return (
          <div key={slot.id} className="nbw__visit">
            <span className="nbw__visit-num">VISIT {index + 1}</span>
            <div className="nbw__visit-fields">
              <label className="nbw__visit-field">
                <span className="new-booking__sublabel">Time</span>
                <input
                  type="time"
                  className="new-booking__input"
                  value={slot.time}
                  onChange={(e) => onPatch(slot.id, { time: e.target.value })}
                  aria-label={`${name} time`}
                />
              </label>
              <label className="nbw__visit-field">
                <span className="new-booking__sublabel">Service</span>
                {options !== null && options.length > 0 ? (
                  <select
                    className="new-booking__input"
                    value={slot.serviceName}
                    onChange={(e) => onPatch(slot.id, { serviceName: e.target.value })}
                    aria-label={`${name} service`}
                  >
                    <option value="">Choose a service…</option>
                    {/* A service the operator has since removed from Settings
                        still names itself here rather than silently reverting
                        this visit to blank. */}
                    {!options.some((o) => o.name === slot.serviceName) && slot.serviceName !== '' && (
                      <option value={slot.serviceName}>{slot.serviceName} (not on the rate card)</option>
                    )}
                    {options.map((o) => (
                      <option key={o.name} value={o.name}>
                        {serviceChipLabel(o)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="new-booking__input"
                    value={slot.serviceName}
                    onChange={(e) => onPatch(slot.id, { serviceName: e.target.value })}
                    aria-label={`${name} service`}
                  />
                )}
              </label>
            </div>
            {visits.length > 1 && (
              <GhostButton label="Remove" onClick={() => onRemove(slot.id)} />
            )}
          </div>
        );
      })}
      <GhostButton label="Add another visit" onClick={onAdd} />
    </div>
  );
}

export interface DatesStepProps {
  state: WizardState;
  onChange: (next: WizardState) => void;
  options: ServiceOption[] | null;
  /** The calendar, rendered by the dialog so the availability reads stay there. */
  calendar: React.ReactNode;
}

export function DatesStep({ state, onChange, options, calendar }: DatesStepProps) {
  const [openDay, setOpenDay] = useState<string | null>(null);
  const visitCount = buildVisits(state).length;

  return (
    <div className="nbw__body">
      <ModeCards mode={state.mode} onPick={(mode) => onChange({ ...state, mode })} />

      <h3 className="nbw__title">
        {state.mode === 'weekly' ? 'Set the repeating schedule' : 'Choose Individual Dates'}
      </h3>
      <p className="nbw__sub">
        {state.mode === 'weekly'
          ? 'Pick a start date and the weekdays this repeats on.'
          : 'Select the one or more dates this household needs the service.'}
      </p>

      {calendar}

      {state.mode === 'weekly' && (
        <>
          <span className="new-booking__sublabel" id="nbw-weekdays">
            Repeat on
          </span>
          <div className="new-booking__weekdays" role="group" aria-labelledby="nbw-weekdays">
            {WEEKDAY_LABELS.map((label, day) => (
              <label key={day} className="new-booking__weekday">
                <input
                  type="checkbox"
                  checked={state.weeklyDays.includes(day)}
                  onChange={() =>
                    onChange({
                      ...state,
                      weeklyDays: state.weeklyDays.includes(day)
                        ? state.weeklyDays.filter((d) => d !== day)
                        : [...state.weeklyDays, day].sort((a, b) => a - b),
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <WeeksChips weeks={state.weeks} onPick={(weeks) => onChange({ ...state, weeks })} />
        </>
      )}

      <section className="nbw__panel">
        <h4 className="nbw__panel-title">Daily Visit Schedule</h4>
        <p className="nbw__sub">
          {state.mode === 'weekly'
            ? 'Every repeat gets these visits.'
            : 'Create multiple visits per day. Changes apply only to dates you pick after this.'}
        </p>
        <VisitRows
          visits={state.template}
          options={options}
          scope="Daily"
          onPatch={(id, patch) => onChange(updateTemplateSlot(state, id, patch))}
          onAdd={() => onChange(addTemplateSlot(state))}
          onRemove={(id) => onChange(removeTemplateSlot(state, id))}
        />
      </section>

      {state.mode === 'dates' && (
        <section className="nbw__panel">
          <div className="nbw__panel-head">
            <h4 className="nbw__panel-title">Selected Dates</h4>
            {state.plans.length > 0 && (
              <GhostButton label="Clear all dates" onClick={() => onChange(clearDays(state))} />
            )}
          </div>
          {state.plans.length === 0 ? (
            <p className="new-booking__hint">No dates picked yet.</p>
          ) : (
            <ul className="nbw__daylist">
              {state.plans.map((plan) => {
                const open = openDay === plan.dayIso;
                return (
                  <li key={plan.dayIso} className="nbw__day">
                    <button
                      type="button"
                      className="nbw__day-head"
                      onClick={() => setOpenDay(open ? null : plan.dayIso)}
                      aria-expanded={open}
                    >
                      <span className="nbw__day-date">{shortDayLabel(plan.dayIso)}</span>
                      <span className="nbw__day-summary">
                        {plan.visits.length} visit{plan.visits.length === 1 ? '' : 's'}
                        {plan.visits.length > 0 && `, from ${plan.visits[0]?.time ?? ''}`}
                      </span>
                      <span aria-hidden="true">{open ? '▴' : '▾'}</span>
                    </button>
                    {open && (
                      <VisitRows
                        visits={plan.visits}
                        options={options}
                        scope={shortDayLabel(plan.dayIso)}
                        onPatch={(id, patch) => onChange(updateDayVisit(state, plan.dayIso, id, patch))}
                        onAdd={() => onChange(addDayVisit(state, plan.dayIso))}
                        onRemove={(id) => onChange(removeDayVisit(state, plan.dayIso, id))}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="nbw__total-row">
            <span>Total bookings</span>
            <strong>{visitCount}</strong>
          </p>
        </section>
      )}

      {/*
        One live region for the whole step. It says WHAT is selected, not merely
        how many, because "3 visits" is not enough to catch a misplaced click
        with the keyboard alone. Carried over from the single-page dialog, which
        is where that reasoning was first written down. Polite, so it never
        interrupts the operator mid-navigation.
      */}
      <span className="new-booking__preview" role="status">
        {planSummary(state, visitCount)}
      </span>
    </div>
  );
}

/** What the live region says: the days, then the number of visits they add up to. */
export function planSummary(state: WizardState, visitCount: number): string {
  if (state.mode === 'weekly') {
    if (state.startDateIso === '') return 'Pick a start date.';
    const prefix = `Starting ${shortDayLabel(state.startDateIso)}.`;
    if (visitCount === 0) return `${prefix} Pick at least one weekday.`;
    return `${prefix} ${visitCount} visit${visitCount === 1 ? '' : 's'} will be requested.`;
  }
  if (state.plans.length === 0) return 'No dates picked yet.';
  const listed = state.plans.map((p) => shortDayLabel(p.dayIso)).join(', ');
  return `Selected ${listed}. ${visitCount} visit${visitCount === 1 ? '' : 's'} will be requested.`;
}

/** Weeks 1 to 12 as a chip row, unchanged from the single-page dialog. */
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

// ── step 4: invoice options ──────────────────────────────────────────────────

export function InvoiceStep({
  state,
  onChange,
}: {
  state: WizardState;
  onChange: (next: WizardState) => void;
}) {
  return (
    <div className="nbw__body">
      <h3 className="nbw__title">Invoice Options</h3>
      <p className="nbw__sub">How this booking should be billed once the visits are done.</p>

      <div className="nbw__choice nbw__choice--on">
        <span className="nbw__choice-title">New invoice</span>
        <span className="nbw__choice-blurb">
          {/*
            The mock says "A separate invoice will be created". Nothing in this
            system raises an invoice from a booking on its own: invoices are
            created in Invoices and the completed visits are attached to one.
            Saying otherwise would have the operator waiting for a document that
            never arrives, so the copy says what is actually true and what the
            preference is for.
          */}
          These visits are billed on their own invoice, separate from anything else this household
          owes. The invoice is raised from Invoices once the visits are complete; this records that
          it should be a new one.
        </span>
      </div>

      <p className="new-booking__hint">
        This is the only billing arrangement the system records today. Choosing where a booking lands
        on an existing invoice is done from Invoices, by attaching the completed visits.
      </p>

      {/* The state is single-valued, so this exists to keep the step honest
          rather than to offer a choice: the value is displayed, not implied. */}
      <input type="hidden" value={state.billing.mode} readOnly onChange={() => onChange(state)} />
    </div>
  );
}

// ── step 5: review ───────────────────────────────────────────────────────────

export interface ReviewStepProps {
  state: WizardState;
  onChange: (next: WizardState) => void;
  options: ServiceOption[];
  householdLabel: string;
  kinLabels: string[];
  onEditStep: (step: StepKey) => void;
}

export function ReviewStep({
  state,
  onChange,
  options,
  householdLabel,
  kinLabels,
  onEditStep,
}: ReviewStepProps) {
  const visits = buildVisits(state);
  const total = wizardTotal(state, options);
  const days = plannedDayCount(state);
  // Read off the BUILT visits, never off `state.serviceName`. Step 2 sets a
  // DEFAULT: it rewrites the template, and days already snapshotted keep the
  // service they were picked with (the "changes apply only to dates you pick
  // after this" rule the Dates step states out loud). So an operator who books
  // Tuesday as a Dog Walk, jumps back and picks Grooming submits one Dog Walk,
  // and a header reading `state.serviceName` would say Grooming. This renders
  // what will be sent, per visit. Android's review row does the same.
  const services = plannedServiceNames(state);
  const firstMs = visits[0]?.startTimeMs;
  const lastMs = visits[visits.length - 1]?.startTimeMs;

  return (
    <div className="nbw__body">
      <h3 className="nbw__title">Review &amp; Confirm</h3>
      <p className="nbw__sub">Check the details below before confirming.</p>

      <section className="nbw__panel">
        <div className="nbw__review-row">
          <div>
            <span className="nbw__review-head">{householdLabel}</span>
            {/* R1: names the Kin either way. "The whole household" used to stand
                in for an EMPTY kinIds, which is exactly the emptiness that then
                got persisted and rendered as "Not set" downstream. */}
            <span className="nbw__review-sub">
              {kinLabels.length === 0
                ? 'No Kin on file for this household'
                : state.allKinMode
                  ? `All Kin in this home: ${kinLabels.join(', ')}`
                  : kinLabels.join(', ')}
            </span>
          </div>
          <GhostButton label="Edit household" onClick={() => onEditStep('client')} />
        </div>

        <div className="nbw__review-row">
          <div>
            <span className="nbw__review-head">
              {services.length === 0 ? 'No service on these visits' : services.join(', ')}
            </span>
            <span className="nbw__review-sub">
              {state.mode === 'weekly' ? 'Repeating weekly' : 'Individual dates'}
              {services.length > 1 && `, ${services.length} different services`}
            </span>
          </div>
          <GhostButton label="Edit service" onClick={() => onEditStep('service')} />
        </div>

        <div className="nbw__review-row">
          <div>
            <span className="nbw__review-head">
              {visits.length} visit{visits.length === 1 ? '' : 's'} across {days} day
              {days === 1 ? '' : 's'}
            </span>
            <span className="nbw__review-sub">
              {firstMs === undefined
                ? 'No dates picked'
                : `${localDayLabel(firstMs)} to ${localDayLabel(lastMs ?? firstMs)}`}
            </span>
          </div>
          <GhostButton label="Edit dates" onClick={() => onEditStep('dates')} />
        </div>
      </section>

      <section className="nbw__panel">
        <p className="nbw__total-row">
          <span className="nbw__review-head">Total</span>
          <strong className="nbw__total">{formatCents(total.cents)}</strong>
        </p>
        {total.unpriced.length > 0 && (
          // Never folded into the number. A total that silently counts an
          // unpriced service as zero is a figure the operator quotes to a
          // household and then has to walk back.
          <p className="nbw__warn" role="alert">
            {total.unpriced.join(', ')} {total.unpriced.length === 1 ? 'has' : 'have'} no price on the
            rate card, so {total.unpriced.length === 1 ? 'it is' : 'they are'} not in this total. Set{' '}
            {total.unpriced.length === 1 ? 'it' : 'them'} in Settings, under KinCare types.
          </p>
        )}
        <p className="new-booking__hint">
          Surcharges and taxes are applied on the invoice, after the visits are done.
        </p>
      </section>

      <section className="nbw__panel">
        <div className="nbw__review-row">
          <div>
            <span className="nbw__review-head">Billing</span>
            <span className="nbw__review-sub">New invoice, raised once the visits are complete.</span>
          </div>
          <GhostButton label="Edit billing" onClick={() => onEditStep('invoice')} />
        </div>
      </section>

      <section className="nbw__panel">
        <h4 className="nbw__panel-title">Communication</h4>
        <label className="nbw__toggle">
          <input
            type="checkbox"
            checked={state.communication.emailConfirmation}
            onChange={(e) =>
              onChange({
                ...state,
                communication: { ...state.communication, emailConfirmation: e.target.checked },
              })
            }
          />
          <span>
            Email confirmation
            <span className="nbw__toggle-blurb">
              {state.communication.emailConfirmation
                ? 'The household gets a confirmation email.'
                : 'No confirmation email is sent.'}
            </span>
          </span>
        </label>
        <label className="nbw__toggle">
          <input
            type="checkbox"
            checked={state.communication.timeVisibility}
            onChange={(e) =>
              onChange({
                ...state,
                communication: { ...state.communication, timeVisibility: e.target.checked },
              })
            }
          />
          <span>
            Exact times
            <span className="nbw__toggle-blurb">
              {state.communication.timeVisibility
                ? 'The household sees the exact start time of each visit.'
                : 'The household sees a time window rather than an exact start time.'}
            </span>
          </span>
        </label>
      </section>

      <label className="new-booking__field">
        <span className="new-booking__label">Private notes (optional)</span>
        <textarea
          className="new-booking__input new-booking__textarea"
          rows={3}
          maxLength={1000}
          value={state.notes}
          onChange={(e) => onChange({ ...state, notes: e.target.value })}
          placeholder="Anything the Auntie should know"
        />
        <span className="new-booking__hint">
          Kept on the booking request for whoever runs these visits.
        </span>
      </label>
    </div>
  );
}

/** "Apr 6, 2026" from an epoch ms, in the operator's LOCAL zone (AO-18). */
function localDayLabel(ms: number): string {
  const d = new Date(ms);
  return `${shortDayLabel(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)}, ${d.getFullYear()}`;
}
