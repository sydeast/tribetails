import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { UNAPPLIED_PAYMENTS_SECTION } from '../lib/notificationActions';
import { Directory } from '../screens/Directory';

/**
 * Deep link to ONE household's profile, `/directory/{kinfolkId}`.
 *
 * Directory already owns the profile as a sibling view of its list; this route
 * just opens the list on that view. Added for the Schedule detail sheet's
 * kinfolk link (operator issue 16), which needs somewhere real to point: a link
 * to a route that does not exist is worse than no link.
 *
 * `onProfileClose` is the COLD-ARRIVAL destination only (#689). An operator who
 * walked here, from the Directory list, the Schedule sheet or an invoice, is
 * returned to that; the bare list is where Back lands when there is nothing
 * behind the profile at all.
 */
export function DirectoryProfileView() {
  const { kinfolkId } = useParams({ from: '/admin/directory/$kinfolkId' });
  const { section, paymentId } = useSearch({ from: '/admin/directory/$kinfolkId' });
  const navigate = useNavigate();
  return (
    <Directory
      initialKinfolkId={kinfolkId}
      // #1003: opened from the `invoice.payment.unapplied` notice.
      openUnappliedPayments={section === UNAPPLIED_PAYMENTS_SECTION}
      {...(paymentId ? { unappliedPaymentId: paymentId } : {})}
      onProfileClose={() => void navigate({ to: '/directory' })}
    />
  );
}
