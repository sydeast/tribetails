import { expandWeekly, sortedDays, visitMsFromDays, type BookingMode, type ServiceOption } from './newBooking';
import { localDateIso } from './invoiceFormat';
import { shortDayLabel } from './bookingAvailability';
import type {
  CreateMultiDateBookingRequestArgs,
  CreateMultiDateBookingRequestArgsVisit,
} from '../contracts/bookingContracts.generated';

/**
 * The New Booking wizard's state, kept out of the dialog so every transition
 * and every derivation is unit-testable without rendering five steps.
 *
 * THE SHAPE OF THE FLOW comes from the operator's three PNGs
 * (ui-ideas/BookingWorkFlow/), which are the authority for what this is:
 *
 *   1 Select Kinfolk & Kin    household, then which Kin the visits are for
 *   2 Choose Service         searchable, grouped, priced
 *   3 Schedule Dates         "Individual Dates" or "Repeating Schedule", a
 *                            calendar, and a per-day list of visits with their
 *                            own time, service and place
 *   4 Invoice Options        how this booking is meant to be billed
 *   5 Review & Confirm       totals, billing, communication, private notes
 *
 * WHAT THE THIRD PNG ACTUALLY SHOWS, and what this models because of it: a
 * "Daily Visit Schedule" panel of visit rows (time, place, service) under the
 * caption "Changes will only be applied to new dates you select", beside a
 * "Selected Dates" list where each picked day carries its own copy. So it is a
 * TEMPLATE plus per-day copies, not one shared time. That caption is the whole
 * design: editing the template must not silently rewrite days the operator has
 * already tuned. `selectDay` snapshots the template at the moment a day is
 * picked, and nothing rewrites a snapshot afterwards.
 *
 * WEEKLY MODE HAS NO PER-DAY LIST, and that matches the mock: the Selected
 * Dates panel lives on the Individual Dates tab. A repeating schedule expands
 * to concrete dates that all carry the template, which is what
 * `lib/newBooking.ts#expandWeekly` has always produced.
 *
 * EVERY TIME IS LOCAL (AO-18), by way of `visitMsFromDays`/`expandWeekly`. This
 * file adds no date arithmetic of its own for exactly that reason.
 */

// ── one visit ────────────────────────────────────────────────────────────────

/**
 * One visit within a day: when, and what.
 *
 * NOT where. A visit happens at the household's address, and the household doc
 * is the only place that address lives (operator ruling, 2026-08-04). This
 * interface used to carry a free-text `location` whose input was placeheld
 * "Home address", which made it an address override on the booking; the
 * callable no longer accepts one and the mock never showed one.
 */
export interface VisitSlot {
  /** Stable across edits, so a React key never re-keys a row the operator is typing in. */
  id: string;
  /** `HH:mm`, local wall clock. */
  time: string;
  serviceName: string;
  /** Catalog id when the service came from one; null for a typed-in name. */
  serviceId: string | null;
}

/** One selected day and the visits planned on it. */
export interface DayPlan {
  dayIso: string;
  visits: VisitSlot[];
}

export interface BillingChoice {
  /**
   * ONE member, because the mock's Invoice Options step offers one choice. A
   * second would be a branch nothing can produce; the server's enum has exactly
   * the same single member for the same reason.
   */
  mode: 'new-invoice';
}

export interface CommunicationChoice {
  /** Send the household a confirmation email. Off by default, per the mock. */
  emailConfirmation: boolean;
  /** Show the household exact start times. Off means they see the window instead. */
  timeVisibility: boolean;
}

export interface WizardState {
  kinfolkId: string;
  /** The Kin these visits are for. Empty means the whole household. */
  kinIds: string[];
  /** Step 2's pick. Seeds every new visit row; a row can then be changed. */
  serviceName: string;
  serviceId: string | null;
  mode: BookingMode;
  /** The Daily Visit Schedule: what a NEWLY picked day starts out as. */
  template: VisitSlot[];
  /** Individual-dates mode only, ascending by day. */
  plans: DayPlan[];
  /** Repeating mode. */
  startDateIso: string;
  weeklyDays: number[];
  weeks: number;
  billing: BillingChoice;
  communication: CommunicationChoice;
  /** Private notes, from the Review step. Sent as the booking's `notes`. */
  notes: string;
}

/** Ids only have to be unique within one dialog, and `crypto.randomUUID` is not in jsdom by default. */
let slotSeq = 0;
export function newSlotId(): string {
  slotSeq += 1;
  return `slot-${slotSeq}`;
}

export function newSlot(over: Partial<VisitSlot> = {}): VisitSlot {
  return {
    id: newSlotId(),
    time: '09:00',
    serviceName: '',
    serviceId: null,
    ...over,
  };
}

export function initialWizardState(): WizardState {
  return {
    kinfolkId: '',
    kinIds: [],
    serviceName: '',
    serviceId: null,
    mode: 'dates',
    template: [newSlot()],
    plans: [],
    startDateIso: '',
    weeklyDays: [],
    weeks: 4,
    billing: { mode: 'new-invoice' },
    communication: { emailConfirmation: false, timeVisibility: false },
    notes: '',
  };
}

// ── steps ────────────────────────────────────────────────────────────────────

export type StepKey = 'client' | 'service' | 'dates' | 'invoice' | 'review';

export interface StepDef {
  key: StepKey;
  /** The label the PNGs put under each numbered circle, verbatim. */
  label: string;
}

/**
 * The PNGs head this step "Select Client & Pets". Both of those words are
 * outside the house vocabulary, which is enforced rather than preferred: a
 * client or household is KINFOLK and a pet is KIN. The mock is the authority
 * for the flow and for what each step contains, never for the voice, so the
 * label says the same thing in the words this product uses.
 */
export const WIZARD_STEPS: readonly StepDef[] = [
  { key: 'client', label: 'Select Kinfolk & Kin' },
  { key: 'service', label: 'Choose Service' },
  { key: 'dates', label: 'Schedule Dates' },
  { key: 'invoice', label: 'Invoice Options' },
  { key: 'review', label: 'Review & Confirm' },
];

export function stepIndex(key: StepKey): number {
  const i = WIZARD_STEPS.findIndex((s) => s.key === key);
  // Never -1: StepKey is exactly the union of the five keys above, and every
  // caller passes one. Stated rather than asserted so a sixth step added to the
  // union without a row here fails a test instead of silently indexing at -1.
  return i === -1 ? 0 : i;
}

// ── service pick ─────────────────────────────────────────────────────────────

/** Apply step 2's chosen service to every template row that has not been given its own. */
export function applyServiceToTemplate(state: WizardState, option: ServiceOption): WizardState {
  return {
    ...state,
    serviceName: option.name,
    serviceId: null,
    template: state.template.map((slot) =>
      // A row the operator has already retargeted keeps its own service: step 2
      // sets the DEFAULT, and silently overwriting a deliberate per-visit choice
      // is the thing this whole template model exists to avoid.
      slot.serviceName === '' || slot.serviceName === state.serviceName
        ? { ...slot, serviceName: option.name, serviceId: null }
        : slot,
    ),
  };
}

// ── days ─────────────────────────────────────────────────────────────────────

/** A fresh copy of the template, with new ids, for a day being picked. */
function snapshotTemplate(template: readonly VisitSlot[]): VisitSlot[] {
  return template.map((slot) => ({ ...slot, id: newSlotId() }));
}

/**
 * Toggle a day in individual-dates mode.
 *
 * Picking a day COPIES the template onto it. Unpicking drops the day and its
 * per-visit edits with it, which is the honest reading of unpicking; the mock's
 * own row menu is the place to change a day, not to hide it.
 */
export function toggleDay(state: WizardState, dayIso: string): WizardState {
  const existing = state.plans.find((p) => p.dayIso === dayIso);
  if (existing) {
    return { ...state, plans: state.plans.filter((p) => p.dayIso !== dayIso) };
  }
  const next: DayPlan = { dayIso, visits: snapshotTemplate(state.template) };
  return { ...state, plans: [...state.plans, next].sort((a, b) => a.dayIso.localeCompare(b.dayIso)) };
}

export function clearDays(state: WizardState): WizardState {
  return { ...state, plans: [] };
}

/** The set the calendar renders its selection from. */
export function selectedDays(state: WizardState): ReadonlySet<string> {
  return new Set(state.plans.map((p) => p.dayIso));
}

// ── per-day and template edits ───────────────────────────────────────────────

export function updateTemplateSlot(
  state: WizardState,
  slotId: string,
  patch: Partial<Omit<VisitSlot, 'id'>>,
): WizardState {
  return {
    ...state,
    template: state.template.map((s) => (s.id === slotId ? { ...s, ...patch } : s)),
  };
}

export function addTemplateSlot(state: WizardState): WizardState {
  const last = state.template[state.template.length - 1];
  return {
    ...state,
    template: [
      ...state.template,
      newSlot({
        // Seeded from the row above, which is what "add another visit" means on
        // a day that already has one: same service, a later time the operator
        // then sets.
        time: last?.time ?? '09:00',
        serviceName: last?.serviceName ?? state.serviceName,
        serviceId: last?.serviceId ?? state.serviceId,
      }),
    ],
  };
}

/** The template always keeps at least one row: a day with no visits is not a booking. */
export function removeTemplateSlot(state: WizardState, slotId: string): WizardState {
  if (state.template.length <= 1) return state;
  return { ...state, template: state.template.filter((s) => s.id !== slotId) };
}

export function updateDayVisit(
  state: WizardState,
  dayIso: string,
  slotId: string,
  patch: Partial<Omit<VisitSlot, 'id'>>,
): WizardState {
  return {
    ...state,
    plans: state.plans.map((p) =>
      p.dayIso !== dayIso
        ? p
        : { ...p, visits: p.visits.map((v) => (v.id === slotId ? { ...v, ...patch } : v)) },
    ),
  };
}

export function addDayVisit(state: WizardState, dayIso: string): WizardState {
  return {
    ...state,
    plans: state.plans.map((p) => {
      if (p.dayIso !== dayIso) return p;
      const last = p.visits[p.visits.length - 1];
      return {
        ...p,
        visits: [
          ...p.visits,
          newSlot({
            time: last?.time ?? '09:00',
            serviceName: last?.serviceName ?? state.serviceName,
            serviceId: last?.serviceId ?? state.serviceId,
          }),
        ],
      };
    }),
  };
}

/** Same floor as the template: the last visit on a day cannot be removed, unpick the day instead. */
export function removeDayVisit(state: WizardState, dayIso: string, slotId: string): WizardState {
  return {
    ...state,
    plans: state.plans.map((p) =>
      p.dayIso !== dayIso || p.visits.length <= 1
        ? p
        : { ...p, visits: p.visits.filter((v) => v.id !== slotId) },
    ),
  };
}

// ── the payload ──────────────────────────────────────────────────────────────

/**
 * One visit as the callable's generated `CreateMultiDateBookingRequestArgsVisit`
 * takes it. The wizard collects no end time and no price override (the server
 * resolves price from the catalog server-side, NOTE-56), so those two travel
 * as an explicit `null` rather than an omitted key -- the generated Args
 * always carries the key, and a `null` here means exactly what an omitted key
 * used to.
 */
export type WizardVisit = CreateMultiDateBookingRequestArgsVisit;

/**
 * Every planned visit, ascending, as the callable's `visits[]`.
 *
 * Individual-dates mode reads the per-day plans, so two visits on one day at
 * two times with two services all survive: that is the whole point of the
 * wizard over the single-page form, which sent one service and one time for
 * every date it had.
 *
 * Weekly mode applies the TEMPLATE to each expanded date, since a repeating
 * schedule has no per-day list to read (see the module header).
 */
export function buildVisits(state: WizardState): WizardVisit[] {
  const rows: { ms: number; slot: VisitSlot }[] = [];

  if (state.mode === 'weekly') {
    for (const slot of state.template) {
      const times = expandWeekly({
        startDateIso: state.startDateIso,
        time: slot.time,
        weeklyDays: state.weeklyDays,
        weeks: state.weeks,
      });
      for (const ms of times) rows.push({ ms, slot });
    }
  } else {
    for (const plan of state.plans) {
      for (const slot of plan.visits) {
        const [ms] = visitMsFromDays([plan.dayIso], slot.time);
        if (ms !== undefined) rows.push({ ms, slot });
      }
    }
  }

  return rows
    .sort((a, b) => a.ms - b.ms)
    .map(({ ms, slot }) => ({
      startTimeMs: ms,
      // No end time in the wizard's UI; null means what an omitted key used to.
      endTimeMs: null,
      serviceName: slot.serviceName.trim(),
      serviceId: slot.serviceId,
      // No price override in the wizard's UI; the server resolves the
      // catalog price from serviceId (NOTE-56).
      priceCents: null,
    }));
}

/** Ascending list of the days a visit falls on, for the review's "N visits across M days". */
export function plannedDayCount(state: WizardState): number {
  return plannedDayIsos(state).length;
}

/**
 * EVERY local day this request will land on, ascending, weekly recurrences
 * EXPANDED.
 *
 * This used to answer `[startDateIso]` in weekly mode, which made every caller
 * blind to occurrences 2..n: a four-week Monday recurrence whose third Monday is
 * a company holiday raised no warning and passed the Dates step, and the server
 * then refused the WHOLE batch at submit. Android's `plannedDates`
 * (`BookingWizard.kt`) expands for exactly that reason and this now matches it.
 *
 * Derived from the CONCRETE visits rather than from a second expansion of the
 * recurrence, so the days reasoned about here are by construction the days the
 * payload carries; a divergence between the two is not expressible.
 */
export function plannedDayIsos(state: WizardState): string[] {
  if (state.mode === 'weekly') {
    return sortedDays(new Set(buildVisits(state).map((v) => localDateIso(new Date(v.startTimeMs)))));
  }
  return sortedDays(state.plans.map((p) => p.dayIso));
}

/** One concrete (day, wall-clock time) the request will contain. */
export interface PlannedVisitTime {
  dayIso: string;
  /** `HH:mm`, local. */
  time: string;
}

/**
 * The distinct day-and-time pairs the request WILL contain, ascending.
 *
 * The availability warnings are built from this, not from "every selected day"
 * crossed with "every time used anywhere in the plan". That cross product warned
 * about visits that do not exist: Aug 17 at 09:00 plus Aug 23 at 19:00 produced
 * "Aug 17: 19:00 is outside business hours" for a 19:00 visit on Aug 17 the
 * operator never asked for. Android computes its warnings per concrete visit for
 * the same reason (`BookingWizardAvailability.kt#bookingSelectionWarnings`).
 *
 * De-duplicated, so two visits at the same minute on the same day still say
 * their one thing once.
 */
export function plannedVisitTimes(state: WizardState): PlannedVisitTime[] {
  const seen = new Set<string>();
  const out: PlannedVisitTime[] = [];
  for (const visit of buildVisits(state)) {
    const at = new Date(visit.startTimeMs);
    const dayIso = localDateIso(at);
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const key = `${dayIso}T${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dayIso, time });
  }
  return out;
}

/**
 * The distinct services the SUBMITTED visits carry, in visit order.
 *
 * Review renders this rather than `state.serviceName`. Step 2 sets a DEFAULT
 * that seeds the template; days already snapshotted keep the service they were
 * added with, so an operator who books Tuesday as a Dog Walk, jumps back to step
 * 2 and picks Grooming submits one Dog Walk and gets a Review header that says
 * Grooming. Android's review row reads the built visits for the same reason
 * (`NewBookingWizard.kt`'s `reviewStep`).
 */
export function plannedServiceNames(state: WizardState): string[] {
  const out: string[] = [];
  for (const visit of buildVisits(state)) {
    const name = visit.serviceName.trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

// ── totals ───────────────────────────────────────────────────────────────────

export interface WizardTotal {
  /** Sum of the priced visits, in cents. */
  cents: number;
  /** Services with no rate on the card. NEVER counted as zero. */
  unpriced: string[];
}

/**
 * Parses a `serviceRates` value ("25", "25.00", "$25") to cents. Null when the
 * operator left it blank or typed something that is not a number, which is a
 * real state: `KinCareRatesEditor` allows a blank rate and the settings
 * overview renders it as "Not set".
 */
export function rateToCents(rate: string): number | null {
  const cleaned = rate.trim().replace(/^\$/, '').replace(/,/g, '');
  if (cleaned === '') return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * The Review step's total.
 *
 * An unpriced service is NAMED, never silently added as zero. A booking whose
 * total reads $30 when one of its three visits has no rate is a number the
 * operator will quote to a household and then have to walk back, and the
 * invoice work in this repo has already been bitten by exactly that (a silent
 * zero bills a household nothing for real work and looks deliberate).
 */
export function wizardTotal(state: WizardState, options: readonly ServiceOption[]): WizardTotal {
  const rateByName = new Map(options.map((o) => [o.name, o.rate]));
  let cents = 0;
  const unpriced: string[] = [];
  for (const visit of buildVisits(state)) {
    const rate = rateByName.get(visit.serviceName);
    const value = rate === undefined ? null : rateToCents(rate);
    if (value === null) {
      if (!unpriced.includes(visit.serviceName)) unpriced.push(visit.serviceName);
      continue;
    }
    cents += value;
  }
  return { cents, unpriced };
}

/** "$30.00". Cents in, dollars out, no locale guessing. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── step gating ──────────────────────────────────────────────────────────────

/**
 * Answers "is this local day a company closure, and what is it called".
 *
 * A FUNCTION rather than a list of closure entries, so this module stays pure
 * and the Firestore read stays in the dialog. The default answers "no closure
 * anywhere", which is what a caller that has not wired closures yet gets:
 * degrading to the pre-closure behavior, never to a fabricated refusal.
 */
export type ClosedDayName = (dayIso: string) => string | null;

const NO_CLOSURES: ClosedDayName = () => null;

/**
 * Why the operator cannot leave this step yet, or null when they can.
 *
 * A REASON, not a boolean, so the Next button can say what is missing rather
 * than sitting greyed out with no explanation. Every message names the thing to
 * do, not the rule that failed.
 *
 * `closedDayName` makes a company closure a HARD gate on the Dates step, over
 * EVERY generated day. `guardCompanyHolidayConflict` (PR #204) refuses a closed
 * date server-side with no override by design, so letting the operator carry one
 * to Review would be offering a submit that cannot succeed, and in weekly mode it
 * would lose the whole batch at the last step. Same ruling as Android's
 * `stepBlocker` (`BookingWizard.kt`).
 */
export function stepBlocker(
  state: WizardState,
  step: StepKey,
  nowMs: number,
  closedDayName: ClosedDayName = NO_CLOSURES,
): string | null {
  switch (step) {
    case 'client':
      return state.kinfolkId === '' ? 'Pick a household first.' : null;
    case 'service':
      return state.serviceName.trim() === '' ? 'Pick a service first.' : null;
    case 'dates': {
      const visits = buildVisits(state);
      if (visits.length === 0) {
        return state.mode === 'weekly'
          ? 'Pick a start date and at least one weekday.'
          : 'Pick at least one date.';
      }
      if (visits.some((v) => v.serviceName === '')) {
        return 'Every visit needs a service.';
      }
      // The 1-minute grace matches the server's own `startTimeMs < now - 60_000`
      // check, so this refuses exactly what the callable would refuse rather
      // than sending a request that is guaranteed to come back invalid.
      if (visits.some((v) => v.startTimeMs < nowMs - 60_000)) {
        return 'Every visit has to be in the future.';
      }
      // The admin callable caps `visits` at 60. Said here, with the count, so a
      // long recurrence is caught before a round trip spends it.
      if (visits.length > MAX_VISITS) {
        return `That is ${visits.length} visits. The most a single request can carry is ${MAX_VISITS}, so shorten the recurrence or split the booking.`;
      }
      // Checked over EVERY generated day, not just the one the operator clicked.
      // A closure in week 3 of a recurrence is the case the start-date-only check
      // used to miss entirely.
      for (const dayIso of plannedDayIsos(state)) {
        const name = closedDayName(dayIso);
        if (name !== null) {
          return `${shortDayLabel(dayIso)} is closed for ${name}. The business will refuse that date, so pick another.`;
        }
      }
      return null;
    }
    case 'invoice':
      return null;
    case 'review':
      return null;
  }
}

/** `createMultiDateBookingRequest`'s own `z.array(VisitArgs).min(1).max(60)`. */
export const MAX_VISITS = 60;

/** Can the wizard move on from this step. */
export function canAdvance(
  state: WizardState,
  step: StepKey,
  nowMs: number,
  closedDayName: ClosedDayName = NO_CLOSURES,
): boolean {
  return stepBlocker(state, step, nowMs, closedDayName) === null;
}

/**
 * The first step that is still blocking, walked from the start.
 *
 * The Review step submits, so it must not be reachable with a hole three steps
 * back: editing the household after picking dates can empty the selection, and
 * a Back-then-Next path would otherwise sail past it.
 */
export function firstBlockedStep(
  state: WizardState,
  nowMs: number,
  closedDayName: ClosedDayName = NO_CLOSURES,
): StepKey | null {
  for (const step of WIZARD_STEPS) {
    if (stepBlocker(state, step.key, nowMs, closedDayName) !== null) return step.key;
  }
  return null;
}

// ── the submission, and the one refusal an operator may override ─────────────

/**
 * The machine-readable `details.code`s `createMultiDateBookingRequest` can
 * refuse with. Mirrors `functions/src/lib/bookingBusyConflict.ts` and
 * `functions/src/lib/companyHolidayConflict.ts`, and Android's
 * `BOOKING_BUSY_CONFLICT_CODE` / `COMPANY_HOLIDAY_CONFLICT_CODE`. Branching on a
 * code rather than on the wording of a sentence is the repo convention
 * (`lib/googleCalendarTargets.ts`, `lib/calendarSyncId.ts`).
 */
export const BOOKING_BUSY_CONFLICT_CODE = 'booking_busy_conflict';
export const COMPANY_HOLIDAY_CONFLICT_CODE = 'company_holiday_conflict';

/**
 * The `details.code` on a callable rejection, or `''` when the rejection carries
 * none. Reads the shape defensively rather than importing `FirebaseError`, so
 * this stays a pure function a test can call with a plain object -- the same
 * approach `lib/googleOAuthSetup.ts#readOAuthFailure` already takes.
 */
export function callableConflictCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return '';
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/**
 * Whether this refusal is the ONE an operator is allowed to knowingly go past.
 *
 * A `GOOGLE_BUSY_IMPORT` clash is advisory-grade information about the
 * operator's own calendar, and `overrideBusyConflict` exists server-side
 * precisely so an admin can write over it (the server then audits the write as
 * `BOOKING_BUSY_CONFLICT_OVERRIDDEN`). A company closure is the operator's own
 * deliberate statement that the business is shut: `guardCompanyHolidayConflict`
 * has no override parameter by design, so it must never reach this as `true`.
 *
 * `alreadyOverridden` is false only on a first attempt. Re-offering "Create
 * anyway" after an override has already failed would offer the same losing move
 * twice; Android refuses that for the same reason.
 */
export function isOverridableBusyRefusal(err: unknown, alreadyOverridden: boolean): boolean {
  if (alreadyOverridden) return false;
  return callableConflictCode(err) === BOOKING_BUSY_CONFLICT_CODE;
}

/**
 * The exact payload the wizard sends, one field per callable argument.
 *
 * Built here rather than inline in the dialog so a test can assert the whole
 * thing -- including that an operator's explicit "Create anyway" really does put
 * `overrideBusyConflict: true` on the wire, which is the flag's entire point and
 * which nothing on this surface set until now.
 *
 * `overrideBusyConflict` is only ever `true` on that explicit retry. `notes` and
 * `kinIds` are omitted rather than sent blank: the callable treats an omitted
 * key and a blank value identically, so sending the blank is noise on the wire.
 */
export function bookingSubmission(
  state: WizardState,
  overrideBusyConflict = false,
): CreateMultiDateBookingRequestArgs {
  return {
    kinfolkId: state.kinfolkId,
    ...(state.kinIds.length > 0 && { kinIds: state.kinIds }),
    ...(state.notes.trim() !== '' && { notes: state.notes.trim() }),
    pattern: state.mode === 'weekly' ? 'weekly' : 'individual',
    ...(state.mode === 'weekly' && { weeklyDays: state.weeklyDays }),
    visits: buildVisits(state),
    billing: state.billing,
    communication: state.communication,
    ...(overrideBusyConflict && { overrideBusyConflict: true }),
  };
}
