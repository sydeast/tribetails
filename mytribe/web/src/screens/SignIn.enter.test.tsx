// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * #1846, the portal's half. The admin sign-in did nothing on Enter because its
 * only button was not a submit button; the portal's is, but every existing test
 * here used `fireEvent.submit`, which cannot tell. These press the real key
 * (userEvent follows the HTML implicit-submission rule) and pin that a second
 * Enter while a sign-in is running sends nothing.
 */

const { navigate, push, signIn } = vi.hoisted(() => ({
  navigate: vi.fn(),
  push: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
  useRouter: () => ({ history: { push } }),
}));
vi.mock('../lib/auth', () => ({ signIn, sendReset: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  doc: () => ({ path: 'business_public/card' }),
  getDoc: () => Promise.resolve({ exists: () => false, data: () => undefined }),
}));
vi.mock('../lib/firebase', () => ({ firestore: { name: 'test-firestore' } }));

import { SignIn } from './SignIn';

const authError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('SignIn, Enter inside a field (#1846)', () => {
  it('the Sign In control is the form submit button and the reveal toggle is not', () => {
    render(<SignIn />);
    expect(screen.getByRole('button', { name: 'Sign In' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('type', 'button');
  });

  it('happy: Enter in Password signs in exactly once and goes Home', async () => {
    signIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email Address'), 'pawsome@hanasamku.com');
    await user.type(screen.getByLabelText('Password'), 'pw-not-real{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/home' }));
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith('pawsome@hanasamku.com', 'pw-not-real');
  });

  it('happy: Enter in Email with both fields filled signs in', async () => {
    signIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Password'), 'pw-not-real');
    await user.type(screen.getByLabelText('Email Address'), 'pawsome@hanasamku.com{Enter}');
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it('negative: Enter with an empty password says so and sends nothing', async () => {
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email Address'), 'pawsome@hanasamku.com{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email and password are required.');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('sad: a wrong password shows the error and the form is usable again', async () => {
    signIn.mockRejectedValue(authError('auth/invalid-credential'));
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email Address'), 'pawsome@hanasamku.com');
    await user.type(screen.getByLabelText('Password'), 'wrong{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password did not match.');
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('error: a network failure is shown and the form recovers', async () => {
    signIn.mockRejectedValue(authError('auth/network-request-failed'));
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email Address'), 'pawsome@hanasamku.com');
    await user.type(screen.getByLabelText('Password'), 'pw-not-real{Enter}');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('wait: while signing in the button shows it and a second Enter sends nothing more', async () => {
    let finish: () => void = () => {};
    signIn.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const user = userEvent.setup();
    render(<SignIn />);
    await user.type(screen.getByLabelText('Email Address'), 'pawsome@hanasamku.com');
    await user.type(screen.getByLabelText('Password'), 'pw-not-real{Enter}');
    const busy = await screen.findByRole('button', { name: /Signing in/ });
    expect(busy).toBeDisabled();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(signIn).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });
});
