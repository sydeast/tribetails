import { useMemo } from 'react';
import { dateKey, monthPickerDays } from '../lib/bookingWizardLogic';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Stable empty map so a caller that never wired closures doesn't create a new prop identity every render. */
const NO_CLOSURES: ReadonlyMap<string, string> = new Map();

/**
 * Individual-pattern date grid for Step 3. Offers the same 28 consecutive
 * days as the Kotlin `SimpleMonthPicker` (starting the 1st of the current
 * month; see bookingWizardLogic.ts's `monthPickerDays`), tap-to-toggle,
 * multi-select. Weekday-aligned with leading blanks and a real month/year
 * header for the desktop mockup's "real date/month labels": purely a
 * display choice; the underlying date SET offered is unchanged from Kotlin.
 *
 * C1: `closedDates` (date key -> closure name, from `getBusinessClosures`)
 * marks and DISABLES a company-holiday day. Unlike every other mark this
 * wizard could show, a closure is not the household's call to overrule --
 * `requestBooking` refuses it server-side unconditionally regardless of what
 * this picker does, so this is purely about not offering a date that is
 * guaranteed to be refused. `NO_CLOSURES` degrades to the pre-C1 behavior
 * (every day pickable) when the caller has not loaded closures yet or the
 * read failed, rather than the wizard being blocked on a secondary read.
 */
export function BookingMonthPicker(props: {
  selectedDates: ReadonlySet<string>;
  onToggle: (key: string, date: Date) => void;
  closedDates?: ReadonlyMap<string, string>;
}) {
  const closedDates = props.closedDates ?? NO_CLOSURES;
  const today = useMemo(() => new Date(), []);
  const days = useMemo(() => monthPickerDays(today), [today]);
  const leadingBlanks = days[0] ? days[0].getDay() : 0;

  return (
    <div className="monthpicker">
      <div className="mp-head">
        {MONTH_NAMES[today.getMonth()]} {today.getFullYear()}
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
          return (
            <button
              key={key}
              type="button"
              className={`mp-day ${selected ? 'is-on' : ''} ${closed ? 'is-closed' : ''}`}
              aria-pressed={selected}
              disabled={closed}
              title={closed ? `Closed: ${closedName}` : undefined}
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
