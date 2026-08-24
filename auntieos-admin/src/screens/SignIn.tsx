import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FirebaseError } from 'firebase/app';
import { signIn, signOutSilent, useAuth } from '../lib/auth';
import { attestationOwnsRecaptcha } from '../lib/boot';
import { readAndClearSignInNotice, recordSignInNotice } from '../lib/signInNotice';
import { resolveAccess } from '../lib/access';
import { PrimaryButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import { GlassSurface } from '../components/GlassSurface';

const DENIED_MSG = 'This account is not authorized for the AuntieOS admin app.';

/** Maps the common auth error codes to a human line; anything else stays raw. */
function authMessage(err: unknown): string {
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

export function SignIn() {
  const navigate = useNavigate();
  const authState = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Why the operator is looking at this form, when they did not ask to be
   * (#573).
   *
   * Read ONCE, in the lazy initializer, and cleared as it is read — the same
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
   * the answer to that is "Invalid site key or not loaded in api.js" — the
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
    void resolveAccess(authState.user).then((access) => {
      if (!live) return;
      if (access.status === 'denied') {
        void denyEntry();
      } else {
        void navigate({ to: '/home' });
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, navigate]);

  async function doSignIn() {
    if (busy) return;
    setError(null);
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault(); // Enter-in-field path
    void doSignIn();
  }

  return (
    <main className="signin">
      <GlassSurface className="signin__card">
        <h1 className="signin__title">AuntieOS</h1>
        <p className="signin__subtitle">Operator sign-in</p>

        {notice ? (
          <Banner tone="warning" title="Signed out">
            {notice}
          </Banner>
        ) : null}

        {error ? (
          <Banner tone="error" title="Can't sign in">
            {error}
          </Banner>
        ) : null}

        <form className="signin__form" onSubmit={onSubmit}>
          <label className="signin__field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="signin__field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {/* ControlShell renders a div, not a native submit button, so the
              pointer path calls doSignIn directly; Enter-in-field goes through
              the form's onSubmit. */}
          <PrimaryButton label="Sign in" busy={busy} onClick={() => void doSignIn()} />
        </form>
      </GlassSurface>
    </main>
  );
}
