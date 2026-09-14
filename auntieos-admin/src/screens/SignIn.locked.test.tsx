// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * #886: when `beforeSignIn` refuses a locked account, the admin sign-in screen
 * says so and keeps "Forgot password?" in view, instead of painting the SDK's
 * raw internal-error text.
 */

const { useAuth, signIn, signOutSilent, sendReset } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  signIn: vi.fn(),
  signOutSilent: vi.fn().mockResolvedValue(undefined),
  sendReset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/auth', () => ({ useAuth, signIn, signOutSilent, sendReset }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/access', () => ({ resolveAccess: vi.fn() }));
vi.mock('../lib/firebase', () => ({ auth: { name: 'test-auth' }, getAppCheckStatus: vi.fn(() => 'inactive') }));
vi.mock('../lib/fns', () => ({ call: vi.fn() }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

import { FirebaseError } from 'firebase/app';
import { SignIn } from './SignIn';
import { ACCOUNT_LOCKED_MSG } from '../lib/failedLogin';

function submit(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Jump back in!' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  useAuth.mockReturnValue({ status: 'signedOut' });
  sendReset.mockResolvedValue(undefined);
});

describe('#886 admin SignIn locked state', () => {
  it('shows the locked message and a usable Forgot password? control', async () => {
    signIn.mockRejectedValue(
      new FirebaseError(
        'auth/internal-error',
        'Firebase: ((HTTP request to https://example.test/beforeSignIn returned HTTP error 403: {"error":{"message":"This account is locked. Use the reset password link or contact support.","status":"PERMISSION_DENIED"}})) (auth/internal-error).',
      ),
    );
    render(<SignIn />);
    submit('auntie@tribetails.test', 'right-password');

    expect(await screen.findByRole('alert')).toHaveTextContent(ACCOUNT_LOCKED_MSG);
    expect(screen.queryByText(/HTTP request to/)).toBeNull();

    const forgot = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgot).toBeVisible();
    expect(forgot).toBeEnabled();
    fireEvent.click(forgot);
    expect(await screen.findByText('Reset link sent. Check your inbox.')).toBeInTheDocument();
    expect(sendReset).toHaveBeenCalledWith('auntie@tribetails.test');
  });

  it('a wrong password still reads "Email or password is incorrect."', async () => {
    signIn.mockRejectedValue(new FirebaseError('auth/invalid-credential', 'Firebase: Error (auth/invalid-credential).'));
    render(<SignIn />);
    submit('auntie@tribetails.test', 'guess');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });
});
