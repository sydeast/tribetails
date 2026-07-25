import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { SCHEDULE_SESSIONS_QUERY, SCHEDULE_BUSY_SLOTS_QUERY, type ScheduleSessionEntry, type BusySlotEntry } from '../api/schedule';
import {
  type ScheduleViewMode,
  weekDays,
  monthGridDays,
  weekdayAbbrev,
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
} from '../lib/sessionFormat';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, ServicePill, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { BookingDetailModal } from '../components/BookingDetailModal';
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
 * STILL OUT OF SCOPE (write/edit surfaces, not this list port):
 * drag-to-reschedule physics, the "Block time" dialog
 * (`createBlockedTimeSlot`), and the New Visit / `createKinCareSession` flow.
 * Reschedule itself is no longer deferred, it lives in the detail sheet.
 *
 * ALSO DEFERRED: the service-type legend orders alphabetically rather than by
 * configured duration. That would need a single-document read of
 * `business_settings`, and `lib/firestore.ts` only has a bounded COLLECTION
 * listener (`useCollection`) today, no single-doc hook. Flagged rather than
 * bolted on ad hoc; see `lib/scheduleFormat.ts#distinctServiceTypes`.
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
            const legend = distinctServiceTypes(sessions);
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

                {view === 'week' && (
                  <WeekStrip
                    days={weekDays(selected)}
                    today={todayIso}
                    selected={selected}
                    byDay={byDay}
                    busyByDate={busyByDate}
                    onSelectDay={setSelected}
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

// ── week strip ──────────────────────────────────────────────────────────────

interface WeekStripProps {
  days: string[];
  today: string;
  selected: string;
  byDay: Map<string, ScheduleSessionEntry[]>;
  busyByDate: Map<string, BusySlotEntry[]>;
  onSelectDay: (day: string) => void;
}

function WeekStrip({ days, today, selected, byDay, busyByDate, onSelectDay }: WeekStripProps) {
  return (
    <div className="schedule__week" role="group" aria-label="Week">
      {days.map((day) => {
        const count = sessionCountForDay(byDay, day);
        const busyCount = busyByDate.get(day)?.length ?? 0;
        return (
          <button
            key={day}
            type="button"
            className={dayCellClass(day, today, selected)}
            onClick={() => onSelectDay(day)}
            aria-current={day === today ? 'date' : undefined}
            aria-pressed={day === selected}
            aria-label={day}
          >
            <span className="schedule__day-weekday">{weekdayAbbrev(day)}</span>
            <span className="schedule__day-number">{Number(day.slice(8, 10))}</span>
            {count > 0 && <span className="schedule__day-count">{count}</span>}
            {busyCount > 0 && <span className="schedule__day-busy-dot" aria-label={`${busyCount} busy block${busyCount === 1 ? '' : 's'}`} />}
          </button>
        );
      })}
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
