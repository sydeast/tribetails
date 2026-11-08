import { useMemo } from 'react';
import { DenPanel, EmptyHint, ErrorHint, ServicePill } from '../../components/DenScreenKit';
import { LoadingRow } from '../../components/LoadingRow';
import { AsyncRegion } from '../../components/AsyncRegion';
import { GhostButton } from '../../components/Buttons';
import { sessionClock, sessionHousehold, sessionState, sessionStateInfo } from '../../lib/sessionFormat';
import { str } from '../../lib/coerce';
import { todayPack, type TodayPack } from '../../lib/dashboardInsights';
import { overdueSessionCount } from '../../lib/sessionFormat';
import { bookingServiceName } from '../../lib/bookingFormat';
import { useBookingCatalog } from '../../lib/useBookingCatalog';
import { useSessionsStream, useSessionsWindowStream, useTodayIso } from './homeData';
import './widgets.css';

interface TodaysPackWidgetProps {
  /** Opens the Auntie Time list, where a visit is acted on. */
  onOpenSessions: () => void;
}

/**
 * W2 Today's Pack, the parity port of android `HomeScreen.kt`'s
 * `DashKey.TODAYS_PACK` panel: the day's visit run in time order, each row
 * naming the household, the service, the clock time and where the visit has got
 * to.
 *
 * WHAT THIS CARD DOES NOT CARRY, said plainly rather than left as a silent gap.
 * The phone's copy of this panel also holds the in-field lifecycle buttons, On
 * My Way / Arrived / Departed. Those are not a missing port: each one starts or
 * stops `LocationTrackingService`, android's foreground GPS service, and fires a
 * local `VisitNotifier` notification, and a browser tab has neither. They are
 * also not gated here, because the browser has never offered them: acting on a
 * visit on this surface goes through Auntie Time, which is one click away on
 * every row and in the footer button below. The counts, the order, the statuses
 * and the notes on this card are the same data the phone shows.
 *
 * LATE WORK IS ON THIS CARD (#1590). The run is today's visits only, so a
 * Home that said "Nothing on the books today" while Auntie Time listed six
 * Overdue hid the day's most urgent work. The overdue line below reads the
 * Auntie Time window (`useSessionsWindowStream`) and counts with the board's
 * own `sessionPhase`, so the number and the link agree with the Overdue
 * heading it opens.
 *
 * "Today" is the operator's LOCAL day (`useTodayIso`), and the run is every
 * status including cancellations, matching android's day query, so the headline
 * count here and the stat tile above it can never disagree.
 */
export function TodaysPackWidget({ onOpenSessions }: TodaysPackWidgetProps) {
  const sessions = useSessionsStream();
  const todayIso = useTodayIso();
  const lateWindow = useSessionsWindowStream(todayIso);
  // #1592: each row's pill names the KinCare, never the stored `visit_60`.
  const catalog = useBookingCatalog();
  const overdue = useMemo(
    () => (lateWindow.status === 'ready' ? overdueSessionCount(lateWindow.data, todayIso) : null),
    [lateWindow, todayIso],
  );

  const pack = useMemo(
    () => (sessions.status === 'ready' ? todayPack(sessions.data, todayIso) : null),
    [sessions, todayIso],
  );

  return (
    <DenPanel title="Today's Pack" subtitle="Your visit run for the day." hoverLift>
      <AsyncRegion
        state={sessions}
        what="today's visits"
        isEmpty={() => pack !== null && pack.visits.length === 0 && overdue === 0}
        loading={<LoadingRow label="Loading today&rsquo;s visits…" className="den-hint" />}
        empty={
          <>
            <EmptyHint>Nothing on the books today. Enjoy the quiet.</EmptyHint>
            <OverdueNote window={lateWindow} overdue={overdue} onOpenSessions={onOpenSessions} />
            <GhostButton label="Open Auntie Time" onClick={onOpenSessions} />
          </>
        }
      >
        {() => (
          <div className="dash-widget">
            <PackHeadline pack={pack} />
            <OverdueNote window={lateWindow} overdue={overdue} onOpenSessions={onOpenSessions} />
            {pack !== null && pack.visits.length === 0 && (
              <EmptyHint>Nothing else on the books today.</EmptyHint>
            )}
            <ul className="dash-widget__list">
              {(pack?.visits ?? []).map((visit) => {
                const state = sessionState(str(visit.status));
                const info = sessionStateInfo(state);
                return (
                  <li key={visit._id} className="pack-row" data-state={info.cssClass}>
                    <span className="pack-row__who" title={sessionHousehold(str(visit.kinfolkName))}>
                      {sessionHousehold(str(visit.kinfolkName))}
                    </span>
                    <ServicePill
                      serviceType={str(visit.serviceType)}
                      label={bookingServiceName(str(visit.serviceType), catalog)}
                    />
                    <span className="pack-row__time">{sessionClock(str(visit.startTime))}</span>
                    <span className="pack-row__state">{info.label}</span>
                  </li>
                );
              })}
            </ul>
            <GhostButton label="Open Auntie Time" onClick={onOpenSessions} />
          </div>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}

/**
 * "6 visits · 2 done, 1 on the way", the same sentence the phone puts under its
 * stat tile. Rendered only from a resolved pack, so it never describes a run
 * nobody has read.
 */
function PackHeadline({ pack }: { pack: TodayPack | null }) {
  if (pack === null) return null;
  const n = pack.visits.length;
  return (
    <p className="dash-widget__count">
      {n}{' '}
      <span className="dash-widget__count-unit">
        visit{n === 1 ? '' : 's'} · {pack.done} done, {pack.onTheWay} on the way
      </span>
    </p>
  );
}

/**
 * The overdue line: a count that opens Auntie Time, where the same visits sit
 * under the Overdue heading. Silent when the window read is still loading or
 * reads zero; a failed read says so rather than implying nothing is late.
 */
function OverdueNote({
  window: lateWindow,
  overdue,
  onOpenSessions,
}: {
  window: ReturnType<typeof useSessionsWindowStream>;
  overdue: number | null;
  onOpenSessions: () => void;
}) {
  if (lateWindow.status === 'error') {
    return <ErrorHint>{`Couldn't check for overdue visits: ${lateWindow.message}`}</ErrorHint>;
  }
  if (overdue === null || overdue === 0) return null;
  return (
    <button type="button" className="pack-overdue" onClick={onOpenSessions}>
      <span className="pack-overdue__count">{overdue}</span>
      <span className="pack-overdue__label">
        overdue visit{overdue === 1 ? '' : 's'} to close out in Auntie Time
      </span>
    </button>
  );
}
