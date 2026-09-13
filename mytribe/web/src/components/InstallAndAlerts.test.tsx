// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InstallAndAlerts } from './InstallAndAlerts';
import { isIos, isStandalone } from '../lib/installState';
import { currentPushPermission, isPushSupported, registerForPush } from '../lib/push';

vi.mock('../lib/installState', () => ({ isIos: vi.fn(), isStandalone: vi.fn() }));
vi.mock('../lib/push', () => ({
  currentPushPermission: vi.fn(),
  isPushSupported: vi.fn(),
  registerForPush: vi.fn(),
}));

/** What a tab-only iPhone looks like: no `Notification` constructor at all. */
function withoutNotificationApi() {
  delete (globalThis as { Notification?: unknown }).Notification;
  vi.mocked(isPushSupported).mockResolvedValue(false);
  vi.mocked(currentPushPermission).mockReturnValue('unsupported');
}

/** A browser that can really offer push: supported, and nothing decided yet. */
function withUndecidedPushPermission() {
  vi.mocked(isPushSupported).mockResolvedValue(true);
  vi.mocked(currentPushPermission).mockReturnValue('default');
}

describe('InstallAndAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('iOS Safari, not installed', () => {
    beforeEach(() => {
      vi.mocked(isIos).mockReturnValue(true);
      vi.mocked(isStandalone).mockReturnValue(false);
      withoutNotificationApi();
    });

    it('renders the install coach rather than nothing', async () => {
      const { container } = render(<InstallAndAlerts />);
      expect(await screen.findByText('Keep MyTribe on your home screen')).toBeInTheDocument();
      expect(screen.getByText('Add to Home Screen')).toBeInTheDocument();
      expect(container).not.toBeEmptyDOMElement();
    });

    it('tells the household that installing is what turns notifications on', () => {
      render(<InstallAndAlerts />);
      expect(
        screen.getByText(/Adding it is what turns notifications on/),
      ).toBeInTheDocument();
    });

    it('warns that the installed app asks them to sign in once more', () => {
      render(<InstallAndAlerts />);
      expect(screen.getByText(/sign in once more the first time you open it/)).toBeInTheDocument();
      expect(screen.getByText(/keeps its own sign in, separate from Safari/)).toBeInTheDocument();
    });

    it('never offers an "Enable notifications" button Safari cannot honour', async () => {
      render(<InstallAndAlerts />);
      await screen.findByText('Keep MyTribe on your home screen');
      expect(screen.queryByText('Enable notifications')).not.toBeInTheDocument();
      // Not even asked: the branch is decided before PushPrompt is mounted.
      expect(isPushSupported).not.toHaveBeenCalled();
      expect(registerForPush).not.toHaveBeenCalled();
    });
  });

  describe('iOS, installed to the home screen', () => {
    beforeEach(() => {
      vi.mocked(isIos).mockReturnValue(true);
      vi.mocked(isStandalone).mockReturnValue(true);
      withUndecidedPushPermission();
    });

    it('offers notifications, which now really work', async () => {
      render(<InstallAndAlerts />);
      expect(await screen.findByText('Enable notifications')).toBeInTheDocument();
    });

    it('drops the install coach, there being nothing left to install', async () => {
      render(<InstallAndAlerts />);
      await screen.findByText('Enable notifications');
      expect(screen.queryByText('Keep MyTribe on your home screen')).not.toBeInTheDocument();
    });
  });

  describe('Android and desktop', () => {
    beforeEach(() => {
      vi.mocked(isIos).mockReturnValue(false);
      vi.mocked(isStandalone).mockReturnValue(false);
      withUndecidedPushPermission();
    });

    it('offers notifications without waiting on an install', async () => {
      render(<InstallAndAlerts />);
      expect(await screen.findByText('Enable notifications')).toBeInTheDocument();
    });

    it('holds the install coach back until the browser offers a prompt', async () => {
      render(<InstallAndAlerts />);
      await screen.findByText('Enable notifications');
      expect(screen.queryByText('Keep MyTribe on your home screen')).not.toBeInTheDocument();
    });
  });
});
