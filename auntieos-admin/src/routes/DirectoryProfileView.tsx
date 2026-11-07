import { useRef } from 'react';
import { useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { UNAPPLIED_PAYMENTS_SECTION } from '../lib/notificationActions';
import { Directory } from '../screens/Directory';
import type { ProfileSubView } from '../screens/KinfolkProfile';

/** `?view=` values the profile knows; anything else is the profile itself. */
function subView(raw: string | undefined): ProfileSubView | undefined {
  return raw === 'household' || raw === 'edit' ? raw : undefined;
}

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
  const { section, paymentId, view } = useSearch({ from: '/admin/directory/$kinfolkId' });
  const navigate = useNavigate();
  const router = useRouter();
  // Set while a sub-view this mount pushed is open, so stepping back out of it
  // pops that entry instead of stacking a second copy of the profile.
  const pushedSubView = useRef(false);
  const profileView = subView(view);
  return (
    <Directory
      initialKinfolkId={kinfolkId}
      // #1003: opened from the `invoice.payment.unapplied` notice.
      openUnappliedPayments={section === UNAPPLIED_PAYMENTS_SECTION}
      {...(paymentId ? { unappliedPaymentId: paymentId } : {})}
      onProfileClose={() => void navigate({ to: '/directory' })}
      // #1594: Household data and Edit are addresses of their own, so Back from
      // Household data returns to the profile instead of skipping it, and a
      // reload stays put. Opening one PUSHES an entry. Coming back to the
      // profile pops that entry when this mount pushed it, and otherwise (the
      // sub-view was opened cold, by a reload or a link) replaces it, so Back
      // from the profile always leaves the profile.
      {...(profileView !== undefined ? { profileView } : {})}
      onProfileViewChange={(next) => {
        if (next !== 'profile') {
          pushedSubView.current = true;
          void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId }, search: { view: next } });
          return;
        }
        if (pushedSubView.current) {
          pushedSubView.current = false;
          router.history.back();
          return;
        }
        void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId }, search: {}, replace: true });
      }}
    />
  );
}
