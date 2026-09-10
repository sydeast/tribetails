// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { changeEmail, sendReset, signOut, AccountSecurityError } = vi.hoisted(() => {
  class AccountSecurityError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AccountSecurityError';
      this.code = code;
    }
  }
  return {
    changeEmail: vi.fn(),
    sendReset: vi.fn(),
    signOut: vi.fn(),
    AccountSecurityError,
  };
});

vi.mock('../lib/auth', () => ({ changeEmail, sendReset, signOut, AccountSecurityError }));

import { SecurityPanel } from './SecurityPanel';

function emailGroup() {
  return within(screen.getByRole('group', { name: /login email/i }));
}

beforeEach(() => {
  changeEmail.mockReset();
  changeEmail.mockResolvedValue(undefined);
  sendReset.mockReset();
  sendReset.mockResolvedValue(undefined);
  signOut.mockReset();
  signOut.mockResolvedValue(undefined);
});

describe('SecurityPanel: change login email', () => {
  it('keeps the send button disabled until a plausible address and the current password are present', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = emailGroup();
    const button = g.getByRole('button', { name: 'Send verification link' });
    expect(button).toBeDisabled();

    await user.type(g.getByLabelText('New login email'), 'not-an-email');
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    expect(button).toBeDisabled();

    await user.clear(g.getByLabelText('New login email'));
    await user.type(g.getByLabelText('New login email'), 'new@tribetails.com');
    expect(button).toBeEnabled();
  });

  it('calls changeEmail and says plainly that nothing has changed yet', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = emailGroup();
    await user.type(g.getByLabelText('New login email'), 'new@tribetails.com');
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.click(g.getByRole('button', { name: 'Send verification link' }));

    expect(changeEmail).toHaveBeenCalledWith('old-secret', 'new@tribetails.com');
    const banner = await screen.findByText(/verification link sent to new@tribetails\.com/i);
    expect(banner).toBeInTheDocument();
    // The whole point of verifyBeforeUpdateEmail: the address has NOT changed yet.
    expect(screen.getByText(/only after you open that link/i)).toBeInTheDocument();
  });

  it('never claims success when the address is already in use', async () => {
    changeEmail.mockRejectedValueOnce(
      new AccountSecurityError('email-already-in-use', 'That email is already in use.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = emailGroup();
    await user.type(g.getByLabelText('New login email'), 'taken@tribetails.com');
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.click(g.getByRole('button', { name: 'Send verification link' }));

    expect(await screen.findByText('That email is already in use.')).toBeInTheDocument();
    expect(screen.queryByText(/verification link sent/i)).toBeNull();
  });

  it('surfaces a wrong current password on the email flow too', async () => {
    changeEmail.mockRejectedValueOnce(
      new AccountSecurityError('wrong-password', 'Current password is incorrect.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = emailGroup();
    await user.type(g.getByLabelText('New login email'), 'new@tribetails.com');
    await user.type(g.getByLabelText('Current password'), 'wrong');
    await user.click(g.getByRole('button', { name: 'Send verification link' }));

    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
  });

  it('surfaces a network failure on the email flow', async () => {
    changeEmail.mockRejectedValueOnce(
      new AccountSecurityError('network-error', 'Network error. Check your connection and try again.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = emailGroup();
    await user.type(g.getByLabelText('New login email'), 'new@tribetails.com');
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.click(g.getByRole('button', { name: 'Send verification link' }));

    expect(await screen.findByText(/check your connection/i)).toBeInTheDocument();
  });

  it('shows the current login address so the operator knows which account they are editing', () => {
    render(<SecurityPanel email="auntie@tribetails.com" />);
    expect(emailGroup().getByText(/auntie@tribetails\.com/)).toBeInTheDocument();
  });
});

describe('SecurityPanel: password reset email (the mock\'s "Change password" row)', () => {
  it('offers a reset row instead of a typed current/new/confirm form', () => {
    render(<SecurityPanel email="auntie@tribetails.com" />);
    expect(screen.getByText('Change password')).toBeInTheDocument();
    expect(
      screen.getByText('A password reset link goes to auntie@tribetails.com.'),
    ).toBeInTheDocument();
    // The three password boxes are gone; the reset link is the whole flow.
    expect(screen.queryByLabelText('New password')).toBeNull();
    expect(screen.queryByLabelText('Confirm new password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update password' })).toBeNull();
  });
  it('sends the reset mail to the signed-in address', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    await user.click(screen.getByRole('button', { name: 'Send reset email' }));

    expect(sendReset).toHaveBeenCalledWith('auntie@tribetails.com');
    expect(
      await screen.findByText(/reset link sent to auntie@tribetails\.com/i),
    ).toBeInTheDocument();
  });

  it('surfaces a reset failure fail-loud', async () => {
    sendReset.mockRejectedValueOnce(
      new AccountSecurityError('too-many-requests', 'Too many attempts. Wait a minute and try again.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    await user.click(screen.getByRole('button', { name: 'Send reset email' }));

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });

  it('cannot send a reset for an account with no address on file, and says why', () => {
    render(<SecurityPanel email="" />);
    expect(screen.getByRole('button', { name: 'Send reset email' })).toBeDisabled();
    expect(
      screen.getByText('No login email is on file, so there is nowhere to send a reset link.'),
    ).toBeInTheDocument();
  });
});
describe('SecurityPanel: sign out row', () => {
  it('signs the operator out of this device', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    expect(screen.getByText('End this session on this device.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
  it('says why when the sign out fails rather than looking like it worked', async () => {
    signOut.mockRejectedValueOnce(new Error('network down'));
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });
  it('does not build the mock\'s suggested "sign out all devices" action', () => {
    // The mock flags that card as "Suggestion, not in current model" and nothing
    // in this app revokes refresh tokens, so there is no button to press.
    render(<SecurityPanel email="auntie@tribetails.com" />);
    expect(screen.queryByRole('button', { name: /all devices/i })).toBeNull();
  });
});
describe('SecurityPanel: meta slot', () => {
  it('renders whatever Access and Activity block the Account screen hands it', () => {
    render(
      <SecurityPanel email="auntie@tribetails.com" meta={<p>Last sign-in: Jul 16, 2026, 12:00</p>} />,
    );
    expect(screen.getByText('Last sign-in: Jul 16, 2026, 12:00')).toBeInTheDocument();
  });
});
