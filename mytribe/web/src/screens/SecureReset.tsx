import { useMemo, useState } from 'react';
import { confirmSecureReset } from '../api/portal';
import { validateNewPassword } from '../api/claimFlow';
import { BusyLabel } from '../components/Loading';

/**
 * Secure-account flow after a kinfolk flags a password reset they did not
 * request. Componentized from ui-ideas/mytribe-secure-reset-2026-05-31.html.
 *
 * The user is signed out here. The reset email links to
 * /account/secure-reset?oobCode=<code>&email=<email> (email may also ride in
 * continueUrl); submitting consumes the oobCode via the public
 * confirmSecureReset endpoint, which also records a security incident and
 * notifies Tribe Tails.
 */
export function SecureReset() {
  const params = useMemo(() => readParams(), []);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [secured, setSecured] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !params) return;
    const p = validateNewPassword(newPassword, confirmPassword);
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(null);
    setServerError(null);
    setBusy(true);
    try {
      await confirmSecureReset({
        oobCode: params.oobCode,
        newPassword,
        email: params.email,
        userAgent: navigator.userAgent,
      });
      setSecured(true);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not secure your account. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="secguesthead">
        <div className="wordmark">
          My<span className="grad">Tribe</span>
        </div>
      </header>

      <main className="secwrap">
        {!params ? (
          <section className="glass card d1">
            <div className="alertbanner">
              <div className="shield">{'\u{1F6E1}'}</div>
              <div className="at">
                <b>This link is incomplete</b>
                <p>
                  Open the link from your email again. If it still does not work, contact Tribe Tails
                  and we will secure your account together.
                </p>
              </div>
            </div>
          </section>
        ) : secured ? (
          <section className="glass card d1">
            <div className="successbox">
              <div className="tick">{'✓'}</div>
              <div>
                <b>Your account is secured.</b>
                <p className="signoff" style={{ textAlign: 'left', marginTop: 6, fontSize: 14 }}>
                  With urgency, Auntie at Tribe Tails
                </p>
              </div>
            </div>
            <p className="helper" style={{ marginTop: 14 }}>
              Your new password is set and Tribe Tails has been notified. You can close this page,
              or <a href="/signin" style={{ color: 'var(--teal)' }}>sign in with your new password</a>.
            </p>
          </section>
        ) : (
          <section className="glass card d1">
            <div className="alertbanner">
              <div className="shield">{'\u{1F6E1}'}</div>
              <div className="at">
                <b>Secure your account</b>
                <p>You flagged a password reset you did not request.</p>
              </div>
            </div>

            <form
              style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 20 }}
              onSubmit={handleSubmit}
            >
              <div className="secfield">
                <label htmlFor="newpw">New Password</label>
                <input
                  id="newpw"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Enter a new password"
                  className={problem ? 'bad' : ''}
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setProblem(null);
                  }}
                />
              </div>

              <div className="secfield">
                <label htmlFor="confpw">Confirm New Password</label>
                <input
                  id="confpw"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Re-enter your new password"
                  className={problem ? 'bad' : ''}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setProblem(null);
                  }}
                />
                {problem && <span className="vmsg">{problem}</span>}
                {serverError && <span className="vmsg">{serverError}</span>}
              </div>

              <div className="secactions">
                <button type="submit" className="btn grad block" disabled={busy}>
                  {busy ? <BusyLabel>Securing…</BusyLabel> : '\u{1F512} Secure my account and notify Tribe Tails'}
                </button>
              </div>
            </form>

            <p className="signoff">With urgency, Auntie at Tribe Tails</p>
          </section>
        )}

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </main>
    </>
  );
}

/**
 * Parses oobCode + email from the launch URL, mirroring the Kotlin deep-link
 * parser: email is a direct query param or tucked inside continueUrl
 * (Firebase appends ActionCodeSettings.url as continueUrl=<encoded-url>).
 */
function readParams(): { oobCode: string; email: string } | null {
  const search = new URLSearchParams(window.location.search);
  const oobCode = search.get('oobCode');
  if (!oobCode) return null;

  let email = search.get('email');
  if (!email) {
    const continueUrl = search.get('continueUrl');
    if (continueUrl) {
      const q = continueUrl.split('?')[1];
      if (q) email = new URLSearchParams(q).get('email');
    }
  }
  if (!email) return null;
  return { oobCode, email };
}
