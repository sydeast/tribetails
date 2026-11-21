import { useEffect, useState } from 'react';
import { useVisitTracking, type VisitTrackingStatus } from '../lib/visitTracking';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { useBusinessZone } from '../lib/useBusinessZone';
import { businessWallClock } from '../lib/businessZoneTime';
import './VisitTrackingIndicator.css';

/**
 * The small live line that says whether THIS browser is tracking a visit
 * (issue #772). Rendered on the Auntie Time card and on the Kin Care detail
 * while a visit is ARRIVED; both read the same store, so a watch started on the
 * card shows on the sheet and back.
 *
 * `idle` means this tab is not the tracker. The phone may still be writing the
 * route, so the card's caller passes the mock's own line for that case
 * (`idleText`). The detail sheet passes nothing and renders nothing.
 */
export function VisitTrackingIndicator({
  sessionId,
  idleText,
  idleLive = true,
}: {
  sessionId: string;
  /** What to show when this tab is not tracking. Omit to render nothing. */
  idleText?: string;
  /** Whether the idle line carries the live dot. */
  idleLive?: boolean;
}) {
  const status = useVisitTracking(sessionId);
  const text = trackingLine(status, idleText);
  if (text === null) return null;
  const live = status.phase === 'on' || (status.phase === 'idle' && idleLive);
  return (
    <p
      className={`vtrack vtrack--${status.phase}`}
      data-testid="visit-tracking"
      data-phase={status.phase}
    >
      {live && <span className="vtrack__dot" aria-hidden="true" />}
      {text}
    </p>
  );
}

/** The indicator's sentence, or null when there is nothing to say. */
export function trackingLine(status: VisitTrackingStatus, idleText?: string): string | null {
  switch (status.phase) {
    case 'idle':
      return idleText ?? null;
    case 'starting':
      return 'Asking this browser for your location';
    case 'on':
      return status.fixes === 0
        ? 'Tracking on from this browser'
        : `Tracking on from this browser · ${status.fixes} ${status.fixes === 1 ? 'ping' : 'pings'} saved`;
    case 'off':
      return `Tracking off for this visit: ${status.message}`;
  }
}

/**
 * The Route panel's empty sentence while a visit is ARRIVED and no crumb has
 * landed yet. Branches on this tab's status: a denied browser must not be left
 * "waiting for the first ping" from a field app that is not running.
 */
export function routeEmptyTextWhileArrived(status: VisitTrackingStatus): string {
  switch (status.phase) {
    case 'on':
    case 'starting':
      return 'Waiting for the first GPS ping from this browser.';
    case 'off':
      return `No route is being recorded from this browser. Tracking is off for this visit: ${status.message}`;
    case 'idle':
      return 'Waiting for the first GPS ping. The field app writes one about every five seconds while a visit is in flight.';
  }
}
/** #2386: a ping this recent means a phone is tracking the visit. Two minutes. */
export const LIVE_PING_WINDOW_MS = 2 * 60_000;

/** How often the Arrived card reads the clock again, so "live" ages out with no new ping. */
export const GPS_LINE_TICK_MS = 15_000;

/** The mock's line, and the operator's ruling (#2386) for a visit a phone is tracking. */
export const LIVE_ROUTE_LINE = 'GPS tracking · live route';

/** The clock, read again every [ms]. */
function useNowEvery(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * #2338 / #2386: the Arrived card's GPS line. When this tab is the tracker it
 * says so (above). Otherwise this browser cannot see the phone, so it reads
 * "tracking" from the visit's own route (`routeGpsLine`): a recent ping is the
 * mock's live line with its dot; an older one is the last ping and its time.
 */
export function VisitRouteIndicator({ sessionId }: { sessionId: string }) {
  const crumbs = useBreadcrumbs(sessionId);
  const zone = useBusinessZone();
  const now = useNowEvery(GPS_LINE_TICK_MS);
  const line = routeGpsLine(crumbs, zone, now);
  return line === null ? (
    <VisitTrackingIndicator sessionId={sessionId} />
  ) : (
    <VisitTrackingIndicator sessionId={sessionId} idleText={line.text} idleLive={line.live} />
  );
}

/**
 * PURE. What the visit's breadcrumbs say about its route, or null while they
 * load or when the read failed (the card then says nothing rather than guess).
 *
 * WHAT "LIVE" MEANS (#2386). The operator ruled the card reads "GPS tracking ·
 * live route" with the live dot while an Auntie's phone is tracking. A
 * tracking phone writes a ping about every five seconds while it moves five
 * metres or more, so a ping from the last [LIVE_PING_WINDOW_MS] (or one a
 * little ahead of this clock) is read as live. Older than that, the line names
 * the last ping and its time with no dot: a visit put back to Arrived by "Undo
 * departed" with nothing tracking it, and also a phone that has sat still for
 * longer than the window, because it writes no ping then. The same words and
 * window as Android (`domain/GpsLine.kt`) and the console (`sessions/GpsLine.kt`).
 */
export function routeGpsLine(
  crumbs: { points: ReadonlyArray<{ t?: number }>; error: string | null; ready: boolean },
  businessZone: string,
  nowMs: number,
): { text: string; live: boolean } | null {
  if (!crumbs.ready || crumbs.error !== null) return null;
  let last: number | null = null;
  for (const p of crumbs.points) {
    if (typeof p.t === 'number' && Number.isFinite(p.t) && (last === null || p.t > last)) last = p.t;
  }
  if (crumbs.points.length === 0) return { text: 'No GPS pings yet', live: false };
  if (last === null) return { text: 'GPS route recorded', live: false };
  if (nowMs - last <= LIVE_PING_WINDOW_MS) return { text: LIVE_ROUTE_LINE, live: true };
  return { text: `GPS route · last ping ${businessWallClock(last, businessZone).hhmm}`, live: false };
}
