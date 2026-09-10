import { useNavigate, useParams } from '@tanstack/react-router';
import { HouseholdMembers } from '../screens/HouseholdMembers';

/**
 * B1. `/household-members/{kinfolkId}` — members and invites for ONE household.
 *
 * Its own route rather than a fourth Directory sub-view, because it is the
 * destination of the household profile's "Members and invites" action and has
 * to be linkable on its own.
 *
 * The `onBack` below is the COLD-ARRIVAL destination only (#689). Walked into,
 * from the profile or from a card in the admin-wide Invites list, Back steps
 * back through history to whichever of those it was; this runs when a link,
 * a bookmark or a typed URL put the operator here with nothing behind them,
 * and the household's own profile is the right place to land from there.
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
