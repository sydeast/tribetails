import { useEffect, useMemo, useState } from 'react';
import { confirmSecureReset } from '../api/portal';
import { validateNewPassword } from '../api/claimFlow';
import { BusyLabel } from '../components/Loading';
import { applyEmailAction, completeReset, readActionCode, sendReset } from '../lib/auth';
import { parseEmailActionLink, type EmailActionLink } from '../lib/emailAction';

/**
 * The project's Firebase email action handler (#892).
 *
 * Identity Toolkit's `callbackUri` points at /account/secure-reset, so every
 * Firebase auth email opens this page: password resets from every client, email
 * verification and email-change links. Staff land here too (the action URL is
 * one URL per project), so the copy is written for anyone with a Tribe Tails
 * account and never assumes a household.
 *
 * A normal reset verifies the code, shows the account it belongs to, and sets
 * the password with the client SDK. No security incident is filed. "I did not
 * ask for this reset" is an explicit choice on the same page; only that path
 * calls the public `confirmSecureReset` endpoint, which derives the account
 * from the oobCode, records an incident and alerts Tribe Tails.
 *
 * Visual base: ui-ideas/mytribe-secure-reset-2026-05-31.html.
 */
export function SecureReset() {
  const link = useMemo(() => parseEmailActionLink(window.location.search, window.location.origin), []);

  let body: React.ReactNode;
  if (!link) {
    body = (
      <Notice title="This link is incomplete.">
        Open the link from your email again. If it still does not work, ask for a new one from the
        sign-in screen.
      </Notice>
    );
  } else if (link.mode === 'resetPassword') {
    body = <ResetPasswordFlow link={link} />;
  } else if (link.mode === 'unsupported') {
    body = (
      <Notice title="This link can't be completed here.">
        Go back to the app or site where you started and try again from there.
      </Notice>
    );
  } else {
    body = <EmailLinkFlow link={link} />;
  }

  return (
    <>
      <header className="secguesthead">
        <div className="wordmark">
          Tribe <span className="grad">Tails</span>
        </div>
      </header>

      <main className="secwrap">
        {body}
        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </main>
    </>
  );
}

// ── Shared pieces ────────────────────────────────────────────────────────────

type CodeProblem = 'expired' | 'invalid' | 'unreachable';

/** Firebase auth error code to what the reader can do about it. */
function codeProblemOf(err: unknown): CodeProblem | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'auth/expired-action-code') return 'expired';
  if (code === 'auth/invalid-action-code' || code === 'auth/user-disabled' || code === 'auth/user-not-found') {
    return 'invalid';
  }
  return null;
}

function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="glass card d1">
      <div className="alertbanner">
        <div className="shield">{'\u{1F6E1}'}</div>
        <div className="at">
          <b>{title}</b>
          <p>{children}</p>
        </div>
      </div>
    </section>
  );
}

function Checking() {
  return (
    <section className="glass card d1" aria-busy="true">
      <p className="helper">
        <BusyLabel>Checking your link…</BusyLabel>
      </p>
    </section>
  );
}

/** The admin app's sign-in, offered beside the portal's when a link does not say whose account it is. */
const STAFF_SIGN_IN_URL = 'https://auntie.tribetails.com/signin';

/**
 * Where to go next.
 *
 * With a continue URL the sender already said where this account signs in, so
 * there is one link. Without one (a bare native link, or a fresh link sent for
 * one) the page cannot tell a household from staff: `verifyPasswordResetCode`
 * returns only the email, and asking the server for the account's role would
 * be a new unauthenticated endpoint answering "is this address staff" for
 * anyone holding a code. So both sign-ins are shown, each named (#892 review).
 */
function SignInLinks({ continueUrl, label }: { continueUrl: string | null; label: string }) {
  const style = { color: 'var(--teal)' };
  if (continueUrl) {
    return (
      <p className="helper" style={{ marginTop: 14 }}>
        <a href={continueUrl} style={style}>
          {label}
        </a>
      </p>
    );
  }
  return (
    <p className="helper" style={{ marginTop: 14 }}>
      <a href="/signin" style={style}>
        Household sign-in
      </a>
      {' · '}
      <a href={STAFF_SIGN_IN_URL} style={style}>
        Staff sign-in
      </a>
    </p>
  );
}

function Success({
  title,
  children,
  continueUrl,
}: {
  title: string;
  children?: React.ReactNode;
  continueUrl: string | null;
}) {
  return (
    <section className="glass card d1">
      <div className="successbox" role="status">
        <div className="tick">{'✓'}</div>
        <div>
          <b>{title}</b>
        </div>
      </div>
      {children}
      <SignInLinks continueUrl={continueUrl} label="Sign in with your new password" />
    </section>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="glass card d1">
      <div className="alertbanner">
        <div className="shield">{'\u{1F6E1}'}</div>
        <div className="at">
          <b>We couldn't check this link.</b>
          <p>Check your connection, then try again. The link itself may still be fine.</p>
        </div>
      </div>
      <div className="secactions" style={{ marginTop: 18 }}>
        <button type="button" className="btn grad block" onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  );
}

/** Asks for an email and sends a fresh reset link that continues where the old one did. */
function ResendLink({ continueUrl }: { continueUrl: string | null }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'sent' | 'failed' | 'missing' | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!address) {
      setResult('missing');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      // null stays null: a bare link gets a bare new link (see SignInLinks).
      await sendReset(address, continueUrl);
      setResult('sent');
    } catch {
      setResult('failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="secform" onSubmit={handleSend}>
      <div className="secfield">
        <label htmlFor="resend-email">Email address</label>
        <input
          id="resend-email"
          type="email"
          autoComplete="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setResult(null);
          }}
        />
        {result === 'missing' && <span className="vmsg">Type the email you sign in with.</span>}
        {result === 'failed' && <span className="vmsg">We couldn't send a new link. Try again in a moment.</span>}
      </div>
      {result === 'sent' ? (
        <p className="helper" role="status">
          A new link is on its way. Check your inbox, and open the newest email.
        </p>
      ) : (
        <div className="secactions">
          <button type="submit" className="btn grad block" disabled={busy}>
            {busy ? <BusyLabel>Sending…</BusyLabel> : 'Send a new link'}
          </button>
        </div>
      )}
    </form>
  );
}

// ── mode=resetPassword ───────────────────────────────────────────────────────

type ResetPhase =
  | { kind: 'checking' }
  | { kind: 'problem'; problem: CodeProblem }
  | { kind: 'mismatch' }
  | { kind: 'ready'; email: string }
  | { kind: 'done'; secured: boolean };

function ResetPasswordFlow({ link }: { link: EmailActionLink }) {
  const [phase, setPhase] = useState<ResetPhase>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [intent, setIntent] = useState<'reset' | 'secure'>('reset');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPhase({ kind: 'checking' });
    // #892 review 2: read what the code really is, as EmailLinkFlow does. A
    // mode=resetPassword link carrying any other kind of code is not a reset.
    readActionCode(link.oobCode).then(
      (info) => {
        if (!live) return;
        if (info.operation !== 'PASSWORD_RESET') {
          setPhase({ kind: 'mismatch' });
          return;
        }
        if (!info.email) {
          setPhase({ kind: 'problem', problem: 'invalid' });
          return;
        }
        setPhase({ kind: 'ready', email: info.email });
      },
      (err: unknown) => {
        if (live) setPhase({ kind: 'problem', problem: codeProblemOf(err) ?? 'unreachable' });
      },
    );
    return () => {
      live = false;
    };
  }, [link.oobCode, attempt]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const p = validateNewPassword(newPassword, confirmPassword);
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(null);
    setServerError(null);
    setBusy(true);
    try {
      if (intent === 'secure') {
        await confirmSecureReset({ oobCode: link.oobCode, newPassword, userAgent: navigator.userAgent });
        setPhase({ kind: 'done', secured: true });
      } else {
        await completeReset(link.oobCode, newPassword);
        setPhase({ kind: 'done', secured: false });
      }
    } catch (err) {
      const codeProblem = codeProblemOf(err);
      if (codeProblem) {
        setPhase({ kind: 'problem', problem: codeProblem });
      } else if (errorCodeOf(err) === 'auth/weak-password') {
        setProblem('That password is too easy to guess. Choose a stronger password.');
      } else if (intent === 'secure' && err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError("We couldn't update your password. Try again in a moment.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === 'checking') return <Checking />;

  if (phase.kind === 'mismatch') {
    return (
      <Notice title="This link can't be completed here.">
        Go back to the app or site where you started and try again from there.
      </Notice>
    );
  }

  if (phase.kind === 'problem') {
    if (phase.problem === 'unreachable') return <Unreachable onRetry={() => setAttempt((n) => n + 1)} />;
    const expired = phase.problem === 'expired';
    return (
      <section className="glass card d1">
        <div className="alertbanner">
          <div className="shield">{'\u{1F6E1}'}</div>
          <div className="at">
            <b>{expired ? 'This reset link has expired.' : 'This reset link has already been used or is not valid.'}</b>
            <p>
              {expired
                ? 'Reset links only work for a short time. Enter your email and we will send a new one.'
                : 'Each reset link works once. Enter your email and we will send a new one.'}
            </p>
          </div>
        </div>
        <ResendLink continueUrl={link.continueUrl} />
      </section>
    );
  }

  if (phase.kind === 'done') {
    return phase.secured ? (
      <Success title="Your account is secured." continueUrl={link.continueUrl}>
        <p className="helper" style={{ marginTop: 14 }}>
          Your new password is set, and Tribe Tails has been alerted to look into the reset you did not
          ask for.
        </p>
      </Success>
    ) : (
      <Success title="Your password is updated." continueUrl={link.continueUrl} />
    );
  }

  const secure = intent === 'secure';
  return (
    <section className="glass card d1">
      {secure ? (
        <div className="alertbanner">
          <div className="shield">{'\u{1F6E1}'}</div>
          <div className="at">
            <b>Secure your account</b>
            <p>
              Someone may be trying to get into your account. Set a new password now, and Tribe Tails
              will be alerted to look into it.
            </p>
          </div>
        </div>
      ) : (
        <div className="sechead">
          <h1>Set a new password</h1>
          <p>
            For <strong className="secaccount">{phase.email}</strong>
          </p>
        </div>
      )}

      <form className="secform" onSubmit={handleSubmit}>
        <div className="secfield">
          <label htmlFor="newpw">New password</label>
          <input
            id="newpw"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className={problem ? 'bad' : ''}
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setProblem(null);
            }}
          />
        </div>

        <div className="secfield">
          <label htmlFor="confpw">Confirm new password</label>
          <input
            id="confpw"
            type="password"
            autoComplete="new-password"
            placeholder="Type it again"
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
            {busy ? (
              <BusyLabel>{secure ? 'Securing…' : 'Saving…'}</BusyLabel>
            ) : secure ? (
              'Secure my account'
            ) : (
              'Set new password'
            )}
          </button>
          <button
            type="button"
            className="seclink"
            disabled={busy}
            onClick={() => {
              setIntent(secure ? 'reset' : 'secure');
              setServerError(null);
            }}
          >
            {secure ? 'Go back' : 'I did not ask for this reset'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── mode=verifyEmail | verifyAndChangeEmail | recoverEmail ───────────────────

type EmailPhase =
  | { kind: 'checking' }
  | { kind: 'problem'; problem: CodeProblem }
  | { kind: 'mismatch' }
  | { kind: 'ready'; email: string | null }
  | { kind: 'done'; email: string | null };

/**
 * What `checkActionCode` must report for each link mode (#892 review). The mode
 * is a URL param anyone can edit, the operation is what the code really does:
 * a `mode=verifyEmail` link carrying a RECOVER_EMAIL code would otherwise show
 * "Confirm this email address" and roll back an email change on the tap.
 */
const OPERATION_FOR_MODE: Record<string, string> = {
  verifyEmail: 'VERIFY_EMAIL',
  verifyAndChangeEmail: 'VERIFY_AND_CHANGE_EMAIL',
  recoverEmail: 'RECOVER_EMAIL',
};

function EmailLinkFlow({ link }: { link: EmailActionLink }) {
  const [phase, setPhase] = useState<EmailPhase>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState<'sent' | 'failed' | null>(null);

  useEffect(() => {
    let live = true;
    setPhase({ kind: 'checking' });
    readActionCode(link.oobCode).then(
      (info) => {
        if (!live) return;
        if (info.operation !== OPERATION_FOR_MODE[link.mode]) {
          setPhase({ kind: 'mismatch' });
          return;
        }
        setPhase({ kind: 'ready', email: info.email });
      },
      (err: unknown) => {
        if (live) setPhase({ kind: 'problem', problem: codeProblemOf(err) ?? 'unreachable' });
      },
    );
    return () => {
      live = false;
    };
  }, [link.oobCode, link.mode, attempt]);

  async function handleApply() {
    if (busy || phase.kind !== 'ready') return;
    setBusy(true);
    setServerError(null);
    try {
      await applyEmailAction(link.oobCode);
      setPhase({ kind: 'done', email: phase.email });
    } catch (err) {
      const codeProblem = codeProblemOf(err);
      if (codeProblem) setPhase({ kind: 'problem', problem: codeProblem });
      else setServerError("We couldn't finish this. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendReset(email: string) {
    if (busy) return;
    setBusy(true);
    try {
      await sendReset(email, link.continueUrl);
      setResetSent('sent');
    } catch {
      setResetSent('failed');
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === 'checking') return <Checking />;

  if (phase.kind === 'problem') {
    if (phase.problem === 'unreachable') return <Unreachable onRetry={() => setAttempt((n) => n + 1)} />;
    return (
      <Notice
        title={phase.problem === 'expired' ? 'This link has expired.' : 'This link has already been used or is not valid.'}
      >
        Go back to where you started and ask for a new link.
      </Notice>
    );
  }

  if (phase.kind === 'mismatch') {
    return (
      <Notice title="This link can't be completed here.">
        Go back to the app or site where you started and try again from there.
      </Notice>
    );
  }

  const recover = link.mode === 'recoverEmail';
  const change = link.mode === 'verifyAndChangeEmail';

  if (phase.kind === 'done') {
    const title = recover
      ? `Your sign-in email is back to ${phase.email ?? 'what it was'}.`
      : change
        ? `Your sign-in email is now ${phase.email ?? 'updated'}.`
        : 'Your email address is confirmed.';
    return (
      <section className="glass card d1">
        <div className="successbox" role="status">
          <div className="tick">{'✓'}</div>
          <div>
            <b>{title}</b>
          </div>
        </div>
        {recover && phase.email && (
          <>
            <p className="helper" style={{ marginTop: 14 }}>
              If you did not change your email, someone else may have. Reset your password now.
            </p>
            {resetSent === 'sent' ? (
              <p className="helper" role="status">
                A reset link is on its way. Check your inbox.
              </p>
            ) : (
              <div className="secactions" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="btn grad block"
                  disabled={busy}
                  onClick={() => void handleSendReset(phase.email as string)}
                >
                  {busy ? <BusyLabel>Sending…</BusyLabel> : 'Send me a password reset link'}
                </button>
                {resetSent === 'failed' && (
                  <span className="vmsg">We couldn't send the reset link. Try again in a moment.</span>
                )}
              </div>
            )}
          </>
        )}
        <SignInLinks continueUrl={link.continueUrl} label="Go to sign in" />
      </section>
    );
  }

  return (
    <section className="glass card d1">
      <div className="sechead">
        <h1>
          {recover ? 'Restore your sign-in email' : change ? 'Confirm your new sign-in email' : 'Confirm your email address'}
        </h1>
        {phase.email && (
          <p>
            {recover ? 'Change it back to ' : 'For '}
            <strong className="secaccount">{phase.email}</strong>
          </p>
        )}
      </div>
      <div className="secactions" style={{ marginTop: 18 }}>
        <button type="button" className="btn grad block" disabled={busy} onClick={() => void handleApply()}>
          {busy ? (
            <BusyLabel>Saving…</BusyLabel>
          ) : recover ? (
            'Restore my sign-in email'
          ) : (
            'Confirm this email address'
          )}
        </button>
        {serverError && <span className="vmsg">{serverError}</span>}
      </div>
    </section>
  );
}
