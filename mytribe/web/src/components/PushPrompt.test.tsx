// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Sentry from '@sentry/react';
import { PushPrompt } from './PushPrompt';
import { currentPushPermission, isPushSupported, registerForPush } from '../lib/push';

vi.mock('../lib/push', () => ({
  currentPushPermission: vi.fn(),
  isPushSupported: vi.fn(),
  registerForPush: vi.fn(),
}));
// The real lib/sentry wrapper runs; only the SDK underneath is faked, so the
// "initialised or not" gate is exercised end to end from the component.
vi.mock('@sentry/react', () => ({
  isInitialized: vi.fn(),
  captureException: vi.fn(),
}));

/** What registerForPush returns when getToken throws a FirebaseError (#1547). */
const fcmFailure = {
  status: 'error' as const,
  message: 'Request timed out.',
  code: 'messaging/token-subscribe-failed',
  stage: 'token' as const,
  error: new Error('Request timed out.'),
  diagnostics: { permission: 'granted' as const, serviceWorker: 'active' as const, vapidKeySet: true },
};

describe('PushPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(currentPushPermission).mockReturnValue('default');
    vi.mocked(isPushSupported).mockResolvedValue(true);
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
  });

  it('renders nothing while support is still resolving, then shows once supported + undecided', async () => {
    const { container } = render(<PushPrompt />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(screen.getByText('Enable notifications')).toBeInTheDocument());
  });

  it('stays hidden entirely when the browser does not support push', async () => {
    vi.mocked(isPushSupported).mockResolvedValue(false);
    const { container } = render(<PushPrompt />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('stays hidden when permission was already decided (granted or denied) — never re-prompts', async () => {
    vi.mocked(currentPushPermission).mockReturnValue('granted');
    const { container } = render(<PushPrompt />);
    await waitFor(() => expect(isPushSupported).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('registers push only on explicit tap, not on mount', async () => {
    vi.mocked(registerForPush).mockResolvedValue({ status: 'registered' });
    render(<PushPrompt />);
    await screen.findByText('Enable notifications');
    expect(registerForPush).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('Enable notifications'));
    expect(registerForPush).toHaveBeenCalledTimes(1);
  });

  it('hides itself after a successful registration', async () => {
    vi.mocked(registerForPush).mockResolvedValue({ status: 'registered' });
    const { container } = render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('surfaces the message and the FCM code in the error line instead of failing silently (#1547)', async () => {
    vi.mocked(registerForPush).mockResolvedValue(fcmFailure);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() =>
      expect(
        screen.getByText('Could not enable notifications: Request timed out. (messaging/token-subscribe-failed)'),
      ).toBeInTheDocument(),
    );
  });

  it('logs one structured console line with the code, stage, message and browser state (#1547)', async () => {
    vi.mocked(registerForPush).mockResolvedValue(fcmFailure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    // Exact object: these six fields and nothing else, so a token or key can
    // never ride along.
    expect(consoleError).toHaveBeenCalledWith('[push] enable failed', {
      code: 'messaging/token-subscribe-failed',
      stage: 'token',
      message: 'Request timed out.',
      permission: 'granted',
      serviceWorker: 'active',
      vapidKeySet: true,
    });
  });

  it('reports the thrown error to Sentry with code and stage tags when Sentry is initialised (#1547)', async () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(registerForPush).mockResolvedValue(fcmFailure);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(Sentry.captureException).toHaveBeenCalledTimes(1));
    expect(Sentry.captureException).toHaveBeenCalledWith(fcmFailure.error, {
      tags: { code: 'messaging/token-subscribe-failed', stage: 'token' },
    });
  });

  it('sends nothing to Sentry when it was never initialised (no DSN) (#1547)', async () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    vi.mocked(registerForPush).mockResolvedValue(fcmFailure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('still shows a plain line when the app-shell service worker never registered', async () => {
    vi.mocked(registerForPush).mockResolvedValue({ status: 'no-service-worker' });
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() =>
      expect(screen.getByText('Could not enable notifications on this device.')).toBeInTheDocument(),
    );
  });

  it('dismiss hides the banner for the rest of the session without registering', async () => {
    render(<PushPrompt />);
    await screen.findByText('Enable notifications');
    await userEvent.click(screen.getByText('Maybe later'));
    expect(screen.queryByText('Enable notifications')).not.toBeInTheDocument();
    expect(registerForPush).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mytribe.push.dismissed')).toBe('1');
  });
});
