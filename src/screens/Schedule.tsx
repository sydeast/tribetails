import { useMemo, useState } from 'react';
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
import './Schedule.css';

const VIEW_MODES: readonly { key: ScheduleViewMode; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

interface ScheduleProps {
  /**
   * Placeholder: the per-session detail (the wasm's `BookingDetailModal`) is a
   * separate, not-yet-built screen; this port is READ ONLY, see the module
   * doc comment below for the full list of write/edit surfaces intentionally
   * left out. The router mounts this screen propless, so `onSelect` is
   * undefined in production, see `AgendaRow`: when unwired the row is a
   * STATIC <div>, not a <button> (a handler-less <button> is still a
   * focusable dead control, the Sessions.tsx/Invoices.tsx/KinTales.tsx
   * convention).
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
 * OUT OF SCOPE (write/edit or detail-navigation surfaces, not this list
 * port): drag-to-reschedule (`rescheduleBooking`), the "Block time" dialog
 * (`createBlockedTimeSlot`), the New Visit / `createKinCareSession` flow, and
 * the per-session `BookingDetailModal` detail view. `onSelect` is this
 * screen's only hook into that later work, same convention as
 * Sessions.tsx/Invoices.tsx/KinTales.tsx.
 *
 * ALSO DEFERRED: the service-type legend orders alphabetically rather than by
 * configured duration, and there is no "Google Calendar sync not configured"
 * gate on the busy-blocks error banner, both would need a single-document
 * read of `business_settings`, and `lib/firestore.ts` only has a bounded
 * COLLECTION listener (`useCollection`) today, no single-doc hook. Flagged
 * rather than bolted on ad hoc; see `lib/scheduleFormat.ts#distinctServiceTypes`.
 */
export function Schedule({ onSelect }: ScheduleProps) {
  const sessionsState = useCollection<ScheduleSessionEntry>(SCHEDULE_SESSIONS_QUERY);
  const busyState = useCollection<BusySlotEntry>(SCHEDULE_BUSY_SLOTS_QUERY);

  const [view, setView] = useState<ScheduleViewMode>('week');
  const todayIso = useMemo(() => localDateIso(new Date()), []);
  const [selected, setSelected] = useState<string>(todayIso);

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
                        <AgendaRow key={entry._id} entry={entry} onSelect={onSelect} />
                      ))}
                      {selectedBusy.map((slot) => (
                        <BusyRow key={slot._id} slot={slot} />
                      ))}
                    </ul>
                  )}
                </DenPanel>
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
        <button type="button" className="schedule__row-main" onClick={() => onSelect(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="schedule__row-main schedule__row-main--static">{body}</div>
      )}
    </li>
  );
}

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
