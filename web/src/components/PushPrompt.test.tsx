// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PushPrompt } from './PushPrompt';
import { currentPushPermission, isPushSupported, registerForPush } from '../lib/push';

vi.mock('../lib/push', () => ({
  currentPushPermission: vi.fn(),
  isPushSupported: vi.fn(),
  registerForPush: vi.fn(),
}));

describe('PushPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(currentPushPermission).mockReturnValue('default');
    vi.mocked(isPushSupported).mockResolvedValue(true);
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

  it('surfaces a distinct error message instead of failing silently', async () => {
    vi.mocked(registerForPush).mockResolvedValue({ status: 'error', message: 'no token returned' });
    render(<PushPrompt />);
    await userEvent.click(await screen.findByText('Enable notifications'));
    await waitFor(() => expect(screen.getByText('no token returned')).toBeInTheDocument());
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
