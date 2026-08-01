import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import { frequentFlyers } from '../../lib/dashboardInsights';
import { useSessionsStream, useTodayIso } from './homeData';
import './widgets.css';

/** The window android measures over, restated here so the copy and the call agree. */
const WINDOW_DAYS = 90;

/**
 * W11 Frequent flyers, the parity port of android's `FrequentFlyersWidget`:
 * the five households with the most COMPLETED visits over the last ninety days.
 *
 * COMPLETED only, and dated by `completedAt` where it was stamped: a booked
 * visit that never happened is not loyalty, and counting it would flatter the
 * households who cancel most. A household whose rows carry no readable name
 * anywhere is dropped rather than listed as an anonymous count.
 *
 * The visit stream is the bounded newest 300, so on a very large book this
 * ranks the ninety days that fit on that page. The card says so rather than
 * presenting a truncated ranking as the whole picture.
 */
export function FrequentFlyersWidget() {
  const sessions = useSessionsStream();
  const todayIso = useTodayIso();

  return (
    <DenPanel
      title="Frequent flyers"
      subtitle="Your most-visited households over the last 90 days."
      hoverLift
    >
      <AsyncRegion
        state={sessions}
        what="visits"
        isEmpty={(rows) => frequentFlyers(rows, todayIso, WINDOW_DAYS).length === 0}
        loading={<EmptyHint>Loading visits…</EmptyHint>}
        empty={<EmptyHint>No completed visits in the last 90 days.</EmptyHint>}
      >
        {(rows) => {
          const flyers = frequentFlyers(rows, todayIso, WINDOW_DAYS);
          const top = flyers[0]?.visits ?? 1;
          return (
            <div className="dash-widget">
              <ul className="dash-widget__list">
                {flyers.map((f, i) => (
                  <li key={f.household} className="flyer-row">
                    <span className="flyer-row__rank" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="flyer-row__who" title={f.household}>
                      {f.household}
                    </span>
                    <progress
                      className="flyer-row__bar"
                      value={f.visits}
                      max={top}
                      aria-label={`${f.household}, ${String(f.visits)} visits`}
                    />
                    <span className="flyer-row__count">{f.visits}</span>
                  </li>
                ))}
              </ul>
              <p className="dash-widget__more">Counted over the most recent 300 visits.</p>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
