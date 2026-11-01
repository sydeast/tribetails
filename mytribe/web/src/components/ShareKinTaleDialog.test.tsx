// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShareKinTaleDialog } from './ShareKinTaleDialog';
import type { CreateShareLinkResult, RevokeShareLinkResult, ShareLinkOptions } from '../api/kinTalesApi';

const mocks = vi.hoisted(() => ({
  createShareLink: vi.fn<(kinTaleId: string, familyId: string, options?: ShareLinkOptions) => Promise<CreateShareLinkResult>>(),
  revokeShareLink: vi.fn<(shareId: string) => Promise<RevokeShareLinkResult>>(),
}));

vi.mock('../api/kinTalesApi', () => ({
  createShareLink: (kinTaleId: string, familyId: string, options?: ShareLinkOptions) =>
    mocks.createShareLink(kinTaleId, familyId, options),
  revokeShareLink: (shareId: string) => mocks.revokeShareLink(shareId),
}));

const SHARE_URL = 'https://kinfolk.tribetails.com/share/share-1';

function renderDialog(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ShareKinTaleDialog taleId="t1" familyId="fam1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

async function createLink(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Generate Link/i }));
  await screen.findByDisplayValue(SHARE_URL);
}

beforeEach(() => {
  mocks.createShareLink.mockReset();
  mocks.revokeShareLink.mockReset();
  mocks.createShareLink.mockResolvedValue({ shareId: 'share-1', shareUrl: SHARE_URL });
  mocks.revokeShareLink.mockResolvedValue({ ok: true });
});

describe('ShareKinTaleDialog: form', () => {
  it('renders Include Photos on by default, expiry defaulting to 7 days, and an optional 4-8 char passcode field', () => {
    renderDialog();

    expect(screen.getByRole('switch', { name: /Include Photos/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('slider', { name: /expiration/i })).toHaveValue('7');
    expect(screen.getByLabelText(/optional.*4 to 8 characters/i)).toBeInTheDocument();
  });

  it('rejects a too-short passcode before calling the callable, with the exact Compose-parity message', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/optional.*4 to 8 characters/i), 'abc');
    await user.click(screen.getByRole('button', { name: /Generate Link/i }));

    expect(await screen.findByText('Passcode must be at least 4 characters.')).toBeInTheDocument();
    expect(mocks.createShareLink).not.toHaveBeenCalled();
  });

  it('sends a blank passcode as absent, and the default toggle/expiry as-is', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /Generate Link/i }));

    await screen.findByDisplayValue(SHARE_URL);
    expect(mocks.createShareLink).toHaveBeenCalledWith('t1', 'fam1', {
      includePhotos: true,
      expiresInDays: 7,
      passcode: undefined,
    });
  });

  it('a successful create shows the URL and a Copy control', async () => {
    const user = userEvent.setup();
    renderDialog();

    await createLink(user);

    expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy Link/i })).toBeInTheDocument();
  });

  it('fails loud on a create error (e.g. permission-denied for a SECONDARY member) and shows no link', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('permission-denied'));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /Generate Link/i }));

    expect(await screen.findByText('permission-denied')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(SHARE_URL)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate Link/i })).toBeInTheDocument();
  });

  it('can retry after a failed attempt', async () => {
    mocks.createShareLink.mockRejectedValueOnce(new Error('temporary failure'));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /Generate Link/i }));
    await screen.findByText('temporary failure');

    await user.click(screen.getByRole('button', { name: /Generate Link/i }));
    expect(await screen.findByDisplayValue(SHARE_URL)).toBeInTheDocument();
  });

  it('copies the link to the clipboard and shows confirmation', async () => {
    // user-event's setup() installs its own clipboard stub the first time it's
    // touched, replacing anything defined earlier — so the spy has to attach
    // AFTER setup(), not in beforeEach, or it gets clobbered.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderDialog();

    await createLink(user);
    await user.click(screen.getByRole('button', { name: /Copy Link/i }));

    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    expect(await screen.findByRole('button', { name: /^Copied$/ })).toBeInTheDocument();
  });
});

describe('ShareKinTaleDialog: revoke', () => {
  it('asks for confirmation before calling revokeShareLink at all', async () => {
    const user = userEvent.setup();
    renderDialog();
    await createLink(user);

    await user.click(screen.getByRole('button', { name: /Revoke link/i }));

    expect(screen.getByRole('button', { name: /Yes, revoke/i })).toBeInTheDocument();
    expect(mocks.revokeShareLink).not.toHaveBeenCalled();
  });

  it('calls revokeShareLink with the returned shareId, and on success stops offering the dead URL for copying', async () => {
    const user = userEvent.setup();
    renderDialog();
    await createLink(user);

    await user.click(screen.getByRole('button', { name: /Revoke link/i }));
    await user.click(screen.getByRole('button', { name: /Yes, revoke/i }));

    expect(mocks.revokeShareLink).toHaveBeenCalledWith('share-1');
    expect(await screen.findByText('This link no longer works.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Link/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(SHARE_URL)).not.toBeInTheDocument();
  });

  it('a failed revoke says so and does NOT claim the link is dead', async () => {
    mocks.revokeShareLink.mockRejectedValue(new Error('not-found'));
    const user = userEvent.setup();
    renderDialog();
    await createLink(user);

    await user.click(screen.getByRole('button', { name: /Revoke link/i }));
    await user.click(screen.getByRole('button', { name: /Yes, revoke/i }));

    expect(await screen.findByText('not-found')).toBeInTheDocument();
    expect(screen.queryByText('This link no longer works.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy Link/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument();
  });

  it('Keep link backs out of the confirm step without revoking', async () => {
    const user = userEvent.setup();
    renderDialog();
    await createLink(user);

    await user.click(screen.getByRole('button', { name: /Revoke link/i }));
    await user.click(screen.getByRole('button', { name: /Keep link/i }));

    expect(mocks.revokeShareLink).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(SHARE_URL)).toBeInTheDocument();
  });
});

describe('ShareKinTaleDialog: dismissal', () => {
  it('Done calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();
    await createLink(user);

    await user.click(screen.getByRole('button', { name: /^Done$/ }));

    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop closes the dialog when nothing is in flight', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();

    await user.click(screen.getByRole('dialog').parentElement!);

    expect(onClose).toHaveBeenCalled();
  });
});

describe('ShareKinTaleDialog: placement and closing (#1327)', () => {
  it('is titled for the action and portalled to <body>, above any page stacking context', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: /Share this KinTale/i });
    expect(screen.getByRole('heading', { name: 'Share this KinTale' })).toBeInTheDocument();
    // Not inside the render container: a `.wrap` ancestor would trap it under the sticky nav.
    expect(dialog.closest('.skd-overlay')?.parentElement).toBe(document.body);
  });
  it('has a labelled close button on the form stage, before any link exists', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('also has it once the link is made', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();
    await createLink(user);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('closes on Escape and on a click outside the card, but not on a click inside it', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();
    await user.click(screen.getByRole('heading', { name: 'Share this KinTale' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    const overlay = screen.getByRole('dialog').closest('.skd-overlay') as HTMLElement;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('does not close while a link is being created', async () => {
    mocks.createShareLink.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    const onClose = renderDialog();
    await user.click(screen.getByRole('button', { name: /Generate Link/i }));
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
  it('hides the passcode as typed, with a control to show it', async () => {
    const user = userEvent.setup();
    renderDialog();
    const field = screen.getByLabelText(/optional.*4 to 8 characters/i);
    expect(field).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show passcode' }));
    expect(field).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide passcode' }));
    expect(field).toHaveAttribute('type', 'password');
  });
});
