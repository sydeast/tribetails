import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FirebaseError } from 'firebase/app';
import { signIn, signOutSilent, useAuth } from '../lib/auth';
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

  // A session that is already signed in when this screen mounts (refresh, or a
  // guard bounce): admins go straight to /home; a denied non-admin is signed
  // out in place so the form below is usable.
  useEffect(() => {
    if (authState.status !== 'signedIn') return;
    let live = true;
    void resolveAccess(authState.user).then((access) => {
      if (!live) return;
      if (access.status === 'denied') {
        setError(DENIED_MSG);
        void signOutSilent();
      } else {
        void navigate({ to: '/home' });
      }
    });
    return () => {
      live = false;
    };
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
