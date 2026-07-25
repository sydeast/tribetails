import { useState } from 'react';
import { AccountSecurityError, changeEmail, changePassword, sendReset } from '../lib/auth';
import { DenPanel } from './DenScreenKit';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './SecurityPanel.css';

interface SecurityPanelProps {
  /** The signed-in operator's current login email. Blank when Auth has none. */
  email: string;
}

/**
 * Account > Security: change the login email, change the password, or mail
 * yourself a reset link. Ported from Android's `SecurityPanel` in
 * AdminSettingsScreen.kt, which the Account screen there already hosts; the
 * field set, the button labels, and the error copy are deliberately the same
 * sentences on both surfaces.
 *
 * All three flows are Firebase Auth client-side. No callable exists for any of
 * them and none is needed: `reauthenticateWithCredential` proves ownership,
 * `updatePassword` and `verifyBeforeUpdateEmail` do the work, and lib/auth.ts
 * turns every failure into a typed AccountSecurityError whose message is
 * already operator-facing.
 *
 * The email flow says "we sent a link", never "your email changed", because
 * that is what verifyBeforeUpdateEmail actually does: the address flips only
 * after the operator opens the link in the NEW inbox. Reporting it as done
 * would leave someone thinking they had moved their login when they had not.
 */
export function SecurityPanel({ email }: SecurityPanelProps) {
  return (
    <DenPanel title="Security" subtitle="Your login email and password.">
      <div className="security__stack">
        <EmailSection email={email} />
        <PasswordSection />
        <ResetSection email={email} />
      </div>
    </DenPanel>
  );
}

/** Enough of an address to be worth a round-trip. Firebase does the real check. */
function isPlausibleEmail(value: string): boolean {
  const v = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Turns anything thrown into copy. Typed errors already carry theirs. */
function failureMessage(err: unknown): string {
  if (err instanceof AccountSecurityError) return err.message;
  return err instanceof Error && err.message.trim() !== ''
    ? err.message
    : "Couldn't complete that change.";
}

interface OutcomeProps {
  errorTitle: string;
  error: string | null;
  success: React.ReactNode | null;
}

/** One banner slot per section: an error or a confirmation, never both. */
function Outcome({ errorTitle, error, success }: OutcomeProps) {
  if (error !== null) {
    return (
      <Banner tone="error" title={errorTitle}>
        {error}
      </Banner>
    );
  }
  // No title on the success banner: the sentence IS the message, and a generic
  // "Done" header above "Password updated." only adds a word to read.
  if (success !== null) {
    return <Banner tone="success">{success}</Banner>;
  }
  return null;
}

// ── login email ─────────────────────────────────────────────────────────────

function EmailSection({ email }: SecurityPanelProps) {
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const target = newEmail.trim();
  const ready = !busy && isPlausibleEmail(target) && password !== '';

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setSentTo(null);
    try {
      await changeEmail(password, target);
      setSentTo(target);
      setNewEmail('');
      setPassword('');
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="security__section" disabled={busy}>
      <legend className="security__legend">Login email</legend>
      <p className="security__hint">
        Signed in as {email === '' ? '(no address on file)' : email}. This is your account
        login, not your business contact email.
      </p>

      <Outcome
        errorTitle="Couldn't send that verification link"
        error={error}
        success={
          sentTo === null ? null : (
            <>
              Verification link sent to {sentTo}. Your login email changes only after you open
              that link and confirm it, so nothing has changed yet.
            </>
          )
        }
      />

      <div className="security__field">
        <label className="security__label" htmlFor="security-new-email">
          New login email
        </label>
        <input
          id="security-new-email"
          type="email"
          autoComplete="email"
          className="security__input"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
      </div>

      <div className="security__field">
        <label className="security__label" htmlFor="security-email-password">
          Current password
        </label>
        <input
          id="security-email-password"
          type="password"
          autoComplete="current-password"
          className="security__input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <PrimaryButton
        label={busy ? 'Sending…' : 'Send verification link'}
        onClick={() => void submit()}
        disabled={!ready}
        busy={busy}
      />
    </fieldset>
  );
}

// ── password ────────────────────────────────────────────────────────────────

const MIN_PASSWORD_LENGTH = 6;

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Only once there is something to compare, so the field does not scold the
  // operator mid-word on the first keystroke of the confirm box.
  const mismatch = next !== '' && confirm !== '' && next !== confirm;
  const ready =
    !busy && current !== '' && next.length >= MIN_PASSWORD_LENGTH && next === confirm;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="security__section" disabled={busy}>
      <legend className="security__legend">Change password</legend>

      <Outcome
        errorTitle="Couldn't change your password"
        error={error}
        success={done ? 'Password updated.' : null}
      />

      <div className="security__field">
        <label className="security__label" htmlFor="security-current-password">
          Current password
        </label>
        <input
          id="security-current-password"
          type="password"
          autoComplete="current-password"
          className="security__input"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>

      <div className="security__field">
        <label className="security__label" htmlFor="security-new-password">
          New password
        </label>
        <input
          id="security-new-password"
          type="password"
          autoComplete="new-password"
          className="security__input"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </div>

      <div className="security__field">
        <label className="security__label" htmlFor="security-confirm-password">
          Confirm new password
        </label>
        <input
          id="security-confirm-password"
          type="password"
          autoComplete="new-password"
          className="security__input"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch}
          aria-describedby={mismatch ? 'security-confirm-error' : undefined}
        />
        {mismatch && (
          <span id="security-confirm-error" className="security__error" role="alert">
            New passwords don&apos;t match.
          </span>
        )}
      </div>

      <PrimaryButton
        label={busy ? 'Updating…' : 'Update password'}
        onClick={() => void submit()}
        disabled={!ready}
        busy={busy}
      />
    </fieldset>
  );
}

// ── reset email ─────────────────────────────────────────────────────────────

function ResetSection({ email }: SecurityPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const ready = !busy && isPlausibleEmail(email);

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      await sendReset(email);
      setSent(true);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="security__section">
      <p className="security__hint">Forgot your password?</p>

      <Outcome
        errorTitle="Couldn't send the reset email"
        error={error}
        success={sent ? `Password reset email sent to ${email}. Check your inbox.` : null}
      />

      <GhostButton
        label={busy ? 'Sending…' : 'Send reset email'}
        onClick={() => void submit()}
        disabled={!ready}
      />
    </div>
  );
}
