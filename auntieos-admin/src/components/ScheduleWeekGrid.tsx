import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ScheduleSessionEntry, BusySlotEntry } from '../api/schedule';
import {
  GRID_END_HOUR,
  GRID_HOURS,
  GRID_START_HOUR,
  GRID_START_MINUTE,
  HOUR_HEIGHT_PX,
  MIN_BLOCK_MINUTES,
  busyPlacement,
  clampDropMinute,
  gridPlacement,
  hhmmFromMinutes,
  hourLabel,
  localMinutesOfDay,
  minuteFromOffsetPx,
  snapMinuteOfDay,
} from '../lib/scheduleGrid';
import { visitDurationMinutes } from '../lib/bookingDetailFormat';
import { sessionHousehold } from '../lib/sessionFormat';
import { busyWindowLabel, weekdayAbbrev } from '../lib/scheduleFormat';
import { str } from '../lib/coerce';
import './ScheduleWeekGrid.css';

/**
 * How far the pointer has to travel before a press counts as a DRAG rather than
 * a click.
 *
 * Without it the grid would have no click at all: every press moves a pixel or
 * two, so opening a visit's detail sheet — which is also the keyboard path to
 * rescheduling it — would fire a reschedule instead. 5px is the usual touch
 * slop, and it is measured from the press point, not accumulated, so a slow
 * wobble in place never crosses it.
 */
const DRAG_THRESHOLD_PX = 5;

/** One in-flight drag. Null whenever the pointer is not down on a block. */
interface DragState {
  pointerId: number;
  sessionId: string;
  /** The day column the block started in, as an index into `days`. */
  fromDayIndex: number;
  /** Where the block's top edge sits when it is not being dragged. */
  originTopPx: number;
  startClientX: number;
  startClientY: number;
  /** False until the pointer has travelled past {@link DRAG_THRESHOLD_PX}: a press that never does is a click. */
  moved: boolean;
  /** Live preview, recomputed on every move. */
  dayIndex: number;
  minute: number;
  /**
   * Raw sideways travel, in px, purely for the preview.
   *
   * THE DRAGGED BLOCK NEVER LEAVES ITS ORIGINAL COLUMN IN THE DOM, and it must
   * not: re-parenting it into the target column unmounts the element the
   * gesture is bound to, and the drag dies halfway with the pointer still down
   * (pointer capture goes with the node). So a cross-day drag is previewed by
   * translating the block sideways out of its own column, and only the DROP
   * moves it, by writing a new day.
   */
  dxPx: number;
}

export interface ScheduleDrop {
  session: ScheduleSessionEntry;
  targetDayIso: string;
  /** Already clamped into the drawn window and snapped to the operator's granularity. */
  dropMinuteOfDay: number;
}

interface ScheduleWeekGridProps {
  /** The seven `YYYY-MM-DD` days on screen, Monday first. */
  days: string[];
  today: string;
  selected: string;
  byDay: Map<string, ScheduleSessionEntry[]>;
  busyByDate: Map<string, BusySlotEntry[]>;
  /** 15 when the operator turned on "Snap drag-to-reschedule to 15 min", else 1. */
  snapMinutes: number;
  /** The session currently being written, so its block reads as in-flight and cannot be grabbed again. */
  pendingSessionId: string | null;
  /**
   * Bumped by the parent to ask the grid to scroll its first busy block into
   * view, e.g. after the operator clicks the "Busy blocks" stat card (#697).
   * A counter rather than a boolean so a second click on the same day (the
   * grid already scrolled there) still fires the effect.
   */
  scrollToBusyRequestId?: number;
  onSelectDay: (day: string) => void;
  onOpenSession: (sessionId: string) => void;
  onDrop: (drop: ScheduleDrop) => void;
}

/**
 * The week time grid, and the drag that moves a visit on it (#397 M13).
 *
 * WHAT THIS REPLACES: the Schedule screen's week strip was seven day BUTTONS
 * with a count badge. It could say a Tuesday had three visits; it could not show
 * when any of them were, which is what a calendar is for, and it gave a drag
 * nothing to be a drag ON. The strip's job — pick a day for the agenda below —
 * is kept: the column headers are still buttons and still drive `selected`.
 *
 * THE GEOMETRY IS PORTED, NOT INVENTED: 8a to 6p at 54px an hour, from the
 * operator's mock and from the desktop admin's shipped Compose grid, which the
 * mock's own comment claims parity with. All of it lives in `lib/scheduleGrid.ts`
 * with unit tests, because a pointer gesture is a terrible place to assert that
 * 9:07 snaps to 9:00.
 *
 * VISITS OUTSIDE THE DRAWN WINDOW ARE COUNTED AND NAMED, never silently
 * dropped: a 7am visit is still a visit, and the line under the grid says how
 * many the calendar could not draw and where to see them.
 *
 * BUSY BLOCKS ARE NOT DRAGGABLE, and that is not a styling choice.
 * `booking_time_slots` is denied every client write by `firestore.rules`; the
 * only way to move one is to delete and re-block it. A grabbable busy block
 * would be the dead control the Buttons.tsx convention exists to prevent, so it
 * renders as a static, `not-allowed` overlay — exactly what the mock draws.
 *
 * EVERY VISIT BLOCK IS A REAL `<button>`. That is the accessibility contract:
 * the drag is a pointer affordance and nothing else, so the grid must not be the
 * only way to move a visit. Tab reaches each block, Enter or Space opens the
 * detail sheet, and the sheet carries the Reschedule form that writes through
 * the same `rescheduleBooking` callable this drag does. Keyboard users take the
 * long way round; they never hit a wall.
 */
export function ScheduleWeekGrid({
  days,
  today,
  selected,
  byDay,
  busyByDate,
  snapMinutes,
  pendingSessionId,
  scrollToBusyRequestId,
  onSelectDay,
  onOpenSession,
  onDrop,
}: ScheduleWeekGridProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // #697: the click that asked for this lands on the day (`onSelectDay`
  // upstream), the scroll here just brings that day's first busy block into
  // the visible area, since the week grid scrolls sideways below 900px
  // (`ScheduleWeekGrid.css`) and a block a few columns over is otherwise off
  // screen. Skipped on request id 0 (the initial render, nothing asked for).
  useEffect(() => {
    if (!scrollToBusyRequestId) return;
    const firstBusyBlock = bodyRef.current?.querySelector('.schedule-grid__busy');
    firstBusyBlock?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [scrollToBusyRequestId]);

  /**
   * Width of one day column, for turning sideways travel into a day shift.
   *
   * MEASURED OFF A COLUMN, not divided out of the body: the body's grid carries
   * a fixed time gutter as its first track, so `width / 7` would be wide by a
   * seventh of the gutter and a two-column drag would land one column short.
   *
   * Zero in any environment that does not lay out (jsdom, a hidden tab), and
   * that is handled rather than divided by: a drag then moves the visit within
   * its own day, which is the desktop admin's only behaviour anyway. A cross-day
   * drag is what the mock adds, never the only way to reach another day — the
   * detail sheet's Reschedule takes a date.
   */
  function columnWidthPx(): number {
    const column = bodyRef.current?.querySelector('.schedule-grid__day');
    return column?.getBoundingClientRect().width ?? 0;
  }

  function onBlockPointerDown(
    e: ReactPointerEvent<HTMLButtonElement>,
    session: ScheduleSessionEntry,
    dayIndex: number,
    topPx: number,
    startMinute: number,
  ) {
    if (pendingSessionId !== null) return;
    // jsdom has no pointer capture; the optional call keeps the gesture working
    // in a real browser without making the component untestable.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({
      pointerId: e.pointerId,
      sessionId: session._id,
      fromDayIndex: dayIndex,
      originTopPx: topPx,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      dayIndex,
      minute: startMinute,
      dxPx: 0,
    });
  }

  function onBlockPointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    setDrag((prev) => {
      if (prev === null || prev.pointerId !== e.pointerId) return prev;
      const dx = e.clientX - prev.startClientX;
      const dy = e.clientY - prev.startClientY;
      const moved = prev.moved || Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX;
      if (!moved) return prev;
      const colWidth = columnWidthPx();
      const shift = colWidth > 0 ? Math.round(dx / colWidth) : 0;
      const dayIndex = Math.min(Math.max(prev.fromDayIndex + shift, 0), days.length - 1);
      const minute = snapMinuteOfDay(
        clampDropMinute(minuteFromOffsetPx(prev.originTopPx + dy)),
        snapMinutes,
      );
      return { ...prev, moved, dayIndex, minute, dxPx: dx };
    });
  }

  function onBlockPointerUp(e: ReactPointerEvent<HTMLButtonElement>, session: ScheduleSessionEntry) {
    const current = drag;
    setDrag(null);
    if (current === null || current.pointerId !== e.pointerId) return;
    if (!current.moved) {
      // A press that never travelled is a click: open the sheet, write nothing.
      onOpenSession(session._id);
      return;
    }
    const targetDayIso = days[current.dayIndex];
    if (targetDayIso === undefined) return;
    onDrop({ session, targetDayIso, dropMinuteOfDay: current.minute });
  }

  // Only rows whose start is READABLE but falls outside the drawn hours. A row
  // whose `startTime` does not parse at all is a different problem and would be
  // a lie to report as "outside the window".
  const offWindow = days.reduce((sum, day) => {
    const rows = byDay.get(day) ?? [];
    return (
      sum +
      rows.filter((r) => {
        const minute = localMinutesOfDay(r.startTime);
        return minute !== null && gridPlacement(minute, MIN_BLOCK_MINUTES) === null;
      }).length
    );
  }, 0);

  return (
    <div className="schedule-grid" role="group" aria-label="Week">
      <div className="schedule-grid__head">
        <div className="schedule-grid__gutter-head" aria-hidden="true" />
        {days.map((day) => (
          <button
            key={day}
            type="button"
            className={dayHeadClass(day, today, selected)}
            onClick={() => onSelectDay(day)}
            aria-current={day === today ? 'date' : undefined}
            aria-pressed={day === selected}
            aria-label={day}
          >
            <span className="schedule-grid__dow">{weekdayAbbrev(day)}</span>
            <span className="schedule-grid__dnum">{Number(day.slice(8, 10))}</span>
          </button>
        ))}
      </div>

      <div className="schedule-grid__body" ref={bodyRef}>
        <div className="schedule-grid__times" aria-hidden="true">
          {Array.from({ length: GRID_HOURS }, (_, i) => (
            <span key={i} className="schedule-grid__time" style={{ height: `${HOUR_HEIGHT_PX}px` }}>
              {hourLabel(GRID_START_HOUR + i)}
            </span>
          ))}
        </div>

        {days.map((day, dayIndex) => (
          <div
            key={day}
            className={day === today ? 'schedule-grid__day schedule-grid__day--today' : 'schedule-grid__day'}
            style={{ height: `${HOUR_HEIGHT_PX * GRID_HOURS}px` }}
            data-day={day}
          >
            {(busyByDate.get(day) ?? []).map((slot) => {
              const place = busyPlacement(slot.startTime, slot.endTime);
              if (place === null) return null;
              return (
                <div
                  key={slot._id}
                  className="schedule-grid__busy"
                  style={{ top: `${place.topPx}px`, height: `${place.heightPx}px` }}
                  title={busyWindowLabel(slot.startTime, slot.endTime)}
                >
                  <span className="schedule-grid__busy-label">Busy</span>
                </div>
              );
            })}

            {(byDay.get(day) ?? []).map((entry) => {
              const startMinute = localMinutesOfDay(entry.startTime);
              if (startMinute === null) return null;
              const place = gridPlacement(startMinute, visitDurationMinutes(entry));
              if (place === null) return null;
              const dragging = drag?.sessionId === entry._id && drag.moved;
              const previewTop = dragging ? previewTopPx(drag.minute) : place.topPx;
              const pending = pendingSessionId === entry._id;
              return (
                <button
                  key={entry._id}
                  type="button"
                  className={blockClass(dragging, pending)}
                  style={{
                    top: `${previewTop}px`,
                    height: `${place.heightPx}px`,
                    ...(dragging && drag.dxPx !== 0 && { transform: `translateX(${drag.dxPx}px)` }),
                  }}
                  data-session-id={entry._id}
                  data-start-minute={startMinute}
                  aria-label={`${sessionHousehold(str(entry.kinfolkName))} at ${hhmmFromMinutes(startMinute)}. Open to reschedule.`}
                  disabled={pending}
                  onPointerDown={(e) => onBlockPointerDown(e, entry, dayIndex, place.topPx, startMinute)}
                  onPointerMove={onBlockPointerMove}
                  onPointerUp={(e) => onBlockPointerUp(e, entry)}
                  onPointerCancel={() => setDrag(null)}
                  // Keyboard activation never drags: Enter and Space open the
                  // sheet, whose Reschedule form is the non-pointer path to the
                  // same write.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenSession(entry._id);
                    }
                  }}
                >
                  <span className="schedule-grid__block-time">
                    {hhmmFromMinutes(dragging ? drag.minute : startMinute)}
                  </span>
                  <span className="schedule-grid__block-name">
                    {sessionHousehold(str(entry.kinfolkName))}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <p className="schedule-grid__note">
        {offWindow > 0
          ? `${offWindow} visit${offWindow === 1 ? '' : 's'} outside the ${hourLabel(GRID_START_HOUR)} to ${hourLabel(GRID_END_HOUR)} window. Open that day below to see all of its visits.`
          : `Drag a visit to move it. Or open one and use Reschedule.`}
      </p>
    </div>
  );
}

/** Top offset for a previewed minute, the inverse of `minuteFromOffsetPx`. */
function previewTopPx(minuteOfDay: number): number {
  return (HOUR_HEIGHT_PX * (minuteOfDay - GRID_START_MINUTE)) / 60;
}

function blockClass(dragging: boolean, pending: boolean): string {
  const classes = ['schedule-grid__block'];
  if (dragging) classes.push('schedule-grid__block--dragging');
  if (pending) classes.push('schedule-grid__block--pending');
  return classes.join(' ');
}

function dayHeadClass(day: string, today: string, selected: string): string {
  const classes = ['schedule-grid__day-head'];
  if (day === today) classes.push('schedule-grid__day-head--today');
  if (day === selected) classes.push('schedule-grid__day-head--selected');
  return classes.join(' ');
}
