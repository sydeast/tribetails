import { useSearch } from '@tanstack/react-router';
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
 */
export function SessionsView() {
  const { sessionId } = useSearch({ from: '/admin/sessions' });
  return <Sessions {...(sessionId ? { initialSessionId: sessionId } : {})} />;
}
