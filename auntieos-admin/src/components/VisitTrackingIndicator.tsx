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
/**
 * #2338: the Arrived card's GPS line. When this tab is the tracker it says so
 * (above). Otherwise this browser cannot know whether a phone is still
 * tracking: "Undo departed" puts a visit back to Arrived with no device
 * tracking it, and the mock's "GPS tracking · live route" was then false. So
 * the line says what the visit's own route shows, the last ping and its time,
 * or that none has landed. No live dot: nothing here knows it is live.
 */
export function VisitRouteIndicator({ sessionId }: { sessionId: string }) {
  const crumbs = useBreadcrumbs(sessionId);
  const zone = useBusinessZone();
  const line = routeLastPingLine(crumbs, zone);
  return line === null ? (
    <VisitTrackingIndicator sessionId={sessionId} />
  ) : (
    <VisitTrackingIndicator sessionId={sessionId} idleText={line} idleLive={false} />
  );
}
/**
 * PURE. What the visit's breadcrumbs say about its route, or null while they
 * load or when the read failed (the card then says nothing rather than guess).
 */
export function routeLastPingLine(
  crumbs: { points: ReadonlyArray<{ t?: number }>; error: string | null; ready: boolean },
  businessZone: string,
): string | null {
  if (!crumbs.ready || crumbs.error !== null) return null;
  let last: number | null = null;
  for (const p of crumbs.points) {
    if (typeof p.t === 'number' && Number.isFinite(p.t) && (last === null || p.t > last)) last = p.t;
  }
  if (crumbs.points.length === 0) return 'No GPS pings yet';
  if (last === null) return 'GPS route recorded';
  return `GPS route · last ping ${businessWallClock(last, businessZone).hhmm}`;
}
