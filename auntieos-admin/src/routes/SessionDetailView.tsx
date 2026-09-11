import { useNavigate, useParams } from '@tanstack/react-router';
import { type SessionEntry } from '../api/sessions';
import { useDocById } from '../lib/firestore';
import { SessionDetail } from '../screens/SessionDetail';

/**
 * ONE Kin Care session at its own URL, `/sessions/{kin_care_sessions doc id}`.
 *
 * WHY THIS ROUTE EXISTS (#753). The operator: "KinCares should have their own id
 * numbers in the params. I don't want to refresh the KinCare." The detail used
 * to be a local-state sub-view of the board, so opening one changed nothing in
 * the address bar: a refresh, a bookmark, a shared link and the browser Back
 * button all lost the open visit, which on a screen an operator sits inside for
 * a whole shift is the difference between a hiccup and losing the place.
 *
 * THE READ IS THE ONE THE BOARD ALREADY RAN, moved rather than added:
 * `useDocById('kin_care_sessions', id)`, a LIVE document subscription. It stays
 * live because this screen hosts writes; a clock-in repaints from the document
 * the server actually wrote, so an optimistic status can never survive a
 * refusal. There is no second Firestore path here and no by-value copy.
 *
 * WHY THE BOARD'S ROW IS NOT USED AS A PLACEHOLDER ANY MORE. It could not be.
 * `/sessions` and `/sessions/$sessionId` are sibling routes, so arriving here
 * unmounts the board and its paged rows go with it, and on a refresh they never
 * existed. What replaced that placeholder is honesty about the wait: the read's
 * own state is handed to `SessionDetail`, which says it is looking the session
 * up rather than reporting a visit that is still loading as one that is gone.
 *
 * BACK GOES TO `/sessions`, a real route move now, so the board is re-entered by
 * the same navigation any other screen gets and the browser's own Back button
 * works on the way in as well as on the way out.
 */
export function SessionDetailView() {
  const { sessionId } = useParams({ from: '/admin/sessions/$sessionId' });
  const navigate = useNavigate();
  const live = useDocById<SessionEntry>('kin_care_sessions', sessionId);
  return (
    <SessionDetail
      entry={live.status === 'ready' ? live.data : null}
      // Passed ONLY while the read is unsettled. Absent means `entry` is the
      // settled answer, which is what tells the screen a null is a session that
      // is genuinely not on file rather than one still arriving.
      {...(live.status === 'ready' ? {} : { read: live })}
      onBack={() => void navigate({ to: '/sessions' })}
    />
  );
}
