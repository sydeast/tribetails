/**
 * What a region shows when its read is PAUSED because the device is offline
 * (see lib/queryState.ts for why the query pauses rather than fails).
 *
 * The one thing this must never do is read like an empty state. A household
 * that has a visit booked and loses signal was being told "No upcoming
 * bookings. Nothing on the calendar yet. Request a booking and your Auntie will
 * confirm a time", and some of them booked the visit a second time. So there is
 * no booking call to action here, no "add one" button, and nothing that implies
 * the list is short. It says what happened to the connection and that the
 * screen heals itself.
 *
 * Nor is there a Retry button, and that is a finding rather than an omission.
 * `refetch()` on a paused query reaches `retryer.js`'s `start()`, where
 * `canStart()` is false while `onlineManager` says offline, so it goes straight
 * back to `pause()`. The button would do nothing, every time, which is a worse
 * answer than not offering one. React Query resumes the query itself the moment
 * the connection returns.
 *
 * Visual vocabulary is `.session-notice` (base.css, #454), the portal's
 * existing "we can't reach the server" card: same glass panel, same icon +
 * heading + body block. Nothing new was invented for this.
 */
export function OfflineNotice(props: { what: string; compact?: boolean }) {
  if (props.compact === true) {
    return (
      <p className="offline-line" role="status">
        <span aria-hidden="true">{'\u{1F4F5}'}</span> Your phone is offline, so we can&rsquo;t check {props.what} right now.
      </p>
    );
  }
  return (
    <div className="offline-notice" role="status">
      <div className="ico" aria-hidden="true">
        {'\u{1F4F5}'}
      </div>
      <div>
        <b>We can&rsquo;t reach Tribe Tails</b>
        <p>
          Your phone is offline, so {props.what} has not loaded. Nothing has been removed. We just can&rsquo;t read it from
          here. It fills back in on its own once your signal returns.
        </p>
      </div>
    </div>
  );
}
