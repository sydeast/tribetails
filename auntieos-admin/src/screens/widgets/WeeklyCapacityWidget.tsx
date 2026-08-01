import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import { weeklyCapacity } from '../../lib/dashboardInsights';
import { useSessionsStream, useTodayIso } from './homeData';
import './widgets.css';

/**
 * W8 Weekly capacity, the parity port of android's `WeeklyCapacityWidget`:
 * this week's booked visits against the busiest of the four weeks before it.
 *
 * The bar is a real `<progress>`, not a styled div: it carries the value, the
 * max and an accessible name for free, and a screen reader reading "9 of 14"
 * is the whole point of the card. The rule behind the numbers is
 * `lib/dashboardInsights.ts#weeklyCapacity`, so the record window and the
 * cancelled-visit exclusion are stated once and shared with the phone.
 */
export function WeeklyCapacityWidget() {
  const sessions = useSessionsStream();
  const todayIso = useTodayIso();

  return (
    <DenPanel
      title="Weekly capacity"
      subtitle="This week's visits against your busiest recent week."
      hoverLift
    >
      <AsyncRegion
        state={sessions}
        what="visits"
        // A week with nothing booked is a real answer worth showing (it is the
        // whole point of a capacity card in a quiet week), so the only empty
        // state is "the day itself would not parse", which cannot happen from
        // `useTodayIso` and is handled rather than assumed away.
        isEmpty={(rows) => weeklyCapacity(rows, todayIso) === null}
        loading={<EmptyHint>Loading visits…</EmptyHint>}
        empty={<EmptyHint>Couldn&rsquo;t read today&rsquo;s date, so this week can&rsquo;t be measured.</EmptyHint>}
      >
        {(rows) => {
          const cap = weeklyCapacity(rows, todayIso);
          if (cap === null) return null;
          return (
            <div className="dash-widget">
              <p className="dash-widget__count">
                {cap.booked}{' '}
                <span className="dash-widget__count-unit">
                  visit{cap.booked === 1 ? '' : 's'} booked this week
                </span>
              </p>
              <progress
                className="capacity__bar"
                value={cap.booked}
                max={cap.capacity}
                aria-label={`${String(cap.booked)} of ${String(cap.capacity)} visits`}
              />
              <p className="capacity__note">
                {cap.beatingRecord
                  ? `Ahead of your recent best of ${String(cap.record)}.`
                  : `Your busiest of the last four weeks was ${String(cap.record)}.`}
              </p>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
