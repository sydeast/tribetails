import { useMemo } from 'react';
import { useOneShot } from '../../lib/useOneShot';
import { optimizeRoute } from '../../api/route';
import { localDateIso } from '../../lib/invoiceFormat';
import { formatMiles, formatDuration } from '../../lib/dashboardInsights';
import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import './widgets.css';

/**
 * AO-35 Route Optimizer. Calls `optimizeRoute(today)` and shows the day's total
 * miles + drive time, the ordered stops (order, household, arrival ETA), and a
 * fail-loud "couldn't route" section listing any household with no address on
 * file (those come back in the callable's `unroutable`, never dropped silently).
 * Minimal pure logic (`formatMiles`/`formatDuration`); the server does the
 * optimize. Empty is an honest "no visits to route" state, distinct from a
 * failed callable (AsyncRegion keeps them apart).
 */
export function RouteOptimizerWidget() {
  // A LOCAL calendar date: route TODAY, the operator's day, not a UTC day.
  const today = useMemo(() => localDateIso(new Date()), []);
  const plan = useOneShot(() => optimizeRoute(today), `optimizeRoute:${today}`);

  return (
    <DenPanel
      title="Route optimizer"
      subtitle="Today's visits in the shortest driving order."
      hoverLift
    >
      <AsyncRegion
        state={plan}
        what="the route"
        isEmpty={(data) => data.stops.length === 0 && data.unroutable.length === 0}
        loading={<EmptyHint>Optimizing route…</EmptyHint>}
        empty={<EmptyHint>No visits to route today.</EmptyHint>}
      >
        {(data) => (
          <div className="dash-widget">
            <p className="dash-widget__count">
              {formatMiles(data.totalMiles)}{' '}
              <span className="dash-widget__count-unit">· {formatDuration(data.totalMinutes)} driving</span>
            </p>

            {data.stops.length > 0 && (
              <ol className="route-stops">
                {data.stops.map((s) => (
                  <li key={s.sessionId} className="route-stop">
                    <span className="route-stop__order">{s.order}</span>
                    <span className="route-stop__main">
                      <span className="route-stop__household">{s.household}</span>
                      <span className="route-stop__address">{s.address}</span>
                    </span>
                    <time className="route-stop__eta">{s.arrivalEta}</time>
                  </li>
                ))}
              </ol>
            )}

            {data.unroutable.length > 0 && (
              <div className="route-unroutable" role="alert">
                <p className="route-unroutable__title">
                  Couldn&rsquo;t route {data.unroutable.length}{' '}
                  {data.unroutable.length === 1 ? 'visit' : 'visits'}
                </p>
                <ul className="route-unroutable__list">
                  {data.unroutable.map((u) => (
                    <li key={u.sessionId} className="route-unroutable__row">
                      <span className="route-unroutable__who">{u.household}</span>
                      <span className="route-unroutable__reason">{u.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}
