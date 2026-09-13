import { DenPanel, EmptyHint, ServicePill } from '../../components/DenScreenKit';
import { LoadingRow } from '../../components/LoadingRow';
import { AsyncRegion } from '../../components/AsyncRegion';
import { overdueVisits } from '../../lib/dashboardInsights';
import { humanizeDate } from '../../lib/invoiceFormat';
import { useSessionsStream, useTodayIso } from './homeData';
import './widgets.css';

/**
 * W9 Overdue visits, the parity port of android's `OverdueVisitsWidget`:
 * visits whose end time has passed with nothing marking them complete, most
 * recent miss first.
 *
 * The horizon is android's 30 days, and it is not arbitrary. Without it the
 * card silts up with visits abandoned months ago that nobody is going to close
 * out, and the two from yesterday that actually need attention sit under them.
 * A visit ending TODAY is not overdue: the operator has the rest of the day to
 * close it, which is why the rule compares against the day and not the clock.
 */
export function OverdueVisitsWidget() {
  const sessions = useSessionsStream();
  const todayIso = useTodayIso();

  return (
    <DenPanel
      title="Overdue visits"
      subtitle="Past their end time and not marked complete."
      hoverLift
    >
      <AsyncRegion
        state={sessions}
        what="visits"
        isEmpty={(rows) => overdueVisits(rows, todayIso).length === 0}
        loading={<LoadingRow label="Loading visits…" className="den-hint" />}
        empty={<EmptyHint>Every visit is closed out.</EmptyHint>}
      >
        {(rows) => {
          const late = overdueVisits(rows, todayIso);
          return (
            <div className="dash-widget">
              <p className="dash-widget__count">
                {late.length}{' '}
                <span className="dash-widget__count-unit">
                  visit{late.length === 1 ? '' : 's'} to close out
                </span>
              </p>
              <ul className="dash-widget__list">
                {late.map((v) => (
                  <li key={v.sessionId} className="overdue-row">
                    <span className="overdue-row__who" title={v.household}>
                      {v.household}
                    </span>
                    <ServicePill serviceType={v.serviceType} />
                    <span className="overdue-row__when">
                      {humanizeDate(v.endedAt, todayIso)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
