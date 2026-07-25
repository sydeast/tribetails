// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { changeEmail, changePassword, sendReset, AccountSecurityError } = vi.hoisted(() => {
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
    changePassword: vi.fn(),
    sendReset: vi.fn(),
    AccountSecurityError,
  };
});

vi.mock('../lib/auth', () => ({ changeEmail, changePassword, sendReset, AccountSecurityError }));

import { SecurityPanel } from './SecurityPanel';

function emailGroup() {
  return within(screen.getByRole('group', { name: /login email/i }));
}
function passwordGroup() {
  return within(screen.getByRole('group', { name: /change password/i }));
}

beforeEach(() => {
  changeEmail.mockReset();
  changeEmail.mockResolvedValue(undefined);
  changePassword.mockReset();
  changePassword.mockResolvedValue(undefined);
  sendReset.mockReset();
  sendReset.mockResolvedValue(undefined);
});

describe('SecurityPanel: change password', () => {
  it('keeps Update password disabled until current, new and matching confirm are all filled', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    const button = g.getByRole('button', { name: 'Update password' });
    expect(button).toBeDisabled();

    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    expect(button).toBeDisabled();

    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    expect(button).toBeEnabled();
  });

  it('warns inline on a confirm mismatch instead of letting the operator submit it', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-2');

    expect(g.getByText("New passwords don't match.")).toBeInTheDocument();
    expect(g.getByRole('button', { name: 'Update password' })).toBeDisabled();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('calls changePassword with current then next, and confirms in a banner', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    expect(changePassword).toHaveBeenCalledWith('old-secret', 'new-secret-1');
    expect(await screen.findByText('Password updated.')).toBeInTheDocument();
  });

  it('clears the password fields after a successful change, so nothing lingers on screen', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    await screen.findByText('Password updated.');
    expect(g.getByLabelText('Current password')).toHaveValue('');
    expect(g.getByLabelText('New password')).toHaveValue('');
    expect(g.getByLabelText('Confirm new password')).toHaveValue('');
  });

  it('surfaces a wrong current password fail-loud, and keeps no success banner', async () => {
    changePassword.mockRejectedValueOnce(
      new AccountSecurityError('wrong-password', 'Current password is incorrect.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'wrong');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    expect(screen.queryByText('Password updated.')).toBeNull();
  });

  it('surfaces a weak-password rejection', async () => {
    changePassword.mockRejectedValueOnce(
      new AccountSecurityError('weak-password', 'Choose a stronger password (at least 6 characters).'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/stronger password/i)).toBeInTheDocument();
  });

  it('surfaces requires-recent-login', async () => {
    changePassword.mockRejectedValueOnce(
      new AccountSecurityError('requires-recent-login', 'Please sign in again, then retry this change.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/sign in again/i)).toBeInTheDocument();
  });

  it('surfaces a network failure rather than failing silently', async () => {
    changePassword.mockRejectedValueOnce(
      new AccountSecurityError('network-error', 'Network error. Check your connection and try again.'),
    );
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/check your connection/i)).toBeInTheDocument();
  });

  it('surfaces a non-typed throw too, so nothing can fall through silently', async () => {
    changePassword.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    const g = passwordGroup();
    await user.type(g.getByLabelText('Current password'), 'old-secret');
    await user.type(g.getByLabelText('New password'), 'new-secret-1');
    await user.type(g.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(g.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });
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

describe('SecurityPanel: password reset email', () => {
  it('sends the reset mail to the signed-in address', async () => {
    const user = userEvent.setup();
    render(<SecurityPanel email="auntie@tribetails.com" />);
    await user.click(screen.getByRole('button', { name: 'Send reset email' }));

    expect(sendReset).toHaveBeenCalledWith('auntie@tribetails.com');
    expect(await screen.findByText(/reset email sent to auntie@tribetails\.com/i)).toBeInTheDocument();
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

  it('cannot send a reset for an account with no address on file', () => {
    render(<SecurityPanel email="" />);
    expect(screen.getByRole('button', { name: 'Send reset email' })).toBeDisabled();
  });
});
