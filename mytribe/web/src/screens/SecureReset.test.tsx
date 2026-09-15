// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * #892: the page Firebase's email action URL points at.
 *
 * Every reset link from admin web, admin Android, admin desktop and portal web
 * used to show "This link is incomplete", because the page demanded an `email`
 * param that no Firebase link carries, and every link that did get through went
 * straight to the "secure my account" flow, which files a security incident.
 */

const mocks = vi.hoisted(() => ({
  completeReset: vi.fn(),
  readActionCode: vi.fn(),
  applyEmailAction: vi.fn(),
  sendReset: vi.fn(),
  confirmSecureReset: vi.fn(),
}));

vi.mock('../lib/auth', () => ({
  completeReset: mocks.completeReset,
  readActionCode: mocks.readActionCode,
  applyEmailAction: mocks.applyEmailAction,
  sendReset: mocks.sendReset,
}));
vi.mock('../api/portal', () => ({ confirmSecureReset: mocks.confirmSecureReset }));

import { SecureReset } from './SecureReset';

function authError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Firebase: Error (${code}).`), { code });
}

function openLink(search: string, path = '/account/secure-reset') {
  window.history.replaceState(null, '', `${path}${search}`);
  return render(<SecureReset />);
}

function typePasswords(pw: string, confirm = pw) {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
}

const NATIVE = '?mode=resetPassword&oobCode=CODE-1&apiKey=AIzaFake&lang=en';

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.readActionCode.mockResolvedValue({ operation: 'PASSWORD_RESET', email: 'pepper@example.com', previousEmail: null });
  mocks.completeReset.mockResolvedValue(undefined);
  mocks.sendReset.mockResolvedValue(undefined);
  mocks.applyEmailAction.mockResolvedValue(undefined);
  mocks.confirmSecureReset.mockResolvedValue({ ok: true, incidentId: 'inc-1' });
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('SecureReset: a normal requested reset', () => {
  it('handles the native Firebase link: verifies the code, shows the account, sets the password, files no incident', async () => {
    openLink(NATIVE);

    expect(await screen.findByText('pepper@example.com')).toBeInTheDocument();
    expect(mocks.readActionCode).toHaveBeenCalledWith('CODE-1');
    expect(screen.queryByText(/incomplete/i)).toBeNull();

    typePasswords('new-password-1');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Your password is updated.')).toBeInTheDocument();
    expect(mocks.completeReset).toHaveBeenCalledWith('CODE-1', 'new-password-1');
    expect(mocks.confirmSecureReset).not.toHaveBeenCalled();
    // A bare link cannot say whose account it is (#892 review), so both sign-ins.
    expect(screen.getByRole('link', { name: 'Household sign-in' })).toHaveAttribute('href', '/signin');
    expect(screen.getByRole('link', { name: 'Staff sign-in' })).toHaveAttribute(
      'href',
      'https://auntie.tribetails.com/signin',
    );
    expect(screen.queryByRole('link', { name: 'Sign in with your new password' })).toBeNull();
  });

  it('a bare expired link asks for a bare new link, so the next page still offers both sign-ins (#892 review)', async () => {
    mocks.readActionCode.mockRejectedValue(authError('auth/expired-action-code'));
    openLink(NATIVE);
    await screen.findByText('This reset link has expired.');
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ops@tribetails.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send a new link' }));
    await screen.findByText(/new link is on its way/i);
    expect(mocks.sendReset).toHaveBeenCalledWith('ops@tribetails.com', null);
  });

  it('handles the requestPasswordReset link: the account comes from the code, not the email in continueUrl', async () => {
    const continueUrl = encodeURIComponent('https://kinfolk.tribetails.com/account/secure-reset?email=spoofed@example.com');
    openLink(`?mode=resetPassword&oobCode=CODE-2&apiKey=AIzaFake&continueUrl=${continueUrl}&lang=en`);

    expect(await screen.findByText('pepper@example.com')).toBeInTheDocument();
    expect(screen.queryByText('spoofed@example.com')).toBeNull();

    typePasswords('new-password-2');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByText('Your password is updated.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in with your new password' })).toHaveAttribute(
      'href',
      'https://kinfolk.tribetails.com/signin',
    );
  });

  it('sends staff back to the admin sign-in and never tells them to contact Tribe Tails', async () => {
    const continueUrl = encodeURIComponent('https://auntie.tribetails.com/signin');
    const { container } = openLink(`?mode=resetPassword&oobCode=CODE-3&continueUrl=${continueUrl}`);

    await screen.findByText('pepper@example.com');
    expect(container.textContent).not.toMatch(/contact Tribe Tails/i);
    typePasswords('new-password-3');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    await screen.findByText('Your password is updated.');
    expect(container.textContent).not.toMatch(/contact Tribe Tails/i);
    expect(screen.getByRole('link', { name: 'Sign in with your new password' })).toHaveAttribute(
      'href',
      'https://auntie.tribetails.com/signin',
    );
  });

  it('uses the existing password rules before calling Firebase', async () => {
    openLink(NATIVE);
    await screen.findByText('pepper@example.com');

    typePasswords('short');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('Password needs at least 8 characters.')).toBeInTheDocument();

    typePasswords('long-enough-1', 'long-enough-2');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
    expect(mocks.completeReset).not.toHaveBeenCalled();
  });

  it('tells the reader when Firebase refuses the new password as too weak', async () => {
    mocks.completeReset.mockRejectedValue(authError('auth/weak-password'));
    openLink(NATIVE);
    await screen.findByText('pepper@example.com');
    typePasswords('password');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/choose a stronger password/i)).toBeInTheDocument();
  });
});

describe('SecureReset: a code that cannot be used', () => {
  it('says an expired link has expired and offers a new one, keeping the continue target', async () => {
    mocks.readActionCode.mockRejectedValue(authError('auth/expired-action-code'));
    const continueUrl = encodeURIComponent('https://auntie.tribetails.com/signin');
    openLink(`?mode=resetPassword&oobCode=OLD&continueUrl=${continueUrl}`);

    expect(await screen.findByText('This reset link has expired.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: ' pepper@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send a new link' }));

    expect(await screen.findByText(/new link is on its way/i)).toBeInTheDocument();
    expect(mocks.sendReset).toHaveBeenCalledWith('pepper@example.com', 'https://auntie.tribetails.com/signin');
  });

  it('says a used or invalid link cannot be used again', async () => {
    mocks.readActionCode.mockRejectedValue(authError('auth/invalid-action-code'));
    openLink(NATIVE);
    expect(await screen.findByText('This reset link has already been used or is not valid.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeInTheDocument();
  });

  it('moves to the expired state when the code runs out between opening the page and submitting', async () => {
    mocks.completeReset.mockRejectedValue(authError('auth/expired-action-code'));
    openLink(NATIVE);
    await screen.findByText('pepper@example.com');
    typePasswords('new-password-1');
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('This reset link has expired.')).toBeInTheDocument();
  });

  it('lets the reader retry when the check fails on the network, without calling the link bad', async () => {
    mocks.readActionCode.mockRejectedValueOnce(authError('auth/network-request-failed'));
    openLink(NATIVE);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('pepper@example.com')).toBeInTheDocument();
    expect(mocks.readActionCode).toHaveBeenCalledTimes(2);
  });

  it.each(['VERIFY_EMAIL', 'RECOVER_EMAIL', 'VERIFY_AND_CHANGE_EMAIL'])(
    'refuses a mode=resetPassword link whose code is really %s, with no form (#892 review 2)',
    async (operation) => {
      mocks.readActionCode.mockResolvedValue({ operation, email: 'pepper@example.com', previousEmail: null });
      openLink(NATIVE);
      expect(await screen.findByText("This link can't be completed here.")).toBeInTheDocument();
      expect(screen.queryByLabelText('New password')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      expect(mocks.completeReset).not.toHaveBeenCalled();
    },
  );
});

describe('SecureReset: "I did not ask for this reset"', () => {
  it('is an explicit choice that secures the account with the oobCode only', async () => {
    openLink(NATIVE);
    await screen.findByText('pepper@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'I did not ask for this reset' }));
    expect(screen.getByText('Secure your account')).toBeInTheDocument();

    typePasswords('new-password-9');
    fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));

    expect(await screen.findByText('Your account is secured.')).toBeInTheDocument();
    expect(mocks.confirmSecureReset).toHaveBeenCalledTimes(1);
    const sent = mocks.confirmSecureReset.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toEqual({ oobCode: 'CODE-1', newPassword: 'new-password-9', userAgent: navigator.userAgent });
    expect(sent).not.toHaveProperty('email');
    expect(mocks.completeReset).not.toHaveBeenCalled();
  });

  it('can be backed out of, returning to the normal reset', async () => {
    openLink(NATIVE);
    await screen.findByText('pepper@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'I did not ask for this reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeInTheDocument();
  });

  it('shows the server error when securing fails', async () => {
    mocks.confirmSecureReset.mockRejectedValue(new Error('Could not secure your account. The reset link may have expired.'));
    openLink(NATIVE);
    await screen.findByText('pepper@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'I did not ask for this reset' }));
    typePasswords('new-password-9');
    fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));
    expect(await screen.findByText(/reset link may have expired/)).toBeInTheDocument();
  });
});

describe('SecureReset: the other Firebase email links', () => {
  it('confirms an email address on a verifyEmail link', async () => {
    mocks.readActionCode.mockResolvedValue({ operation: 'VERIFY_EMAIL', email: 'pepper@example.com', previousEmail: null });
    openLink('?mode=verifyEmail&oobCode=V-1&apiKey=AIzaFake&lang=en');

    fireEvent.click(await screen.findByRole('button', { name: 'Confirm this email address' }));
    expect(await screen.findByText('Your email address is confirmed.')).toBeInTheDocument();
    expect(mocks.applyEmailAction).toHaveBeenCalledWith('V-1');
  });

  it('confirms a new sign-in email on a verifyAndChangeEmail link', async () => {
    mocks.readActionCode.mockResolvedValue({
      operation: 'VERIFY_AND_CHANGE_EMAIL',
      email: 'new@example.com',
      previousEmail: 'old@example.com',
    });
    openLink('?mode=verifyAndChangeEmail&oobCode=V-2');

    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this email address' }));
    expect(await screen.findByText('Your sign-in email is now new@example.com.')).toBeInTheDocument();
  });

  it('restores the previous email on a recoverEmail link and offers a password reset', async () => {
    mocks.readActionCode.mockResolvedValue({
      operation: 'RECOVER_EMAIL',
      email: 'old@example.com',
      previousEmail: 'new@example.com',
    });
    openLink('?mode=recoverEmail&oobCode=R-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Restore my sign-in email' }));
    expect(await screen.findByText('Your sign-in email is back to old@example.com.')).toBeInTheDocument();
    expect(mocks.applyEmailAction).toHaveBeenCalledWith('R-1');

    fireEvent.click(screen.getByRole('button', { name: 'Send me a password reset link' }));
    await waitFor(() => expect(mocks.sendReset).toHaveBeenCalledWith('old@example.com', null));
  });

  it.each([
    ['verifyEmail', 'RECOVER_EMAIL'],
    ['verifyEmail', 'VERIFY_AND_CHANGE_EMAIL'],
    ['verifyAndChangeEmail', 'RECOVER_EMAIL'],
    ['recoverEmail', 'VERIFY_EMAIL'],
    ['verifyEmail', 'PASSWORD_RESET'],
  ])('refuses a mode=%s link whose code is really %s, and never applies it (#892 review)', async (mode, operation) => {
    mocks.readActionCode.mockResolvedValue({ operation, email: 'old@example.com', previousEmail: 'new@example.com' });
    const { container } = openLink(`?mode=${mode}&oobCode=MISMATCH`);

    expect(await screen.findByText("This link can't be completed here.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).not.toMatch(/contact Tribe Tails/i);
    expect(mocks.applyEmailAction).not.toHaveBeenCalled();
  });

  it('says an expired email link has expired', async () => {
    mocks.readActionCode.mockRejectedValue(authError('auth/expired-action-code'));
    openLink('?mode=verifyEmail&oobCode=V-OLD');
    expect(await screen.findByText('This link has expired.')).toBeInTheDocument();
  });

  it('gives a clear message for a link type this page does not handle', async () => {
    const { container } = openLink('?mode=revertSecondFactorAddition&oobCode=X');
    expect(await screen.findByText("This link can't be completed here.")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/incomplete/i);
    expect(container.textContent).not.toMatch(/contact Tribe Tails/i);
  });

  it('keeps "incomplete" for a link with no code at all', () => {
    openLink('?source=unauthorized_attempt&email=pepper@example.com');
    expect(screen.getByText('This link is incomplete.')).toBeInTheDocument();
  });

  it('works the same on the /account/action alias', async () => {
    openLink(NATIVE, '/account/action');
    expect(await screen.findByText('pepper@example.com')).toBeInTheDocument();
  });
});
