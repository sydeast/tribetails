import { useSignOut } from '../lib/auth';
import { useSessionHealth, type SessionHealth } from '../lib/sessionHealth';
import { BusyLabel } from '../components/Loading';

/**
 * The portal's notice for a session that can no longer renew its own sign-in
 * (#454). See lib/sessionHealth.ts for what is being watched and why.
 *
 * The admin gets the same two states in operator language; this one is written
 * for a kinfolk, who does not know what a token is and should not have to. What
 * both versions owe the reader is the same: the reason a booking or a message
 * is about to be refused, and what to do about it.
 */

export interface SessionNoticeContent {
  title: string;
  body: string;
  /** True when the only way out is to sign in again. */
  reauth: boolean;
}

/** Health to copy, pure so it is testable without a timer or a token. */
export function sessionNoticeContent(health: SessionHealth): SessionNoticeContent | null {
  switch (health.status) {
    case 'ok':
      return null;
    case 'unreachable':
      return {
        title: 'Trouble keeping you signed in',
        body: "We can't reach the sign-in service to renew your session. Still trying. Until that works, anything you save or send may not go through.",
        reauth: false,
      };
    case 'expired':
      return {
        title: 'Please sign in again',
        body: 'Your session has run out and cannot renew itself, so nothing you do here will save. Signing in again puts it right.',
        reauth: true,
      };
  }
}

export function SessionNotice() {
  const content = sessionNoticeContent(useSessionHealth());
  const { signOut, signingOut } = useSignOut();
  if (content === null) return null;
  return (
    <section className="glass session-notice" role="alert">
      <div className="hd">
        <div className="ico" aria-hidden="true">
          {'\u{1F510}'}
        </div>
        <div>
          <b>{content.title}</b>
          <p>{content.body}</p>
        </div>
      </div>
      {content.reauth ? (
        <button className="btn grad block" onClick={signOut} disabled={signingOut}>
          {signingOut ? <BusyLabel>Signing out…</BusyLabel> : 'Sign in again'}
        </button>
      ) : null}
    </section>
  );
}
