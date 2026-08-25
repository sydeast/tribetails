import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { getBookingPolicy, getBusinessClosures, getServiceCatalog, requestBooking } from '../api/bookingApi';
import type { BookingMode, GetBookingPolicyResult, ServiceDto, TimeBlockDto } from '../api/bookingApi';
import type { RequestBookingArgsVisit, RequestBookingResult } from '../contracts/bookingContracts.generated';
import { getMyKin } from '../api/portal';
import type { KinDto } from '../api/types';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { kinVariant, speciesEmoji } from '../lib/portalFormat';
import { PortalNav } from '../components/PortalNav';
import { BookingMonthPicker } from '../components/BookingMonthPicker';
import { LaunchError } from './LaunchError';
import {
  BOOKING_HORIZON_DAYS,
  bookingHorizonEnd,
  buildVisits,
  buildWeeklyVisits,
  dateKey,
  estimateBookingTotal,
  formatEstimate,
  initialBookingMode,
  MAX_RECURRING_VISITS,
  pastPlannedVisits,
  plannedVisitLine,
  priceLabel,
  renderPlannedVisits,
  slotsBlocker,
  summariseSlots,
  timeBlockLabel,
  weeklyPotentialCount,
  weeklyVisitsBlocker,
} from '../lib/bookingWizardLogic';
import type { BookingTiming, KinCareSlot } from '../lib/bookingWizardLogic';
import '../styles/booking.css';

/**
 * C1 / #544: the lookahead window `getBusinessClosures` is asked to resolve,
 * once per wizard session. It is deliberately the SAME constant the picker
 * bounds itself by (`BOOKING_HORIZON_DAYS`, itself the server's own
 * `MAX_RANGE_DAYS`), so every month a household can page to has already had
 * its closures answered by that one read -- paging months never fires
 * another call, and never shows a month whose closed days are unknown. It
 * also covers the Weekly pattern's longest offered run (8 weeks = 56 days,
 * `WEEK_COUNT_OPTIONS`).
 */
const CLOSURE_LOOKAHEAD_DAYS = BOOKING_HORIZON_DAYS;

type Pattern = 'individual' | 'weekly';

/**
 * #542: step 2 is "KinCare Duration", not "Service". The catalog this
 * business sells is priced by length of visit (30/45/60 Minute), so the
 * kinfolk-facing word for it is a duration. Only the copy moved -- the
 * catalog, its `services` wire shape and every backend field keep their
 * names.
 */
const STEP_LABELS = ['Kin', 'KinCare Duration', 'Schedule Dates', 'Extra Love & Context', 'Review & Confirm'];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_COUNT_OPTIONS = [2, 4, 6, 8];
/** What a freshly added KinCare's time starts at. The household changes it in step 3. */
const DEFAULT_VISIT_TIME = '09:00';
/**
 * Time-block booking: what the wizard runs on while `getBookingPolicy` is in
 * flight, or when it failed. Clock times, no windows — the pre-time-block
 * behaviour, and the same shape the callable itself falls back to when its own
 * settings read fails, so a loading wizard and a degraded one behave alike.
 */
const CLOCK_ONLY_POLICY: GetBookingPolicyResult = {
  allowTimeBlockBooking: false,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  timeBlocks: [],
};
const SERVICE_ICON_EMOJI: Record<string, string> = {
  sun: '\u{2600}\u{FE0F}',
  bell: '\u{1F514}',
  heart: '\u{1F970}',
  moon: '\u{1F319}',
  walk: '\u{1F43E}',
};

function serviceIcon(s: ServiceDto): string {
  const byKey = s.iconKey ? SERVICE_ICON_EMOJI[s.iconKey] : undefined;
  if (byKey) return byKey;
  return s.isOvernight ? SERVICE_ICON_EMOJI.moon! : '\u{1F43E}';
}

function kinSubtitle(k: KinDto): string {
  return [k.breed ?? k.species, k.ageYears !== null ? `${k.ageYears} yrs` : null].filter((v): v is string => v !== null).join(' • ');
}

/** Preserves first-encountered category order (mirrors Kotlin's `groupBy` on a List). */
function groupServicesByCategory(services: ServiceDto[]): Array<[string, ServiceDto[]]> {
  const order: string[] = [];
  const byCategory = new Map<string, ServiceDto[]>();
  for (const s of services) {
    const cat = s.category ?? 'KinCare Durations';
    let bucket = byCategory.get(cat);
    if (!bucket) {
      bucket = [];
      byCategory.set(cat, bucket);
      order.push(cat);
    }
    bucket.push(s);
  }
  return order.map((cat) => [cat, byCategory.get(cat) ?? []]);
}

export interface BookingWizardProps {
  onClose: () => void;
  onComplete: (result: RequestBookingResult) => void;
  /** Starts on the Weekly pattern, mirrors BookingWizardScreen.kt's `startWeekly` param (e.g. a "Set up a recurring visit" entry point). */
  startWeekly?: boolean;
}

/**
 * The 5-step booking wizard, wired for the real app: adds the top nav and a
 * router-backed sign-out for the query-error screen. Everything else lives
 * in {@link BookingWizardBody}, which stays free of router/auth
 * dependencies so it can be unit-tested by rendering it directly (see
 * BookingWizard.test.tsx) without a RouterProvider.
 */
export function BookingWizard(props: BookingWizardProps) {
  const { signOut, signingOut } = useSignOut();

  return (
    <>
      <PortalNav active="schedule" />
      <BookingWizardBody {...props} onSignOut={signOut} signingOut={signingOut} />
    </>
  );
}

// route-only lookup (no static import of router.tsx's route object needed —
// avoids a circular import while still code-splitting this whole screen,
// including this wrapper, into its own chunk via router.tsx's
// lazyRouteComponent).
const bookingRouteApi = getRouteApi('/schedule/book');

/**
 * Route-ready wrapper: reads `?weekly=1` (BookingWizardScreen.kt's
 * "Set up a recurring visit" entry point) and wires close/complete back to
 * /schedule. Kept in this file (not router.tsx) so dynamically importing
 * this module for code-splitting pulls the whole booking-wizard chunk in
 * one piece.
 */
export function BookingWizardRoute() {
  const navigate = useNavigate();
  const { weekly } = bookingRouteApi.useSearch();
  return (
    <BookingWizard
      startWeekly={weekly}
      onClose={() => void navigate({ to: '/schedule' })}
      onComplete={() => void navigate({ to: '/schedule' })}
    />
  );
}

export interface BookingWizardBodyProps extends BookingWizardProps {
  onSignOut: () => void;
  signingOut?: boolean;
}

/**
 * The 5-step booking wizard's actual content (no PortalNav, no router
 * hooks). Behavior ported from
 * src/commonMain/kotlin/com/kinfolk/portal/screens/schedule/BookingWizardScreen.kt
 * + RecurringBooking.kt (see lib/bookingWizardLogic.ts); desktop layout
 * (stepper, 3-col duration grid, persistent summary/price rail) from
 * ui-ideas/mytribe-booking-wizard-2026-05-31.html.
 *
 * #545: the steps are Kin -> KinCare Duration -> Dates -> Extra Love &
 * Context -> Review, which is the mock's own list. What used to sit at step 4
 * was an "Invoice Options" card that said an invoice arrives later and offered
 * nothing to decide — a kinfolk-facing surface for a decision kinfolk do not
 * make. It is deleted, not hidden: there is no component left to render, and
 * the route's `validateSearch` exposes only `weekly`, so no URL selects a step
 * at all. The Extra Love & Context note moved out of Review and into the step
 * the stepper has always named for it.
 *
 * `plannedVisits` below is the single source of truth for the visit list, for
 * BOTH patterns: computed once per (pattern, dates, weeklyDays, weekCount,
 * slots) via useMemo (same shape as the Kotlin `remember(...)` block) and
 * reused for the Step 3 count, the summary rail's count AND price, the Review
 * step's enumerated dates and price, AND the requestBooking payload. The
 * Individual pattern used to be the exception, building its visits only inside
 * the submit mutation — which is exactly how #546/#547 happened: the rail and
 * Review had no visit list to read a price off, so they read the catalog
 * sticker price instead and never changed. Every number a kinfolk sees is now
 * derived from the same array that gets submitted.
 */
export function BookingWizardBody(props: BookingWizardBodyProps) {
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const [step, setStep] = useState(1);
  const [allKinMode, setAllKinMode] = useState(true);
  const [selectedKinIds, setSelectedKinIds] = useState<Set<string>>(new Set());
  // #541 / #543: a LIST of KinCares, each with its own time of day, not one
  // service and one clock. See KinCareSlot in lib/bookingWizardLogic.ts.
  const [slots, setSlots] = useState<KinCareSlot[]>([]);
  const [pattern, setPattern] = useState<Pattern>(props.startWeekly ? 'weekly' : 'individual');
  const [selectedDates, setSelectedDates] = useState<Map<string, Date>>(new Map());
  const [weeklyDays, setWeeklyDays] = useState<Set<number>>(new Set());
  const [weekCount, setWeekCount] = useState(4);
  const [notes, setNotes] = useState('');
  /**
   * Time-block booking: null means "whatever this business opens on". The
   * household's own choice overrides it once they use the toggle, which only
   * exists when the business allows both.
   */
  const [modeChoice, setModeChoice] = useState<BookingMode | null>(null);

  const kinQuery = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });
  const servicesQuery = useQuery({ queryKey: ['serviceCatalog'], queryFn: () => getServiceCatalog() });

  // C1: which dates are closed. A failed or still-loading read degrades to
  // "nothing known closed" (the picker offers every date, same as before this
  // task) rather than blocking the wizard on a secondary read -- the server
  // is the actual authority and refuses a closed date regardless of what this
  // client shows.
  const closuresQuery = useQuery({
    queryKey: ['businessClosures'],
    queryFn: () => {
      const today = new Date();
      const from = dateKey(today);
      const to = dateKey(bookingHorizonEnd(today, CLOSURE_LOOKAHEAD_DAYS));
      return getBusinessClosures({ fromDate: from, toDate: to });
    },
  });
  const closedDates: ReadonlyMap<string, string> = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of closuresQuery.data?.closures ?? []) m.set(c.date, c.name);
    return m;
  }, [closuresQuery.data]);

  /**
   * Time-block booking: what this business lets a household choose.
   *
   * A failed or still-loading read degrades to {@link CLOCK_ONLY_POLICY} —
   * specific times, no windows — which is BOTH the pre-time-block behaviour and
   * the exact fallback `getBookingPolicy` itself returns when its settings read
   * fails. A secondary read must not decide whether the wizard opens, and the
   * server refuses whatever it will not accept regardless of what this shows.
   */
  const policyQuery = useQuery({ queryKey: ['bookingPolicy'], queryFn: () => getBookingPolicy() });
  const policy = policyQuery.data ?? CLOCK_ONLY_POLICY;

  /**
   * The mode in force. Derived rather than stored, so it can never be a mode
   * the business does not allow — including in the moment between the wizard
   * mounting and the policy arriving.
   */
  const mode: BookingMode = (() => {
    const preferred = modeChoice ?? initialBookingMode(policy);
    if (preferred === 'TIME_BLOCK' && !policy.allowTimeBlockBooking) return 'SPECIFIC_TIME';
    if (preferred === 'SPECIFIC_TIME' && !policy.allowSpecificTimeBooking) return 'TIME_BLOCK';
    return preferred;
  })();
  const timeBlocks = policy.timeBlocks;
  const timing: BookingTiming = useMemo(
    () => ({ mode, blocks: mode === 'TIME_BLOCK' ? timeBlocks : [] }),
    [mode, timeBlocks],
  );
  /** Both modes on offer: the only case where the household gets a choice to make. */
  const canChooseMode = policy.allowTimeBlockBooking && policy.allowSpecificTimeBooking;

  // Slot ids are local and never sent; they exist so two KinCares of the same
  // duration stay distinguishable to React while one of their times or blocks
  // is edited.
  const slotSeq = useRef(0);
  const addSlot = (serviceId: string) => {
    slotSeq.current += 1;
    setSlots((prev) => [
      ...prev,
      {
        slotId: `slot-${slotSeq.current}`,
        serviceId,
        time: DEFAULT_VISIT_TIME,
        // In block mode a fresh KinCare lands in the FIRST window rather than
        // on "choose one": a picker whose every row starts unset is a blocker
        // dressed as a control, and the household can move it in one tap.
        timeBlockId: mode === 'TIME_BLOCK' ? (timeBlocks[0]?.id ?? null) : null,
      },
    ]);
  };
  const removeSlot = (slotId: string) => setSlots((prev) => prev.filter((s) => s.slotId !== slotId));
  const setSlotTime = (slotId: string, time: string) =>
    setSlots((prev) => prev.map((s) => (s.slotId === slotId ? { ...s, time } : s)));
  const setSlotBlock = (slotId: string, timeBlockId: string) =>
    setSlots((prev) => prev.map((s) => (s.slotId === slotId ? { ...s, timeBlockId } : s)));

  const activeKin = useMemo(() => (kinQuery.data?.kin ?? []).filter((k) => k.status === 'active'), [kinQuery.data]);
  const services = useMemo(() => servicesQuery.data?.services ?? [], [servicesQuery.data]);
  const resolvedKinIds = allKinMode ? activeKin.map((k) => k.id) : [...selectedKinIds];

  // Single source of truth for the visit list, BOTH patterns; see the doc
  // comment above. Deliberately NOT keyed on a ticking clock, so it recomputes
  // exactly when the plan changes.
  const plannedVisits: RequestBookingArgsVisit[] = useMemo(() => {
    if (pattern === 'weekly') {
      return buildWeeklyVisits({ nowMs: Date.now(), weeklyDays, weeks: weekCount, slots, services, timing });
    }
    return buildVisits([...selectedDates.values()], slots, services, timing);
  }, [pattern, weeklyDays, weekCount, slots, selectedDates, services, timing]);

  /** #546: the running estimate, derived from the plan above and from nothing else. */
  const estimate = useMemo(() => estimateBookingTotal(plannedVisits, services), [plannedVisits, services]);

  const weeklyPotential = weeklyPotentialCount(weeklyDays, weekCount, slots.length);
  const weeklyCapped = pattern === 'weekly' && plannedVisits.length > 0 && weeklyPotential > plannedVisits.length;
  const weeklyBlocker = weeklyVisitsBlocker(weeklyDays, weekCount, slots, timing);
  const individualBlocker = selectedDates.size === 0 ? 'Tap at least one date.' : slotsBlocker(slots, timing);

  /**
   * C1: every date currently in the plan that `closedDates` says is closed.
   * The Individual-pattern picker already refuses to let one get selected in
   * the first place (`BookingMonthPicker`'s `disabled`), so this mainly
   * catches the Weekly pattern, which has no per-date picker to disable at
   * all -- a generated weekly date can land on a closure with no UI short of
   * this check ever telling the household so before they hit Create Booking
   * and the whole request comes back refused.
   */
  const closedDatesInPlan = useMemo(() => {
    if (pattern === 'individual') {
      return [...selectedDates.keys()].filter((k) => closedDates.has(k));
    }
    const seen = new Set<string>();
    for (const v of plannedVisits) {
      const k = dateKey(new Date(v.startTimeMs));
      if (closedDates.has(k)) seen.add(k);
    }
    return [...seen];
  }, [pattern, selectedDates, plannedVisits, closedDates]);

  /**
   * Visits the plan already puts in the PAST. `requestBooking` refuses any
   * start more than a minute ago, and the Individual pattern has never
   * filtered for one, so this used to surface only as a refusal at Create
   * Booking. Time blocks make it routine rather than rare: a window offers one
   * start time, so today's Midday visits are all in the past from the moment
   * the window opens, and the household has no control to nudge.
   *
   * Recomputed with the plan, not on a clock: the household is editing, and a
   * warning that appears while nobody touched anything is worse than one that
   * appears when they next change something.
   */
  const pastVisits = useMemo(() => pastPlannedVisits(plannedVisits, Date.now()), [plannedVisits]);

  const scheduleReady =
    (pattern === 'individual' ? individualBlocker === null : weeklyBlocker === null) &&
    closedDatesInPlan.length === 0 &&
    pastVisits.length === 0;
  const visitCount = plannedVisits.length;
  /** How many calendar days the plan touches; with 2 KinCares a day that is not the visit count. */
  const dayCount =
    pattern === 'individual'
      ? selectedDates.size
      : new Set(plannedVisits.map((v) => dateKey(new Date(v.startTimeMs)))).size;

  const canAdvance = (() => {
    switch (step) {
      case 1:
        return allKinMode ? activeKin.length > 0 : selectedKinIds.size > 0;
      case 2:
        return slots.length > 0;
      case 3:
        return scheduleReady;
      default:
        return true;
    }
  })();

  const submit = useMutation({
    mutationFn: async () => {
      if (slots.length === 0) throw new Error('Choose a KinCare Duration first.');
      // The SAME array the rail, step 3 and Review have been showing.
      const visits = plannedVisits;
      if (visits.length === 0) throw new Error('No visits to book. Check the days and weeks.');
      return requestBooking({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        kinIds: resolvedKinIds,
        pattern,
        ...(pattern === 'weekly' ? { weeklyDays: [...weeklyDays].sort((a, b) => a - b) } : {}),
        visits,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['myBookings', kinfolkId] });
      props.onComplete(result);
    },
  });

  if (kinQuery.isError || servicesQuery.isError) {
    return (
      <LaunchError
        onRetry={() => {
          void kinQuery.refetch();
          void servicesQuery.refetch();
        }}
        retrying={kinQuery.isRefetching || servicesQuery.isRefetching}
        onSignOut={props.onSignOut}
        signingOut={props.signingOut ?? false}
      />
    );
  }

  if (kinQuery.isLoading || servicesQuery.isLoading) {
    return (
      <div className="wrap">
        <p className="sub">Loading the booking wizard…</p>
      </div>
    );
  }

  const submitErrorMessage = submit.error ? (submit.error instanceof Error ? submit.error.message : 'Could not create booking') : null;

  return (
    <div className="wrap">
        <header className="hero-greet">
          <div className="kick">Schedule</div>
          <h1>
            New <span>Booking</span>
          </h1>
        </header>

        <div className="stepper" role="list" aria-label="Booking steps">
          {STEP_LABELS.map((label, idx) => {
            const n = idx + 1;
            const state = n === step ? 'on' : n < step ? 'done' : '';
            return (
              <div key={label} className={`step ${state}`} role="listitem">
                <div className="dot">
                  <div className="num">{n}</div>
                  <div className="lbl">{label}</div>
                </div>
                <div className="ln" />
              </div>
            );
          })}
        </div>

        <div className="cols">
          <div className="stack">
            <section className="glass card d1">
              {step === 1 && (
                <Step1KinSelect
                  kin={activeKin}
                  allKinMode={allKinMode}
                  onToggleAllMode={setAllKinMode}
                  selectedIds={selectedKinIds}
                  onToggle={(id) =>
                    setSelectedKinIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                />
              )}
              {step === 2 && <Step2KinCareSelect services={services} slots={slots} onAdd={addSlot} onRemove={removeSlot} />}
              {step === 3 && (
                <Step3ScheduleDates
                  pattern={pattern}
                  onPatternChange={setPattern}
                  selectedDates={selectedDates}
                  onToggleDate={(key, date) =>
                    setSelectedDates((prev) => {
                      const next = new Map(prev);
                      if (next.has(key)) next.delete(key);
                      else next.set(key, date);
                      return next;
                    })
                  }
                  weeklyDays={weeklyDays}
                  onToggleWeekday={(day) =>
                    setWeeklyDays((prev) => {
                      const next = new Set(prev);
                      if (next.has(day)) next.delete(day);
                      else next.add(day);
                      return next;
                    })
                  }
                  weekCount={weekCount}
                  onWeekCountChange={setWeekCount}
                  slots={slots}
                  services={services}
                  onSlotTimeChange={setSlotTime}
                  onSlotBlockChange={setSlotBlock}
                  mode={mode}
                  canChooseMode={canChooseMode}
                  onModeChange={setModeChoice}
                  timeBlocks={timeBlocks}
                  weeklyEmitted={plannedVisits.length}
                  weeklyCapped={weeklyCapped}
                  weeklyBlocker={weeklyBlocker}
                  individualBlocker={individualBlocker}
                  visitCount={visitCount}
                  closedDates={closedDates}
                  closedDatesInPlan={closedDatesInPlan}
                  pastVisitCount={pastVisits.length}
                />
              )}
              {step === 4 && <Step4ExtraLoveAndContext notes={notes} onNotesChange={setNotes} />}
              {step === 5 && (
                <Step5Review
                  kinNames={allKinMode ? ['All Kin in this home'] : activeKin.filter((k) => selectedKinIds.has(k.id)).map((k) => k.name ?? 'Unnamed Kin')}
                  kinCareSummary={summariseSlots(slots, services)}
                  pattern={pattern}
                  visits={plannedVisits}
                  timeBlocks={timeBlocks}
                  notes={notes}
                  estimateLabel={formatEstimate(estimate)}
                  capped={weeklyCapped}
                  submitting={submit.isPending}
                  error={submitErrorMessage}
                />
              )}
            </section>

            <div className="wiz-foot">
              <button type="button" className="btn cancel" onClick={props.onClose}>
                Cancel
              </button>
              <span className="spacer" />
              {step > 1 && (
                <button type="button" className="btn ghost" onClick={() => setStep((s) => s - 1)}>
                  Back
                </button>
              )}
              {step < 5 ? (
                <button type="button" className="btn grad" disabled={!canAdvance} onClick={() => setStep((s) => s + 1)}>
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  className="btn grad"
                  disabled={submit.isPending || slots.length === 0 || !scheduleReady || plannedVisits.length === 0}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending ? 'Creating…' : 'Create Booking'}
                </button>
              )}
            </div>
          </div>

          {/*
            #547: the rail stands down on Review. The operator's words were
            "why are we displaying review & confirm AND booking summary on the
            same page" — and they are right, Review IS the summary, in more
            detail, three inches to the left. Every earlier step still needs it,
            because on those the summary is the only place the plan is visible.
          */}
          {step < 5 && (
            <div className="stack">
              <section className="glass card d3">
                <div className="sectlabel">Booking summary</div>

                <div className="sum-row">
                  <div className="sk">KinCare</div>
                  {slots.length > 0 ? (
                    <div className="sv">{summariseSlots(slots, services)}</div>
                  ) : (
                    <div className="sv muted">Not chosen yet</div>
                  )}
                </div>

                <div className="sum-row">
                  <div className="sk">Kin</div>
                  <div className={`sv ${allKinMode || selectedKinIds.size > 0 ? '' : 'muted'}`}>
                    {allKinMode ? 'All Kin in this home' : selectedKinIds.size > 0 ? `${selectedKinIds.size} chosen` : 'Not chosen yet'}
                  </div>
                </div>

                <div className="sum-row">
                  <div className="sk">{pattern === 'weekly' ? 'Schedule' : 'Dates'}</div>
                  {visitCount > 0 ? (
                    <div className="sv">
                      {visitCount} {visitCount === 1 ? 'visit' : 'visits'}
                      <small>
                        {pattern === 'weekly'
                          ? `over ${weekCount} weeks`
                          : `across ${dayCount} ${dayCount === 1 ? 'day' : 'days'}`}
                      </small>
                    </div>
                  ) : (
                    <div className="sv muted">No dates selected yet.</div>
                  )}
                </div>

                <div className="price-box">
                  <span className="pl">Estimated Price</span>
                  <span className="pv">{formatEstimate(estimate)}</span>
                </div>
                <p className="sub" style={{ marginTop: 12 }}>
                  {/*
                    The old line here promised the estimate updates "as you add
                    Kin and dates". Kin have never moved the price — the catalog
                    is priced per visit, not per animal — so half of that
                    sentence was describing something the app does not do.
                  */}
                  Your estimate updates as you add KinCare and dates. Your Auntie confirms the final price before the booking
                  starts.
                </p>
              </section>
            </div>
          )}
        </div>

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
  );
}

// ---- step components ----

function SelectedIndicator() {
  return (
    <span className="selected-indicator">
      {'✓'} Selected
    </span>
  );
}

/**
 * #540: step 1 owns the whole "who is this booking for" story now.
 *
 * The rail used to carry a second, read-only "Booking for" card listing the
 * same Kin next to this one -- two boxes for one choice, and the operator
 * called it: only one of them did anything. The card is gone; what it alone
 * used to show (each Kin's photo ring, breed/species and age, and the
 * "no Kin on file yet" state) moved in here, under the All-Kin option, so
 * nothing was lost with it. The roster renders in All-Kin mode only: in
 * specific-pick mode the pickable rows already say the same thing, and
 * printing both would rebuild the exact duplication being removed.
 */
function Step1KinSelect(props: {
  kin: KinDto[];
  allKinMode: boolean;
  onToggleAllMode: (v: boolean) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { kin, allKinMode, onToggleAllMode, selectedIds, onToggle } = props;
  return (
    <>
      <h3 className="title">Select Kin</h3>
      <p className="sub">
        Most bookings cover everyone. We&rsquo;ll default to all Kin in your home unless you&rsquo;d like to pick specific Kin for this visit.
      </p>
      {kin.length === 0 ? (
        <p className="sub" style={{ marginTop: 12 }}>
          No Kin on file yet. Add them first: open the menu (top right) and choose The Kin.
        </p>
      ) : (
        <>
          <button type="button" className="kinopt" style={{ marginTop: 14 }} onClick={() => onToggleAllMode(true)}>
            <div>
              <div className="kt">All Kin in this home</div>
              {/* The roster below this button is the subtitle when it is shown;
                  printing the names here as well would be the duplication #540
                  is about. In specific-pick mode the roster is hidden, so the
                  names line comes back. */}
              {!allKinMode && <span className="ks">{kin.map((k) => k.name).filter(Boolean).join(', ')}</span>}
            </div>
            {allKinMode && <SelectedIndicator />}
          </button>

          {allKinMode && (
            <div className="kinroster">
              {kin.map((k, i) => (
                <div className={`kinrow ${kinVariant(i)}`} key={k.id}>
                  <div className="pic">{speciesEmoji(k.species)}</div>
                  <div>
                    <b>{k.name ?? 'Unnamed Kin'}</b>
                    {kinSubtitle(k) && <small>{kinSubtitle(k).toUpperCase()}</small>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <button type="button" className="btn ghost block" style={{ marginTop: 12 }} onClick={() => onToggleAllMode(!allKinMode)}>
            {allKinMode ? 'Choose specific Kin' : 'Use All Kin instead'}
          </button>

          {!allKinMode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {kin.map((k, i) => {
                const selected = selectedIds.has(k.id);
                return (
                  <button type="button" key={k.id} className="kinopt" onClick={() => onToggle(k.id)}>
                    <div className={`kinrow ${kinVariant(i)} is-static`}>
                      <div className="pic">{speciesEmoji(k.species)}</div>
                      <div>
                        <b>{k.name ?? 'Unnamed Kin'}</b>
                        {kinSubtitle(k) && <small>{kinSubtitle(k).toUpperCase()}</small>}
                      </div>
                    </div>
                    {selected && <SelectedIndicator />}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * #541 + #543: step 2 builds the day's KinCare LIST, not a single choice.
 *
 * The grid used to be a `radiogroup`: picking a second duration silently
 * unpicked the first, which is #541, and there was no way at all to ask for two
 * KinCares in one day, which is #543. A radio group is the wrong control for
 * either — so the cards are now ADD buttons (tap a card again for a second one
 * of the same duration, which is how the morning-and-evening walk gets asked
 * for), and the list below is where a KinCare is taken back out. Adding on the
 * card and removing in the list keeps one control from having to mean both.
 *
 * Each KinCare's time of day is set on step 3, next to the dates, where the
 * single "Visit Time" field used to live.
 */
function Step2KinCareSelect(props: {
  services: ServiceDto[];
  slots: readonly KinCareSlot[];
  onAdd: (serviceId: string) => void;
  onRemove: (slotId: string) => void;
}) {
  const groups = groupServicesByCategory(props.services);
  const countFor = (id: string) => props.slots.filter((s) => s.serviceId === id).length;
  return (
    <>
      <h3 className="title">Choose KinCare Duration</h3>
      <p className="sub">
        How long should each visit run? Add as many as this booking needs. Tap a duration twice for two of them in the same
        day.
      </p>
      {groups.map(([category, list]) => (
        <div key={category}>
          <div className="svc-category">{category}</div>
          <div className="svc-grid" role="group" aria-label="KinCare Duration">
            {list.map((s) => {
              const count = countFor(s.id);
              return (
                <button
                  type="button"
                  key={s.id}
                  className={`svc ${count > 0 ? 'sel' : ''}`}
                  aria-label={`Add ${s.name}`}
                  onClick={() => props.onAdd(s.id)}
                >
                  <div className="pick">{count > 1 ? `×${count}` : '✓'}</div>
                  <div className="ico">{serviceIcon(s)}</div>
                  <h4>{s.name}</h4>
                  {s.description && <p>{s.description}</p>}
                  <div className="pr">{priceLabel(s).toUpperCase()}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="svc-category" style={{ marginTop: 18 }}>
        KinCare in each day
      </div>
      {props.slots.length === 0 ? (
        <p className="sub">Nothing added yet. Tap a duration above.</p>
      ) : (
        <ul className="slotlist">
          {props.slots.map((slot, idx) => {
            const service = props.services.find((s) => s.id === slot.serviceId);
            const name = service?.name ?? slot.serviceId;
            return (
              <li key={slot.slotId} className="slotrow">
                <span className="slotname">
                  {idx + 1}. {name}
                </span>
                <span className="slotprice">{service ? priceLabel(service) : ''}</span>
                <button type="button" className="btn ghost" aria-label={`Remove ${name}`} onClick={() => props.onRemove(slot.slotId)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Step3ScheduleDates(props: {
  pattern: Pattern;
  onPatternChange: (p: Pattern) => void;
  selectedDates: Map<string, Date>;
  onToggleDate: (key: string, date: Date) => void;
  weeklyDays: Set<number>;
  onToggleWeekday: (day: number) => void;
  weekCount: number;
  onWeekCountChange: (n: number) => void;
  slots: readonly KinCareSlot[];
  services: ServiceDto[];
  onSlotTimeChange: (slotId: string, time: string) => void;
  /** Time-block booking: which named window this KinCare goes in. */
  onSlotBlockChange: (slotId: string, timeBlockId: string) => void;
  mode: BookingMode;
  /** True only when the business allows BOTH, which is the only case with a choice to render. */
  canChooseMode: boolean;
  onModeChange: (m: BookingMode) => void;
  timeBlocks: readonly TimeBlockDto[];
  weeklyEmitted: number;
  weeklyCapped: boolean;
  weeklyBlocker: string | null;
  individualBlocker: string | null;
  visitCount: number;
  /** C1: date key -> closure name, from `getBusinessClosures`. */
  closedDates: ReadonlyMap<string, string>;
  /** C1: dates currently in the plan that land on one of `closedDates`. */
  closedDatesInPlan: readonly string[];
  /** Visits the plan already puts in the past; the server refuses every one of them. */
  pastVisitCount: number;
}) {
  const { pattern, weeklyDays, weekCount, slots, mode, canChooseMode, timeBlocks, weeklyEmitted, weeklyCapped, weeklyBlocker, individualBlocker, visitCount, closedDatesInPlan, pastVisitCount } =
    props;
  return (
    <>
      <h3 className="title">Schedule Dates</h3>
      <div className="pattern-toggle" role="radiogroup" aria-label="Booking pattern">
        <button
          type="button"
          className={`pattern-btn ${pattern === 'individual' ? 'is-on' : ''}`}
          role="radio"
          aria-checked={pattern === 'individual'}
          onClick={() => props.onPatternChange('individual')}
        >
          Individual Dates
        </button>
        <button
          type="button"
          className={`pattern-btn ${pattern === 'weekly' ? 'is-on' : ''}`}
          role="radio"
          aria-checked={pattern === 'weekly'}
          onClick={() => props.onPatternChange('weekly')}
        >
          Repeating Schedule
        </button>
      </div>

      {pattern === 'weekly' ? (
        <>
          <h4 style={{ marginTop: 16 }}>Repeat on</h4>
          <p className="sub">Each chosen day repeats every week.</p>
          <div className="chiprow" style={{ marginTop: 8 }}>
            {WEEKDAY_LABELS.map((label, idx) => (
              <button
                key={label}
                type="button"
                className={`togglechip ${weeklyDays.has(idx) ? 'is-on' : ''}`}
                aria-pressed={weeklyDays.has(idx)}
                onClick={() => props.onToggleWeekday(idx)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="sub" style={{ marginTop: 16, marginBottom: 6 }}>
            For how many weeks
          </p>
          <div className="chiprow">
            {WEEK_COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`togglechip ${weekCount === n ? 'is-on' : ''}`}
                aria-pressed={weekCount === n}
                onClick={() => props.onWeekCountChange(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <h4 style={{ marginTop: 16 }}>Choose Individual Dates</h4>
          <p className="sub">Tap dates to add or remove from the booking. Closed dates can&rsquo;t be selected.</p>
          <BookingMonthPicker
            selectedDates={new Set(props.selectedDates.keys())}
            onToggle={props.onToggleDate}
            closedDates={props.closedDates}
          />
        </>
      )}

      {/*
        Time-block booking (operator requirement 2026-08-24). The mode is a
        BOOKING-level choice, not a per-KinCare one: the operator asked for
        blocks instead of clocks, not for a mixture. It is only rendered when
        the business allows both — with one mode on offer there is nothing to
        decide, and a disabled toggle would be a control that lies.
      */}
      {canChooseMode && (
        <>
          <h4 style={{ marginTop: 18 }}>How do you want to set the time?</h4>
          <div className="pattern-toggle" role="radiogroup" aria-label="Time selection">
            <button
              type="button"
              className={`pattern-btn ${mode === 'TIME_BLOCK' ? 'is-on' : ''}`}
              role="radio"
              aria-checked={mode === 'TIME_BLOCK'}
              onClick={() => props.onModeChange('TIME_BLOCK')}
            >
              Time Blocks
            </button>
            <button
              type="button"
              className={`pattern-btn ${mode === 'SPECIFIC_TIME' ? 'is-on' : ''}`}
              role="radio"
              aria-checked={mode === 'SPECIFIC_TIME'}
              onClick={() => props.onModeChange('SPECIFIC_TIME')}
            >
              A Specific Time
            </button>
          </div>
        </>
      )}

      {/*
        #543: one control PER KinCare, not one for the booking. Two KinCares of
        the same duration in a day are only two things at all because they
        differ here — by the clock in specific-time mode, and by the window in
        block mode.
      */}
      <h4 style={{ marginTop: 18 }}>{mode === 'TIME_BLOCK' ? 'Time Blocks' : 'Visit Times'}</h4>
      {mode === 'TIME_BLOCK' && (
        <p className="sub">
          Your Auntie arrives at some point during the block you pick. That leaves her room to get between homes without rushing anyone.
        </p>
      )}
      {slots.length === 0 ? (
        <p className="sub">No KinCare chosen yet. Go back a step to add one.</p>
      ) : (
        <div className="slottimes">
          {slots.map((slot, idx) => {
            const name = props.services.find((s) => s.id === slot.serviceId)?.name ?? slot.serviceId;
            const inputId = `booking-time-${slot.slotId}`;
            return (
              <div className="field" key={slot.slotId} style={{ maxWidth: 260 }}>
                <label htmlFor={inputId}>
                  {idx + 1}. {name}
                </label>
                {mode === 'TIME_BLOCK' ? (
                  <select
                    id={inputId}
                    className="inp"
                    value={slot.timeBlockId ?? ''}
                    onChange={(e) => props.onSlotBlockChange(slot.slotId, e.target.value)}
                  >
                    {slot.timeBlockId === null && <option value="">Choose a time block</option>}
                    {timeBlocks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {timeBlockLabel(b)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={inputId}
                    type="time"
                    className="inp"
                    value={slot.time}
                    onChange={(e) => props.onSlotTimeChange(slot.slotId, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {pattern === 'weekly' ? (
        <>
          <p className={weeklyBlocker === null ? 'wiz-ok' : 'wiz-warn'}>
            {weeklyBlocker ?? `${weeklyEmitted} visit(s) over ${weekCount} weeks. Your Auntie confirms each visit.`}
          </p>
          {weeklyCapped && (
            <p className="wiz-warn">
              That&rsquo;s more than we can book at once. Only the first {MAX_RECURRING_VISITS} visits will be requested. Reduce the days or weeks
              to send fewer.
            </p>
          )}
        </>
      ) : individualBlocker !== null ? (
        <p className={props.selectedDates.size === 0 ? 'sub' : 'wiz-warn'}>{individualBlocker}</p>
      ) : (
        <p className="wiz-ok">
          {props.selectedDates.size} {props.selectedDates.size === 1 ? 'date' : 'dates'} selected, {visitCount}{' '}
          {visitCount === 1 ? 'visit' : 'visits'}
        </p>
      )}

      {closedDatesInPlan.length > 0 && (
        <p className="wiz-warn">
          {closedDatesInPlan.length === 1
            ? `${closedDatesInPlan[0]} is closed`
            : `${closedDatesInPlan.length} of these dates are closed (${closedDatesInPlan.join(', ')})`}
          . Remove {closedDatesInPlan.length === 1 ? 'it' : 'them'} to continue. A closed date can&rsquo;t be booked.
        </p>
      )}

      {pastVisitCount > 0 && (
        <p className="wiz-warn">
          {pastVisitCount === 1 ? '1 visit in this plan has' : `${pastVisitCount} visits in this plan have`} already
          started.{' '}
          {mode === 'TIME_BLOCK'
            ? 'Pick a later block, or drop today from the dates.'
            : 'Pick a later time, or drop today from the dates.'}
        </p>
      )}
    </>
  );
}

/**
 * #545: step 4 is what the stepper has always called it.
 *
 * The card that used to sit here was headed "Invoice Options" and offered no
 * option: it said an Auntie raises the invoice after she confirms, and gave the
 * household a Next button. Kinfolk do not choose how they are billed, so
 * nothing belonged on this step but the note the stepper already promised —
 * which was stranded at the bottom of Review. It lives here now.
 */
function Step4ExtraLoveAndContext(props: { notes: string; onNotesChange: (v: string) => void }) {
  return (
    <>
      <h3 className="title">Extra Love &amp; Context</h3>
      <p className="sub">Anything your Auntie should know before she arrives? Optional.</p>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="booking-notes">Extra Love &amp; Context</label>
        <textarea
          id="booking-notes"
          className="inp"
          value={props.notes}
          onChange={(e) => props.onNotesChange(e.target.value)}
          placeholder="e.g. She's a bit shy today, or the gate is tricky to open…"
        />
        <span className="hint" style={{ color: 'var(--coral)' }}>
          This note will be highlighted for Auntie during the visit.
        </span>
      </div>
    </>
  );
}

function Step5Review(props: {
  kinNames: string[];
  kinCareSummary: string;
  pattern: Pattern;
  visits: readonly RequestBookingArgsVisit[];
  /** Time-block booking: needed to NAME the window each visit was booked into. */
  timeBlocks: readonly TimeBlockDto[];
  notes: string;
  estimateLabel: string;
  capped: boolean;
  submitting: boolean;
  error: string | null;
}) {
  const { pattern, visits, notes, estimateLabel, capped, submitting, error } = props;
  const rendered = renderPlannedVisits(visits, props.timeBlocks);
  return (
    <>
      <h3 className="title">Review &amp; Confirm</h3>

      <div style={{ marginTop: 10 }}>
        <div className="sum-row">
          <div className="sk">Kin</div>
          <div className="sv">{props.kinNames.join(', ') || '—'}</div>
        </div>
        <div className="sum-row">
          <div className="sk">KinCare</div>
          <div className="sv">{props.kinCareSummary || '—'}</div>
        </div>
        <div className="sum-row">
          <div className="sk">Pattern</div>
          <div className="sv">{pattern === 'individual' ? 'Individual Dates' : 'Repeating Schedule'}</div>
        </div>
        <div className="sum-row">
          <div className="sk">Est. Price</div>
          <div className="sv">{estimateLabel}</div>
        </div>
      </div>

      {/*
        #547: "Pattern = Dates. Actually display those dates." Review used to
        print "3 visits" and leave the household to remember which three. Every
        visit is enumerated here, spelled the way
        docs/superpowers/specs/2026-08-23-visit-date-rendering-design.md
        spells one ("Thu, Sep 4 at 9:00 AM") so the wizard and the messages
        that follow it name the same day the same way.
      */}
      <h4 style={{ marginTop: 18 }}>
        {rendered.length === 1 ? '1 visit' : `${rendered.length} visits`}
      </h4>
      {rendered.length === 0 ? (
        <p className="sub">No visits in this booking yet.</p>
      ) : (
        <ul className="visitlist">
          {rendered.map((v) => (
            <li key={v.key}>
              <b>{plannedVisitLine(v)}</b>
              <small> {v.serviceName}</small>
            </li>
          ))}
        </ul>
      )}

      {capped && <p className="wiz-warn">Capped at {MAX_RECURRING_VISITS} visits. Reduce days or weeks to request fewer.</p>}

      <div className="sum-row" style={{ marginTop: 18 }}>
        <div className="sk">Extra Love &amp; Context</div>
        <div className={`sv ${notes.trim() ? '' : 'muted'}`}>{notes.trim() || 'None added'}</div>
      </div>

      {error && <p className="wiz-warn" style={{ marginTop: 12 }}>{error}</p>}
      {submitting && <p className="sub">Creating your booking…</p>}
    </>
  );
}
