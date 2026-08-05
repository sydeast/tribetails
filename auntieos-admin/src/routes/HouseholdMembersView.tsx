import { useNavigate, useParams } from '@tanstack/react-router';
import { HouseholdMembers } from '../screens/HouseholdMembers';

/**
 * B1. `/household-members/{kinfolkId}` — members and invites for ONE household.
 *
 * Its own route rather than a fourth Directory sub-view, because it is the
 * destination of the household profile's "Members and invites" action and has
 * to be linkable on its own. Closing it returns to that household's profile,
 * which is where it was opened from, so the URL and the screen never disagree.
 */
export function HouseholdMembersView() {
  const { kinfolkId } = useParams({ from: '/admin/household-members/$kinfolkId' });
  const navigate = useNavigate();
  return (
    <HouseholdMembers
      kinfolkId={kinfolkId}
      onBack={() => void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId } })}
    />
  );
}
