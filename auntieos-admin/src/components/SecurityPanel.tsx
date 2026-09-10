import { useState } from 'react';
import { AccountSecurityError, changeEmail, sendReset, signOut } from '../lib/auth';
import { DenPanel } from './DenScreenKit';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './SecurityPanel.css';

interface SecurityPanelProps {
  /** The signed-in operator's current login email. Blank when Auth has none. */
  email: string;
  /** Rendered under the rows: the Access and Activity facts (see Account.tsx). */
  meta?: React.ReactNode;
}

/**
 * Account > Security: mail yourself a password reset link, end this session,
 * or move your login to a different address. Ported from Android's
 * `SecurityPanel` in AdminSettingsScreen.kt, which the Account screen there
 * already hosts; the button labels and the error copy are deliberately the
 * same sentences on both surfaces.
 *
 * ISSUE #719 reshaped this to the 2026-05-27 User profile mock: the mock draws
 * Security as two action ROWS, "Change password" (which sends a reset link, not
 * a form) and "Sign out". The typed current/new/confirm password form is gone
 * with them; a reset link is the flow the mock chose and the one that also
 * works for an operator who has forgotten the current password. `changePassword`
 * stays in lib/auth.ts with its own tests: nothing about the credential flow
 * broke, this screen just stopped asking for three password boxes.
 *
 * The login-email form below the rows is KEPT even though the mock does not
 * draw it. It exists, it works, and no other surface offers it, so deleting it
 * would take away the only way to move an admin login off a dead address.
 *
 * Every flow is Firebase Auth client-side. No callable exists for any of them
 * and none is needed: `reauthenticateWithCredential` proves ownership,
 * `verifyBeforeUpdateEmail` and `sendPasswordResetEmail` do the work, and
 * lib/auth.ts turns every failure into a typed AccountSecurityError whose
 * message is already operator-facing.
 *
 * The email flow says "we sent a link", never "your email changed", because
 * that is what verifyBeforeUpdateEmail actually does: the address flips only
 * after the operator opens the link in the NEW inbox. Reporting it as done
 * would leave someone thinking they had moved their login when they had not.
 */
export function SecurityPanel({ email, meta }: SecurityPanelProps) {
  return (
    <DenPanel title="Security" subtitle="Your password, this session, and the address you sign in with.">
      <div className="security__rows">
        <ResetRow email={email} />
        <SignOutRow />
      </div>
      <div className="security__stack">
        <EmailSection email={email} />
      </div>
      {meta}
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

// ── action rows (the mock's two Security rows) ──────────────────────
interface SecurityRowProps {
  title: string;
  detail: React.ReactNode;
  outcome: React.ReactNode;
  action: React.ReactNode;
}
/** One "what it does / here is the button" row. The mock's `.secrow`. */
function SecurityRow({ title, detail, outcome, action }: SecurityRowProps) {
  return (
    <div className="security__row">
      <div className="security__rowText">
        <b className="security__rowTitle">{title}</b>
        <small className="security__rowDetail">{detail}</small>
        {outcome}
      </div>
      <div className="security__rowAction">{action}</div>
    </div>
  );
}
/**
 * "Change password" in the mock's words: a reset link to the account email,
 * not a form. Disabled when Auth holds no usable address, because there is
 * nowhere to send the link and a button that cannot work should say so.
 */
function ResetRow({ email }: { email: string }) {
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
    <SecurityRow
      title="Change password"
      detail={
        isPlausibleEmail(email)
          ? `A password reset link goes to ${email}.`
          : 'No login email is on file, so there is nowhere to send a reset link.'
      }
      outcome={
        <Outcome
          errorTitle="Couldn't send the reset email"
          error={error}
          success={sent ? `Reset link sent to ${email}. Check your inbox.` : null}
        />
      }
      action={
        <GhostButton
          label={busy ? 'Sending…' : 'Send reset email'}
          onClick={() => void submit()}
          disabled={!ready}
        />
      }
    />
  );
}
/**
 * Ends THIS session on THIS device, the same `signOut` the topbar chip calls.
 * The mock's suggestion card for revoking every other device is deliberately
 * not built here: nothing in this app revokes refresh tokens today, and a
 * button that only looks like it would is worse than no button.
 */
function SignOutRow() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signOut();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SecurityRow
      title="Sign out"
      detail="End this session on this device."
      outcome={<Outcome errorTitle="Couldn't sign you out" error={error} success={null} />}
      action={
        <GhostButton
          label={busy ? 'Signing out…' : 'Sign out'}
          onClick={() => void submit()}
          disabled={busy}
        />
      }
    />
  );
}
