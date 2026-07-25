import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  addCalendarDays,
  monthGridDays,
  rangeLabel,
  shiftRange,
  sessionDayLabel,
} from '../lib/scheduleFormat';
import { dayBadge, dayDescription, type DayAvailability } from '../lib/bookingAvailability';
import './AuntieDatePicker.css';

/**
 * The admin's booking calendar: a month grid the operator can drive entirely
 * from the keyboard, marked with what the business already has on each day.
 *
 * ── WHY THIS IS NOT THE PORTAL'S PICKER ─────────────────────────────────────
 *
 * `mytribe/web/src/components/BookingMonthPicker.tsx` exists and does look like
 * this, so it was the first thing checked. It is not reusable here, on three
 * counts that are all about what the KINFOLK wizard is for:
 *
 *  - It offers a fixed 28 consecutive days from the 1st of the current month
 *    and has NO month navigation, because a kinfolk booking a walk is choosing
 *    inside a near window. An operator filing a request on a household's behalf
 *    routinely books next quarter.
 *  - It has no availability marks and no disabled days. It is the client's view,
 *    where the business's blocked time is not the client's business; the whole
 *    ask here is that the admin's picker stop looking authoritative about days
 *    the business is shut.
 *  - It is mouse-only: plain buttons, no grid semantics, no arrow keys.
 *
 * It also lives behind `mytribe/web`'s own Vite project and imports that tree's
 * `lib/bookingWizardLogic`, so there is no import path from here to there that
 * does not mean restructuring two builds. The kinship that DOES matter is kept:
 * a weekday-aligned month grid, tap to toggle, multi-select, and the same
 * "a selected day is a set member" model. Nothing is forked that could be shared.
 *
 * ── KEYBOARD: WHY NOT `useRovingTabs` ───────────────────────────────────────
 *
 * `lib/useRovingTabs.ts` is the right helper for the twelve chip rows that use
 * it, and the wrong one here, because it solves a ONE-dimensional tablist over
 * a FIXED set of tabs. A calendar is neither:
 *
 *  - Left/Right move by a day, Up/Down move by a WEEK. `useRovingTabs` maps its
 *    two arrow keys to the same +1/-1 step on one axis and wraps at the ends;
 *    a calendar needs both axes live at once with different strides.
 *  - Home/End mean the start and end of the focused WEEK, not of the whole set.
 *  - PageUp/PageDown change month, and arrowing off the edge of the grid has to
 *    change the RENDERED SET and keep focus on the day that moved into view.
 *    `useRovingTabs` addresses tabs by index into a fixed count; it has no way
 *    to express "the set just changed under you".
 *
 * What is reused is the PRINCIPLE that helper encodes and this file re-states
 * for two dimensions: roving tabindex, so exactly one cell is in the Tab order
 * and one Tab keypress leaves the calendar instead of stepping through 42 days.
 * The WAI-ARIA grid pattern this follows is the Date Picker Dialog:
 * https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 *
 * Every `iso` in and out of this component is a LOCAL `YYYY-MM-DD`, the
 * operator's device wall clock. See `lib/bookingAvailability.ts`'s header for
 * the full decision and why no conversion happens anywhere in this feature.
 */

interface AuntieDatePickerProps {
  /** Selected days, LOCAL `YYYY-MM-DD`. One member in `single` mode. */
  selected: ReadonlySet<string>;
  /** Fired with the LOCAL `YYYY-MM-DD` of the activated day. */
  onToggle: (iso: string) => void;
  /** Today, LOCAL `YYYY-MM-DD`. Days before it are never selectable. */
  todayIso: string;
  /** What the picker knows about a given day. Called per rendered cell. */
  availabilityFor: (iso: string) => DayAvailability;
  /** `multi` toggles set membership; `single` replaces it. Affects copy only. */
  mode: 'multi' | 'single';
  /** Accessible name for the whole control, e.g. "Visit dates". */
  label: string;
}

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function AuntieDatePicker({
  selected,
  onToggle,
  todayIso,
  availabilityFor,
  mode,
  label,
}: AuntieDatePickerProps) {
  const headingId = useId();

  /**
   * The month on screen, as any day inside it. Seeded from the earliest
   * selection so reopening a partly-filled form lands where the operator was,
   * and from today otherwise.
   */
  const [cursorIso, setCursorIso] = useState(() => earliest(selected) ?? todayIso);

  /**
   * The one cell in the Tab order. Kept separate from `selected` because
   * focus and selection are genuinely different in a multi-select grid: the
   * operator arrows across days without choosing them, and must be able to.
   */
  const [focusIso, setFocusIso] = useState(cursorIso);

  /**
   * Set only by a key press, so React moves DOM focus after the grid re-renders
   * (which is the case that matters: arrowing across a month boundary renders a
   * different 42 days). Never set on mount or on a click, or the calendar would
   * steal focus from the dialog when it opens.
   */
  const pendingFocus = useRef<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const days = useMemo(() => monthGridDays(cursorIso), [cursorIso]);

  useEffect(() => {
    const want = pendingFocus.current;
    if (want === null) return;
    pendingFocus.current = null;
    cellRefs.current.get(want)?.focus();
  });

  const moveFocus = useCallback((nextIso: string) => {
    setFocusIso(nextIso);
    setCursorIso(nextIso);
    pendingFocus.current = nextIso;
  }, []);

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const from = focusIso;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(addCalendarDays(from, -1));
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(addCalendarDays(from, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(addCalendarDays(from, -7));
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(addCalendarDays(from, 7));
        return;
      case 'Home': {
        // Start of the focused week. The grid is Monday-first, and its rows are
        // sliced from `monthGridDays`, so the row start is derived from the
        // rendered array rather than recomputed with a second weekday rule.
        event.preventDefault();
        const idx = days.indexOf(from);
        if (idx >= 0) moveFocus(days[idx - (idx % 7)]!);
        return;
      }
      case 'End': {
        event.preventDefault();
        const idx = days.indexOf(from);
        if (idx >= 0) moveFocus(days[idx - (idx % 7) + 6]!);
        return;
      }
      case 'PageUp':
        event.preventDefault();
        moveFocus(shiftRange(from, 'month', -1));
        return;
      case 'PageDown':
        event.preventDefault();
        moveFocus(shiftRange(from, 'month', 1));
        return;
      default:
        // Enter and Space are left to the native <button> in the cell, so the
        // activation path is the same one a click takes. Nothing to duplicate.
        return;
    }
  }

  function stepMonth(direction: 1 | -1) {
    const next = shiftRange(cursorIso, 'month', direction);
    setCursorIso(next);
    // Keep the Tab target inside the month now on screen, or Tab would land on
    // a cell that is no longer rendered and focus would fall to the document.
    setFocusIso(next);
  }

  const monthLabel = rangeLabel(cursorIso, 'month');
  const cursorMonth = cursorIso.slice(0, 7);
  const rows = useMemo(
    () => Array.from({ length: days.length / 7 }, (_, r) => days.slice(r * 7, r * 7 + 7)),
    [days],
  );

  return (
    <div className="datepicker">
      <div className="datepicker__head">
        <button
          type="button"
          className="datepicker__nav"
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
        >
          &lsaquo;
        </button>
        <span className="datepicker__month" id={headingId} aria-live="polite">
          {monthLabel}
        </span>
        <button
          type="button"
          className="datepicker__nav"
          onClick={() => stepMonth(1)}
          aria-label="Next month"
        >
          &rsaquo;
        </button>
      </div>

      <div className="datepicker__weekdays" aria-hidden="true">
        {WEEKDAY_HEADERS.map((w) => (
          <span key={w} className="datepicker__weekday">
            {w}
          </span>
        ))}
      </div>

      <div
        className="datepicker__grid"
        role="grid"
        aria-label={label}
        aria-multiselectable={mode === 'multi'}
        onKeyDown={onGridKeyDown}
      >
        {rows.map((row) => (
          <div className="datepicker__row" role="row" key={row[0]}>
            {row.map((iso) => {
              const day = availabilityFor(iso);
              const isSelected = selected.has(iso);
              const badge = dayBadge(day);
              const description = dayDescription(day);
              const outside = iso.slice(0, 7) !== cursorMonth;
              return (
                <button
                  key={iso}
                  type="button"
                  role="gridcell"
                  ref={(el) => {
                    if (el) cellRefs.current.set(iso, el);
                    else cellRefs.current.delete(iso);
                  }}
                  className={cellClass({ isSelected, outside, day, badge })}
                  tabIndex={iso === focusIso ? 0 : -1}
                  aria-selected={isSelected}
                  // `aria-disabled`, not `disabled`: a past day must stay
                  // FOCUSABLE or arrowing left off the 1st of the month drops
                  // focus to the document and the keyboard user is stranded
                  // mid-grid. The activation guard below is what actually
                  // refuses the pick.
                  aria-disabled={day.past}
                  aria-label={
                    description === ''
                      ? sessionDayLabel(iso, todayIso)
                      : `${sessionDayLabel(iso, todayIso)}, ${description}`
                  }
                  onClick={() => {
                    setFocusIso(iso);
                    if (day.past) return;
                    onToggle(iso);
                  }}
                >
                  <span className="datepicker__daynum">{Number(iso.slice(8, 10))}</span>
                  {badge !== null && <span className="datepicker__badge">{badge}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function cellClass(opts: {
  isSelected: boolean;
  outside: boolean;
  day: DayAvailability;
  badge: string | null;
}): string {
  // No `.lift`, deliberately, and for the reason `.schedule__day-cell` skipped
  // it: 42 tiles each rising 3px under a 36px shadow reads as noise, not depth.
  const classes = ['datepicker__day'];
  if (opts.isSelected) classes.push('datepicker__day--selected');
  if (opts.outside) classes.push('datepicker__day--outside');
  if (opts.day.past) classes.push('datepicker__day--past');
  if (opts.badge === 'Blocked') classes.push('datepicker__day--blocked');
  if (opts.badge === 'Closed') classes.push('datepicker__day--closed');
  return classes.join(' ');
}

function earliest(set: ReadonlySet<string>): string | null {
  let min: string | null = null;
  for (const iso of set) if (min === null || iso < min) min = iso;
  return min;
}
