import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { getServiceCatalog, requestBooking } from '../api/bookingApi';
import type { BookingVisitInput, RequestBookingResult, ServiceDto } from '../api/bookingApi';
import { getMyKin } from '../api/portal';
import type { KinDto } from '../api/types';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { BookingMonthPicker } from '../components/BookingMonthPicker';
import { LaunchError } from './LaunchError';
import {
  buildVisits,
  buildWeeklyVisits,
  MAX_RECURRING_VISITS,
  parseHourMinute,
  priceLabel,
  weeklyPotentialCount,
  weeklyVisitsBlocker,
} from '../lib/bookingWizardLogic';
import '../styles/booking.css';

type Pattern = 'individual' | 'weekly';

const STEP_LABELS = ['Kin', 'Service', 'Schedule Dates', 'Extra Love & Context', 'Review & Confirm'];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_COUNT_OPTIONS = [2, 4, 6, 8];
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
    const cat = s.category ?? 'Services';
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
 * (stepper, 3-col service grid, persistent summary/price rail) from
 * ui-ideas/mytribe-booking-wizard-2026-05-31.html. Step order follows the
 * Kotlin reference (Kin -> Service -> Dates -> Invoice -> Review), not the
 * mockup's single static screen (which only shows step 1 = Choose Service).
 *
 * `weeklyPreview` below is the single source of truth for the weekly-
 * pattern visit list: computed once per (pattern, weeklyDays, weekCount,
 * visitTime, serviceId) via useMemo (same shape as the Kotlin
 * `remember(...)` block) and reused for the Step 3 count, the summary
 * panel, the Review step, AND the requestBooking payload. That is what
 * fixes F35/F36 by construction: the count a kinfolk confirms can never
 * drift from what actually gets submitted.
 */
export function BookingWizardBody(props: BookingWizardBodyProps) {
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const [step, setStep] = useState(1);
  const [allKinMode, setAllKinMode] = useState(true);
  const [selectedKinIds, setSelectedKinIds] = useState<Set<string>>(new Set());
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [pattern, setPattern] = useState<Pattern>(props.startWeekly ? 'weekly' : 'individual');
  const [selectedDates, setSelectedDates] = useState<Map<string, Date>>(new Map());
  const [weeklyDays, setWeeklyDays] = useState<Set<number>>(new Set());
  const [weekCount, setWeekCount] = useState(4);
  const [visitTime, setVisitTime] = useState('09:00');
  const [notes, setNotes] = useState('');

  const kinQuery = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });
  const servicesQuery = useQuery({ queryKey: ['serviceCatalog'], queryFn: () => getServiceCatalog() });

  const activeKin = useMemo(() => (kinQuery.data?.kin ?? []).filter((k) => k.status === 'active'), [kinQuery.data]);
  const services = servicesQuery.data?.services ?? [];
  const selectedService = services.find((s) => s.id === selectedServiceId) ?? null;
  const resolvedKinIds = allKinMode ? activeKin.map((k) => k.id) : [...selectedKinIds];

  // Single source of truth for the weekly series; see the doc comment above.
  const weeklyPreview: BookingVisitInput[] = useMemo(() => {
    if (pattern !== 'weekly' || !selectedService) return [];
    const t = parseHourMinute(visitTime);
    if (t === null || weeklyDays.size === 0 || weekCount < 1) return [];
    return buildWeeklyVisits({
      nowMs: Date.now(),
      weeklyDays,
      weeks: weekCount,
      time: t,
      serviceId: selectedService.id,
      serviceName: selectedService.name,
      priceCents: selectedService.priceCents ?? selectedService.priceMinCents,
    });
    // Deliberately keyed on the same inputs as the Kotlin `remember(...)`
    // block (pattern, weeklyDays, weekCount, visitTime, selectedServiceId).
    // NOT on `services`/`selectedService` object identity, and NOT on a
    // ticking clock, so this recomputes exactly when the rule changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, weeklyDays, weekCount, visitTime, selectedServiceId]);

  const weeklyPotential = weeklyPotentialCount(weeklyDays, weekCount);
  const weeklyCapped = pattern === 'weekly' && weeklyPreview.length > 0 && weeklyPotential > weeklyPreview.length;
  const weeklyBlocker = weeklyVisitsBlocker(weeklyDays, weekCount, visitTime);
  const individualReady = selectedDates.size > 0 && parseHourMinute(visitTime) !== null;
  const scheduleReady = pattern === 'individual' ? individualReady : weeklyBlocker === null;
  const visitCount = pattern === 'weekly' ? weeklyPreview.length : selectedDates.size;

  const canAdvance = (() => {
    switch (step) {
      case 1:
        return allKinMode ? activeKin.length > 0 : selectedKinIds.size > 0;
      case 2:
        return selectedServiceId !== null;
      case 3:
        return scheduleReady;
      default:
        return true;
    }
  })();

  const submit = useMutation({
    mutationFn: async () => {
      if (!selectedService) throw new Error('Choose a service first.');
      const visits = pattern === 'weekly' ? weeklyPreview : buildVisits([...selectedDates.values()], visitTime, selectedService);
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
              {step === 2 && <Step2ServiceSelect services={services} selectedId={selectedServiceId} onSelect={setSelectedServiceId} />}
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
                  visitTime={visitTime}
                  onVisitTimeChange={setVisitTime}
                  serviceLabel={selectedService?.name ?? 'Service'}
                  weeklyEmitted={weeklyPreview.length}
                  weeklyCapped={weeklyCapped}
                  weeklyBlocker={weeklyBlocker}
                />
              )}
              {step === 4 && <Step4InvoiceOptions />}
              {step === 5 && (
                <Step5Review
                  kinNames={allKinMode ? ['All Kin in this home'] : activeKin.filter((k) => selectedKinIds.has(k.id)).map((k) => k.name ?? 'Unnamed Kin')}
                  service={selectedService}
                  pattern={pattern}
                  visitCount={visitCount}
                  visitTime={visitTime}
                  notes={notes}
                  onNotesChange={setNotes}
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
                  disabled={submit.isPending || !selectedService || !scheduleReady}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending ? 'Creating…' : 'Create Booking'}
                </button>
              )}
            </div>
          </div>

          <div className="stack">
            <section className="glass card d3">
              <div className="sectlabel">Booking summary</div>

              <div className="sum-row">
                <div className="sk">Service</div>
                {selectedService ? (
                  <div className="sv">
                    {selectedService.name}
                    {selectedService.category && <small>{selectedService.category}</small>}
                  </div>
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
                    {pattern === 'weekly' && <small>over {weekCount} weeks</small>}
                  </div>
                ) : (
                  <div className="sv muted">No dates selected yet.</div>
                )}
              </div>

              <div className="price-box">
                <span className="pl">Estimated Price</span>
                <span className="pv">
                  {selectedService ? priceLabel(selectedService) || '—' : '$0'}
                  <small> {selectedService ? '' : '/ pending'}</small>
                </span>
              </div>
              <p className="sub" style={{ marginTop: 12 }}>
                Your estimate updates as you add Kin and dates. Your Auntie confirms the final price before the booking starts.
              </p>
            </section>

            <section className="glass card d4">
              <div className="sectlabel">Booking for</div>
              {activeKin.length === 0 ? (
                <p className="sub">No Kin on file yet.</p>
              ) : (
                activeKin.map((k) => (
                  <div className="kinrow" key={k.id}>
                    <div className="pic">{'\u{1F43E}'}</div>
                    <div>
                      <b>{k.name ?? 'Unnamed Kin'}</b>
                      <small>{kinSubtitle(k).toUpperCase()}</small>
                    </div>
                  </div>
                ))
              )}
              <p className="sub" style={{ margin: '8px 2px 0' }}>
                Pick which Kin to include in step 1.
              </p>
            </section>
          </div>
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
              <span className="ks">{kin.map((k) => k.name).filter(Boolean).join(', ')}</span>
            </div>
            {allKinMode && <SelectedIndicator />}
          </button>

          <button type="button" className="btn ghost block" style={{ marginTop: 12 }} onClick={() => onToggleAllMode(!allKinMode)}>
            {allKinMode ? 'Choose specific Kin' : 'Use All Kin instead'}
          </button>

          {!allKinMode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {kin.map((k) => {
                const selected = selectedIds.has(k.id);
                return (
                  <button type="button" key={k.id} className="kinopt" onClick={() => onToggle(k.id)}>
                    <div>
                      <div className="kt">{k.name ?? 'Unnamed Kin'}</div>
                      {kinSubtitle(k) && <span className="ks">{kinSubtitle(k)}</span>}
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

function Step2ServiceSelect(props: { services: ServiceDto[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const groups = groupServicesByCategory(props.services);
  return (
    <>
      <h3 className="title">Choose Service</h3>
      <p className="sub">Choose the service you&rsquo;d like for this booking.</p>
      {groups.map(([category, list]) => (
        <div key={category}>
          <div className="svc-category">{category}</div>
          <div className="svc-grid" role="radiogroup" aria-label="Service">
            {list.map((s) => {
              const selected = s.id === props.selectedId;
              return (
                <button
                  type="button"
                  key={s.id}
                  className={`svc ${selected ? 'sel' : ''}`}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => props.onSelect(s.id)}
                >
                  <div className="pick">{'✓'}</div>
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
  visitTime: string;
  onVisitTimeChange: (t: string) => void;
  serviceLabel: string;
  weeklyEmitted: number;
  weeklyCapped: boolean;
  weeklyBlocker: string | null;
}) {
  const { pattern, weeklyDays, weekCount, visitTime, weeklyEmitted, weeklyCapped, weeklyBlocker } = props;
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
          <p className="sub">Tap dates to add or remove from the booking.</p>
          <BookingMonthPicker selectedDates={new Set(props.selectedDates.keys())} onToggle={props.onToggleDate} />
        </>
      )}

      <div className="field" style={{ marginTop: 18, maxWidth: 220 }}>
        <label htmlFor="booking-time">Visit Time</label>
        <input
          id="booking-time"
          type="time"
          className="inp"
          value={visitTime}
          onChange={(e) => props.onVisitTimeChange(e.target.value)}
        />
      </div>
      <p className="sub" style={{ marginTop: 8 }}>
        Service: {props.serviceLabel}
      </p>

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
      ) : props.selectedDates.size === 0 ? (
        <p className="sub">No dates selected yet.</p>
      ) : (
        <p className="wiz-ok">
          {props.selectedDates.size} {props.selectedDates.size === 1 ? 'date' : 'dates'} selected
        </p>
      )}
    </>
  );
}

function Step4InvoiceOptions() {
  return (
    <>
      <h3 className="title">Invoice Options</h3>
      <p className="sub">
        Auntie creates and sends the invoice once she confirms. You&rsquo;ll be able to add any extra context for Auntie in the next step.
      </p>
    </>
  );
}

function Step5Review(props: {
  kinNames: string[];
  service: ServiceDto | null;
  pattern: Pattern;
  visitCount: number;
  visitTime: string;
  notes: string;
  onNotesChange: (v: string) => void;
  capped: boolean;
  submitting: boolean;
  error: string | null;
}) {
  const { service, pattern, visitCount, visitTime, notes, onNotesChange, capped, submitting, error } = props;
  return (
    <>
      <h3 className="title">Review &amp; Confirm</h3>

      <div style={{ marginTop: 10 }}>
        <div className="sum-row">
          <div className="sk">Kin</div>
          <div className="sv">{props.kinNames.join(', ') || '—'}</div>
        </div>
        <div className="sum-row">
          <div className="sk">Service</div>
          <div className="sv">{service?.name ?? '—'}</div>
        </div>
        <div className="sum-row">
          <div className="sk">Pattern</div>
          <div className="sv">{pattern === 'individual' ? 'Individual Dates' : 'Repeating Schedule'}</div>
        </div>
        <div className="sum-row">
          <div className="sk">Visits</div>
          <div className="sv">{visitCount === 1 ? '1 visit' : `${visitCount} visits`}</div>
        </div>
        <div className="sum-row">
          <div className="sk">Time</div>
          <div className="sv">{visitTime}</div>
        </div>
        {service && (
          <div className="sum-row">
            <div className="sk">Est. Price</div>
            <div className="sv">{priceLabel(service) || '—'}</div>
          </div>
        )}
      </div>
      {capped && <p className="wiz-warn">Capped at {MAX_RECURRING_VISITS} visits. Reduce days or weeks to request fewer.</p>}

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="booking-notes">Extra Love &amp; Context</label>
        <textarea
          id="booking-notes"
          className="inp"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="e.g. She's a bit shy today, or the gate is tricky to open…"
        />
        <span className="hint" style={{ color: 'var(--coral)' }}>
          This note will be highlighted for Auntie during the visit.
        </span>
      </div>

      {error && <p className="wiz-warn" style={{ marginTop: 12 }}>{error}</p>}
      {submitting && <p className="sub">Creating your booking…</p>}
    </>
  );
}
