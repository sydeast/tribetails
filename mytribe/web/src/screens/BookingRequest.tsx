import { Link, Navigate, useParams } from '@tanstack/react-router';
import type { GetMyBookingsResult, GetMyBookingsResultEnvelope } from '../contracts/bookingContracts.generated';
import { useMyBookings } from '../lib/useMyBookings';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { viewOfQuery } from '../lib/queryState';
import { serviceEyebrowOf, visitTitleOf } from '../lib/serviceLabel';
import { bookingChip, bookingSubtitle, speciesEmoji, visitStageOf, visitTile, visitVariant } from '../lib/portalFormat';
import { PortalNav } from '../components/PortalNav';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { LaunchError } from './LaunchError';
import '../styles/bookingdetail.css';

/**
 * #1865: one booking request, the whole of it.
 *
 * A notice about a whole request ("KinCare booking confirmed", a request
 * declined) names the request's batch and no single visit, and used to open
 * the Schedule list, where the household had to find the booking among the
 * rest. This is the request on its own: a request of one visit goes straight
 * to that visit's page, and a request of several lists them, each opening its
 * own page. MyTribe Android's `BookingEnvelopeScreen` is the other half.
 */
export function bookingRequestOf(result: GetMyBookingsResult | undefined, batchId: string): GetMyBookingsResultEnvelope | null {
  return result?.envelopes.find((e) => e.batchId === batchId) ?? null;
}

/** "1 visit" / "3 visits": the household word (#1825), as Android's same screen says it. */
export function visitCountLabel(count: number): string {
  return count === 1 ? '1 visit' : `${count} visits`;
}

/** The request's shape and state, in the words of Android's `BookingEnvelopeScreen`. */
export function requestStateLine(request: Pick<GetMyBookingsResultEnvelope, 'pattern' | 'envelopeStatus'>): string {
  const pattern = request.pattern === 'weekly' ? 'Repeating Schedule' : 'Individual Dates';
  const status: Record<GetMyBookingsResultEnvelope['envelopeStatus'], string> = {
    requested: 'Requested',
    partiallyConfirmed: 'Partially confirmed',
    confirmed: 'Confirmed',
    inProgress: 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return `${pattern} \u00b7 ${status[request.envelopeStatus]}`;
}

export function BookingRequest() {
  const { batchId } = useParams({ from: '/schedule/booking/$batchId' });
  const kinfolkId = getActiveKinfolkId();
  const bookings = useMyBookings(kinfolkId);
  const { signOut, signingOut, error: signOutError } = useSignOut();

  if (bookings.isError) {
    return (
      <LaunchError
        onRetry={() => void bookings.refetch()}
        retrying={bookings.isRefetching}
        onSignOut={signOut}
        signingOut={signingOut}
        signOutError={signOutError}
      />
    );
  }
  const view = viewOfQuery(bookings);
  if (view.kind === 'offline') {
    return (
      <>
        <PortalNav active="schedule" />
        <div className="wrap">
          <section className="glass card">
            <OfflineNotice what="this booking" />
          </section>
        </div>
      </>
    );
  }
  // A list read before this request existed must not say it is gone while the
  // fresh read is still on its way.
  const stillLooking = bookings.isFetching && !bookingRequestOf(bookings.data, batchId)?.kinCares.length;
  if (view.kind !== 'data' || stillLooking) {
    return (
      <>
        <PortalNav active="schedule" />
        <div className="wrap">
          <LoadingLine variant="block" what="this booking" retry={() => void bookings.refetch()}>
            Loading this booking…
          </LoadingLine>
        </div>
      </>
    );
  }

  const request = bookingRequestOf(bookings.data, batchId);
  const kinCares = request?.kinCares ?? [];
  if (kinCares.length === 1) {
    return <Navigate to="/schedule/$visitId" params={{ visitId: kinCares[0]!.id }} replace />;
  }

  return (
    <>
      <PortalNav active="schedule" />
      <div className="wrap">
        <div className="crumbrow">
          <Link className="backlink" to="/schedule">
            {'←'} Back to Schedule
          </Link>
        </div>
        {request === null || kinCares.length === 0 ? (
          <section className="glass card">
            <h3 className="title">We couldn&rsquo;t find that booking.</h3>
            <p className="sub">It may have been removed. Head back to your schedule to see what&rsquo;s current.</p>
          </section>
        ) : (
          <section className="glass card d1" aria-label="This booking" data-testid="booking-request">
            <div className="sectlabel">{visitCountLabel(kinCares.length)}</div>
            <h3 className="title">{request.serviceName ?? 'Booking'}</h3>
            <p className="sub">{requestStateLine(request)}</p>
            {request.kinNames.length > 0 && <p className="sub">{request.kinNames.join(', ')}</p>}
            {kinCares.map((b, i) => {
              const tile = visitTile(b);
              const chip = bookingChip(visitStageOf(b));
              return (
                <div key={b.id}>
                  <Link className={`visit ${visitVariant(i)}`} to="/schedule/$visitId" params={{ visitId: b.id }}>
                    <div className="cal">
                      <div className="m">{tile.month}</div>
                      <div className="d">{tile.day}</div>
                    </div>
                    <div className="info">
                      {serviceEyebrowOf(b) && <span className="svc">{serviceEyebrowOf(b)}</span>}
                      <b>{visitTitleOf(b) ?? 'Visit'}</b>
                      <small>{bookingSubtitle(b)}</small>
                    </div>
                    <div className="pet">{speciesEmoji(null)}</div>
                    <span className={`chip ${chip.tone}`}>{chip.label}</span>
                  </Link>
                  {i < kinCares.length - 1 && <div className="rowdiv" />}
                </div>
              );
            })}
          </section>
        )}
      </div>
    </>
  );
}
