import { CONVERSATIONS_QUERY, type ConversationDoc } from '../api/inbox';
import { useCollection } from './firestore';
import { unreadThreadCount } from './inboxFormat';
import { asyncScalar, type ResolvedScalar } from './async';

/**
 * Unread client threads, for the nav rail's Inbox count pill.
 *
 * ONE listener for the whole app, opened by the shell, which is the only
 * component that is mounted on every screen and so the only one that can own an
 * app-wide number. It is the same `useCollection` contract every screen uses
 * (bounded, server-ordered, capped, sandbox-scoped centrally), and it is
 * cheaper than the per-screen listeners already running, not an addition on top
 * of them: the Inbox screen keeps its own callable load for the thread LIST,
 * which is a different question from "how many are waiting".
 *
 * The return type is `ResolvedScalar<number>`, not `number`, and that is the
 * point. `asyncScalar` will not project a value out of a loading or failed
 * read, so there is no `?? 0` anywhere in this path and no way for the rail to
 * inherit the defect lib/async.ts was written against: a confident zero
 * standing in for an unknown.
 *
 * WHAT A FAILURE DOES, decided deliberately rather than by omission.
 *
 * On `loading` and on `error` alike the rail renders NO pill, and nothing else
 * about the rail changes: every link is still there, still clickable, still
 * keyboard reachable. There is no banner in the rail and no toast.
 *
 * That is not the silent-degradation this project bans, and the distinction is
 * worth being exact about, because the two look similar from a distance. What
 * is banned is a fabricated value: printing "0" or a stale number where the
 * truth is unknown, which makes a false claim the operator cannot see through.
 * Showing nothing claims nothing. The Inbox screen remains the authority on
 * unread threads and reports its own load failure loudly, with a message and a
 * retry, on the surface where the operator went looking for that data. A red
 * banner welded to the navigation of every screen in the app, for a decoration
 * on a link, would be the worse failure: the operator cannot dismiss it, cannot
 * retry it from there, and cannot use the app without reading it.
 *
 * The failure is still REPORTED, just not into the navigation: the message goes
 * to `console.warn` and to Sentry through `lib/sentry.ts` at the call site
 * (AppShell), so a rail that never shows a badge is diagnosable instead of
 * mysterious.
 *
 * A Stage-0I sandbox account is the expected error here: `conversations` is
 * `isAuntie()`-only and carries no `kinfolkId` field to scope by, so a test
 * admin's read is denied. `SUPPRESSED_IN_TEST_MODE` in `lib/testScope.ts` is
 * where that belongs (it converts exactly this class of read into an honest
 * empty result), and adding `conversations` to that set is a one-line follow-up
 * in a file this change does not own.
 */
export function useUnreadInbox(): ResolvedScalar<number> {
  const threads = useCollection<ConversationDoc>(CONVERSATIONS_QUERY);
  return asyncScalar(threads, unreadThreadCount);
}
