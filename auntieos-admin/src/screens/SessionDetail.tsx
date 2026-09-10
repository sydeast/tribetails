import { useEffect, useMemo, useState } from 'react';
import { type SessionEntry } from '../api/sessions';
import { kinForHouseholdQuery, type Kin } from '../api/directory';
import { getBusinessSettings } from '../api/settings';
import { serviceOptionsFromRates, type ServiceOption } from '../lib/newBooking';
import { useCollection } from '../lib/firestore';
import { updateKinCareSession } from '../api/sessionsWrite';
import {
  appendOfficeNote,
  lifecycleActionsFor,
  lifecycleNowIso,
} from '../lib/sessionLifecycle';
import { useVisitLifecycle } from '../lib/useVisitLifecycle';
import { useBreadcrumbs, routePointsFromGpsSummary } from '../lib/breadcrumbs';
import {
  sessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionClock,
  sessionDayKey,
  sessionDayLabel,
  localDateIso,
} from '../lib/sessionFormat';
import { str, arr } from '../lib/coerce';
import { DenScreenHeading, DenPanel, ServicePill, EmptyHint, ErrorHint } from '../components/DenScreenKit';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { RouteMap } from '../components/RouteMap';
import './SessionDetail.css';

interface SessionDetailProps {
  /**
   * The session row. Sessions.tsx now resolves it through `useDocById`, a LIVE
   * document subscription, rather than by value out of its paged list: this
   * screen hosts writes, and `useDocById`'s own header states the rule --
   * "a frozen copy of the record would disagree with the list behind it the
   * moment one landed". A clock-in here therefore repaints this screen from the
   * document the server actually wrote, never from what the client hoped it
   * wrote, so an optimistic status can never survive a refusal.
   *
   * `null` means the id no longer resolves to a row (the read is not ready yet,
   * or a stale/removed id): that gets its own honest "unavailable" state below,
   * never a blank or a fabricated detail.
   */
  entry: SessionEntry | null;
  onBack: () => void;
}

/** One label/value line; renders nothing when the value is blank (never "undefined"), the KinfolkProfile `Fact` convention. */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (value.trim() === '') return null;
  return (
    <div className="sdetail__fact">
      <dt className="sdetail__fact-label">{label}</dt>
      <dd className={mono ? 'sdetail__fact-value sdetail__fact-value--mono' : 'sdetail__fact-value'}>{value}</dd>
    </div>
  );
}

/** True when a section has at least one non-blank field (so an all-blank section hides). */
function any(...vals: string[]): boolean {
  return vals.some((v) => v.trim() !== '');
}

/**
 * A single session ISO field as a LOCAL "Today · 20:00" moment, composed ONLY
 * from the existing AO-18 helpers (`sessionDayKey`/`sessionDayLabel`/`sessionClock`
 * in lib/sessionFormat.ts), never new date logic or `toLocaleString`. Blank when
 * the field is empty or does not parse, so a `Fact` hides it rather than showing
 * a fabricated "(no time)" clock or an "Undated" day.
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
 *                       while ARRIVED.
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
export function SessionDetail({ entry, onBack }: SessionDetailProps) {
  // "Today" doesn't change mid-view; computed once (the Sessions.tsx todayIso
  // rationale). Called unconditionally, above the null branch, per Rules of Hooks.
  const todayIso = useMemo(() => localDateIso(new Date()), []);
  const sessionLabel = entry !== null ? sessionHousehold(str(entry.kinfolkName)) : 'Kin Care session';

  const sessionId = entry?._id ?? null;
  const status = str(entry?.status);
  const state = sessionState(status);
  const household = entry === null ? 'the household' : sessionHousehold(str(entry.kinfolkName));

  // ── the visit clock ────────────────────────────────────────────────────────
  // The four in-visit writes, the confirm gate and the sentence they produce all
  // live in `lib/useVisitLifecycle.ts` now, because the Auntie Time CARD drives
  // the same clock since #703 and two copies of "did the server actually change
  // anything?" would drift. This screen keeps its own dialog and its own action
  // row; the hook keeps the write. No refresh callback is passed here: `entry`
  // is a LIVE `useDocById` subscription, so the document repaints itself.
  const clock = useVisitLifecycle(sessionId, household);

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

  return (
    <div className="screen">
      <DenScreenHeading
        // "Auntie Time" is the rail's name for /sessions (lib/nav.ts: "the rail
        // says Auntie Time; the slug and the code say sessions"), and a crumb
        // that called it anything else would name a screen the operator cannot
        // find. `onSelect`: this detail is a sibling view of the list, opened
        // without a URL change.
        crumbs={[{ label: 'Auntie Time', onSelect: onBack }, { label: sessionLabel }]}
        title={sessionLabel}
        subtitle="Kin Care session detail."
        trailing={<GhostButton label="Back to Auntie Time" onClick={onBack} />}
      />

      {entry === null ? (
        <DenPanel title="Session unavailable">
          <EmptyHint>
            This Kin Care session is no longer available. It may have been removed, or the list is still
            loading.
          </EmptyHint>
        </DenPanel>
      ) : (
        (() => {
          // Every field is read through `str()`/`arr()`: `SessionEntry` is a cast
          // over raw Firestore data, not a validation of it (see api/sessions.ts),
          // so a doc can genuinely lack any of these. An absent field reads as
          // blank, which the sections below already hide (`Fact`/`any`) and the
          // helpers already classify honestly ('unknown', 'Undated'), rather than
          // throwing and blanking the view.
          const info = sessionStateInfo(state);
          const serviceTypeNow = str(entry.serviceType);
          const notes = str(entry.notes).trim();
          // R1: a KinCare session covers EVERY Kin in the home, so the Kin panel
          // is always shown. It used to be hidden whenever `kinIds` was empty,
          // and empty was exactly the whole-household case -- a booking for the
          // dog AND the cat rendered with no Kin section at all.
          const kinIds = savedKinIds;
          const kinNames = arr<string>(entry.kinNames).filter((n) => n.trim() !== '');

          const startKey = sessionDayKey(str(entry.startTime));
          const dayLabel = startKey === 'Undated' ? '' : sessionDayLabel(startKey, todayIso);
          const scheduled = sessionWindow(str(entry.startTime), str(entry.endTime));
          const scheduledValue = scheduled === 'Time TBD' ? '' : scheduled;
          const onTheWay = localMoment(str(entry.onMyWayAt), todayIso);
          const clockedIn = localMoment(str(entry.arrivedAt), todayIso);
          // CLOCKED OUT IS `departedAt`, NOT `completedAt`, and this line used to
          // read the wrong field. They are different events: departing is the
          // Auntie leaving the house, completing is the office ruling the visit
          // happened and is billable, and `transitionBookingStatus` can stamp
          // the second without the first ever having been stamped. Labelling
          // completion as a clock-out made every visit completed from the
          // Bookings screen look as though someone had clocked out of it.
          const clockedOut = localMoment(str(entry.departedAt), todayIso);
          const completed = localMoment(str(entry.completedAt), todayIso);

          const actions = lifecycleActionsFor(state);

          return (
            <>
              {/* The household names the page in the heading above; this panel
                  is the status/service line, so it isn't repeated here. */}
              <DenPanel title="Status">
                <div className="sdetail__head">
                  <div className="sdetail__head-tags">
                    <span className={`sdetail__chip sdetail__chip--${info.cssClass}`}>{info.chipLabel}</span>
                    <ServicePill serviceType={serviceTypeNow} />
                  </div>
                  {state === 'unknown' && (
                    <p className="sdetail__hint">
                      This session&rsquo;s status (&ldquo;{status}&rdquo;) isn&rsquo;t recognized, so
                      it is shown as UNKNOWN rather than guessed into a state.
                    </p>
                  )}
                </div>
              </DenPanel>

              <DenPanel
                title="Visit clock"
                subtitle="On the way, clocked in, clocked out. The office marks a visit Completed from Bookings."
              >
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

              {any(dayLabel, scheduledValue, onTheWay, clockedIn, clockedOut, completed) && (
                <DenPanel title="Timing">
                  <dl className="sdetail__facts">
                    <Fact label="Day" value={dayLabel} />
                    <Fact label="Scheduled" value={scheduledValue} mono />
                    <Fact label="On the way" value={onTheWay} mono />
                    <Fact label="Clocked in" value={clockedIn} mono />
                    <Fact label="Clocked out" value={clockedOut} mono />
                    <Fact label="Completed" value={completed} mono />
                  </dl>
                </DenPanel>
              )}

              <DenPanel
                title="Route"
                subtitle="GPS breadcrumbs recorded during the visit. Operator view; the kinfolk sharing switch does not apply here."
              >
                {crumbs.error !== null ? (
                  <ErrorHint>
                    Couldn&rsquo;t read the live GPS trail for this visit. {crumbs.error}
                  </ErrorHint>
                ) : route.length === 0 ? (
                  <EmptyHint>
                    {state === 'arrived'
                      ? 'Waiting for the first GPS ping. The field app writes one about every five seconds while a visit is in flight.'
                      : inFlight
                        ? 'No GPS breadcrumbs were recorded for this Kin Care.'
                        : 'No route on file for this Kin Care. Tracking runs while an Auntie is clocked in; older breadcrumbs are cleared once past the retention window, leaving the saved summary.'}
                  </EmptyHint>
                ) : (
                  <>
                    <RouteMap
                      route={route}
                      live={state === 'arrived'}
                      distanceMeters={gpsSummary?.distanceMeters}
                      durationSeconds={gpsSummary?.durationSeconds}
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

              <DenPanel
                title="Visit details"
                subtitle="Service, length and which Kin this visit covers. Times move from the Schedule; the status moves from the visit clock above."
              >
                <div className="sdetail__form">
                  <label className="sdetail__field">
                    <span className="sdetail__field-label">Service type</span>
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

                  <label className="sdetail__field">
                    <span className="sdetail__field-label">Visit length (minutes)</span>
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

                  <fieldset className="sdetail__field sdetail__kin-picker">
                    <legend className="sdetail__field-label">Kin on this visit</legend>
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
                </div>
              </DenPanel>

              <DenPanel title="Kin" subtitle="Every Kin in this home, unless the booking was narrowed.">
                {kinNames.length > 0 ? (
                  <dl className="sdetail__facts">
                    <Fact label="Kin covered" value={kinNames.join(', ')} />
                    {/* Named Kin can be fewer than covered Kin: a Kin doc with
                        no name contributes an id and no name. Said out loud
                        rather than letting the list quietly under-report. */}
                    {kinIds.length > kinNames.length && (
                      <Fact
                        label="Unnamed Kin"
                        value={String(kinIds.length - kinNames.length)}
                      />
                    )}
                  </dl>
                ) : kinIds.length > 0 ? (
                  // Ids but no names: a pre-R1 document, or a household whose
                  // Kin docs carry no `name`. The count is the honest answer.
                  <dl className="sdetail__facts">
                    <Fact label="Kin covered" value={`${kinIds.length} (names not on file)`} />
                  </dl>
                ) : (
                  <EmptyHint>
                    No Kin are recorded on this session. It was booked before the roster was written
                    onto the record, so the household&rsquo;s Kin list is what this visit covers.
                  </EmptyHint>
                )}
              </DenPanel>

              <DenPanel
                title="Notes"
                subtitle="Admin-internal. A note is stamped and kept; nothing here is overwritten."
              >
                {notes === '' ? (
                  <EmptyHint>No notes on this visit yet.</EmptyHint>
                ) : (
                  <p className="sdetail__notes">{notes}</p>
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
