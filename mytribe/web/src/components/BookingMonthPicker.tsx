import { useMemo, useState } from 'react';
import {
  BOOKING_HORIZON_DAYS,
  bookingHorizonEnd,
  dateKey,
  isBookableDay,
  monthIndex,
  monthPickerDays,
  shiftMonth,
  startOfDay,
} from '../lib/bookingWizardLogic';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Stable empty map so a caller that never wired closures doesn't create a new prop identity every render. */
const NO_CLOSURES: ReadonlyMap<string, string> = new Map();

/**
 * Individual-pattern date grid for Step 3: a real calendar month,
 * weekday-aligned, tap-to-toggle, multi-select.
 *
 * #544: the month is navigable. It used to be frozen on the current month
 * with no control to leave it, so a household could not book ahead at all --
 * on the 28th of a month there were three bookable days left in the whole
 * portal. Back is bounded at today's month and Next at the booking horizon
 * (`BOOKING_HORIZON_DAYS`); inside the shown month, a day before today or
 * past the horizon renders disabled rather than vanishing, so the grid still
 * reads as a calendar. The mirror of this lives in BookingWizardScreen.kt's
 * `SimpleMonthPicker` (bounds in BookingCalendar.kt).
 *
 * C1: `closedDates` (date key -> closure name, from `getBusinessClosures`)
 * marks and DISABLES a company-holiday day. Unlike every other mark this
 * wizard could show, a closure is not the household's call to overrule --
 * `requestBooking` refuses it server-side unconditionally regardless of what
 * this picker does, so this is purely about not offering a date that is
 * guaranteed to be refused. `NO_CLOSURES` degrades to the pre-C1 behavior
 * (every day pickable) when the caller has not loaded closures yet or the
 * read failed, rather than the wizard being blocked on a secondary read.
 * The caller resolves ONE closure window spanning the whole horizon, so
 * every month this picker can reach is already answered before it is shown.
 */
export function BookingMonthPicker(props: {
  selectedDates: ReadonlySet<string>;
  onToggle: (key: string, date: Date) => void;
  closedDates?: ReadonlyMap<string, string>;
  /** Overridable so tests can pin "today" instead of racing the wall clock. */
  today?: Date;
  horizonDays?: number;
}) {
  const closedDates = props.closedDates ?? NO_CLOSURES;
  const fixedToday = props.today;
  const horizonDays = props.horizonDays ?? BOOKING_HORIZON_DAYS;
  const today = useMemo(() => startOfDay(fixedToday ?? new Date()), [fixedToday]);
  const horizonEnd = useMemo(() => bookingHorizonEnd(today, horizonDays), [today, horizonDays]);

  const [anchor, setAnchor] = useState<Date>(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const days = useMemo(() => monthPickerDays(anchor), [anchor]);
  const leadingBlanks = days[0] ? days[0].getDay() : 0;

  const canGoBack = monthIndex(anchor) > monthIndex(today);
  const canGoForward = monthIndex(anchor) < monthIndex(horizonEnd);
  const monthLabel = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;

  return (
    <div className="monthpicker">
      <div className="mp-head">
        <button
          type="button"
          className="mp-nav"
          aria-label="Previous month"
          disabled={!canGoBack}
          onClick={() => setAnchor((a) => shiftMonth(a, -1))}
        >
          {'‹'}
        </button>
        <span className="mp-month" aria-live="polite">
          {monthLabel}
        </span>
        <button
          type="button"
          className="mp-nav"
          aria-label="Next month"
          disabled={!canGoForward}
          onClick={() => setAnchor((a) => shiftMonth(a, 1))}
        >
          {'›'}
        </button>
      </div>
      <div className="mp-grid mp-weekdays">
        {WEEKDAY_HEADERS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="mp-grid">
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <span key={`blank-${i}`} className="mp-blank" />
        ))}
        {days.map((d) => {
          const key = dateKey(d);
          const selected = props.selectedDates.has(key);
          const closedName = closedDates.get(key);
          const closed = closedName !== undefined;
          const bookable = isBookableDay(d, today, horizonEnd);
          const title = closed
            ? `Closed: ${closedName}`
            : bookable
              ? undefined
              : d < today
                ? 'Already past'
                : 'Too far ahead to book';
          return (
            <button
              key={key}
              type="button"
              className={`mp-day ${selected ? 'is-on' : ''} ${closed ? 'is-closed' : ''} ${bookable ? '' : 'is-unavailable'}`}
              aria-pressed={selected}
              disabled={closed || !bookable}
              title={title}
              onClick={() => props.onToggle(key, d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
