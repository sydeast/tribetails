import { signOut } from '../lib/auth';
import { useSessionHealth, type SessionHealth } from '../lib/sessionHealth';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';

/**
 * The shell's notice for a session that can no longer renew its own ID token
 * (#454). See lib/sessionHealth.ts for what is being watched and why.
 *
 * The copy's whole job is to replace the symptom an operator would otherwise
 * get — an unexplained permission error on a save that worked five minutes ago
 * — with the cause and the remedy.
 */

export interface SessionNotice {
  tone: 'warning' | 'error';
  title: string;
  body: string;
  /** True when the only way out is to authenticate again. */
  reauth: boolean;
}

/**
 * Health to notice, pure so the copy is testable without a timer or a token.
 * Mirrors Android's `sessionHealthNotice` in the admin app one for one.
 */
export function sessionNotice(health: SessionHealth): SessionNotice | null {
  switch (health.status) {
    case 'ok':
      return null;
    case 'unreachable':
      return {
        tone: 'warning',
        title: 'Signed in, but out of touch',
        body:
          "This session's sign-in token is due for renewal and the network is refusing it. Trying again. Until one goes through, saves and uploads may be turned down.",
        reauth: false,
      };
    case 'expired':
      return {
        tone: 'error',
        title: 'Sign in again to keep working',
        body:
          'This session can no longer renew its sign-in, so anything you do from here will be refused. Signing in again fixes it.',
        reauth: true,
      };
  }
}

export function SessionBanner() {
  const notice = sessionNotice(useSessionHealth());
  if (notice === null) return null;
  return (
    <Banner
      tone={notice.tone}
      title={notice.title}
      trailing={
        notice.reauth ? <GhostButton label="Sign in again" onClick={() => void signOut()} /> : undefined
      }
    >
      {notice.body}
    </Banner>
  );
}
