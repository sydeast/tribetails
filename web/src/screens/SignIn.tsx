import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { sendReset, signIn } from '../lib/auth';
import { mapAuthError } from '../lib/authErrors';

type ResetToast =
  | { tone: 'ok'; title: string; sub: string }
  | { tone: 'warn'; title: string; sub: string }
  | { tone: 'err'; title: string; sub: string };

/**
 * Sign-in screen, componentized from ui-ideas/mytribe-signin-2026-05-31.html.
 * Enter submits (native form submit), password has a show/hide toggle, and
 * errors surface as the mockup's inline validate banner / reset toasts.
 */
export function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetToast, setResetToast] = useState<ResetToast | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setResetToast(null);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      void navigate({ to: '/home' });
    } catch (err) {
      setError(mapAuthError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleForgot() {
    if (busy) return;
    setError(null);
    if (!email.trim()) {
      setResetToast({
        tone: 'warn',
        title: 'Type your email above first.',
        sub: 'We need an address to send the reset link to.',
      });
      return;
    }
    setBusy(true);
    try {
      await sendReset(email.trim());
      setResetToast({
        tone: 'ok',
        title: 'Reset link sent. Check your inbox.',
        sub: 'Sent to the email you typed above.',
      });
    } catch {
      setResetToast({
        tone: 'err',
        title: "Couldn't send reset email.",
        sub: 'Something went wrong on our end. Try again in a moment.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="authshell">
      <div className="authcol">
        <header className="brandhead">
          <div className="mark">{'\u{1F43E}'}</div>
          <div className="wm">
            Tribe <span className="grad">Tails</span>
          </div>
          <div className="kick">Pet Care Portal</div>
        </header>

        <section className="glass card authcard d1">
          <h2>
            Welcome back to <span>Tribe!</span>
          </h2>
          <p className="subline">Jump back in!</p>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">Email Address</label>
              <div className="inwrap">
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="field has-toggle">
              <label htmlFor="password">Password</label>
              <div className="inwrap">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="pwtoggle"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? '\u{1F648}' : '\u{1F441}'}
                </button>
              </div>
            </div>

            {error && (
              <div className="validate" role="alert">
                <span className="x">{'⚠'}</span>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn grad block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <div className="forgotrow">
            <a onClick={() => void handleForgot()}>Forgot password?</a>
          </div>
        </section>

        {resetToast && (
          <div className={`toast ${resetToast.tone} d2`} role="status">
            <div className="ico">
              {resetToast.tone === 'ok' ? '✓' : resetToast.tone === 'warn' ? '✎' : '⚠'}
            </div>
            <div>
              <div className="tt">{resetToast.title}</div>
              <div className="ts">{resetToast.sub}</div>
            </div>
          </div>
        )}

        <p className="authfoot">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </main>
  );
}
