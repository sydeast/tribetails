// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignIn } from './SignIn';
import { SESSION_ENDED_STORAGE_KEY } from '../lib/revokedSession';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/auth', () => ({ signIn: vi.fn(), sendReset: vi.fn() }));

/**
 * #557, the last step of the chain. The backend refuses a revoked session, the
 * callable client signs the kinfolk out and lands them here — and if this
 * screen says nothing, the whole thing reads as "the app logged me out for no
 * reason", which is a worse experience than the bug being fixed.
 */
describe('SignIn session-ended notice', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('says why, when the sign-out was not the kinfolk’s doing', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, 'Your session ended, so we signed you out.');
    render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toHaveTextContent(/session ended/i);
  });

  it('says nothing on an ordinary visit', () => {
    render(<SignIn />);
    expect(screen.queryByTestId('session-ended-notice')).toBeNull();
  });

  it('shows the notice once — a remount does not resurrect it', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, 'Your session ended, so we signed you out.');
    const first = render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toBeInTheDocument();
    first.unmount();
    render(<SignIn />);
    expect(screen.queryByTestId('session-ended-notice')).toBeNull();
  });
});
