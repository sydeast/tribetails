import { useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { DEFAULT_SIGN_IN_LANDING, safeRedirectPath } from '../lib/signInRedirect';
import { sendReset, signIn } from '../lib/auth';
import { isRateLimitedError, mapAuthError } from '../lib/authErrors';
import { readAndClearSessionEndedNotice } from '../lib/revokedSession';
import { useBusinessPublicCard } from '../lib/businessPublicCard';
import { BusyLabel } from '../components/Loading';

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
  // #1384: the email link the route guard turned this household away from.
  // Re-checked here: it is an address-bar value, not a trusted router value.
  const { redirect: carried } = useSearch({ strict: false }) as { redirect?: unknown };
  const landing = safeRedirectPath(carried);
  const { history } = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetToast, setResetToast] = useState<ResetToast | null>(null);
  /**
   * #557: read ONCE, in the lazy initializer, and clear as we read. Landing
   * here after an involuntary sign-out with no explanation is the failure this
   * closes — "it logged me out and I don't know why" is the complaint. Reading
   * in an effect instead would let the banner reappear on a remount, and
   * reading on every render would fight the clear.
   */
  const [sessionEndedNotice] = useState<string | null>(readAndClearSessionEndedNotice);
  /** #1321: `business_public/card.name`, cached copy first, then live. '' omits the line. */
  const businessName = useBusinessPublicCard().name;

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
      if (landing === null) void navigate({ to: DEFAULT_SIGN_IN_LANDING });
      else history.push(landing); // whole string, so the link's own search and hash survive
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
    } catch (err) {
      // #905: the reset callable's per-IP limit. Trying again at once is exactly
      // what will not work, so it is not told as "something went wrong".
      setResetToast(
        isRateLimitedError(err)
          ? { tone: 'err', title: 'Too many tries for now.', sub: 'Wait a few minutes, then try again.' }
          : {
              tone: 'err',
              title: "Couldn't send reset email.",
              sub: 'Something went wrong on our end. Try again in a moment.',
            },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="authshell">
      <div className="authcol">
        <header className="brandhead">
          <div className="mark">{'\u{1F43E}'}</div>
          {/* #1321: the app is MyTribe; the business it is for follows when the
              public card arrives, and is left out while the operator has set
              no name. The headline never waits on the read. */}
          <div className="wm">
            My<span className="grad">Tribe</span>
          </div>
          {businessName !== '' && (
            <div className="kick" data-testid="business-byline">
              by {businessName}
            </div>
          )}
        </header>

        <section className="glass card authcard d1">
          <h2>
            Welcome back to <span>Tribe!</span>
          </h2>
          <p className="subline">Jump back in!</p>

          {sessionEndedNotice && (
            <div className="validate" role="status" data-testid="session-ended-notice">
              <span className="x">{'⚠'}</span>
              <span>{sessionEndedNotice}</span>
            </div>
          )}

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
              {busy ? <BusyLabel>Signing in…</BusyLabel> : 'Sign In'}
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

        {businessName !== '' && (
          <p className="authfoot" data-testid="business-footnote">
            Cared for by <b>{businessName}</b>
          </p>
        )}
      </div>
    </main>
  );
}
