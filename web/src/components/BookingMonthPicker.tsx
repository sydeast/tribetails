import { useMemo } from 'react';
import { dateKey, monthPickerDays } from '../lib/bookingWizardLogic';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Individual-pattern date grid for Step 3. Offers the same 28 consecutive
 * days as the Kotlin `SimpleMonthPicker` (starting the 1st of the current
 * month; see bookingWizardLogic.ts's `monthPickerDays`), tap-to-toggle,
 * multi-select. Weekday-aligned with leading blanks and a real month/year
 * header for the desktop mockup's "real date/month labels": purely a
 * display choice; the underlying date SET offered is unchanged from Kotlin.
 */
export function BookingMonthPicker(props: { selectedDates: ReadonlySet<string>; onToggle: (key: string, date: Date) => void }) {
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
          return (
            <button
              key={key}
              type="button"
              className={`mp-day ${selected ? 'is-on' : ''}`}
              aria-pressed={selected}
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
