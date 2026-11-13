// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirebaseError } from 'firebase/app';

/**
 * #1846: Enter inside Email or Password did nothing. The primary control was a
 * `type="button"`, so the form had two text inputs and no submit button and the
 * browser never implicit-submitted. These tests press the real key (userEvent
 * follows the HTML implicit-submission rule; fireEvent.submit would not).
 */

const { useAuth, signIn, signOutSilent, sendReset } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  signIn: vi.fn(),
  signOutSilent: vi.fn().mockResolvedValue(undefined),
  sendReset: vi.fn().mockResolvedValue(undefined),
}));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
const { resolveAccess } = vi.hoisted(() => ({ resolveAccess: vi.fn() }));

vi.mock('../lib/auth', () => ({ useAuth, signIn, signOutSilent, sendReset }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
  useRouter: () => ({ history: { push: vi.fn() } }),
}));
vi.mock('../lib/access', () => ({ resolveAccess }));
vi.mock('../lib/firebase', () => ({ auth: { name: 'test-auth' }, getAppCheckStatus: () => 'inactive' }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

import { SignIn } from './SignIn';

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ status: 'signedOut' });
  signOutSilent.mockResolvedValue(undefined);
  resolveAccess.mockResolvedValue({ status: 'admin' });
});

describe('SignIn, Enter inside a field (#1846)', () => {
  it('the primary control is the form submit button', () => {
    render(<SignIn />);
    expect(screen.getByRole('button', { name: 'Jump back in!' })).toHaveAttribute('type', 'submit');
    // The reveal toggle and the reset link must not submit.
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveAttribute('type', 'button');
  });

  it('happy: Enter in Password signs in exactly once', async () => {
    signIn.mockResolvedValue({ uid: 'admin-1' });
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com');
    await user.type(screen.getByLabelText('Password'), 'hunter22{Enter}');
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith('e2e-admin@tribetails.com', 'hunter22');
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('happy: Enter in Email with both fields filled signs in', async () => {
    signIn.mockResolvedValue({ uid: 'admin-1' });
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com{Enter}');
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it('a click on the button signs in once, not twice', async () => {
    signIn.mockResolvedValue({ uid: 'admin-1' });
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com');
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Jump back in!' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it('negative: Enter in empty Email names both fields, does not submit, and focuses Email', async () => {
    const user = userEvent.setup();
    render(<SignIn />);
    await user.click(screen.getByLabelText('Email'));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Enter your email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('negative: Enter in empty Password with an email names only the password and focuses it', async () => {
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com');
    await user.click(screen.getByLabelText('Password'));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Enter your password.')).toBeInTheDocument();
    expect(screen.queryByText('Enter your email.')).not.toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('sad: a wrong password shows the error and leaves the typed email in place', async () => {
    signIn.mockRejectedValue(new FirebaseError('auth/invalid-credential', 'bad'));
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com');
    await user.type(screen.getByLabelText('Password'), 'wrong{Enter}');
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('e2e-admin@tribetails.com');
    // The form is usable again: the button is not stuck busy.
    expect(screen.getByRole('button', { name: 'Jump back in!' })).toBeEnabled();
  });

  it('error: a network failure is named and the form recovers', async () => {
    signIn.mockRejectedValue(new FirebaseError('auth/network-request-failed', 'net'));
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com');
    await user.type(screen.getByLabelText('Password'), 'hunter22{Enter}');
    expect(await screen.findByText('Network error. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump back in!' })).toBeEnabled();
  });

  it('wait: while signing in the control shows the busy indicator and a second Enter does not resubmit', async () => {
    let finish: (v: unknown) => void = () => {};
    signIn.mockReturnValue(new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email'), 'e2e-admin@tribetails.com');
    await user.type(screen.getByLabelText('Password'), 'hunter22{Enter}');
    const btn = await screen.findByRole('button', { name: 'Signing in...' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(signIn).toHaveBeenCalledTimes(1);
    finish({ uid: 'admin-1' });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });
});
