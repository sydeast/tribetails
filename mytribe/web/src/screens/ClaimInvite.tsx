import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { acceptInvite, claimInviteSignup, getInvitePreview } from '../api/portal';
import { parseInviteId, stepForPreview, validateNewPassword, withTimeout, type ClaimStep } from '../api/claimFlow';
import {
  refreshEmailVerification,
  resendVerificationEmail,
  signIn,
  signInWithToken,
  useAuth,
  useSignOut,
} from '../lib/auth';
import { isEmailAlreadyInUse, isEmailUnverified, mapAuthError } from '../lib/authErrors';

/**
 * Invite-claim funnel, reached from the welcome email
 * (https://kinfolk.tribetails.com/claim?invite=<id>; legacy #/claim/<id> and
 * /claim/<id> forms are also parsed). Componentized from
 * ui-ideas/mytribe-claim-invite-2026-05-31.html.
 *
 * Contract (matches the Kotlin ClaimInviteScreen):
 *   getInvitePreview -> create account via claimInviteSignup (server mints the
 *   account, returns a custom token) -> sign in with the token -> acceptInvite.
 * Existing account: claimInviteSignup throws already-exists and the screen
 * flips to sign-in mode with the invited email.
 */
export function ClaimInvite() {
  const navigate = useNavigate();
  const authState = useAuth();
  const inviteId = parseInviteId(window.location);

  const [inFlight, setInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signInMode, setSignInMode] = useState(false);
  const [done, setDone] = useState(false);
  // Set when acceptInvite refuses an unverified address. It is deliberately a
  // state of its OWN and not another `actionError` string: this is not a failure
  // to retry, it is a step the invitee has to take, and the two need different
  // cards. The invite stays live the whole time.
  const [needsVerification, setNeedsVerification] = useState(false);
  const acceptedForUid = useRef<string | null>(null);
  const { signOut, signingOut } = useSignOut();

  const preview = useQuery({
    queryKey: ['invitePreview', inviteId],
    queryFn: () => getInvitePreview(inviteId!),
    enabled: inviteId !== null,
    retry: 1,
    staleTime: Infinity,
  });

  const step: ClaimStep | null =
    done || preview.isError
      ? null
      : !preview.data || authState.status === 'loading'
        ? { kind: 'loading' }
        : stepForPreview(
            preview.data,
            authState.status === 'signedIn',
            authState.status === 'signedIn' ? (authState.user.email ?? null) : null,
          );

  async function accept() {
    // O-35: bound the WHOLE call — the SDK's own 20s timeout starts only
    // after context (token) acquisition, which is exactly where the
    // post-sign-in stall lives.
    await withTimeout(acceptInvite(inviteId!), 15_000, 'Joining your Tribe');
    setDone(true);
  }

  /**
   * Shared by the auto-accept effect and the explicit "Try again" button.
   * A failed accept (S7-BLOCKER-2: acceptInvite can cold-start past the 20s
   * callable timeout) must surface an error card with a retry — never an
   * unbounded spinner. The error used to be recorded but the loading card
   * rendered anyway, so a timed-out first attempt looked like a hang.
   */
  function runAccept(forUid: string) {
    acceptedForUid.current = forUid;
    setActionError(null);
    setInFlight(true);
    accept()
      .catch((err: unknown) => {
        acceptedForUid.current = null;
        // "Verify your email first" is not an error to retry into. Route it to
        // its own card, which tells them what to do and can prove when it is
        // done, instead of a generic "didn't finish. Try again." that would loop.
        if (isEmailUnverified(err)) {
          setNeedsVerification(true);
          return;
        }
        setActionError(err instanceof Error ? err.message : 'Could not accept invite');
      })
      .finally(() => setInFlight(false));
  }

  // Signed in with the invited email (fresh signup, sign-in, or pre-existing
  // session): accept exactly once per uid.
  const uid = authState.status === 'signedIn' ? authState.user.uid : null;
  useEffect(() => {
    if (
      step?.kind === 'autoAccept' &&
      uid &&
      acceptedForUid.current !== uid &&
      !inFlight &&
      !actionError &&
      // Without this the effect would re-fire the moment the refusal cleared
      // inFlight, hammering the callable (and its verification mailer) in a loop
      // behind the verify card.
      !needsVerification
    ) {
      runAccept(uid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.kind, uid]);

  async function handleCreateOrSignIn(invitedEmail: string, password: string) {
    setActionError(null);
    setInFlight(true);
    try {
      if (signInMode) {
        await signIn(invitedEmail, password);
      } else {
        // Client-side signup is project-disabled; the server mints the account
        // off the live invite and returns a custom token to sign in with.
        const { token } = await claimInviteSignup(inviteId!, password);
        await signInWithToken(token);
      }
      // O-35: the first callable on a seconds-old in-page session can stall
      // inside the SDK's context acquisition (pre-timeout, silent). The boot
      // path is proven fast, so reload into it: the URL keeps ?invite=, the
      // signed-in boot re-enters autoAccept, and accept lands in seconds.
      // jsdom throws "Not implemented: navigation" — the auto-accept effect
      // is the in-test fallback.
      try {
        window.location.reload();
        return;
      } catch {
        // Test environment: fall through to the in-page auto-accept effect.
      }
    } catch (err) {
      if (!signInMode && isEmailAlreadyInUse(err)) {
        setSignInMode(true);
        setActionError('You already have an account. Enter your password to sign in.');
      } else {
        setActionError(mapAuthError(err).message);
      }
    } finally {
      setInFlight(false);
    }
  }

  return (
    <main className="guest">
      <header className="guesthead">
        <div className="wordmark">
          My<span className="grad">Tribe</span>
        </div>
        <div className="kick">Your invite</div>
      </header>

      {inviteId === null ? (
        <InvalidCard message="This link is missing its invite code. Open the link from your email again, or ask Auntie to resend it." />
      ) : done ? (
        <WelcomeCard onEnter={() => void navigate({ to: '/home' })} />
      ) : preview.isError ? (
        <ErrorCard
          title="Could not open this invite"
          detail="Check your connection and try again."
          onRetry={() => void preview.refetch()}
        />
      ) : step?.kind === 'inviteInvalid' ? (
        <InvalidCard message={step.message} />
      ) : needsVerification && uid ? (
        <VerifyEmailCard
          // The step is only ever `autoAccept` here, and reaching it already
          // proved the signed-in email equals the invited one, so either source
          // names the same mailbox.
          invitedEmail={
            step?.kind === 'autoAccept'
              ? step.invitedEmail
              : authState.status === 'signedIn'
                ? (authState.user.email ?? '')
                : ''
          }
          onVerified={() => {
            setNeedsVerification(false);
            runAccept(uid);
          }}
        />
      ) : step?.kind === 'autoAccept' && actionError && uid ? (
        <ErrorCard
          title="Almost there"
          detail="Your account is ready, but joining your Tribe didn't finish. Try again."
          onRetry={() => runAccept(uid)}
        />
      ) : step?.kind === 'wrongAccount' ? (
        <section className="glass card d1">
          <h3 className="title">This invite is for someone else</h3>
          <p className="sub" style={{ marginTop: 10 }}>
            The invite was sent to {step.invitedEmail}, but you are signed in as {step.currentEmail}.
          </p>
          <div style={{ marginTop: 18 }}>
            <button className="btn grad block" onClick={signOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out and continue'}
            </button>
          </div>
        </section>
      ) : step?.kind === 'createAccount' ? (
        <CreateAccountCard
          invitedEmail={step.invitedEmail}
          tribeName={step.tribeName}
          signInMode={signInMode}
          inFlight={inFlight}
          error={actionError}
          onToggleMode={() => {
            setSignInMode((v) => !v);
            setActionError(null);
          }}
          onSubmit={(password) => void handleCreateOrSignIn(step.invitedEmail, password)}
        />
      ) : actionError !== null ? (
        <ErrorCard
          title="Could not accept invite"
          detail={actionError}
          onRetry={() => {
            setActionError(null);
            setInFlight(true);
            accept()
              .catch((err: unknown) => {
                setActionError(err instanceof Error ? err.message : 'Try again in a moment.');
              })
              .finally(() => setInFlight(false));
          }}
          retryLabel={inFlight ? 'Trying…' : 'Try Again'}
          onSkip={() => void navigate({ to: '/signin' })}
        />
      ) : (
        <section className="glass card d1" style={{ textAlign: 'center' }}>
          <h3 className="title" style={{ justifyContent: 'center' }}>
            {step?.kind === 'autoAccept' ? 'Accepting your invite…' : 'Opening your invite…'}
          </h3>
        </section>
      )}

      <p className="footnote">
        Welcome to <b>MyTribe</b>
      </p>
    </main>
  );
}

/** Celebratory success card from the mockup. */
function WelcomeCard({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="glass welcome d1">
      <div className="banner">
        <span className="confetti c1">{'✨'}</span>
        <span className="confetti c2">{'\u{1F389}'}</span>
        <span className="confetti c3">{'\u{1F496}'}</span>
        <span className="confetti c4">{'✨'}</span>
        <div className="mark">{'\u{1F43E}'}</div>
      </div>
      <div className="body">
        <h1>You're in!</h1>
        <p className="lede">Welcome to your Tribe.</p>
        <div className="actions">
          <button className="btn grad block" onClick={onEnter}>
            Enter MyTribe
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Shown when `acceptInvite` refuses because the invited address is not verified
 * ("secondary needs email verification as well").
 *
 * Only invitees who ALREADY had a Firebase account can land here;
 * `claimInviteSignup` mints new accounts already verified. That population is
 * exactly the one PR #203's claim path exists to serve, so this card has to end
 * with them inside, not with an apology. The server has already mailed them a
 * link by the time this renders.
 *
 * "I've verified" does not just retry: it forces a token refresh first. The ID
 * token in this tab was minted before they clicked the link and still says
 * unverified, so a plain retry would be refused again and read as a broken
 * verification link. If the refreshed token still says unverified we say so
 * plainly rather than bouncing them off the callable a second time.
 */
function VerifyEmailCard(props: { invitedEmail: string; onVerified: () => void }) {
  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function check() {
    setNote(null);
    setChecking(true);
    refreshEmailVerification()
      .then((verified) => {
        if (verified) {
          props.onVerified();
          return;
        }
        setNote("We still don't see this address as confirmed. Open the link in the email, then check again.");
      })
      .catch(() => setNote('Could not check just now. Try again in a moment.'))
      .finally(() => setChecking(false));
  }

  function resend() {
    setNote(null);
    setResending(true);
    resendVerificationEmail()
      .then(() => setNote(`Sent again to ${props.invitedEmail}. It can take a minute.`))
      .catch(() => setNote('Could not send another email just now. Try again in a moment.'))
      .finally(() => setResending(false));
  }

  return (
    <section className="glass card d1">
      <h3 className="title">Confirm your email to join</h3>
      <p className="sub" style={{ marginTop: 10 }}>
        You already have an account with {props.invitedEmail || 'this address'}, and it has not been
        confirmed yet. We just emailed a confirmation link. Open it, then come back here.
      </p>
      <p className="sub" style={{ marginTop: 10 }}>
        Your invite stays open in the meantime, so there is nothing to re-request.
      </p>
      {note !== null && (
        <div className="validate" role="alert" style={{ marginTop: 12 }}>
          <span className="x">{'⚠'}</span>
          <span>{note}</span>
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        <button className="btn grad block" onClick={check} disabled={checking || resending}>
          {checking ? 'Checking…' : "I've confirmed it"}
        </button>
      </div>
      <div className="forgotrow">
        <a onClick={resending ? undefined : resend}>
          {resending ? 'Sending…' : 'Send the email again'}
        </a>
      </div>
    </section>
  );
}

function InvalidCard({ message }: { message: string }) {
  return (
    <section className="glass card d1">
      <h3 className="title">Invite couldn't be opened</h3>
      <p className="sub" style={{ marginTop: 10 }}>{message}</p>
      <div style={{ marginTop: 18 }}>
        <a className="btn ghost block" href="/signin">
          Go to sign in
        </a>
      </div>
    </section>
  );
}

function ErrorCard(props: {
  title: string;
  detail: string;
  onRetry: () => void;
  retryLabel?: string;
  onSkip?: () => void;
}) {
  return (
    <section className="glass errcard d2">
      <div className="ehead">
        <div className="edot">{'⚠'}</div>
        <div className="etxt">
          <b>{props.title}</b>
          <small>{props.detail}</small>
        </div>
      </div>
      <div className="eactions">
        <button className="btn tiny" onClick={props.onRetry}>
          {props.retryLabel ?? 'Try Again'}
        </button>
        {props.onSkip && (
          <button className="btn ghost" onClick={props.onSkip}>
            Skip for now
          </button>
        )}
      </div>
    </section>
  );
}

/** Create-account (set password) module, with a sign-in mode for returning kinfolk. */
function CreateAccountCard(props: {
  invitedEmail: string;
  tribeName: string;
  signInMode: boolean;
  inFlight: boolean;
  error: string | null;
  onToggleMode: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (props.inFlight || !password) return;
    if (!props.signInMode) {
      const problem = validateNewPassword(password, confirm);
      if (problem) {
        setLocalError(problem);
        return;
      }
    }
    setLocalError(null);
    props.onSubmit(password);
  }

  const shownError = localError ?? props.error;

  return (
    <section className="glass card authcard d1">
      <h2>
        {props.tribeName
          ? <>Welcome to the Tribe, <span>{props.tribeName}</span></>
          : <>Welcome to the <span>Tribe</span></>}
      </h2>
      <p className="subline">
        {props.signInMode
          ? 'Sign in to claim your invite.'
          : 'Set a password to finish creating your account.'}
      </p>
      <p className="subline" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{props.invitedEmail}</p>

      <form onSubmit={handleSubmit}>
        <div className="field has-toggle">
          <label htmlFor="claim-password">{props.signInMode ? 'Password' : 'Choose a password'}</label>
          <div className="inwrap">
            <input
              id="claim-password"
              type={reveal ? 'text' : 'password'}
              autoComplete={props.signInMode ? 'current-password' : 'new-password'}
              placeholder={props.signInMode ? 'Your password' : 'At least 8 characters'}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setLocalError(null);
              }}
            />
            <button
              type="button"
              className="pwtoggle"
              aria-label={reveal ? 'Hide password' : 'Show password'}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? '\u{1F648}' : '\u{1F441}'}
            </button>
          </div>
        </div>

        {!props.signInMode && (
          <div className="field has-toggle">
            <label htmlFor="claim-confirm">Confirm password</label>
            <div className="inwrap">
              <input
                id="claim-confirm"
                type={reveal ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Same password again"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setLocalError(null);
                }}
              />
            </div>
          </div>
        )}

        {shownError && (
          <div className="validate" role="alert">
            <span className="x">{'⚠'}</span>
            <span>{shownError}</span>
          </div>
        )}

        <button type="submit" className="btn grad block" disabled={props.inFlight || !password}>
          {props.inFlight ? 'Working…' : props.signInMode ? 'Sign in & join' : 'Create account & join'}
        </button>
      </form>

      <div className="forgotrow">
        <a onClick={props.onToggleMode}>
          {props.signInMode ? 'New here? Set a password instead' : 'Already have a password? Sign in'}
        </a>
      </div>
    </section>
  );
}
