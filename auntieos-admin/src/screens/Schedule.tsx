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
  type SessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionDayLabel,
  sessionDayKey,
} from '../lib/sessionFormat';
import { sortServiceTypesByDuration } from '../lib/newBooking';
import {
  SNAP_MINUTES_OFF,
  SNAP_MINUTES_ON,
  rescheduleTimesForDrop,
  isNoOpDrop,
  localMinutesOfDay,
  minutesFromHHmm,
  hhmmFromMinutes,
} from '../lib/scheduleGrid';
import { getBusinessSettings } from '../api/settings';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { rescheduleBooking } from '../api/bookingsWrite';
import {
  deleteBlockedTimeSlot,
  isOperatorBlock,
  overridableScheduleRefusal,
  overrideHint,
} from '../api/scheduleWrite';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import {
  DenScreenHeading,
  DenPanel,
  StatCard,
  ServicePill,
  StatusPill,
  EmptyHint,
  serviceTone,
  type DenTone,
} from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { LoadingRow } from '../components/LoadingRow';
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

/**
 * The brand tone each session state wears in the kit's status pill.
 *
 * The same seven-line record `SessionDetail.tsx` carries, kept as a twin
 * rather than imported from it: the two screens are swept by different PRs
 * (#755) and a shared export would put one file in both diffs. A total record
 * over `SessionState`, so a state added to the lifecycle fails the typecheck
 * here instead of rendering in whatever colour a default happened to be.
 */
const SESSION_STATE_TONE: Record<SessionState, DenTone> = {
  scheduled: 'neutral',
  onMyWay: 'orange',
  arrived: 'teal',
  departed: 'purple',
  completed: 'success',
  // Not a stage of the visit: the visit is not happening. Muted and struck
  // through, which is how the agenda chip drew it before it became this pill.
  cancelled: 'muted',
  unknown: 'warning',
};

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
 * per-day agenda above it (#695), plus a read-only "Busy" overlay from
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
 * THE MONTH VIEW IS A CALENDAR (#696), not a date picker. Every cell lists its
 * own day: a block per visit tinted by service type, a hatched block per busy
 * window, "+N more" past the cap. See `MonthGrid`'s own doc for why the cell is
 * a div. The legend below applies to it exactly as it does to the week view;
 * it always has, and the operator saw none only because the month they marked
 * had nothing scheduled in it.
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

  // ── unblock (#574) ─────────────────────────────────────────────────────────
  // Blocking a window has had a callable since B6; removing one had none, so no
  // web surface could ever offer it. `deleteBlockedTimeSlot` is the other half,
  // and this is where an operator takes a block back off the calendar.
  //
  // NO OPTIMISTIC REMOVAL: `booking_time_slots` is a live stream, so the row
  // leaves on its own the moment the delete lands. `unblockingId` only marks the
  // row as in-flight so it cannot be pressed twice.
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [unblockError, setUnblockError] = useState<string | null>(null);

  async function unblock(slotId: string) {
    setUnblockingId(slotId);
    setUnblockError(null);
    try {
      await deleteBlockedTimeSlot(slotId);
      setUnblockingId(null);
    } catch (err) {
      setUnblockingId(null);
      // The server's own sentence: on the Google-mirror refusal it IS the
      // instruction (clear it in Google Calendar, or turn sync off).
      setUnblockError(err instanceof Error ? err.message : 'Could not remove that block.');
    }
  }

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
  const busyCardClickable = busyInViewCount.kind === 'value' && busyInViewCount.value > 0;

  // #697: bumped each time the "Busy blocks" card is clicked, so
  // ScheduleWeekGrid knows to scroll its first busy block into view even when
  // the day it lands on was already selected (a plain state change would not
  // re-fire the grid's effect in that case).
  const [busyScrollRequestId, setBusyScrollRequestId] = useState(0);

  /**
   * "Busy blocks" was a dead count with no way to reach the days it counted
   * (issue #697). Clicking it selects the first day in the current range that
   * carries a busy slot; ScheduleWeekGrid separately scrolls that day's first
   * busy block into view, and MonthGrid draws every busy window as its own
   * hatched block (#696 replaced #697's corner dot with the block itself), so
   * the count can be traced to dates without a click at all.
   */
  function selectFirstBusyDay() {
    if (busyState.status !== 'ready') return;
    const byDate = groupBlockedSlotsByDate(busyState.data);
    const firstBusyDay = daysInView.find((day) => (byDate.get(day)?.length ?? 0) > 0);
    if (firstBusyDay === undefined) return;
    setSelected(firstBusyDay);
    setBusyScrollRequestId((n) => n + 1);
  }

  return (
    <div className="screen">
      {/*
       * The mock's head: kicker and title on the left, and on the right the
       * range navigator, the Day/Week/Month segment and "New visit", all in the
       * one band. The title stays "Schedule" plus the view word rather than
       * the mock's "This week's runs": that line was reframed on both
       * platforms (spec 13 item 1, recorded on the Android screen) so the label
       * follows the active view, and the mock is amended to match. The range
       * itself reads off the navigator, the way the mock draws it, so it is
       * not repeated on `detail`. "Block time" (#397 M11) sits beside "New
       * visit"; the mock has only the one button and is amended for that too.
       */}
      <DenScreenHeading
        kicker="The Den · Schedule"
        title="Schedule"
        accentTail={`${view}.`}
        subtitle="Every Kin Care visit on the books, from the latest 300, with Google Calendar busy windows and your own blocked time laid over them."
        className="schedule__heading"
        trailing={
          <div className="schedule__actions">
            <ScheduleControls
              rangeLabel={rangeLabel(selected, view)}
              view={view}
              onViewChange={setView}
              onPrev={() => setSelected(shiftRange(selected, view, -1))}
              onNext={() => setSelected(shiftRange(selected, view, 1))}
            />
            <PrimaryButton label="New visit" onClick={() => setNewVisitOpen(true)} />
            <GhostButton label="Block time" onClick={() => setBlockTimeOpen(true)} />
          </div>
        }
      />

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
          trend={
            busyCardClickable
              ? 'Google Calendar + manually blocked. Click to jump to the busy days.'
              : 'Google Calendar + manually blocked'
          }
          tone="orange"
          feature={busyCardClickable}
          {...(busyCardClickable && { onClick: selectFirstBusyDay })}
        />
      </div>

      {/*
       * No panel around the calendar. The mock's `.cal` is its own glass
       * surface with no title and no padding, so a DenPanel titled "Schedule"
       * under a hero that already says Schedule was a second lid on the same
       * box. The agenda panel below is a DenPanel; the grid paints the panel
       * gradient itself (see `ScheduleWeekGrid.css`).
       */}
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
        loading={<LoadingRow label="Loading the schedule…" className="schedule__hint" />}
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
              {/*
               * #695: this panel used to sit after the week/month grid, off
               * the bottom of the screen behind a 540px time grid until the
               * operator scrolled to it. "Move the Today block up one" reads
               * here as above the grid: the operator's own addition to a mock
               * that draws no agenda at all, so it stays through the #755
               * sweep and the mock is amended to carry it. It is the first
               * thing under the stat cards now that the Day/Week/Month
               * controls live in the hero band. `collapsible` lets the
               * operator shrink it back down on a day with a long list, so it
               * does not push the grid itself off screen.
               */}
              <DenPanel
                title={sessionDayLabel(selected, todayIso)}
                subtitle="Kin Care visits on this day."
                className="schedule__agenda-panel"
                collapsible
              >
                {unblockError !== null && (
                  <Banner tone="error" title="Couldn’t remove that block">
                    <p>{unblockError}</p>
                  </Banner>
                )}
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
                      <BusyRow
                        key={slot._id}
                        slot={slot}
                        pending={unblockingId === slot._id}
                        busy={unblockingId !== null}
                        onUnblock={() => void unblock(slot._id)}
                      />
                    ))}
                  </ul>
                )}
              </DenPanel>

              {legend.length > 0 && (
                <ScheduleLegend serviceTypes={legend} dragHint={view === 'week' ? dragHint(snapMinutes) : null} />
              )}

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
                  scrollToBusyRequestId={busyScrollRequestId}
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
                  busyByDate={busyByDate}
                  onSelectDay={setSelected}
                  onOpenSession={onSelect ?? setOpenSessionId}
                />
              )}

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

/**
 * The mock's own words for the legend's right-hand note, with the real snap
 * value in place of its placeholder: "snaps to 15 min" is only true when the
 * operator turned the Settings switch on, and the other reading is a minute.
 */
function dragHint(snapMinutes: number): string {
  return snapMinutes === SNAP_MINUTES_ON
    ? `Drag a visit to reschedule · snaps to ${SNAP_MINUTES_ON} min`
    : 'Drag a visit to reschedule · to the minute';
}

/**
 * The mock's `.legend`: a small square swatch and a plain label per service
 * type, the hatched Busy swatch, and the drag note pushed to the right edge.
 *
 * A SWATCH, NOT A PILL. The 2026-09-10 pass drew each type as a `ServicePill`
 * here, and the pill is the right object on a row (it says what THAT visit
 * is); the legend is a key to the colours on the grid, and the mock keys them
 * with a square of the colour. `data-tone` carries the same `serviceTone`
 * mapping the month blocks and week blocks read, so the swatch and the block
 * it stands for resolve to one token.
 */
function ScheduleLegend({ serviceTypes, dragHint }: { serviceTypes: string[]; dragHint: string | null }) {
  return (
    <div className="schedule__legend" aria-label="Service type legend">
      {serviceTypes.map((type) => (
        <span key={type} className="schedule__legend-item" data-tone={serviceTone(type)}>
          <span className="schedule__legend-swatch" />
          {type}
        </span>
      ))}
      <span className="schedule__legend-item schedule__legend-item--busy">
        <span className="schedule__legend-swatch schedule__legend-swatch--busy" />
        Busy
      </span>
      {dragHint !== null && <span className="schedule__legend-hint">{dragHint}</span>}
    </div>
  );
}

// ── month grid ──────────────────────────────────────────────────────────────

/**
 * How many blocks one month cell draws before the rest fold into "+N more".
 *
 * Three, the same cap the Android month cell already uses
 * (`ScheduleViewScreen.kt#EnhancedDayCell`). A cell that grows to fit its
 * busiest day makes every other row in the month jump, and six rows of that is
 * not a calendar anybody can scan. The overflow is never silent: the count says
 * how many are folded, and pressing it puts the whole day in the agenda.
 *
 * IT COUNTS VISITS ONLY. Busy windows are drawn whatever else is on the day,
 * because #697's whole point is that the "Busy blocks" stat card's count can be
 * traced to dates from the month grid alone. A cap over the merged list would
 * hide the busy block on exactly the crowded day an operator is most likely to
 * be looking for a free window on, which is the promise #697 made and this
 * would quietly take back. There are three busy windows in the whole month the
 * operator marked; visits are what fills a cell.
 */
const MONTH_CELL_BLOCK_CAP = 3;

/** One drawn thing in a month cell: a visit, or a read-only busy window. */
type MonthCellItem =
  | { kind: 'visit'; key: string; minute: number | null; entry: ScheduleSessionEntry }
  | { kind: 'busy'; key: string; minute: number | null; slot: BusySlotEntry };

/** What one month cell draws, and how many visits it could not fit. */
interface MonthCellContents {
  /** Drawn blocks in clock order: every busy window, plus the first {@link MONTH_CELL_BLOCK_CAP} visits. */
  drawn: MonthCellItem[];
  /** Visits past the cap. Never dropped: "+N more" names them and opens the day. */
  folded: number;
}

/** Sorts by local start, putting a row whose start does not parse LAST rather than dropping it. */
function byStartMinute(a: MonthCellItem, b: MonthCellItem): number {
  return (a.minute ?? Number.MAX_SAFE_INTEGER) - (b.minute ?? Number.MAX_SAFE_INTEGER);
}

/**
 * One day's blocks, in clock order, visits and busy windows interleaved the way
 * the operator's mock draws them on the week calendar.
 *
 * A visit whose start does not parse sorts LAST rather than being dropped. It
 * is still a visit on the books, and the agenda panel is where its real window
 * can be read; silently omitting it is how a month view starts under-reporting
 * the day it is supposed to summarize.
 */
function monthCellContents(
  visits: ScheduleSessionEntry[],
  busy: BusySlotEntry[],
): MonthCellContents {
  const visitItems: MonthCellItem[] = visits
    .map((entry) => ({
      kind: 'visit' as const,
      key: entry._id,
      minute: localMinutesOfDay(str(entry.startTime)),
      entry,
    }))
    .sort(byStartMinute);
  // Busy rows store a plain `HH:mm` wall clock with no zone, which is why they
  // read through a different parser than the sessions above.
  const busyItems: MonthCellItem[] = busy.map((slot) => ({
    kind: 'busy' as const,
    key: slot._id,
    minute: minutesFromHHmm(str(slot.startTime)),
    slot,
  }));
  const shownVisits = visitItems.slice(0, MONTH_CELL_BLOCK_CAP);
  return {
    drawn: [...shownVisits, ...busyItems].sort(byStartMinute),
    folded: visitItems.length - shownVisits.length,
  };
}

interface MonthGridProps {
  days: string[];
  anchorMonth: string;
  today: string;
  selected: string;
  byDay: Map<string, ScheduleSessionEntry[]>;
  /** Google Calendar + manually blocked windows, by local date (#697). */
  busyByDate: Map<string, BusySlotEntry[]>;
  onSelectDay: (day: string) => void;
  onOpenSession: (sessionId: string) => void;
}

/**
 * The month calendar (#696).
 *
 * WHAT THIS REPLACES: a 7-column grid of date-picker number pills carrying at
 * most a session count and, after #697, a busy dot. It could say a Tuesday had
 * three visits; it could not say who, when, or what kind, which is the whole
 * job of a calendar. The operator's words were "we are still using the wrong
 * calendar", against a mock whose cells draw the visits themselves.
 *
 * SO EACH CELL NOW LISTS ITS DAY: a short block per visit, tinted by service
 * type through the SAME `serviceTone` the legend's pills and every service pill
 * in the app use, carrying the household and the local start time; a hatched,
 * read-only block per busy window; and "+N more" when the day's VISITS run past
 * {@link MONTH_CELL_BLOCK_CAP}. Busy windows are outside that cap and always
 * drawn, for the reason the cap's own doc gives.
 *
 * THE CELL IS A DIV, NOT A BUTTON, and that is structural rather than
 * cosmetic. The blocks inside it are controls (a visit opens its detail sheet,
 * "+N more" opens the day in the agenda), and a button cannot contain a button.
 * The day NUMBER stays the button that picks the agenda day, so it keeps the
 * `aria-pressed` / `aria-current` the cell used to carry and every existing
 * "click the day" path still lands on the same control.
 *
 * BUSY BLOCKS ARE STATIC, the same rule `ScheduleWeekGrid` documents at length:
 * `firestore.rules` denies every client write to `booking_time_slots`, so a
 * pressable busy block would be a dead control. Removing one is the agenda
 * panel's "Unblock" (#574), which is one click away on the day number.
 */
function MonthGrid({
  days,
  anchorMonth,
  today,
  selected,
  byDay,
  busyByDate,
  onSelectDay,
  onOpenSession,
}: MonthGridProps) {
  return (
    <div className="schedule__month" role="group" aria-label="Month">
      {days.map((day) => {
        const { drawn, folded } = monthCellContents(byDay.get(day) ?? [], busyByDate.get(day) ?? []);
        const inMonth = day.slice(0, 7) === anchorMonth;
        return (
          <div
            key={day}
            className={`${dayCellClass(day, today, selected)}${inMonth ? '' : ' schedule__day-cell--outside'}`}
            data-day={day}
          >
            <button
              type="button"
              className="schedule__day-number"
              onClick={() => onSelectDay(day)}
              aria-current={day === today ? 'date' : undefined}
              aria-pressed={day === selected}
              aria-label={day}
            >
              {Number(day.slice(8, 10))}
            </button>

            {drawn.length > 0 && (
              <ul className="schedule__day-blocks">
                {drawn.map((item) =>
                  item.kind === 'visit' ? (
                    <li key={item.key}>
                      <MonthVisitBlock
                        entry={item.entry}
                        startMinute={item.minute}
                        onOpen={() => onOpenSession(item.entry._id)}
                      />
                    </li>
                  ) : (
                    <li key={item.key}>
                      <MonthBusyBlock slot={item.slot} startMinute={item.minute} />
                    </li>
                  ),
                )}
              </ul>
            )}

            {folded > 0 && (
              <button
                type="button"
                className="schedule__day-more"
                onClick={() => onSelectDay(day)}
                aria-label={`${folded} more visit${folded === 1 ? '' : 's'} on ${day}. Open this day in the agenda.`}
              >
                +{folded} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The time a month block shows, or the same "Time TBD" the agenda row falls back to. */
function blockTimeLabel(startMinute: number | null): string {
  return startMinute === null ? 'Time TBD' : hhmmFromMinutes(startMinute);
}

function MonthVisitBlock({
  entry,
  startMinute,
  onOpen,
}: {
  entry: ScheduleSessionEntry;
  startMinute: number | null;
  onOpen: () => void;
}) {
  // str() on every field read: `serviceType` is absent on 76 of the 99 live
  // sessions, and `serviceTone` reads it as a string.
  const household = sessionHousehold(str(entry.kinfolkName));
  const when = blockTimeLabel(startMinute);
  return (
    <button
      type="button"
      className="schedule__month-block schedule__month-block--visit"
      data-tone={serviceTone(str(entry.serviceType))}
      data-session-id={entry._id}
      onClick={onOpen}
      aria-label={`${household} at ${when}. Open this visit.`}
    >
      <span className="schedule__month-block-time">{when}</span>
      <span className="schedule__month-block-name">{household}</span>
    </button>
  );
}

function MonthBusyBlock({ slot, startMinute }: { slot: BusySlotEntry; startMinute: number | null }) {
  return (
    <div
      className="schedule__month-block schedule__month-block--busy"
      title={busyWindowLabel(slot.startTime, slot.endTime)}
    >
      <span className="schedule__month-block-time">{blockTimeLabel(startMinute)}</span>
      <span className="schedule__month-block-name">Busy</span>
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
      <span className="schedule__row-status">
        <StatusPill label={info.chipLabel} tone={SESSION_STATE_TONE[state]} struck={state === 'cancelled'} />
      </span>
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
/**
 * One blocked window on the selected day, and (#574) the only place on this app
 * where one can be taken back off.
 *
 * UNBLOCK IS DRAWN ONLY ON THE OPERATOR'S OWN BLOCKS. A `GOOGLE_BUSY_IMPORT`
 * row mirrors an event on the connected calendar, and deleting it here would
 * not free the time: the next sync writes it straight back.
 * `deleteBlockedTimeSlot` refuses those server-side, so a button beside one
 * would be exactly the dead control the Buttons.tsx convention exists to
 * prevent. The row says where the block came from instead, which is also where
 * the remedy is.
 */
function BusyRow({
  slot,
  pending,
  busy,
  onUnblock,
}: {
  slot: BusySlotEntry;
  /** True while THIS row's delete is in flight. */
  pending: boolean;
  /** True while ANY row's delete is in flight, so two cannot be started at once. */
  busy: boolean;
  onUnblock: () => void;
}) {
  const removable = isOperatorBlock(slot.source);
  return (
    <li className="schedule__row schedule__row--busy">
      <div className="schedule__row-main schedule__row-main--static">
        <span className="schedule__row-when">{busyWindowLabel(slot.startTime, slot.endTime)}</span>
        <span className="schedule__row-who">
          <span className="schedule__row-name">Busy</span>
        </span>
        <span className="schedule__row-status">
          <StatusPill label="Blocked" tone="muted" />
        </span>
        {removable ? (
          <GhostButton
            label={pending ? 'Removing…' : 'Unblock'}
            onClick={onUnblock}
            disabled={busy}
          />
        ) : (
          <span className="schedule__busy-source">From Google Calendar</span>
        )}
      </div>
    </li>
  );
}
