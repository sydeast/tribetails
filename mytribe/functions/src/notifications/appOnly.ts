/**
 * #1507: did what an enqueue wrote reach the household in the app only?
 *
 * Since #1505 a recipient who left a notification on but turned every delivery
 * channel off still gets their `notifications/{id}` record, and nothing is
 * emailed, texted or pushed. `EnqueueOutcome.written` therefore means "record
 * exists", and `EnqueueOutcome.appOnly` names the recipients for whom that is
 * the whole delivery. A callable that tells an admin "sent" reads this so the
 * admin is not shown an email that does not exist.
 *
 * Its own module rather than a dispatcher export on purpose: every callable
 * test mocks `../notifications/dispatcher` whole, and a pure function living
 * there would vanish under the mock. This file imports only the type.
 */
import type { EnqueueOutcome } from './dispatcher';

/**
 * With a `recipientUid`, the answer for that one recipient: a both-audience key
 * such as `invoice.new` also writes an office copy, and the office's email must
 * not stand in for the household's. Without one, true when every record the
 * call wrote had no delivery channel behind it, which is the whole answer for a
 * kinfolk-only key with one recipient. False when nothing was written.
 */
export function reachedAppOnly(outcome: EnqueueOutcome, recipientUid?: string): boolean {
  const appOnly = outcome.appOnly ?? [];
  if (recipientUid !== undefined && recipientUid !== '') return appOnly.includes(recipientUid);
  return outcome.written.length > 0 && appOnly.length === outcome.written.length;
}
