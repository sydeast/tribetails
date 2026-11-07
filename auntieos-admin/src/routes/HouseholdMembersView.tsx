import { useNavigate, useParams } from '@tanstack/react-router';
import { kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { AsyncLoading } from '../components/AsyncRegion';
import { ErrorHint } from '../components/DenScreenKit';
import { useDocById } from '../lib/firestore';
import { HouseholdMembers } from '../screens/HouseholdMembers';

/**
 * B1. `/household-members/{kinfolkId}` — members and invites for ONE household.
 *
 * Its own route rather than a fourth Directory sub-view, because it is the
 * destination of the household profile's "Members and invites" action and has
 * to be linkable on its own.
 *
 * The household's NAME is read here and handed down (#1589). The route only
 * has the id, and the screen used to fall back to it, so the title, avatar and
 * breadcrumb all read the database id. The screen waits for the name rather
 * than flashing the id first. A household that cannot be read is an error
 * shown in place, not an id in a heading.
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
  const household = useDocById<Kinfolk>('kinfolk', kinfolkId);
  if (household.status === 'loading') {
    return <AsyncLoading what="household" retry={household.retry} />;
  }
  if (household.status === 'error') {
    return <ErrorHint>{`Couldn't load this household: ${household.message}`}</ErrorHint>;
  }
  if (household.data === null) {
    return <ErrorHint>This household is not on file.</ErrorHint>;
  }
  return (
    <HouseholdMembers
      kinfolkId={kinfolkId}
      kinfolkName={kinfolkDisplayName(household.data)}
      onBack={() => void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId } })}
    />
  );
}
