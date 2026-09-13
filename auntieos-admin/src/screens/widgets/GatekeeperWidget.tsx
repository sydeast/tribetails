import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { LoadingRow } from '../../components/LoadingRow';
import { AsyncRegion } from '../../components/AsyncRegion';
import { householdVisitGaps, type HouseholdGap } from '../../lib/dashboardInsights';
import { useSessionsStream, useTodayIso } from './homeData';
import './widgets.css';

/**
 * W14 Gatekeeper, the parity port of android `HomeScreen.kt`'s
 * `DashKey.GATEKEEPER` panel: the households that have gone longest without a
 * completed visit, five at a time, longest gap first.
 *
 * The urgency banding is android's, unchanged: 14 days or more is an error
 * tone, 7 or more is a warning, anything fresher is fine. It is a display
 * band, not a rule about the business, which is why it lives here beside the
 * markup and not in the shared logic.
 *
 * A NOTE ON WHAT THE NUMBER MEASURES. The visit stream is the bounded newest
 * 300 (`homeData.ts`), so on a very large book "days since the last completed
 * visit" is measured over that page rather than over all of history. A
 * household with no completed visit anywhere on the page is not listed at all
 * rather than reported as an infinite gap, and the card says so under the list.
 */
export function GatekeeperWidget() {
  const sessions = useSessionsStream();
  const todayIso = useTodayIso();

  return (
    <DenPanel
      title="Gatekeeper"
      subtitle="Households going longest without a visit. Close the gaps."
      hoverLift
    >
      <AsyncRegion
        state={sessions}
        what="visits"
        isEmpty={(rows) => householdVisitGaps(rows, todayIso).length === 0}
        loading={<LoadingRow label="Loading visits…" className="den-hint" />}
        empty={<EmptyHint>No completed visits yet to measure gaps against.</EmptyHint>}
      >
        {(rows) => {
          const gaps = householdVisitGaps(rows, todayIso);
          return (
            <div className="dash-widget">
              <ul className="dash-widget__list">
                {gaps.map((gap) => (
                  <li key={gap.household} className="gap-row" data-urgency={urgencyOf(gap)}>
                    <span className="gap-row__who" title={gap.household}>
                      {gap.household}
                    </span>
                    <span className="gap-row__days">{gap.daysSinceLastVisit}d</span>
                  </li>
                ))}
              </ul>
              <p className="dash-widget__more">Measured over the most recent 300 visits.</p>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}

/** Android's three bands: 14+ overdue, 7+ due, else fine. */
function urgencyOf(gap: HouseholdGap): 'overdue' | 'due' | 'fine' {
  if (gap.daysSinceLastVisit >= 14) return 'overdue';
  if (gap.daysSinceLastVisit >= 7) return 'due';
  return 'fine';
}
