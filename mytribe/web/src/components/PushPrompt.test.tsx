// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Sentry from '@sentry/react';
import { PushPrompt } from './PushPrompt';
import {
  currentPushPermission,
  isPushSupported,
  refreshPushRegistration,
  registerForPush,
  settledPushRegistration,
} from '../lib/push';
import { isIos, isStandalone } from '../lib/installState';

vi.mock('../lib/push', () => ({
  currentPushPermission: vi.fn(),
  isPushSupported: vi.fn(),
  registerForPush: vi.fn(),
  refreshPushRegistration: vi.fn(),
  settledPushRegistration: vi.fn(),
}));
vi.mock('../lib/installState', () => ({ isIos: vi.fn(), isStandalone: vi.fn() }));
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

/** What registerForPush returns when getRegistration() resolved null (#1550). */
const noServiceWorker = {
  status: 'no-service-worker' as const,
  diagnostics: { permission: 'granted' as const, serviceWorker: 'none' as const, vapidKeySet: true },
};

describe('PushPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(currentPushPermission).mockReturnValue('default');
    vi.mocked(isPushSupported).mockResolvedValue(true);
    vi.mocked(refreshPushRegistration).mockResolvedValue({ status: 'registered' });
    vi.mocked(settledPushRegistration).mockReturnValue(null);
    vi.mocked(isIos).mockReturnValue(false);
    vi.mocked(isStandalone).mockReturnValue(false);
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
    vi.mocked(registerForPush).mockResolvedValue({ ...fcmFailure });
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
    vi.mocked(registerForPush).mockResolvedValue({ ...fcmFailure });
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
    vi.mocked(registerForPush).mockResolvedValue({ ...fcmFailure });
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
    vi.mocked(registerForPush).mockResolvedValue({ ...fcmFailure });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // #1550: the no-service-worker outcome was the one failure that left no
  // trace: a bare banner line, no console line, no Sentry event.
  it('names the unready background worker in the banner, with the reload and the iPhone home-screen step, when the app-shell service worker never registered (#1550)', async () => {
    vi.mocked(registerForPush).mockResolvedValue({ ...noServiceWorker });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Could not enable notifications: the app's background worker could not be installed on this device. Reload the page and try again; on an iPhone, add MyTribe to the home screen first.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Could not enable notifications on this device.')).not.toBeInTheDocument();
  });

  it('logs one structured console line for the no-service-worker outcome with the same six fields (#1550)', async () => {
    vi.mocked(registerForPush).mockResolvedValue({ ...noServiceWorker });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    expect(consoleError).toHaveBeenCalledWith('[push] enable failed', {
      code: 'no-service-worker',
      stage: 'service-worker',
      message: 'No service worker registration.',
      permission: 'granted',
      serviceWorker: 'none',
      vapidKeySet: true,
    });
  });

  it('reports the no-service-worker outcome to Sentry as an Error tagged with code and stage (#1550)', async () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(registerForPush).mockResolvedValue({ ...noServiceWorker });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(Sentry.captureException).toHaveBeenCalledTimes(1));
    const [reported, context] = vi.mocked(Sentry.captureException).mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe('No service worker registration.');
    expect(context).toEqual({ tags: { code: 'no-service-worker', stage: 'service-worker' } });
  });

  it('sends the no-service-worker outcome nowhere when Sentry was never initialised (#1550)', async () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    vi.mocked(registerForPush).mockResolvedValue({ ...noServiceWorker });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('dismiss hides the banner for the rest of the session without registering', async () => {
    render(<PushPrompt />);
    await screen.findByText('Enable notifications');
    await userEvent.click(screen.getByText('Maybe later'));
    expect(screen.queryByText('Enable notifications')).not.toBeInTheDocument();
    expect(registerForPush).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mytribe.push.dismissed')).toBe('1');
  });

  // #1787: the four states by browser permission.
  describe('permission states (#1787)', () => {
    it('granted and registered: registers silently on mount and shows no card', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ status: 'registered' });
      const { container } = render(<PushPrompt />);
      await waitFor(() => expect(refreshPushRegistration).toHaveBeenCalledTimes(1));
      expect(container).toBeEmptyDOMElement();
      expect(registerForPush).not.toHaveBeenCalled();
    });
    it('granted and failed: shows the finish card with the coded error and logs it once', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(Sentry.isInitialized).mockReturnValue(true);
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...fcmFailure });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<PushPrompt />);
      expect(await screen.findByText('Finish turning on notifications')).toBeInTheDocument();
      expect(
        screen.getByText('Could not enable notifications: Request timed out. (messaging/token-subscribe-failed)'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.queryByText('Enable notifications')).not.toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(fcmFailure.error, {
        tags: { code: 'messaging/token-subscribe-failed', stage: 'token' },
      });
    });
    it('granted and no service worker: shows the finish card with the worker sentence', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...noServiceWorker });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<PushPrompt />);
      expect(await screen.findByText('Finish turning on notifications')).toBeInTheDocument();
      expect(screen.getByText(/background worker could not be installed/)).toBeInTheDocument();
    });
    it('Retry registers again, and the card goes away when it works', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...fcmFailure });
      vi.mocked(registerForPush).mockResolvedValue({ status: 'registered' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { container } = render(<PushPrompt />);
      await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(registerForPush).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });
    it('Retry that fails again keeps the card and shows the new code', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...fcmFailure });
      vi.mocked(registerForPush).mockResolvedValue({ ...fcmFailure, code: 'messaging/failed-service-worker-registration', error: new Error('x') });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<PushPrompt />);
      await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(/messaging\/failed-service-worker-registration/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    });
    it('denied: shows the Chrome note, not the Enable button, and never registers', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('denied');
      render(<PushPrompt />);
      expect(await screen.findByText('Notifications are blocked')).toBeInTheDocument();
      expect(screen.getByText(/lock icon next to the address/)).toBeInTheDocument();
      expect(screen.queryByText('Enable notifications')).not.toBeInTheDocument();
      expect(registerForPush).not.toHaveBeenCalled();
      expect(refreshPushRegistration).not.toHaveBeenCalled();
    });
    it('denied: Close hides the note for the session', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('denied');
      const { container } = render(<PushPrompt />);
      await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
      expect(container).toBeEmptyDOMElement();
      expect(sessionStorage.getItem('mytribe.push.dismissed')).toBe('1');
    });
    it('default: shows the Enable card and does not register silently', async () => {
      render(<PushPrompt />);
      expect(await screen.findByText('Enable notifications')).toBeInTheDocument();
      expect(screen.getByText('Get notified about visits')).toBeInTheDocument();
      expect(refreshPushRegistration).not.toHaveBeenCalled();
    });
    it('granted and failed: Maybe later hides the card for the session', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...noServiceWorker });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { container } = render(<PushPrompt />);
      await userEvent.click(await screen.findByText('Maybe later'));
      expect(container).toBeEmptyDOMElement();
    });
    it('closing the browser prompt without choosing leaves the Enable card, not the blocked note', async () => {
      vi.mocked(registerForPush).mockResolvedValue({ status: 'denied' });
      render(<PushPrompt />);
      await userEvent.click(await screen.findByText('Enable notifications'));
      expect(await screen.findByText('Enable notifications')).toBeInTheDocument();
      expect(screen.queryByText('Notifications are blocked')).not.toBeInTheDocument();
    });
    it('a real block from the prompt shows the blocked note', async () => {
      vi.mocked(registerForPush).mockImplementation(async () => {
        vi.mocked(currentPushPermission).mockReturnValue('denied');
        return { status: 'denied' };
      });
      render(<PushPrompt />);
      await userEvent.click(await screen.findByText('Enable notifications'));
      expect(await screen.findByText('Notifications are blocked')).toBeInTheDocument();
    });
    it('ignoreDismissal shows the card although Home was dismissed, and closing it leaves that choice alone', async () => {
      sessionStorage.setItem('mytribe.push.dismissed', '1');
      vi.mocked(currentPushPermission).mockReturnValue('denied');
      const { container } = render(<PushPrompt ignoreDismissal />);
      await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
      expect(container).toBeEmptyDOMElement();
      expect(sessionStorage.getItem('mytribe.push.dismissed')).toBe('1');
    });
    it('without ignoreDismissal a dismissed session shows nothing', async () => {
      sessionStorage.setItem('mytribe.push.dismissed', '1');
      vi.mocked(currentPushPermission).mockReturnValue('denied');
      const { container } = render(<PushPrompt />);
      await waitFor(() => expect(isPushSupported).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    });

    it('granted but the browser does not support push: nothing, and no registration', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(isPushSupported).mockResolvedValue(false);
      const { container } = render(<PushPrompt />);
      await waitFor(() => expect(isPushSupported).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
      expect(refreshPushRegistration).not.toHaveBeenCalled();
    });
  });

  // #1808: Notification Settings never goes blank; Home stays as it was.
  describe('this device on Notification Settings (#1808)', () => {
    it('signed up: says notifications are on for this device, with no button and no dismiss', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Notifications are on for this device.');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(refreshPushRegistration).toHaveBeenCalledTimes(1);
      expect(registerForPush).not.toHaveBeenCalled();
    });
    it('signed up on Home: still no card at all', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      const { container } = render(<PushPrompt />);
      await waitFor(() => expect(refreshPushRegistration).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(screen.queryByText('Notifications are on for this device.')).not.toBeInTheDocument();
    });
    it('sign-up still running: says it is signing up, with the loading cue, then turns into the on line', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      let finish: (o: { status: 'registered' }) => void = () => {};
      vi.mocked(refreshPushRegistration).mockReturnValue(new Promise((r) => (finish = r)));
      const { container } = render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText('Signing up this device…')).toBeInTheDocument();
      expect(container.querySelector('.push-signing .loading-spinner')).not.toBeNull();
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      finish({ status: 'registered' });
      expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
      expect(screen.queryByText('Signing up this device…')).not.toBeInTheDocument();
    });
    it('sign-up still running on Home: nothing', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockReturnValue(new Promise(() => {}));
      const { container } = render(<PushPrompt />);
      await waitFor(() => expect(refreshPushRegistration).toHaveBeenCalledTimes(1));
      expect(container).toBeEmptyDOMElement();
    });
    it('an answer the sign-in already has is drawn at once, with no signing-up frame first', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(settledPushRegistration).mockReturnValue({ status: 'registered' });
      const seen: string[] = [];
      const { container } = render(<PushPrompt ignoreDismissal showDeviceStatus />);
      const observer = new MutationObserver(() => seen.push(container.textContent ?? ''));
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
      observer.disconnect();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((t) => t.includes('Signing up'))).toBe(false);
    });
    it('sign-up failed: the Finish card with the code and Retry, unchanged', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...fcmFailure });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText('Finish turning on notifications')).toBeInTheDocument();
      expect(screen.getByText(/messaging\/token-subscribe-failed/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.queryByText('Notifications are on for this device.')).not.toBeInTheDocument();
    });
    it('Retry that works turns the Finish card into the on line', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ ...fcmFailure });
      vi.mocked(registerForPush).mockResolvedValue({ status: 'registered' });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
      expect(screen.queryByText('Finish turning on notifications')).not.toBeInTheDocument();
    });
    it('Enable that works ends on the on line, not a blank card', async () => {
      vi.mocked(registerForPush).mockImplementation(async () => {
        vi.mocked(currentPushPermission).mockReturnValue('granted');
        return { status: 'registered' };
      });
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      await userEvent.click(await screen.findByText('Enable notifications'));
      expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
    });
    it('blocked: the blocked note, unchanged', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('denied');
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText('Notifications are blocked')).toBeInTheDocument();
      expect(screen.queryByText('Notifications are on for this device.')).not.toBeInTheDocument();
    });
    it('default permission: the Enable card, unchanged', async () => {
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText('Enable notifications')).toBeInTheDocument();
      expect(refreshPushRegistration).not.toHaveBeenCalled();
    });
    it('unsupported browser: says this browser cannot get notifications, and nothing about an iPhone', async () => {
      vi.mocked(isPushSupported).mockResolvedValue(false);
      vi.mocked(currentPushPermission).mockReturnValue('unsupported');
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText("This browser can't get notifications.")).toBeInTheDocument();
      expect(screen.queryByText(/home screen/)).not.toBeInTheDocument();
      expect(refreshPushRegistration).not.toHaveBeenCalled();
    });
    it('unsupported on an iPhone tab: also says to add MyTribe to the home screen first, in the install card words', async () => {
      vi.mocked(isPushSupported).mockResolvedValue(false);
      vi.mocked(currentPushPermission).mockReturnValue('unsupported');
      vi.mocked(isIos).mockReturnValue(true);
      vi.mocked(isStandalone).mockReturnValue(false);
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText("This browser can't get notifications.")).toBeInTheDocument();
      expect(screen.getByText(/Add MyTribe to your home screen first/)).toHaveTextContent(
        'Add MyTribe to your home screen first. Tap the Share button at the bottom of Safari, then Add to Home Screen.',
      );
      expect(
        screen.getByText(
          'An iPhone will not send you a visit update from a Safari tab, only from the app on your home screen.',
        ),
      ).toBeInTheDocument();
    });
    it('unsupported in an app already on the iPhone home screen: no home-screen step', async () => {
      vi.mocked(isPushSupported).mockResolvedValue(false);
      vi.mocked(isIos).mockReturnValue(true);
      vi.mocked(isStandalone).mockReturnValue(true);
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText("This browser can't get notifications.")).toBeInTheDocument();
      expect(screen.queryByText(/Add MyTribe to your home screen first/)).not.toBeInTheDocument();
    });
    it('granted, but the sign-up finds push unsupported: the unsupported line, not the on line', async () => {
      vi.mocked(currentPushPermission).mockReturnValue('granted');
      vi.mocked(refreshPushRegistration).mockResolvedValue({ status: 'unsupported' });
      render(<PushPrompt ignoreDismissal showDeviceStatus />);
      expect(await screen.findByText("This browser can't get notifications.")).toBeInTheDocument();
      expect(screen.queryByText('Notifications are on for this device.')).not.toBeInTheDocument();
    });
    it('unsupported on Home: still nothing', async () => {
      vi.mocked(isPushSupported).mockResolvedValue(false);
      vi.mocked(currentPushPermission).mockReturnValue('unsupported');
      const { container } = render(<PushPrompt />);
      await waitFor(() => expect(isPushSupported).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    });
  });
});
