import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { SCHEDULE_SESSIONS_QUERY, SCHEDULE_BUSY_SLOTS_QUERY, type ScheduleSessionEntry, type BusySlotEntry } from '../api/schedule';
import {
  type ScheduleViewMode,
  weekDays,
  monthGridDays,
  rangeLabel,
  shiftRange,
  sessionsByLocalDay,
  sessionCountForDay,
  groupBlockedSlotsByDate,
  busyWindowLabel,
  distinctServiceTypes,
  localDateIso,
} from '../lib/scheduleFormat';
import {
  sessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionDayLabel,
  sessionDayKey,
} from '../lib/sessionFormat';
import { sortServiceTypesByDuration } from '../lib/newBooking';
import { SNAP_MINUTES_OFF, SNAP_MINUTES_ON, rescheduleTimesForDrop, isNoOpDrop } from '../lib/scheduleGrid';
import { getBusinessSettings } from '../api/settings';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { rescheduleBooking } from '../api/bookingsWrite';
import { overridableScheduleRefusal, overrideHint } from '../api/scheduleWrite';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, ServicePill, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { BookingDetailModal } from '../components/BookingDetailModal';
import { BlockTimeDialog } from '../components/BlockTimeDialog';
import { NewVisitDialog } from '../components/NewVisitDialog';
import { ScheduleWeekGrid, type ScheduleDrop } from '../components/ScheduleWeekGrid';
import './Schedule.css';

const VIEW_MODES: readonly { key: ScheduleViewMode; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

interface ScheduleProps {
  /**
   * Row-open OVERRIDE. Propless (the router default), a row opens the
   * in-screen `BookingDetailModal` detail sheet, exactly the way a Directory
   * card opens `KinfolkProfile` and a KinTales row opens `KinTaleDetail`. A
   * caller can pass its own handler (a test, or a future route) to take over
   * selection; then the sheet never opens.
   *
   * Before 2026-07-25 this prop was the ONLY thing that made a row
   * interactive, and nothing ever passed it, so every agenda row rendered as
   * a static div and the screen had no detail view at all (operator issue 16).
   */
  onSelect?: (sessionId: string) => void;
}

/**
 * Admin Schedule screen ("The Den · Schedule", nav slug `schedule`).
 *
 * WHAT THIS IS: a calendar of the SAME `kin_care_sessions` collection
 * Sessions.tsx ("Auntie Time") reads, viewed as a Day/Week/Month grid with a
 * per-day agenda below, plus a read-only "Busy" overlay from
 * `booking_time_slots` (Google Calendar sync + manually-blocked windows).
 * Confirmed against the wasm reference (`ScheduleScreen.kt`) before writing
 * a line of this: it is fundamentally a calendar/agenda, not the business
 * hours/availability config screen (that lives in Settings) and not a pure
 * editor with no meaningful read surface. See `lib/scheduleFormat.ts` for the
 * day/week/month arithmetic and the busy-slot classification, both with
 * direct unit coverage.
 *
 * THE DETAIL SHEET: clicking an agenda row opens `BookingDetailModal`, the
 * port of the archive's per-visit info card (facts, both note threads, inline
 * reschedule, assigned Auntie, and the links out to the household record and
 * the visit's KinTale). It is a sibling VIEW of this list, opened from the
 * row and closed back to it, the Directory/KinTales convention, so this screen
 * owns the open state rather than the router: the sheet needs the whole
 * session row, which only this screen's live stream has.
 *
 * THE THREE WRITE SURFACES (#397 M11/M12/M13). This screen used to be read-only
 * apart from the detail sheet, and the comment here listed all three as out of
 * scope. They are in now, and each is wired to a callable that was already
 * deployed and had simply never been called from this app:
 *
 *   - "Block time" (`BlockTimeDialog` -> `createBlockedTimeSlot`): mark a window
 *     unavailable. Refuses, with an override, when a visit already occupies it.
 *   - "New visit" (`NewVisitDialog` -> `createKinCareSession`): put a confirmed
 *     one-off visit on the calendar. This is NOT the booking wizard, which mints
 *     a request for approval; both are real jobs and both stay.
 *   - Drag-to-reschedule (`ScheduleWeekGrid` -> `rescheduleBooking`): the week
 *     view is now a real time grid, and a visit can be dragged on it. The drop
 *     computes the new END from the visit's own stored duration, never from
 *     where the pointer landed, so a move never silently resizes a visit.
 *
 * THE DRAG IS NOT THE ONLY WAY TO MOVE A VISIT, and it must never become one.
 * Every block on the grid is a real button: Tab reaches it, Enter or Space opens
 * the detail sheet, and the sheet's Reschedule form writes through the same
 * callable with the same duration rule. That is the documented keyboard path,
 * and `ScheduleWeekGrid`'s own doc comment says so at the other end.
 *
 * THE LEGEND, TWO RULES (operator mark 5, 2026-08-17, issue #392). SCOPE: the
 * legend lists only the service types actually present on the days currently
 * on screen (`daysInView`, the same set the "in view" stat card counts from),
 * not the whole bounded 300-session stream and not the operator's whole
 * configured set — it changes with date navigation, the view-mode tabs, and
 * an empty view legitimately shows no legend at all. A type on screen but
 * never configured in Settings still gets a row; scope comes from the
 * sessions, not from `business_settings`. ORDER: sorted by duration via
 * `sortServiceTypesByDuration` (`lib/newBooking.ts`), the same two-source
 * rule #373 gave the Android legend (`ServiceTypeSort.kt`) — an
 * operator-stated `business_settings.serviceDurations` value first, the
 * length parsed out of the type's own name as fallback, unresolvable last.
 * The previous version of this comment claimed duration ordering needed a
 * single-doc hook `lib/firestore.ts` didn't have; that was false the whole
 * time — `api/settings.ts#getBusinessSettings` is exactly that one-shot read,
 * and `NewBookingDialog.tsx` already fetches it the same way this screen now
 * does. See `lib/scheduleFormat.ts#distinctServiceTypes` for the raw
 * (unordered) extraction this legend is built from.
 *
 * NOT deferred, DECLINED (2026-07-25, Task 7.1). The superseded Compose screen
 * hides the busy-blocks error banner unless a calendar id is configured
 * (`ScheduleScreen.kt#shouldShowBusyBlockError`), and that rule was on the list
 * to port here. It is not ported, on purpose. `booking_time_slots` is not a
 * calendar-only collection: `createBlockedTimeSlot` writes operator-blocked
 * windows into the same place. Suppressing a read failure on that collection
 * because a DIFFERENT feature is unconfigured would hide a real fault in the
 * manual blocks, which is the silent degradation this codebase forbids. The
 * banner names what failed either way; an operator with no calendar sync reads
 * it as "the blocks did not load", which is exactly true.
 */
export function Schedule({ onSelect }: ScheduleProps) {
  const sessionsState = useCollection<ScheduleSessionEntry>(SCHEDULE_SESSIONS_QUERY);
  const busyState = useCollection<BusySlotEntry>(SCHEDULE_BUSY_SLOTS_QUERY);
  const navigate = useNavigate();

  const [view, setView] = useState<ScheduleViewMode>('week');
  const todayIso = useMemo(() => localDateIso(new Date()), []);
  const [selected, setSelected] = useState<string>(todayIso);
  // The open detail sheet, held as an ID rather than the row object so the
  // sheet always re-reads from the live stream (a reschedule that lands while
  // it is open re-renders it with the new window instead of a stale copy).
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  // One-shot read of `business_settings.serviceDurations`, purely to ORDER the
  // legend (see the screen doc comment above). Same `getBusinessSettings` +
  // `live`-guard shape as `NewBookingDialog.tsx`'s service-options fetch. `{}`
  // both before this resolves and if it fails: `sortServiceTypesByDuration`
  // treats a missing entry as "no stated duration", which falls through to
  // parsing the length out of the type's own name — the one fallback every
  // type has always had, and the only ordering this legend could show before
  // #373 added the stored attribute at all. That is an honest degrade to a
  // real, pre-existing ordering, not a fabricated one, so it fails quiet
  // rather than surfacing a banner over what is a display-order nicety, not
  // schedule data.
  const [serviceDurations, setServiceDurations] = useState<Record<string, string>>({});
  /**
   * The operator's KinCare catalog, `business_settings.serviceRates`. Read here
   * for the New visit dialog's service picker, which must offer exactly these
   * keys: a session carries no price, so `listUninvoicedSessions` prices a
   * completed visit by looking this string up in that same map, and free text
   * comes back unpriceable. See `NewVisitDialog`'s doc for the whole chain.
   */
  const [serviceRates, setServiceRates] = useState<Record<string, string>>({});
  /**
   * "Snap drag-to-reschedule to 15 min", off by default.
   *
   * `snapRescheduleTo15Min` has been storable and editable in Settings all
   * along; nothing on web read it, because until this screen had a drag there
   * was nothing for it to govern. Wiring it is what makes an existing switch
   * real rather than decorative. Off means minute precision, matching the
   * desktop admin's `if (snapRescheduleTo15Min) 15 else 1`.
   */
  const [snapMinutes, setSnapMinutes] = useState<number>(SNAP_MINUTES_OFF);
  useEffect(() => {
    let live = true;
    getBusinessSettings()
      .then((settings) => {
        if (!live) return;
        setServiceDurations(settings.serviceDurations);
        setServiceRates(settings.serviceRates);
        setSnapMinutes(settings.snapRescheduleTo15Min ? SNAP_MINUTES_ON : SNAP_MINUTES_OFF);
      })
      .catch(() => {
        // See the state's own doc comment: leaving `serviceDurations` at `{}`
        // is the correct degrade here, not an omission. The same applies to the
        // other two: an empty catalog makes the New visit dialog say so out
        // loud rather than offer a made-up list, and an unread snap preference
        // falls back to its own stored default rather than to the other value.
      });
    return () => {
      live = false;
    };
  }, []);

  // The household list for the New visit dialog. Directory already streams this
  // collection for its own tab; this is Schedule's own bounded listener, the
  // same one-listener-per-screen rule `SCHEDULE_SESSIONS_QUERY` follows.
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const households = useMemo(
    () =>
      kinfolkState.status === 'ready'
        ? kinfolkState.data.map((kf) => ({ id: kf._id, label: kinfolkDisplayName(kf) }))
        : [],
    [kinfolkState],
  );

  const [blockTimeOpen, setBlockTimeOpen] = useState(false);
  const [newVisitOpen, setNewVisitOpen] = useState(false);

  // ── drag-to-reschedule (M13) ───────────────────────────────────────────────
  // The session currently being written, and the last refusal. Held on the
  // screen rather than in the grid because the grid is a view: the write, its
  // in-flight state, and the operator's chance to override all belong to the
  // surface that owns the callable.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dropRetry, setDropRetry] = useState<
    { drop: ScheduleDrop; kind: 'visit' | 'busy' } | null
  >(null);

  async function commitDrop(drop: ScheduleDrop, override: 'visit' | 'busy' | null) {
    const times = rescheduleTimesForDrop(drop.session, drop.targetDayIso, drop.dropMinuteOfDay, snapMinutes);
    if (times === null) {
      setDropError('That visit could not be moved: its record has no readable start time.');
      return;
    }
    setPendingSessionId(drop.session._id);
    setDropError(null);
    setDropRetry(null);
    try {
      await rescheduleBooking(drop.session._id, times.startTime, times.endTime, {
        ...(override === 'visit' && { visit: true }),
        ...(override === 'busy' && { busy: true }),
      });
      setPendingSessionId(null);
    } catch (err) {
      setPendingSessionId(null);
      // The block snaps back on its own: nothing was written, and the grid
      // draws every block from the live stream rather than from drag state.
      setDropError(err instanceof Error ? err.message : 'Could not move that visit.');
      const kind = overridableScheduleRefusal(err, override !== null);
      setDropRetry(kind === null ? null : { drop, kind });
    }
  }

  function handleDrop(drop: ScheduleDrop) {
    // A drop that lands back where the visit already was writes nothing: no
    // callable, no audit entry, no "rescheduled" event for a move nobody made.
    const fromDay = sessionDayKey(str(drop.session.startTime));
    if (isNoOpDrop(drop.session, fromDay, drop.targetDayIso, drop.dropMinuteOfDay, snapMinutes)) return;
    void commitDrop(drop, null);
  }

  const daysInView = useMemo(() => {
    switch (view) {
      case 'day':
        return [selected];
      case 'week':
        return weekDays(selected);
      case 'month':
        return monthGridDays(selected);
    }
  }, [view, selected]);

  const inViewCount = asyncScalar(sessionsState, (data) => {
    const byDay = sessionsByLocalDay(data);
    return daysInView.reduce((sum, day) => sum + sessionCountForDay(byDay, day), 0);
  });

  const busyInViewCount = asyncScalar(busyState, (data) => {
    const byDate = groupBlockedSlotsByDate(data);
    return daysInView.reduce((sum, day) => sum + (byDate.get(day)?.length ?? 0), 0);
  });

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Schedule"
        title="Schedule"
        accentTail={`${view}.`}
        subtitle={rangeLabel(selected, view)}
      />

      <div className="schedule__actions">
        <PrimaryButton label="New visit" onClick={() => setNewVisitOpen(true)} />
        <GhostButton label="Block time" onClick={() => setBlockTimeOpen(true)} />
      </div>

      <div className="schedule__summary">
        <StatCard
          label={`${VIEW_MODES.find((v) => v.key === view)?.label ?? 'Range'} sessions`}
          value={inViewCount}
          trend="in the visible range"
          tone="teal"
        />
        <StatCard
          label="Busy blocks"
          value={busyInViewCount}
          trend="Google Calendar + manually blocked"
          tone="orange"
          feature={busyInViewCount.kind === 'value' && busyInViewCount.value > 0}
        />
      </div>

      <DenPanel title="Schedule" subtitle="Every Kin Care visit on the books, from the latest 300.">
        <AsyncRegion
          state={sessionsState}
          what="the schedule"
          // Empty only when BOTH sources have nothing: a proven-empty sessions
          // stream must not hide a real busy block (closes over `busyState`
          // rather than deriving from `data` alone, since AsyncRegion's
          // `isEmpty` only sees the sessions side of this two-collection
          // screen). Anything other than a READY, zero-length busy list
          // (loading/error) does not count as "proven non-empty" here, its
          // own inline error/loading note still surfaces separately below.
          isEmpty={(data) => data.length === 0 && !(busyState.status === 'ready' && busyState.data.length > 0)}
          loading={<p className="schedule__hint">Loading the schedule…</p>}
          empty={<EmptyHint>Nothing on the schedule yet.</EmptyHint>}
        >
          {(sessions) => {
            const byDay = sessionsByLocalDay(sessions);
            const busyByDate = busyState.status === 'ready' ? groupBlockedSlotsByDate(busyState.data) : new Map<string, BusySlotEntry[]>();
            // SCOPED to the days on screen (`daysInView`, the same set the "in
            // view" stat card counts from), never the whole bounded 300-session
            // stream and never the operator's whole configured set: navigating
            // the date range or switching Day/Week/Month changes `daysInView`,
            // which changes the legend along with it, and a view with nothing
            // scheduled yields an empty legend rather than a stale full list.
            const sessionsInView = daysInView.flatMap((day) => byDay.get(day) ?? []);
            const legend = sortServiceTypesByDuration(distinctServiceTypes(sessionsInView), serviceDurations);
            const selectedSessions = (byDay.get(selected) ?? []).slice().sort((a, b) => str(a.startTime).localeCompare(str(b.startTime)));
            const selectedBusy = busyByDate.get(selected) ?? [];
            // Re-resolved from the stream every render, so the sheet closes on
            // its own if the session leaves the page (deleted, or pushed out of
            // the bounded 300) rather than showing a row that no longer exists.
            const openSession =
              openSessionId === null ? undefined : sessions.find((s) => s._id === openSessionId);

            return (
              <>
                <ScheduleControls
                  rangeLabel={rangeLabel(selected, view)}
                  view={view}
                  onViewChange={setView}
                  onPrev={() => setSelected(shiftRange(selected, view, -1))}
                  onNext={() => setSelected(shiftRange(selected, view, 1))}
                />

                {legend.length > 0 && <ScheduleLegend serviceTypes={legend} />}

                {busyState.status === 'error' && (
                  <p className="schedule__busy-error" role="alert">
                    Busy blocks unavailable: {busyState.message}
                  </p>
                )}

                {dropError !== null && (
                  <Banner tone="error" title="Couldn’t move that visit">
                    <p>{dropError}</p>
                    {dropRetry !== null && (
                      <>
                        <p>{overrideHint(dropRetry.kind)}</p>
                        <GhostButton
                          label="Move anyway"
                          onClick={() => void commitDrop(dropRetry.drop, dropRetry.kind)}
                          disabled={pendingSessionId !== null}
                        />
                      </>
                    )}
                  </Banner>
                )}

                {view === 'week' && (
                  <ScheduleWeekGrid
                    days={weekDays(selected)}
                    today={todayIso}
                    selected={selected}
                    byDay={byDay}
                    busyByDate={busyByDate}
                    snapMinutes={snapMinutes}
                    pendingSessionId={pendingSessionId}
                    onSelectDay={setSelected}
                    onOpenSession={onSelect ?? setOpenSessionId}
                    onDrop={handleDrop}
                  />
                )}

                {view === 'month' && (
                  <MonthGrid
                    days={monthGridDays(selected)}
                    anchorMonth={selected.slice(0, 7)}
                    today={todayIso}
                    selected={selected}
                    byDay={byDay}
                    onSelectDay={setSelected}
                  />
                )}

                <DenPanel
                  title={sessionDayLabel(selected, todayIso)}
                  subtitle="Kin Care visits on this day."
                  className="schedule__agenda-panel"
                >
                  {selectedSessions.length === 0 && selectedBusy.length === 0 ? (
                    <EmptyHint>No Kin Care sessions on this day.</EmptyHint>
                  ) : (
                    <ul className="schedule__agenda-list">
                      {selectedSessions.map((entry) => (
                        <AgendaRow
                          key={entry._id}
                          entry={entry}
                          onSelect={onSelect ?? setOpenSessionId}
                        />
                      ))}
                      {selectedBusy.map((slot) => (
                        <BusyRow key={slot._id} slot={slot} />
                      ))}
                    </ul>
                  )}
                </DenPanel>

                {openSession !== undefined && (
                  <BookingDetailModal
                    entry={openSession}
                    onClose={() => setOpenSessionId(null)}
                    onOpenKinfolk={(kinfolkId) =>
                      void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId } })
                    }
                    onOpenKinTale={(kinTaleId) =>
                      // Search param, not a path: `lib/notificationActions.ts`
                      // set that convention for invoice and kintale deep links,
                      // and one convention beats two that drift.
                      void navigate({ to: '/kintales', search: { kinTaleId } })
                    }
                  />
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {/* Outside AsyncRegion on purpose: an operator must be able to block time
          or add a visit on a day the sessions stream is still loading, or has
          nothing to show. Gating a write surface on a read finishing is how an
          empty calendar becomes an unusable one. */}
      {blockTimeOpen && (
        <BlockTimeDialog
          initialDate={selected}
          onClose={() => setBlockTimeOpen(false)}
          onBlocked={() => setBlockTimeOpen(false)}
        />
      )}

      {newVisitOpen && (
        <NewVisitDialog
          households={households}
          serviceRates={serviceRates}
          serviceDurations={serviceDurations}
          initialDate={selected}
          onClose={() => setNewVisitOpen(false)}
          onCreated={() => setNewVisitOpen(false)}
        />
      )}
    </div>
  );
}

// ── controls ────────────────────────────────────────────────────────────────

interface ScheduleControlsProps {
  rangeLabel: string;
  view: ScheduleViewMode;
  onViewChange: (view: ScheduleViewMode) => void;
  onPrev: () => void;
  onNext: () => void;
}

function ScheduleControls({ rangeLabel: label, view, onViewChange, onPrev, onNext }: ScheduleControlsProps) {
  // Roving-tabindex keyboard nav for the Day/Week/Month tablist below
  // (Left/Right, Home/End, roving tabIndex).
  const { getTabProps } = useRovingTabs({
    count: VIEW_MODES.length,
    activeIndex: VIEW_MODES.findIndex((v) => v.key === view),
  });

  return (
    <div className="schedule__controls">
      <div className="schedule__nav">
        <button type="button" className="schedule__nav-btn" onClick={onPrev} aria-label="Previous">
          ‹
        </button>
        <span className="schedule__nav-label">{label}</span>
        <button type="button" className="schedule__nav-btn" onClick={onNext} aria-label="Next">
          ›
        </button>
      </div>

      <div className="schedule__tabs" role="tablist" aria-label="Schedule view">
        {VIEW_MODES.map((v, index) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            className={view === v.key ? 'schedule__tab schedule__tab--active' : 'schedule__tab'}
            onClick={() => onViewChange(v.key)}
            {...getTabProps(index)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── legend ──────────────────────────────────────────────────────────────────

function ScheduleLegend({ serviceTypes }: { serviceTypes: string[] }) {
  return (
    <div className="schedule__legend" aria-label="Service type legend">
      {serviceTypes.map((type) => (
        <span key={type} className="schedule__legend-item">
          <ServicePill serviceType={type} />
        </span>
      ))}
      <span className="schedule__legend-item schedule__legend-item--busy">
        <span className="schedule__legend-swatch" />
        Busy
      </span>
    </div>
  );
}

// ── month grid ──────────────────────────────────────────────────────────────

interface MonthGridProps {
  days: string[];
  anchorMonth: string;
  today: string;
  selected: string;
  byDay: Map<string, ScheduleSessionEntry[]>;
  onSelectDay: (day: string) => void;
}

function MonthGrid({ days, anchorMonth, today, selected, byDay, onSelectDay }: MonthGridProps) {
  return (
    <div className="schedule__month" role="group" aria-label="Month">
      {days.map((day) => {
        const count = sessionCountForDay(byDay, day);
        const inMonth = day.slice(0, 7) === anchorMonth;
        return (
          <button
            key={day}
            type="button"
            className={`${dayCellClass(day, today, selected)}${inMonth ? '' : ' schedule__day-cell--outside'}`}
            onClick={() => onSelectDay(day)}
            aria-current={day === today ? 'date' : undefined}
            aria-pressed={day === selected}
            aria-label={day}
          >
            <span className="schedule__day-number">{Number(day.slice(8, 10))}</span>
            {count > 0 && <span className="schedule__day-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function dayCellClass(day: string, today: string, selected: string): string {
  const classes = ['schedule__day-cell'];
  if (day === today) classes.push('schedule__day-cell--today');
  if (day === selected) classes.push('schedule__day-cell--selected');
  return classes.join(' ');
}

// ── agenda rows ──────────────────────────────────────────────────────────────

interface AgendaRowProps {
  entry: ScheduleSessionEntry;
  /** Always wired now (the screen falls back to its own sheet opener), kept
   *  optional so the static branch below stays reachable if that ever changes. */
  onSelect?: ((sessionId: string) => void) | undefined;
}

function AgendaRow({ entry, onSelect }: AgendaRowProps) {
  // str() on every field read: `ScheduleSessionEntry` is a cast over the raw
  // `kin_care_sessions` doc, and the absent-field fallbacks these helpers
  // already carry ('unknown', 'Unnamed Kinfolk', 'Time TBD', 'visit') only get
  // a chance to run if the undefined reaches them as '' instead of throwing.
  // `serviceType` is genuinely absent on 76 of the 99 live sessions.
  const state = sessionState(str(entry.status));
  const info = sessionStateInfo(state);
  const household = sessionHousehold(str(entry.kinfolkName));

  const body = (
    <>
      <span className="schedule__row-when">{sessionWindow(str(entry.startTime), str(entry.endTime))}</span>
      <span className="schedule__row-who">
        <span className="schedule__row-name">{household}</span>
        <ServicePill serviceType={str(entry.serviceType)} />
      </span>
      <span className={`schedule__chip schedule__chip--${info.cssClass}`}>{info.chipLabel}</span>
    </>
  );

  // Static, non-interactive row unless a detail handler is wired: a live
  // no-op button is the dead-control anti-pattern (Sessions.tsx convention).
  return (
    <li className="schedule__row">
      {onSelect ? (
        <button type="button" className="schedule__row-main lift" onClick={() => onSelect(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="schedule__row-main schedule__row-main--static">{body}</div>
      )}
    </li>
  );
}

/**
 * A busy block. STATIC ON PURPOSE, and it must stay that way: these rows are
 * read-only overlays from `booking_time_slots` (Google Calendar free/busy
 * imports and admin-blocked windows). They are not visits. There is no
 * kinfolk, no service, no note thread, no KinTale, nothing a detail sheet
 * could show, and `firestore.rules` denies every client write to that
 * collection anyway. Making this a button to match `AgendaRow` would produce
 * exactly the dead control the Buttons.tsx convention exists to prevent.
 */
function BusyRow({ slot }: { slot: BusySlotEntry }) {
  return (
    <li className="schedule__row schedule__row--busy">
      <div className="schedule__row-main schedule__row-main--static">
        <span className="schedule__row-when">{busyWindowLabel(slot.startTime, slot.endTime)}</span>
        <span className="schedule__row-who">
          <span className="schedule__row-name">Busy</span>
        </span>
        <span className="schedule__chip schedule__chip--busy">BLOCKED</span>
      </div>
    </li>
  );
}
