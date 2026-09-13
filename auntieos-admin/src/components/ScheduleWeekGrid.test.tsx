// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ScheduleWeekGrid } from './ScheduleWeekGrid';
import { HOUR_HEIGHT_PX, SNAP_MINUTES_ON, rescheduleTimesForDrop } from '../lib/scheduleGrid';
import type { ScheduleSessionEntry, BusySlotEntry } from '../api/schedule';

/**
 * The pointer half of #397 M13. The ARITHMETIC is pinned next door in
 * `lib/scheduleGrid.test.ts`; what this suite owns is the gesture: that a press
 * that never travels is a click, that one that does reports the day and minute
 * it landed on, and that a keyboard user is never stranded.
 *
 * jsdom has no `PointerEvent` constructor and no layout. Both are handled
 * rather than worked around: React binds `onPointerDown` to the native
 * `pointerdown` type, so a `MouseEvent` of that type reaches the handler with
 * real `clientX`/`clientY`, and the one measurement the component takes
 * (`getBoundingClientRect` on a day column, for its width) is stubbed
 * per-test so a cross-day drag is a real assertion rather than a coincidence.
 */

const DAYS = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'];
/** Width of one day column once jsdom is told what a column is (see stubColumnWidth). */
const COLUMN_WIDTH = 100;

function session(over: Partial<ScheduleSessionEntry> = {}): ScheduleSessionEntry {
  return {
    _id: 'sess-1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: [],
    serviceType: 'Dog Walk',
    // 9:00 to 10:30 LOCAL, so the block lands inside the 8a-6p window in any zone.
    startTime: new Date(2026, 6, 16, 9, 0, 0, 0).toISOString(),
    arrivedAt: '',
    endTime: new Date(2026, 6, 16, 10, 30, 0, 0).toISOString(),
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  } as ScheduleSessionEntry;
}

const onSelectDay = vi.fn();
const onOpenSession = vi.fn();
const onDrop = vi.fn();

beforeEach(() => {
  onSelectDay.mockReset();
  onOpenSession.mockReset();
  onDrop.mockReset();
});

function renderGrid(rows: ScheduleSessionEntry[], busy: BusySlotEntry[] = []) {
  const byDay = new Map<string, ScheduleSessionEntry[]>();
  byDay.set('2026-07-16', rows);
  const busyByDate = new Map<string, BusySlotEntry[]>();
  if (busy.length > 0) busyByDate.set('2026-07-16', busy);
  return render(
    <ScheduleWeekGrid
      days={DAYS}
      today="2026-07-16"
      selected="2026-07-16"
      byDay={byDay}
      busyByDate={busyByDate}
      snapMinutes={SNAP_MINUTES_ON}
      pendingSessionId={null}
      onSelectDay={onSelectDay}
      onOpenSession={onOpenSession}
      onDrop={onDrop}
    />,
  );
}

/** jsdom lays nothing out, so the one width the component measures is stated here. */
function stubColumnWidth(width = COLUMN_WIDTH) {
  for (const column of document.querySelectorAll('.schedule-grid__day')) {
    (column as HTMLElement).getBoundingClientRect = () =>
      ({ width, height: 540, top: 0, left: 0, right: width, bottom: 540, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
}

function block(): HTMLElement {
  return screen.getByRole('button', { name: /The Whitfields/i });
}

/** One press-move-release, in client coordinates. */
function drag(el: HTMLElement, dx: number, dy: number) {
  fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
  fireEvent(el, new MouseEvent('pointermove', { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }));
  fireEvent(el, new MouseEvent('pointerup', { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }));
}

describe('ScheduleWeekGrid', () => {
  it('draws a visit at its local start, with the height its duration earns', () => {
    renderGrid([session()]);
    const el = block();
    // 9:00 is one hour into an 8a grid; 90 minutes is one and a half rows.
    expect(el.style.top).toBe(`${HOUR_HEIGHT_PX}px`);
    expect(el.style.height).toBe(`${HOUR_HEIGHT_PX * 1.5}px`);
    expect(el).toHaveTextContent('09:00');
  });

  it('a press that never travels is a click: it opens the sheet and writes nothing', () => {
    renderGrid([session()]);
    stubColumnWidth();
    drag(block(), 2, 3); // inside the 5px threshold
    expect(onOpenSession).toHaveBeenCalledWith('sess-1');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a real vertical drag reports the snapped minute it landed on, same day', () => {
    renderGrid([session()]);
    stubColumnWidth();
    // 54px is one hour down from 9:00; 7px more is 7.8 minutes, which floors to
    // the 10:00 quarter-hour rather than nudging the visit to 10:07.
    drag(block(), 0, HOUR_HEIGHT_PX + 7);
    expect(onDrop).toHaveBeenCalledTimes(1);
    const drop = onDrop.mock.calls[0]![0];
    expect(drop.targetDayIso).toBe('2026-07-16');
    expect(drop.dropMinuteOfDay).toBe(10 * 60);
  });

  /**
   * THE ASSERTION THAT MATTERS: the end is the visit's own 90-minute span moved
   * whole, never a length read off where the pointer stopped.
   */
  it('the times a drop maps to keep the visit exactly as long', () => {
    renderGrid([session()]);
    stubColumnWidth();
    drag(block(), 0, HOUR_HEIGHT_PX);
    const drop = onDrop.mock.calls[0]![0];
    const times = rescheduleTimesForDrop(drop.session, drop.targetDayIso, drop.dropMinuteOfDay, SNAP_MINUTES_ON);
    expect(times).toEqual({
      startTime: new Date(2026, 6, 16, 10, 0, 0, 0).toISOString(),
      endTime: new Date(2026, 6, 16, 11, 30, 0, 0).toISOString(),
    });
  });

  it('a sideways drag moves the visit to another day at the same hour', () => {
    renderGrid([session()]);
    stubColumnWidth();
    drag(block(), COLUMN_WIDTH * 2, 0); // two columns to the right of Thursday
    const drop = onDrop.mock.calls[0]![0];
    expect(drop.targetDayIso).toBe('2026-07-18');
    expect(drop.dropMinuteOfDay).toBe(9 * 60);
  });

  it('a drag past the end of the week stops at the last column, never off the grid', () => {
    renderGrid([session()]);
    stubColumnWidth();
    drag(block(), 2000, 0);
    expect(onDrop.mock.calls[0]![0].targetDayIso).toBe('2026-07-19');
  });

  it('a drag below the grid lands on the last snappable minute inside it', () => {
    renderGrid([session()]);
    stubColumnWidth();
    drag(block(), 0, 5000);
    expect(onDrop.mock.calls[0]![0].dropMinuteOfDay).toBe(17 * 60 + 45);
  });

  /**
   * The keyboard path (#397 M13's accessibility half): a block is a real
   * button, Enter opens the detail sheet, and the sheet's Reschedule form
   * writes through the same callable the drag does. A keyboard user is never
   * asked to perform a gesture.
   */
  it('Enter and Space open the detail sheet rather than moving anything', () => {
    renderGrid([session()]);
    const el = block();
    expect(el.tagName).toBe('BUTTON');
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyDown(el, { key: ' ' });
    expect(onOpenSession).toHaveBeenCalledTimes(2);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('a busy block is a static overlay, never a control', () => {
    renderGrid([], [{ _id: 'slot-1', date: '2026-07-16', startTime: '09:00', endTime: '10:00', slotType: 'BLOCKED' }]);
    const busy = screen.getByText('Busy');
    expect(busy.closest('button')).toBeNull();
  });

  /**
   * #755: the mock tints every block by its service type and says where a
   * busy block came from. The tone rides `data-tone`, the attribute the kit
   * resolves to `--den-tone`, so the block, the month cell and the legend
   * swatch all read one mapping.
   */
  it('a visit block carries its service tone, and a busy block its start and source', () => {
    renderGrid(
      [session({ serviceType: 'House Sit' })],
      [
        { _id: 'g', date: '2026-07-16', startTime: '11:00', endTime: '12:00', slotType: 'BLOCKED', source: 'GOOGLE_BUSY_IMPORT' },
        { _id: 'm', date: '2026-07-16', startTime: '13:00', endTime: '14:00', slotType: 'BLOCKED', source: 'INTERNAL_MANUAL' },
      ],
    );
    expect(block()).toHaveAttribute('data-tone', 'purple');
    const [mirror, manual] = Array.from(document.querySelectorAll('.schedule-grid__busy')) as [HTMLElement, HTMLElement];
    expect(mirror).toHaveTextContent('11:00');
    expect(mirror).toHaveTextContent('From Google Calendar');
    expect(manual).toHaveTextContent('13:00');
    expect(manual).not.toHaveTextContent('From Google Calendar');
  });

  it('a visit already being written cannot be grabbed again', () => {
    const byDay = new Map([['2026-07-16', [session()]]]);
    render(
      <ScheduleWeekGrid
        days={DAYS}
        today="2026-07-16"
        selected="2026-07-16"
        byDay={byDay}
        busyByDate={new Map()}
        snapMinutes={SNAP_MINUTES_ON}
        pendingSessionId="sess-1"
        onSelectDay={onSelectDay}
        onOpenSession={onOpenSession}
        onDrop={onDrop}
      />,
    );
    expect(block()).toBeDisabled();
  });

  it('a visit outside the drawn hours is counted and named, never silently dropped', () => {
    renderGrid([session({ _id: 'early', startTime: new Date(2026, 6, 16, 6, 0, 0, 0).toISOString(), endTime: new Date(2026, 6, 16, 7, 0, 0, 0).toISOString() })]);
    expect(screen.getByText(/1 visit outside the 8a to 6p window/)).toBeInTheDocument();
  });

  it('the day headers still pick the agenda day', () => {
    renderGrid([session()]);
    fireEvent.click(screen.getByRole('button', { name: '2026-07-18' }));
    expect(onSelectDay).toHaveBeenCalledWith('2026-07-18');
  });
});

/**
 * The "now" line (#696).
 *
 * The mock draws a coral rule with the clock beside it across today's column;
 * this grid had none. The gap sat unrecorded because the walk that found the
 * month view ran at 1:44am, hours outside the drawn 8a-6p window, so the line
 * would have been absent there either way and the mark could only say
 * "unverified".
 *
 * Clock-pinned, because "is the line at 11:18" is not a question a test can ask
 * of the real time of day. `renderGrid` fixes today at 2026-07-16, so the date
 * set here has to match it for the line to have a column to sit in.
 */
describe('ScheduleWeekGrid now line', () => {
  function nowLine(): HTMLElement | null {
    return document.querySelector('.schedule-grid__day--today .schedule-grid__now');
  }

  function atLocalTime(hour: number, minute: number, run: () => void): void {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 16, hour, minute, 0, 0));
      run();
    } finally {
      vi.useRealTimers();
    }
  }

  it('draws the line at the current minute, in today’s column, with the clock beside it', () => {
    atLocalTime(11, 18, () => {
      renderGrid([session()]);
      const line = nowLine();
      expect(line).not.toBeNull();
      // 11:18 is 198 minutes into an 8a grid, at 0.9px a minute.
      expect(line?.style.top).toBe(`${(HOUR_HEIGHT_PX * 198) / 60}px`);
      expect(line).toHaveTextContent('11:18');
    });
  });

  it('draws no line at all when the clock is outside the drawn hours', () => {
    // 7pm, an hour past the bottom edge. Pinning the line to that edge would
    // claim 6pm is now, which is the silent-lie shape this codebase forbids.
    atLocalTime(19, 0, () => {
      renderGrid([session()]);
      expect(nowLine()).toBeNull();
      expect(document.querySelector('.schedule-grid__now')).toBeNull();
    });
  });

  it('never marks a day that is not today', () => {
    atLocalTime(11, 18, () => {
      renderGrid([session()]);
      // One line on the whole grid, and it is inside the today column.
      expect(document.querySelectorAll('.schedule-grid__now')).toHaveLength(1);
      const column = document.querySelector('.schedule-grid__day--today') as HTMLElement;
      expect(column.dataset['day']).toBe('2026-07-16');
    });
  });

  it('keeps ticking: an hour of wall clock moves the line down an hour', () => {
    atLocalTime(11, 18, () => {
      renderGrid([session()]);
      const before = nowLine()?.style.top;
      act(() => {
        vi.advanceTimersByTime(60 * 60 * 1000);
      });
      expect(nowLine()?.style.top).toBe(`${Number(before?.replace('px', '')) + HOUR_HEIGHT_PX}px`);
      expect(nowLine()).toHaveTextContent('12:18');
    });
  });
});
