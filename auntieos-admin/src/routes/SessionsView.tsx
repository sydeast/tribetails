import { useNavigate } from '@tanstack/react-router';
import { Sessions } from '../screens/Sessions';

/**
 * The Auntie Time board at `/sessions`, wired to the three places a card can
 * send the operator.
 *
 * OPENING A VISIT IS A ROUTE MOVE (#753). A card head navigates to
 * `/sessions/{id}`, where `SessionDetailView` mounts the detail. The board used
 * to open that detail in its own state with the URL unchanged, so a refresh lost
 * it; there is one way in now, and it is addressable.
 *
 * `/sessions?sessionId=<id>` still resolves, as the redirect declared on the
 * route in `router.tsx`, because an invoice line drawn from a visit has linked
 * that way since #408: the money on such a line comes from the visit, so the way
 * to change it is to open the visit, and links in that shape are already stored
 * in records.
 *
 * WHERE THE KINTALE BUTTONS GO (#703). The Auntie Time card carries "Complete
 * KinTale" on a departed visit and "View KinTale" on a completed one, and both
 * are NAVIGATION, not writes. The navigating belongs here rather than inside the
 * screen for the reason every other list on this app keeps it out: `Sessions`
 * renders in unit tests with no router around it, and a `useNavigate` inside it
 * would make mounting the screen depend on having one. The screen hides either
 * KinTale button when its handler is absent, so a caller that cannot navigate
 * never draws a control that would do nothing.
 */
export function SessionsView() {
  const navigate = useNavigate();
  return (
    <Sessions
      onSelect={(id) => void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } })}
      onComposeKinTale={(id) => void navigate({ to: '/kintales', search: { sessionId: id } })}
      onViewKinTale={(id) => void navigate({ to: '/kintales', search: { kinTaleId: id } })}
    />
  );
}
