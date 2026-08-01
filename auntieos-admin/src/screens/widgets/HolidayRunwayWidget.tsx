import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import { holidayRunway } from '../../lib/dashboardInsights';
import { humanizeDate } from '../../lib/invoiceFormat';
import { useSessionsStream, useTodayIso } from './homeData';
import './widgets.css';

/**
 * W12 Holiday runway, the parity port of android's `HolidayRunwayWidget`: the
 * next three US pet-care holidays and how many visits are already booked in the
 * five-day window around each.
 *
 * The six holidays and the two-day window either side are android's, unchanged
 * (`lib/dashboardInsights.ts#usPetCareHolidays`). The list spans this year and
 * next, so late December shows January rather than "no holidays coming", which
 * is precisely the week an operator most needs the card.
 *
 * A zero here is a real and useful answer, not an empty state: "Thanksgiving in
 * 61 days, nothing booked" is the whole reason to look.
 */
export function HolidayRunwayWidget() {
  const sessions = useSessionsStream();
  const todayIso = useTodayIso();

  return (
    <DenPanel
      title="Holiday runway"
      subtitle="The next big pet-care holidays, and what is already booked."
      hoverLift
    >
      <AsyncRegion
        state={sessions}
        what="visits"
        isEmpty={(rows) => holidayRunway(rows, todayIso).length === 0}
        loading={<EmptyHint>Loading visits…</EmptyHint>}
        empty={<EmptyHint>Couldn&rsquo;t read today&rsquo;s date, so no holidays can be placed.</EmptyHint>}
      >
        {(rows) => (
          <div className="dash-widget">
            <ul className="dash-widget__list">
              {holidayRunway(rows, todayIso).map((h) => (
                <li key={h.dateIso} className="holiday-row">
                  <span className="holiday-row__name">{h.name}</span>
                  <span className="holiday-row__when">
                    {h.daysUntil === 0 ? 'today' : `in ${String(h.daysUntil)}d`} ·{' '}
                    {humanizeDate(h.dateIso, todayIso)}
                  </span>
                  <span className="holiday-row__booked">
                    {h.bookedVisits} booked
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}
