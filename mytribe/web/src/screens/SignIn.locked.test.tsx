// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * #886: when `beforeSignIn` refuses a locked account, the portal sign-in screen
 * says the account is locked and keeps the way out in view, instead of the
 * generic "Something went wrong on our end".
 */

const { signIn, sendReset } = vi.hoisted(() => ({ signIn: vi.fn(), sendReset: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/auth', () => ({ signIn, sendReset }));

import { SignIn } from './SignIn';
import { ACCOUNT_LOCKED_MESSAGE } from '../lib/authErrors';

const LOCKED = Object.assign(
  new Error(
    'Firebase: ((HTTP request to https://example.test/beforeSignIn returned HTTP error 403: {"error":{"message":"This account is locked. Use the reset password link or contact support.","status":"PERMISSION_DENIED"}})) (auth/internal-error).',
  ),
  { code: 'auth/internal-error' },
);

function submit(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('#886 portal SignIn locked state', () => {
  it('shows the locked message with the Forgot password? link beside it', async () => {
    signIn.mockRejectedValue(LOCKED);
    render(<SignIn />);
    submit('pat@household.test', 'right-password');

    expect(await screen.findByRole('alert')).toHaveTextContent(ACCOUNT_LOCKED_MESSAGE);
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    const reset = screen.getByText('Forgot password?');
    expect(reset).toBeVisible();

    // The link works from the locked state: it sends the reset to the typed email.
    sendReset.mockResolvedValue(undefined);
    fireEvent.click(reset);
    expect(await screen.findByText('Reset link sent. Check your inbox.')).toBeInTheDocument();
    expect(sendReset).toHaveBeenCalledWith('pat@household.test');
  });

  it('a wrong password still shows the same credentials message as before', async () => {
    signIn.mockRejectedValue(Object.assign(new Error('Firebase: Error (auth/invalid-credential).'), { code: 'auth/invalid-credential' }));
    render(<SignIn />);
    submit('pat@household.test', 'guess');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password did not match. Check for typos and try again.',
    );
  });
});
