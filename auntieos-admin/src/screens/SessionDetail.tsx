import { useEffect, useMemo, useState } from 'react';
import { type SessionEntry } from '../api/sessions';
import { kinForHouseholdQuery, type Kin, type Kinfolk } from '../api/directory';
import { getBusinessSettings } from '../api/settings';
import { serviceOptionsFromRates, type ServiceOption } from '../lib/newBooking';
import { useCollection, useDocById } from '../lib/firestore';
import { updateKinCareSession } from '../api/sessionsWrite';
import {
  appendOfficeNote,
  lifecycleActionsFor,
  lifecycleNowIso,
} from '../lib/sessionLifecycle';
import { useVisitLifecycle } from '../lib/useVisitLifecycle';
import { useVisitTracking } from '../lib/visitTracking';
import {
  VisitTrackingIndicator,
  routeEmptyTextWhileArrived,
} from '../components/VisitTrackingIndicator';
import { useBreadcrumbs, routePointsFromGpsSummary } from '../lib/breadcrumbs';
import { useHouseholdLocation } from '../lib/householdLocation';
import {
  sessionState,
  type SessionState,
  sessionStateInfo,
  SESSION_STATE_TONE,
  sessionHousehold,
  sessionWindow,
  sessionClock,
  sessionDayKey,
  sessionDayLabel,
  localDateIso,
} from '../lib/sessionFormat';
import { str, arr } from '../lib/coerce';
import {
  DenScreenHeading,
  DenPanel,
  StatusPill,
  EmptyHint,
  ErrorHint,
} from '../components/DenScreenKit';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { RouteMap } from '../components/RouteMap';
import './SessionDetail.css';

interface SessionDetailProps {
  /**
   * The session row. `routes/SessionDetailView.tsx` resolves it through
   * `useDocById`, a LIVE document subscription, rather than by value out of the
   * board's paged list: this screen hosts writes, and `useDocById`'s own header
   * states the rule -- "a frozen copy of the record would disagree with the list
   * behind it the moment one landed". A clock-in here therefore repaints this
   * screen from the document the server actually wrote, never from what the
   * client hoped it wrote, so an optimistic status can never survive a refusal.
   *
   * `null` means the read produced no row. WHICH kind of no row it is comes from
   * `read` below, never from this prop on its own.
   */
  entry: SessionEntry | null;
  /**
   * What the by-id read is doing while it is not `ready`, so a null `entry` is
   * reported as the thing it actually is.
   *
   * Three answers, not one. A read still in flight is not a removed visit, and a
   * refused read is not one either, so calling either of them "no longer
   * available" would be this screen inventing a fact about the record. Absent
   * means the caller already holds a settled answer, and a null entry there is a
   * visit that genuinely is not on file.
   */
  read?: { status: 'loading' } | { status: 'error'; message: string; retry?: () => void };
  onBack: () => void;
}

/**
 * One read-only line of the Details panel: the mock's `.field`, a dim key on
 * the left and a bold value on the right. Renders nothing when the value is
 * blank (never "undefined"), the KinfolkProfile `Fact` convention.
 */
function FieldRow({ label, value }: { label: string; value: string }) {
  if (value.trim() === '') return null;
  return (
    <div className="sdetail__row">
      <span className="sdetail__row-key">{label}</span>
      <span className="sdetail__row-value">{value}</span>
    </div>
  );
}

/**
 * The mock's five lifecycle nodes, in visit order. `SessionState` names the
 * same five plus cancelled and unknown, which are not steps: cancelled is the
 * absence of a visit and unknown is a status nobody wrote, so neither gets a
 * node, and the hero pill is where they are named.
 */
type StampedStep = 'onMyWay' | 'arrived' | 'departed' | 'completed';
type StepState = 'scheduled' | StampedStep;

const LIFECYCLE_STEPS: readonly { state: StepState; name: string }[] = [
  { state: 'scheduled', name: 'Scheduled' },
  { state: 'onMyWay', name: 'On my way' },
  { state: 'arrived', name: 'Arrived' },
  { state: 'departed', name: 'Departed' },
  { state: 'completed', name: 'Completed' },
];

type StepMood = 'done' | 'now' | 'todo';

interface LifecycleStep {
  state: StepState;
  name: string;
  mood: StepMood;
  /** The local moment the step was stamped, or '' when it was not. */
  stamp: string;
}

/**
 * Which node is lit, and how, for the stepper the mock draws under
 * "Visit lifecycle".
 *
 * A step is DONE when its own timestamp is on the record, NOW when it is the
 * state the visit is in, TODO otherwise. Done is read from the stamp and never
 * from "every step before the current one": a visit the office completed from
 * Bookings without a clock-out has `completedAt` and no `departedAt`, and
 * lighting Departed on that visit would make every office completion look as
 * though someone had clocked out of it, the exact defect the old "Clocked out"
 * line was fixed for. Scheduled is the one step with no stamp on the record
 * (a session document is the scheduling), so it is NOW while the visit waits
 * and DONE the moment anything else has happened to it.
 */
function lifecycleSteps(state: SessionState, stamps: Record<StampedStep, string>): LifecycleStep[] {
  return LIFECYCLE_STEPS.map(({ state: step, name }) => {
    const stamp = step === 'scheduled' ? '' : stamps[step];
    const mood: StepMood =
      step === state
        ? 'now'
        : step === 'scheduled' || stamp !== ''
          ? 'done'
          : 'todo';
    return { state: step, name, mood, stamp };
  });
}

/**
 * How far along the progress bar runs, as a fraction of the distance between
 * the first and last node: to the last node that is not still to come.
 */
function lifecycleProgress(steps: readonly LifecycleStep[]): number {
  let last = 0;
  steps.forEach((s, i) => {
    if (s.mood !== 'todo') last = i;
  });
  return steps.length < 2 ? 0 : last / (steps.length - 1);
}

/**
 * A single session ISO field as a LOCAL "Today · 20:00" moment, composed ONLY
 * from the existing AO-18 helpers (`sessionDayKey`/`sessionDayLabel`/`sessionClock`
 * in lib/sessionFormat.ts), never new date logic or `toLocaleString`. Blank when
 * the field is empty or does not parse, so a lifecycle node stamps nothing rather
 * than a fabricated "(no time)" clock or an "Undated" day.
 */
function localMoment(iso: string, todayIso: string): string {
  if ((iso ?? '').trim() === '') return '';
  const clock = sessionClock(iso);
  if (clock === '(no time)') return '';
  const key = sessionDayKey(iso);
  const day = key === 'Undated' ? '' : sessionDayLabel(key, todayIso);
  return day === '' ? clock : `${day} · ${clock}`;
}

/** The three async states a write can be in, kept apart rather than merged into a boolean. */
type WriteState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'error'; message: string }
  | { status: 'done'; message: string };

function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : 'The write failed.';
}

/**
 * Kin Care session detail: the operational card for ONE visit, and the WRITE
 * surface the web admin did not have (#397 L19).
 *
 * WHAT CHANGED, and against what. This screen used to be read-only, and
 * `Sessions.tsx`'s header said so in as many words: "Still NOT built here: the
 * WRITE flows, clock-in/out, GPS tracking". Android ships all three, so this is
 * the port, and every behaviour below is transcribed from a named Android
 * surface rather than designed here:
 *
 *   the visit clock     `ui/home/HomeScreen.kt#TodayVisitCardView`'s
 *                       `LifecycleButton` enablement, plus Auntie Time's
 *                       "Undo Arrival" (`ui/admin/KinCareSessionsScreen.kt`).
 *                       Which buttons appear from which state lives in
 *                       `lib/sessionLifecycle.ts#lifecycleActionsFor`.
 *   note to office      `KinCareSessionsScreen.kt#appendOfficeNote`, format and
 *                       newest-first ordering included.
 *   the route           `ui/components/RouteMap.kt` + `LiveTrackingScreen.kt`:
 *                       a polyline over the breadcrumb subcollection, live only
 *                       while ARRIVED. Since #760 that polyline is drawn over a
 *                       Mapbox satellite basemap with the visit's times on a
 *                       strip above it, and the Android Kin Care detail carries
 *                       the same map; the Canvas polyline is the fallback on
 *                       both platforms, not the target.
 *
 * THE LAYOUT IS THE MOCK'S, `ui-ideas/auntieos-kincare-detail-2026-05-27.html`,
 * since the #755 sweep: a hero band naming the visit by its Kin and service with
 * the status pill on its right edge, then Visit lifecycle (the five-node
 * stepper over the action row), the Route map, the two note boxes side by side
 * and a Details panel of key/value rows. The old Status, Visit clock, Timing,
 * Kin and Notes panels are those same facts re-homed, not dropped: the pill
 * and the service went up into the hero, the clock times became the stepper's
 * stamps, the Kin facts became a Details row above the picker, and the note
 * composer sits in the admin-internal box. What the mock draws that this screen
 * does not is the Kin photo stack at the front of the hero, which needs a
 * leading slot on `DenScreenHeading`.
 *
 * THE BUTTONS ARE A COURTESY, THE SERVER IS THE GUARD. `lifecycleActionsFor`
 * only OFFERS what applies to the state being rendered, so the operator is not
 * shown a control that will fail. It is not the enforcement:
 * `functions/src/lib/visitLifecycle.ts` refuses an illegal action from a stale
 * row or a second operator and audits the attempt, and its sentence is what the
 * operator reads. Same split `BookingActions.tsx` documents for its own map.
 *
 * WHOSE LOCATION POLICY APPLIES TO THE GPS PANEL: the operator's own, which is
 * to say none. `allowClientLocationSharing` is the "Let kinfolk see visit
 * locations" switch and it governs HOUSEHOLD surfaces only -- see
 * `lib/breadcrumbs.ts`'s header for the two citations. An admin's read is
 * untouched by it, so this panel draws the route whatever the switch says.
 */
export function SessionDetail({ entry, read, onBack }: SessionDetailProps) {
  // "Today" doesn't change mid-view; computed once (the Sessions.tsx todayIso
  // rationale). Called unconditionally, above the null branch, per Rules of Hooks.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  const sessionId = entry?._id ?? null;
  const status = str(entry?.status);
  const state = sessionState(status);
  const household = entry === null ? 'the household' : sessionHousehold(str(entry.kinfolkName));

  // ── the hero band ──────────────────────────────────────────────────────────
  // The mock names the visit by its Kin and its service ("Biscuit & Gravy ·
  // 30-min walk"), puts the day, the window, the household and the door on the
  // line under it, and hangs the status pill off the right edge. The household
  // is the fallback name, never the first choice: on this screen the family is
  // context and the visit is the subject.
  const kinNames = arr<string>(entry?.kinNames).filter((n) => n.trim() !== '');
  const kinLabel = kinNames.join(' & ');
  const serviceTypeNow = str(entry?.serviceType);
  const sessionLabel =
    entry === null ? 'Kin Care session' : kinLabel !== '' ? kinLabel : household;
  const heroTitle =
    entry === null
      ? 'Kin Care session'
      : [kinLabel, serviceTypeNow].filter((p) => p.trim() !== '').join(' · ') || household;
  // The door comes off the household record, the one field this screen reads
  // from it. A live subscription for the reason `useHouseholdLocation` gives:
  // the address is edited from the Kinfolk profile, and a frozen copy would
  // keep sending the Auntie to the old street.
  const kinfolkDoc = useDocById<Kinfolk>('kinfolk', entry === null ? null : str(entry.kinfolkId));
  const address = kinfolkDoc.status === 'ready' ? str(kinfolkDoc.data?.serviceAddress).trim() : '';
  const startKey = sessionDayKey(str(entry?.startTime));
  const dayLabel = startKey === 'Undated' ? '' : sessionDayLabel(startKey, todayIso);
  const heroDetail =
    entry === null
      ? ''
      : [dayLabel, sessionWindow(str(entry.startTime), str(entry.endTime)), household, address]
          .filter((p) => p.trim() !== '')
          .join(' · ');

  // ── the visit clock ────────────────────────────────────────────────────────
  // The four in-visit writes, the confirm gate and the sentence they produce all
  // live in `lib/useVisitLifecycle.ts` now, because the Auntie Time CARD drives
  // the same clock since #703 and two copies of "did the server actually change
  // anything?" would drift. This screen keeps its own dialog and its own action
  // row; the hook keeps the write. No refresh callback is passed here: `entry`
  // is a LIVE `useDocById` subscription, so the document repaints itself.
  const clock = useVisitLifecycle(sessionId, household);
  // Whether THIS browser is writing the route (#772). Drives the live line
  // under the clock and the Route panel's empty sentence while ARRIVED.
  const tracking = useVisitTracking(sessionId);

  // ── the details edit ───────────────────────────────────────────────────────
  const currentServiceType = str(entry?.serviceType);
  const currentDuration = entry?.serviceDurationMinutes;
  const [serviceType, setServiceType] = useState(currentServiceType);
  const [duration, setDuration] = useState(
    typeof currentDuration === 'number' ? String(currentDuration) : '',
  );
  const [kinSelection, setKinSelection] = useState<string[] | null>(null);
  const [editWrite, setEditWrite] = useState<WriteState>({ status: 'idle' });

  // Re-seed the form whenever the document itself changes identity, so opening a
  // second visit never inherits the first one's half-typed edit. Keyed on the
  // id, NOT on the values: re-seeding on every value change would fight the
  // operator's typing the moment the live listener delivered anything.
  useEffect(() => {
    setServiceType(currentServiceType);
    setDuration(typeof currentDuration === 'number' ? String(currentDuration) : '');
    setKinSelection(null);
    setEditWrite({ status: 'idle' });
    // The visit clock's own reset lives in `useVisitLifecycle`, keyed on the
    // same id, so it is not repeated here.
    setNoteText('');
    setNoteWrite({ status: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const [catalog, setCatalog] = useState<ServiceOption[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getBusinessSettings()
      .then((s) => {
        if (cancelled) return;
        setCatalog(serviceOptionsFromRates(s.serviceRates, s.serviceDurations));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed catalog read is NOT a reason to hide the field: the visit's
        // own service type is still true and still editable as free text. It is
        // a reason to say the picker is missing, so the operator knows why they
        // are typing instead of choosing.
        setCatalogError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The household's roster, for the Kin checkboxes. A blank household matches
  // nothing, which is exactly right (see `kinForHouseholdQuery`).
  const roster = useCollection<Kin>(kinForHouseholdQuery(str(entry?.kinfolkId)));

  const savedKinIds = arr<string>(entry?.kinIds);
  const effectiveKinIds = kinSelection ?? savedKinIds;
  const kinDirty =
    kinSelection !== null &&
    (kinSelection.length !== savedKinIds.length ||
      kinSelection.some((id) => !savedKinIds.includes(id)));
  const durationDirty = duration !== (typeof currentDuration === 'number' ? String(currentDuration) : '');
  const serviceDirty = serviceType !== currentServiceType;
  const editDirty = serviceDirty || durationDirty || kinDirty;

  const durationValue = duration.trim() === '' ? null : Number(duration);
  const durationValid =
    durationValue === null ||
    (Number.isInteger(durationValue) && durationValue >= 0 && durationValue <= 24 * 60);

  async function saveDetails() {
    if (sessionId === null || !editDirty) return;
    if (!durationValid) {
      setEditWrite({ status: 'error', message: 'Visit length must be a whole number of minutes, 0 to 1440.' });
      return;
    }
    setEditWrite({ status: 'saving' });
    try {
      // A PATCH OF STATED KEYS ONLY, never a rebuild from form state. Sending
      // an unchanged field would be harmless here but would make this the third
      // surface in the codebase that saves by rebuilding a model, which is the
      // pattern that wipes fields no form has a control for.
      const res = await updateKinCareSession(sessionId, {
        ...(serviceDirty ? { serviceType: serviceType.trim() } : {}),
        ...(durationDirty && durationValue !== null ? { serviceDurationMinutes: durationValue } : {}),
        ...(kinDirty && kinSelection !== null ? { kinIds: kinSelection } : {}),
      });
      setKinSelection(null);
      setEditWrite({ status: 'done', message: `Saved: ${res.updated.join(', ')}.` });
    } catch (err) {
      setEditWrite({ status: 'error', message: messageOf(err) });
    }
  }

  // ── note to office ─────────────────────────────────────────────────────────
  const [noteText, setNoteText] = useState('');
  const [noteWrite, setNoteWrite] = useState<WriteState>({ status: 'idle' });

  async function sendOfficeNote() {
    if (sessionId === null) return;
    const typed = noteText.trim();
    if (typed === '') return;
    setNoteWrite({ status: 'saving' });
    try {
      await updateKinCareSession(sessionId, {
        notes: appendOfficeNote(str(entry?.notes), typed, lifecycleNowIso()),
      });
      setNoteText('');
      setNoteWrite({ status: 'done', message: 'Note added to this visit.' });
    } catch (err) {
      setNoteWrite({ status: 'error', message: messageOf(err) });
    }
  }

  // ── GPS ────────────────────────────────────────────────────────────────────
  // Live pings while a visit is in flight; the durable `gpsSummary` copy once it
  // is not. Both are needed: `purgeOldVisitRoutes` deletes breadcrumbs past the
  // retention window, so a completed visit's only route is the summary, and a
  // panel that read breadcrumbs alone would go blank on exactly the visits an
  // operator reviews.
  const inFlight = state === 'arrived' || state === 'departed';
  const crumbs = useBreadcrumbs(inFlight ? sessionId : null);
  const summaryRoute = useMemo(
    () => routePointsFromGpsSummary(entry?.gpsSummary),
    [entry],
  );
  const route = crumbs.points.length > 0 ? crumbs.points : summaryRoute;
  const gpsSummary = entry?.gpsSummary;
  // The purple house marker's coordinate (#760). Read from the household's own
  // record, never geocoded here: `lib/householdLocation.ts` says why, and the
  // map simply draws no house when the record has none.
  const house = useHouseholdLocation(str(entry?.kinfolkId));

  return (
    <div className="screen">
      <DenScreenHeading
        // "Auntie Time" is the rail's name for /sessions (lib/nav.ts: "the rail
        // says Auntie Time; the slug and the code say sessions"), and a crumb
        // that called it anything else would name a screen the operator cannot
        // find. `onSelect` runs the same `onBack` the trailing button does, and
        // since #753 that is a real route move back to `/sessions`. The crumb IS
        // the way back: the mock's hero carries the status pill on its right
        // edge and no button, so the "Back to Auntie Time" button that used to
        // sit there is gone rather than crowding the pill.
        crumbs={[{ label: 'Auntie Time', onSelect: onBack }, { label: sessionLabel }]}
        title={heroTitle}
        subtitle="Kin Care session detail."
        detail={heroDetail === '' ? undefined : heroDetail}
        trailing={
          entry === null ? undefined : (
            <StatusPill
              label={sessionStateInfo(state).chipLabel}
              tone={SESSION_STATE_TONE[state]}
              struck={state === 'cancelled'}
            />
          )
        }
      />

      {entry === null ? (
        // THE THREE NO-ROW ANSWERS, kept apart (#753). A refresh on
        // `/sessions/<id>` now mounts this screen with nothing resolved yet, so
        // the old single "no longer available" line would have accused every
        // reload of naming a removed visit.
        read?.status === 'loading' ? (
          <DenPanel title="Kin Care session">
            {/* The Bookings by-id sheet says "Looking this booking up…" for the
                same moment, and the same voice is the point: the operator should
                not have to learn two sentences for one wait. */}
            <p className="den-hint" role="status">
              Looking this Kin Care session up…
            </p>
          </DenPanel>
        ) : read?.status === 'error' ? (
          <DenPanel title="Session unavailable">
            <ErrorHint>
              Couldn&rsquo;t read this Kin Care session. {read.message}
              {read.retry && (
                <button type="button" className="async-retry" onClick={read.retry}>
                  Retry
                </button>
              )}
            </ErrorHint>
          </DenPanel>
        ) : (
          <DenPanel title="Session unavailable">
            <EmptyHint>
              No Kin Care session is on file under this id. It may have been removed. The Auntie
              Time crumb above returns to the board.
            </EmptyHint>
          </DenPanel>
        )
      ) : (
        (() => {
          // Every field is read through `str()`/`arr()`: `SessionEntry` is a cast
          // over raw Firestore data, not a validation of it (see api/sessions.ts),
          // so a doc can genuinely lack any of these. An absent field reads as
          // blank, which the sections below already hide (`Fact`/`any`) and the
          // helpers already classify honestly ('unknown', 'Undated'), rather than
          // throwing and blanking the view.
          const info = sessionStateInfo(state);
          const notes = str(entry.notes).trim();
          const kinfolkNotes = str(entry.kinfolkNotes).trim();
          // R1: a KinCare session covers EVERY Kin in the home, so the Kin row
          // is always shown. It used to be hidden whenever `kinIds` was empty,
          // and empty was exactly the whole-household case -- a booking for the
          // dog AND the cat rendered with no Kin line at all.
          const kinIds = savedKinIds;
          const reportCount = arr<string>(entry.reportIds).filter((id) => id.trim() !== '').length;
          const rate = catalog?.find((o) => o.name === serviceTypeNow)?.rate ?? '';

          // DEPARTED IS `departedAt`, NOT `completedAt`, and the old "Clocked
          // out" line used to read the wrong field. They are different events:
          // departing is the Auntie leaving the house, completing is the office
          // ruling the visit happened and is billable, and
          // `transitionBookingStatus` can stamp the second without the first
          // ever having been stamped. Labelling completion as a clock-out made
          // every visit completed from the Bookings screen look as though
          // someone had clocked out of it. `lifecycleSteps` reads each node from
          // its own stamp for the same reason.
          const steps = lifecycleSteps(state, {
            onMyWay: localMoment(str(entry.onMyWayAt), todayIso),
            arrived: localMoment(str(entry.arrivedAt), todayIso),
            departed: localMoment(str(entry.departedAt), todayIso),
            completed: localMoment(str(entry.completedAt), todayIso),
          });
          const progress = lifecycleProgress(steps);

          const actions = lifecycleActionsFor(state);

          return (
            <>
              {/* The mock's first panel: the five nodes with their stamps, the
                  progress bar to the lit one, then the action row. The status
                  pill and the service moved up into the hero band with #755, so
                  the "Status" panel that used to sit here is gone. */}
              <DenPanel
                title="Visit lifecycle"
                className="d1"
                subtitle="On the way, clocked in, clocked out. The office marks a visit Completed from Bookings."
              >
                {state === 'unknown' && (
                  <p className="sdetail__hint">
                    This session&rsquo;s status (&ldquo;{status}&rdquo;) isn&rsquo;t recognized, so
                    it is shown as UNKNOWN rather than guessed into a state.
                  </p>
                )}
                <div className="sdetail__life">
                  <span
                    className="sdetail__lifebar"
                    aria-hidden="true"
                    style={{ width: `${String(progress * 80)}%` }}
                  />
                  <ol className="sdetail__steps" aria-label="Visit lifecycle">
                    {steps.map((s) => (
                      <li key={s.state} className="sdetail__step" data-mood={s.mood}>
                        <span className="sdetail__node" aria-hidden="true">
                          {s.mood === 'done' ? '✓' : s.mood === 'now' ? '●' : ''}
                        </span>
                        <span className="sdetail__step-name">{s.name}</span>
                        {/* A stamp when there is one. A node still to come reads
                            "--"; a lit node with nothing on the record (Scheduled
                            has no booking timestamp on the session) reads
                            nothing, rather than a dash that says "not yet". */}
                        {(s.stamp !== '' || s.mood === 'todo') && (
                          <span className="sdetail__step-ts">{s.stamp === '' ? '--' : s.stamp}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
                {actions.length === 0 ? (
                  <EmptyHint>
                    {state === 'completed' || state === 'cancelled'
                      ? `This visit is ${info.label.toLowerCase()}, so its clock is closed.`
                      : 'This session’s status is not one the visit clock recognizes, so no clock action is offered rather than guessing one.'}
                  </EmptyHint>
                ) : (
                  <div className="sdetail__actions">
                    {actions.map((a) =>
                      a.tone === 'primary' ? (
                        <PrimaryButton
                          key={a.action}
                          label={a.label}
                          onClick={() => clock.ask(a)}
                          disabled={clock.saving}
                        />
                      ) : (
                        <GhostButton
                          key={a.action}
                          label={a.label}
                          onClick={() => clock.ask(a)}
                          disabled={clock.saving}
                        />
                      ),
                    )}
                  </div>
                )}
                {state === 'arrived' && sessionId !== null && (
                  <VisitTrackingIndicator sessionId={sessionId} />
                )}
                {clock.write.status === 'error' && (
                  <ErrorHint>
                    Couldn&rsquo;t update the visit clock. {clock.write.message}
                  </ErrorHint>
                )}
                {clock.write.status === 'done' && (
                  <p className="sdetail__ok" role="status">
                    {clock.write.message}
                  </p>
                )}
              </DenPanel>

              <DenPanel
                title="Route"
                subtitle="GPS breadcrumbs recorded during the visit. Operator view; the kinfolk sharing switch does not apply here."
                className="d2"
              >
                {crumbs.error !== null ? (
                  <ErrorHint>
                    Couldn&rsquo;t read the live GPS trail for this visit. {crumbs.error}
                  </ErrorHint>
                ) : route.length === 0 ? (
                  <EmptyHint>
                    {state === 'arrived'
                      ? routeEmptyTextWhileArrived(tracking)
                      : inFlight
                        ? 'No GPS breadcrumbs were recorded for this Kin Care.'
                        : state === 'completed' || state === 'cancelled' || state === 'unknown'
                          ? gpsSummary != null
                            ? 'A GPS summary was saved for this Kin Care, but it has no route points to draw.'
                            : 'No GPS breadcrumbs were recorded for this Kin Care because it was never tracked.'
                          : 'Tracking starts once an Auntie clocks in for this Kin Care.'}
                  </EmptyHint>
                ) : (
                  <>
                    <RouteMap
                      route={route}
                      live={state === 'arrived'}
                      distanceMeters={gpsSummary?.distanceMeters}
                      durationSeconds={gpsSummary?.durationSeconds}
                      arrivedAt={str(entry.arrivedAt)}
                      departedAt={str(entry.departedAt)}
                      house={house}
                    />
                    {crumbs.points.length === 0 && summaryRoute.length > 0 && (
                      <p className="sdetail__hint">
                        Replay from the route saved on this visit. The per-ping breadcrumbs are not
                        being read, so this is the down-sampled copy.
                      </p>
                    )}
                  </>
                )}
              </DenPanel>

              {/* The mock's two note boxes side by side: what the household
                  said about their own house, and what the office keeps to
                  itself. */}
              <div className="sdetail__cols">
                <DenPanel
                  title="Kinfolk-facing note"
                  className="d3"
                  meta={`visible to ${household}`}
                  subtitle="The household's own note for this visit, written when they booked. Notes to the household are added from the booking on Bookings."
                >
                  {kinfolkNotes === '' ? (
                    <p className="sdetail__nbox sdetail__nbox--empty">
                      No note from the household on this visit.
                    </p>
                  ) : (
                    <p className="sdetail__nbox">{kinfolkNotes}</p>
                  )}
                </DenPanel>

                <DenPanel
                  title="Admin-internal note"
                  className="d3"
                  meta="private"
                  subtitle="Only staff see this. A note is stamped and kept; nothing here is overwritten."
                >
                  {notes === '' ? (
                    <p className="sdetail__nbox sdetail__nbox--empty">No notes on this visit yet.</p>
                  ) : (
                    <p className="sdetail__nbox">{notes}</p>
                  )}
                  <label className="sdetail__field">
                    <span className="sdetail__field-label">Note to office</span>
                    <textarea
                      className="sdetail__input sdetail__textarea"
                      rows={3}
                      placeholder="What does the office need to know?"
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                    />
                  </label>
                  <div className="sdetail__actions">
                    <GhostButton
                      label={noteWrite.status === 'saving' ? 'Sending…' : 'Add note'}
                      onClick={() => void sendOfficeNote()}
                      disabled={noteText.trim() === '' || noteWrite.status === 'saving'}
                    />
                  </div>
                  {noteWrite.status === 'error' && (
                    <ErrorHint>
                      Couldn&rsquo;t add the note. {noteWrite.message}
                    </ErrorHint>
                  )}
                  {noteWrite.status === 'done' && (
                    <p className="sdetail__ok" role="status">
                      {noteWrite.message}
                    </p>
                  )}
                </DenPanel>
              </div>

              {/* The mock's Details: key on the left, value on the right, one
                  hairline per row. The rows that are editable here (#397 L19)
                  keep their controls in the value slot rather than losing the
                  edit to match a read-only picture. */}
              <DenPanel
                title="Details"
                className="d4"
                subtitle="Service, length and which Kin this visit covers. Times move from the Schedule; the status moves from the visit lifecycle above."
              >
                <div className="sdetail__rows">
                  <label className="sdetail__row">
                    <span className="sdetail__row-key">Service type</span>
                    {catalog !== null && catalog.length > 0 ? (
                      <select
                        className="sdetail__input"
                        value={serviceType}
                        onChange={(e) => setServiceType(e.target.value)}
                      >
                        {/* The visit's OWN service stays selectable even when the
                            rate card no longer carries it. A retired service is a
                            real state on an old visit, and dropping it from the
                            list would silently re-price the visit on the next
                            save to whatever happened to be first. */}
                        {!catalog.some((o) => o.name === serviceType) && serviceType !== '' && (
                          <option value={serviceType}>{serviceType} (not on the rate card)</option>
                        )}
                        {serviceType === '' && <option value="">Choose a service</option>}
                        {catalog.map((o) => (
                          <option key={o.name} value={o.name}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="sdetail__input"
                        type="text"
                        value={serviceType}
                        onChange={(e) => setServiceType(e.target.value)}
                      />
                    )}
                  </label>
                  {catalogError !== null && (
                    <p className="sdetail__hint">
                      The rate card couldn&rsquo;t be read ({catalogError}), so the service is a free-text
                      box rather than a list. Pricing is by this exact name, so match it to a service on
                      the rate card.
                    </p>
                  )}

                  <label className="sdetail__row">
                    <span className="sdetail__row-key">Visit length (minutes)</span>
                    <input
                      className="sdetail__input"
                      type="number"
                      min={0}
                      max={24 * 60}
                      step={1}
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                    />
                  </label>
                  {!durationValid && (
                    <p className="sdetail__hint" role="alert">
                      Visit length must be a whole number of minutes, 0 to 1440.
                    </p>
                  )}

                  {/* The rate card's price for THIS service, read-only: pricing
                      is by exact name (the hint above says so), so the row
                      appears only when the name matches a rate and the operator
                      typed one. Never a computed total. */}
                  <FieldRow label="Rate" value={rate === '' ? '' : `$${rate}`} />

                  {/* What the RECORD says the visit covers, before the picker
                      below that changes it. Named Kin can be fewer than covered
                      Kin (a Kin doc with no name contributes an id and no
                      name), and a pre-R1 document carries ids and no names at
                      all; each is said out loud rather than under-reported. */}
                  <FieldRow
                    label="Kin covered"
                    value={
                      kinNames.length > 0
                        ? kinIds.length > kinNames.length
                          ? `${kinNames.join(', ')} · ${String(kinIds.length - kinNames.length)} without a name on file`
                          : kinNames.join(', ')
                        : kinIds.length > 0
                          ? `${String(kinIds.length)} (names not on file)`
                          : 'Every Kin in the home (the booking named none)'
                    }
                  />

                  <fieldset className="sdetail__row sdetail__row--stack sdetail__kin-picker">
                    <legend className="sdetail__row-key">Kin on this visit</legend>
                    {roster.status === 'error' ? (
                      <ErrorHint>
                        Couldn&rsquo;t read this household&rsquo;s Kin. {roster.message} The Kin already
                          on this visit are unchanged.
                      </ErrorHint>
                    ) : roster.status === 'loading' ? (
                      <p className="sdetail__hint">Loading this household&rsquo;s Kin&hellip;</p>
                    ) : roster.data.length === 0 ? (
                      <EmptyHint>
                        No Kin are on file for this household, so there is nothing to choose from.
                      </EmptyHint>
                    ) : (
                      <>
                        {roster.data.map((k) => (
                          <label key={k._id} className="sdetail__check">
                            <input
                              type="checkbox"
                              checked={effectiveKinIds.includes(k._id)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...effectiveKinIds, k._id]
                                  : effectiveKinIds.filter((id) => id !== k._id);
                                setKinSelection(next);
                              }}
                            />
                            <span>{str(k.name).trim() === '' ? k._id : str(k.name)}</span>
                          </label>
                        ))}
                        {/* R1, stated where the operator can act on it: an empty
                            selection is not "no Kin", it is the whole household,
                            and the server expands it that way. Saying so here
                            stops "I unticked everything" from reading as a way
                            to book a visit for nobody. */}
                        {effectiveKinIds.length === 0 && (
                          <p className="sdetail__hint">
                            Nothing ticked means the whole household: a Kin Care covers every Kin in the
                            home unless the booking was narrowed.
                          </p>
                        )}
                      </>
                    )}
                  </fieldset>

                  {/* Present only once the visit has been billed, the same
                      rule as the board's "Invoice linked" chip: an unbilled
                      visit is the normal state of a visit, not a gap. */}
                  <FieldRow label="Invoice" value={str(entry.invoiceId).trim() === '' ? '' : 'Linked'} />
                  {/* SENT KinTales only, which is what `reportIds` holds; a
                      draft has nothing to show a household yet. */}
                  <FieldRow
                    label="KinTales sent"
                    value={reportCount === 0 ? '' : String(reportCount)}
                  />
                </div>

                <div className="sdetail__actions">
                  <PrimaryButton
                    label={editWrite.status === 'saving' ? 'Saving…' : 'Save details'}
                    onClick={() => void saveDetails()}
                    disabled={!editDirty || editWrite.status === 'saving'}
                  />
                </div>
                {editWrite.status === 'error' && (
                  <ErrorHint>
                    Couldn&rsquo;t save this visit. {editWrite.message}
                  </ErrorHint>
                )}
                {editWrite.status === 'done' && (
                  <p className="sdetail__ok" role="status">
                    {editWrite.message}
                  </p>
                )}
              </DenPanel>

              {clock.pending !== null && (
                <Dialog
                  title={clock.pending.label}
                  onClose={clock.dismiss}
                  footer={
                    <>
                      <GhostButton label="Not yet" onClick={clock.dismiss} />
                      <PrimaryButton label={clock.pending.confirmLabel} onClick={clock.confirm} />
                    </>
                  }
                >
                  {/* Future tense, and a confirm label the operator has not
                      already pressed once: the BookingActions confirm-copy
                      rule, and the walk it came from. */}
                  <p>{clock.pending.confirmBody(household)}</p>
                </Dialog>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}
