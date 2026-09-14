import { useEffect, useId, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FirebaseError } from 'firebase/app';
import { sendReset, signIn, signOutSilent, useAuth } from '../lib/auth';
import { attestationOwnsRecaptcha } from '../lib/boot';
import { readAndClearSignInNotice, recordSignInNotice } from '../lib/signInNotice';
import { ACCOUNT_LOCKED_MSG, isAccountLockedError } from '../lib/failedLogin';
import { resolveAccess } from '../lib/access';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import { GlassSurface } from '../components/GlassSurface';

/**
 * The copy on this screen is the mock's (`ui-ideas/auntieos-sign-in-2026-05-27.html`),
 * which reproduces the wasm SignInScreen.kt verbatim. The admin gate line used
 * to read "not authorized for the AuntieOS admin app" here and "does not have
 * the admin claim" on Android; the sweep for #755 put all three on one string.
 */
const DENIED_MSG = 'This account does not have admin access.';
const MISSING_MSG = 'Email and password are required.';
const RESET_NEEDS_EMAIL_MSG = 'Type your email above first.';
const RESET_SENT_MSG = 'Reset link sent. Check your inbox.';

/** Maps the common auth error codes to a human line; anything else stays raw. */
function authMessage(err: unknown): string {
  // #886: beforeSignIn's refusal arrives as auth/internal-error, whose raw
  // message would otherwise be painted below. Checked first for that reason.
  if (isAccountLockedError(err)) return ACCOUNT_LOCKED_MSG;
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/invalid-email':
        return 'That email address is not valid.';
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Email or password is incorrect.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Wait a moment and try again.';
      case 'auth/network-request-failed':
        return 'Network error. Check your connection and try again.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Sign-in failed.';
}

/**
 * The brand mark: Lucide's PawPrint, inlined because no icon package is
 * installed on the web side and one glyph is not worth a dependency. The
 * Android screen draws the same glyph from the Lucide library it already has.
 */
function PawMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="4" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
      <path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z" />
    </svg>
  );
}

export function SignIn() {
  const navigate = useNavigate();
  const authState = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  /**
   * Why the operator is looking at this form, when they did not ask to be
   * (#573).
   *
   * Read ONCE, in the lazy initializer, and cleared as it is read, the same
   * shape the portal's SignIn uses. Both writers get here by ending the
   * document (a revoked session navigates, a denied non-admin reloads), so this
   * component mounts already holding the explanation and initialising state
   * from it puts the banner in the first paint. Reading in an effect instead
   * would let it reappear on a remount; reading on every render would fight the
   * clear.
   *
   * Its OWN state slot, not folded into `error`. `error` is what this form has
   * to say about the credentials just typed, and `doSignIn` clears it on every
   * attempt; the notice is about what happened before the form was ever shown.
   * One slot for both would mean the first keystroke-and-submit erased the only
   * account of it.
   */
  const [notice] = useState<string | null>(readAndClearSignInNotice);
  // Explicit `for`/`id` pairs rather than wrapping labels: the password rule
  // holds the reveal button too, and a wrapping label would fold "show" into
  // the field's accessible name.
  const emailId = useId();
  const passwordId = useId();

  /**
   * A non-admin who authenticates has to be signed out, and how depends on
   * whether App Check activated in this page lifetime (#576).
   *
   * IN PLACE is the cheap answer and the usual one: the store flips to
   * signedOut and the form below re-renders with the refusal, no reload.
   *
   * A FRESH DOCUMENT is required when attestation is running, and only then. A
   * lifetime that booted signed-in activated App Check, whose reCAPTCHA
   * Enterprise script owns `window.grecaptcha` for as long as the document
   * lives. Handing the form back on that document means the next sign-in
   * executes the Identity Platform site key against App Check's instance, and
   * the answer to that is "Invalid site key or not loaded in api.js": the
   * button spins and never settles. That is the S7-BLOCKER-1 collision the
   * portal hit, arriving here by a different door. A fresh document boots
   * signed-out, so `boot.ts` leaves App Check alone and the auth loader has the
   * field to itself.
   *
   * The refusal crosses the reload in `sessionStorage`, because a message that
   * does not survive is the same as no message.
   */
  async function denyEntry(): Promise<void> {
    await signOutSilent();
    if (attestationOwnsRecaptcha()) {
      recordSignInNotice(DENIED_MSG);
      try {
        window.location.assign('/signin');
        return;
      } catch {
        // jsdom throws "Not implemented: navigation". Fall through and show the
        // message in place, which is all this environment can do anyway.
      }
    }
    setError(DENIED_MSG);
  }

  // A session that is already signed in when this screen mounts (refresh, or a
  // guard bounce): admins go straight to /home; a denied non-admin is signed
  // out so the form below is usable.
  useEffect(() => {
    if (authState.status !== 'signedIn') return;
    let live = true;
    void resolveAccess(authState.user)
      .then((access) => {
        if (!live) return;
        if (access.status === 'denied') {
          void denyEntry();
        } else {
          void navigate({ to: '/home' });
        }
      })
      .catch((err: unknown) => {
        // #812: `resolveAccess` mints a token, so this rejects whenever the
        // refresh cannot be had, which is exactly the state that sends an
        // operator here in the first place. It was an unhandled rejection,
        // and the operator was left staring at a form with no account of why
        // nothing happened. The form stays up and usable (that is the right
        // answer: a re-auth IS the remedy for the `expired` case that routes
        // here) and the reason is now on screen above it.
        if (!live) return;
        setError(authMessage(err));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, navigate]);

  async function doSignIn() {
    if (busy || resetting) return;
    setError(null);
    setResetSent(false);
    // The pointer path calls this directly, so the inputs' `required` never
    // runs for a click. Checked here, with the mock's line, instead of letting
    // Firebase answer an empty email with "That email address is not valid."
    if (email.trim() === '' || password === '') {
      setError(MISSING_MSG);
      return;
    }
    setBusy(true);
    try {
      const user = await signIn(email.trim(), password);
      const access = await resolveAccess(user, true); // fresh token: claims may be minutes old
      if (access.status === 'denied') {
        await signOutSilent();
        setError(DENIED_MSG);
        return;
      }
      await navigate({ to: '/home' });
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The mock's ghost control sends the reset straight away, to the email typed
   * above, with no confirm step. The wasm screen and the portal do the same.
   */
  async function doReset() {
    if (busy || resetting) return;
    setError(null);
    setResetSent(false);
    if (email.trim() === '') {
      setError(RESET_NEEDS_EMAIL_MSG);
      return;
    }
    setResetting(true);
    try {
      await sendReset(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setResetting(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault(); // Enter-in-field path
    void doSignIn();
  }

  return (
    <main className="signin">
      <div className="signin__stage">
        <div className="signin__mark d1" aria-hidden="true">
          <PawMark />
        </div>
        <p className="signin__brand d2">AuntieOS</p>

        <GlassSurface className="signin__card d3">
          <div className="signin__head">
            <h1 className="signin__title">Welcome home, Auntie</h1>
            <p className="signin__subtitle">Sign in to keep the Kinfolk taken care of.</p>
          </div>

          {/* One line each, no title: the mock's toasts carry only the message,
              and the tone does the rest. `warning` and `error` keep role=alert
              from Banner, which the e2e specs read the refusal through. */}
          {notice ? <Banner tone="warning">{notice}</Banner> : null}

          {error ? <Banner tone="error">{error}</Banner> : null}

          {resetSent ? <Banner tone="info">{RESET_SENT_MSG}</Banner> : null}

          <form className="signin__form" onSubmit={onSubmit}>
            <div className="signin__field">
              <label className="signin__label" htmlFor={emailId}>
                Email
              </label>
              <div className="signin__input">
                <input
                  id={emailId}
                  type="email"
                  autoComplete="username"
                  placeholder="you@auntieos.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="signin__field">
              <label className="signin__label" htmlFor={passwordId}>
                Password
              </label>
              <div className="signin__input">
                <input
                  id={passwordId}
                  type={revealed ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="signin__reveal"
                  onClick={() => setRevealed((r) => !r)}
                  aria-pressed={revealed}
                  aria-label={revealed ? 'Hide password' : 'Show password'}
                >
                  {revealed ? 'hide' : 'show'}
                </button>
              </div>
            </div>
            {/* ControlShell renders type="button", not a submit button, so the
                pointer path calls doSignIn directly; Enter-in-field goes through
                the form's onSubmit. */}
            <PrimaryButton
              label={busy ? 'Signing in...' : 'Jump back in!'}
              busy={busy}
              disabled={resetting}
              onClick={() => void doSignIn()}
              className="signin__submit"
            />
            <div className="signin__ghostrow">
              <GhostButton
                label={resetting ? 'Sending...' : 'Forgot password?'}
                disabled={busy || resetting}
                onClick={() => void doReset()}
                className="signin__forgot"
              />
            </div>
          </form>
        </GlassSurface>
      </div>
    </main>
  );
}
