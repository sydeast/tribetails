import { useParams } from '@tanstack/react-router';
import { InviteDetail } from '../screens/InviteDetail';

/**
 * `/invites/{inviteId}`: one invite (#1339). The target of the link in every
 * `invite.auntie-notify` email, `${AUNTIE_OS_REVIEW_BASE_URL}/invites/<id>`,
 * and of each card in the admin-wide Invites list.
 */
export function InviteDetailView() {
  const { inviteId } = useParams({ from: '/admin/invites/$inviteId' });
  return <InviteDetail inviteId={inviteId} />;
}
