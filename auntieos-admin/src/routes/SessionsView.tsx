import { useNavigate, useSearch } from '@tanstack/react-router';
import { Sessions } from '../screens/Sessions';

/**
 * Adapts `/sessions?sessionId=<kin_care_sessions doc id>` to Sessions' props,
 * the same one-line convention `BookingsView` and `InvoicesView` use.
 *
 * WHO LINKS HERE: an invoice line drawn from a visit (#408). The money on such
 * a line comes from the visit, so the way to change it is to open the visit,
 * and every surface that shows a bound line offers that route. The screen reads
 * the named visit by id when its own window does not hold it, so a link to work
 * old enough to be billed still opens.
 *
 * WHERE THE KINTALE BUTTONS GO (#703). The Auntie Time card carries "Complete
 * KinTale" on a departed visit and "View KinTale" on a completed one, and both
 * are NAVIGATION, not writes. The navigating belongs here rather than inside the
 * screen for the reason every other list on this app keeps it out: `Sessions`
 * renders in unit tests with no router around it, and a `useNavigate` inside it
 * would make mounting the screen depend on having one. The screen hides either
 * button when its handler is absent, so a caller that cannot navigate never
 * draws a control that would do nothing.
 */
export function SessionsView() {
  const { sessionId } = useSearch({ from: '/admin/sessions' });
  const navigate = useNavigate();
  return (
    <Sessions
      {...(sessionId ? { initialSessionId: sessionId } : {})}
      onComposeKinTale={(id) => void navigate({ to: '/kintales', search: { sessionId: id } })}
      onViewKinTale={(id) => void navigate({ to: '/kintales', search: { kinTaleId: id } })}
    />
  );
}
