// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallPrompt } from './InstallPrompt';
import { isIos, isStandalone } from '../lib/installState';

vi.mock('../lib/installState', () => ({ isIos: vi.fn(), isStandalone: vi.fn() }));

/** The event Chrome fires when it is willing to install the app. */
function fireInstallPrompt() {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  const prompt = vi.fn().mockResolvedValue(undefined);
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome: 'accepted' as const });
  window.dispatchEvent(event);
  return prompt;
}

describe('InstallPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(isIos).mockReturnValue(false);
    vi.mocked(isStandalone).mockReturnValue(false);
  });

  it('says nothing on a browser that has not offered an install', () => {
    const { container } = render(<InstallPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing once the admin is already installed', () => {
    vi.mocked(isStandalone).mockReturnValue(true);
    vi.mocked(isIos).mockReturnValue(true);
    const { container } = render(<InstallPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('Chrome and the other browsers with an install prompt', () => {
    it('offers the install once the browser says it is willing', async () => {
      render(<InstallPrompt />);
      fireInstallPrompt();
      expect(await screen.findByText('Keep AuntieOS on your home screen')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Install AuntieOS' })).toBeInTheDocument();
    });

    it('hands the press straight to the browser prompt it captured', async () => {
      render(<InstallPrompt />);
      const prompt = fireInstallPrompt();
      await userEvent.click(await screen.findByRole('button', { name: 'Install AuntieOS' }));
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it('gets out of the way once the install is accepted', async () => {
      const { container } = render(<InstallPrompt />);
      fireInstallPrompt();
      await userEvent.click(await screen.findByRole('button', { name: 'Install AuntieOS' }));
      await waitFor(() => {
        expect(container).toBeEmptyDOMElement();
      });
    });

    it('does not coach through Safari steps on a browser that has a button', async () => {
      render(<InstallPrompt />);
      fireInstallPrompt();
      await screen.findByText('Keep AuntieOS on your home screen');
      expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument();
    });
  });

  describe('iOS, where Safari offers no prompt at all', () => {
    beforeEach(() => {
      vi.mocked(isIos).mockReturnValue(true);
    });

    it('shows the steps without waiting for an event that never arrives', () => {
      render(<InstallPrompt />);
      expect(screen.getByText('Keep AuntieOS on your home screen')).toBeInTheDocument();
      expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    });

    it('offers no Install button, there being nothing behind it to press', () => {
      render(<InstallPrompt />);
      expect(screen.queryByRole('button', { name: 'Install AuntieOS' })).not.toBeInTheDocument();
    });

    it('warns that the installed admin asks for a sign in of its own', () => {
      render(<InstallPrompt />);
      expect(screen.getByText(/sign in once more the first time you open it/)).toBeInTheDocument();
    });
  });

  it('stays gone after the operator dismisses it, across reloads', async () => {
    vi.mocked(isIos).mockReturnValue(true);
    const first = render(<InstallPrompt />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(first.container).toBeEmptyDOMElement();
    expect(localStorage.getItem('auntieos.install.dismissed')).toBe('1');

    first.unmount();
    const second = render(<InstallPrompt />);
    expect(second.container).toBeEmptyDOMElement();
  });
});
