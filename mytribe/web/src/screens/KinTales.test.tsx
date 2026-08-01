// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KinTales } from './KinTales';
import type { GetMyKinTalesResult, KinTaleDto } from '../api/types';
import type { GetKinTaleCommentsResult, KinTaleReactionResult } from '../api/kinTalesApi';

const mocks = vi.hoisted(() => ({
  getMyKinTales: vi.fn<() => Promise<GetMyKinTalesResult>>(),
  getKinTaleReaction: vi.fn<() => Promise<KinTaleReactionResult>>(),
  getMyKinTaleComments: vi.fn<() => Promise<GetKinTaleCommentsResult>>(),
  createShareLink: vi.fn<(taleId: string, familyId: string) => Promise<{ shareId: string; shareUrl: string }>>(),
}));

vi.mock('../api/portal', () => ({
  getMyKinTales: () => mocks.getMyKinTales(),
}));

vi.mock('../api/kinTalesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/kinTalesApi')>('../api/kinTalesApi');
  return {
    ...actual,
    // Only the network-touching wrappers are replaced; every pure helper
    // (filterTales, threadComments, loveLine, …) stays real, same
    // convention as Messages.test.tsx's messagesApi mock.
    getKinTaleReaction: () => mocks.getKinTaleReaction(),
    getMyKinTaleComments: () => mocks.getMyKinTaleComments(),
    createShareLink: (taleId: string, familyId: string) => mocks.createShareLink(taleId, familyId),
  };
});

vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1', email: 'k@example.com' } }),
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

const SHARE_BUTTON = /Share/;

function tale(overrides: Partial<KinTaleDto> = {}): KinTaleDto {
  return {
    id: 't1',
    title: '',
    body: 'A fine walk in the park.',
    authorDisplayName: 'Maya',
    mediaIds: [],
    sentAtMs: 1_700_000_000_000,
    shared: false,
    ...overrides,
  };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <KinTales />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getMyKinTales.mockReset();
  mocks.getKinTaleReaction.mockReset();
  mocks.getMyKinTaleComments.mockReset();
  mocks.createShareLink.mockReset();

  mocks.getMyKinTales.mockResolvedValue({ tales: [tale()], hasMore: false });
  mocks.getKinTaleReaction.mockResolvedValue({ loved: false, loveCount: 0 });
  mocks.getMyKinTaleComments.mockResolvedValue({ comments: [] });
  mocks.createShareLink.mockResolvedValue({ shareId: 'share-1', shareUrl: 'https://kinfolk.tribetails.com/share/share-1' });
});

describe('KinTales: Share', () => {
  it('happy path: creates a link for the right tale + tribe and reveals it in place of the button', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));

    await waitFor(() => expect(mocks.createShareLink).toHaveBeenCalledWith('t1', 'fam1'));
    expect(await screen.findByDisplayValue('https://kinfolk.tribetails.com/share/share-1')).toBeInTheDocument();
    // the Share button itself is gone, replaced by the reveal panel
    expect(screen.queryByRole('button', { name: SHARE_BUTTON })).not.toBeInTheDocument();
  });

  it('copies the link to the clipboard and shows confirmation', async () => {
    // user-event's setup() installs its own clipboard stub the first time it's
    // touched, replacing anything defined earlier — so the spy has to attach
    // AFTER setup(), not in beforeEach, or it gets clobbered.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));
    await screen.findByDisplayValue('https://kinfolk.tribetails.com/share/share-1');
    await user.click(screen.getByRole('button', { name: /Copy Link/i }));

    expect(writeText).toHaveBeenCalledWith('https://kinfolk.tribetails.com/share/share-1');
    expect(await screen.findByRole('button', { name: /^Copied$/ })).toBeInTheDocument();
  });

  it('error path: surfaces a rejection instead of swallowing it (fail loud), and does not reveal a panel', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('kinTale not found'));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));

    expect(await screen.findByText('kinTale not found')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/https:\/\//)).not.toBeInTheDocument();
  });

  it('unauthorized path: surfaces the requirePrimary denial verbatim (a SECONDARY member is denied server-side)', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('permission-denied'));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));

    expect(await screen.findByText('permission-denied')).toBeInTheDocument();
  });

  it('can retry after a failed attempt', async () => {
    mocks.createShareLink.mockRejectedValueOnce(new Error('temporary failure'));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));
    await screen.findByText('temporary failure');

    await user.click(screen.getByRole('button', { name: SHARE_BUTTON }));
    expect(await screen.findByDisplayValue('https://kinfolk.tribetails.com/share/share-1')).toBeInTheDocument();
  });
});
