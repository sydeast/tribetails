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
  createShareLink: vi.fn<(taleId: string, familyId: string, options?: unknown) => Promise<{ shareId: string; shareUrl: string }>>(),
  revokeShareLink: vi.fn<(shareId: string) => Promise<{ ok: true }>>(),
  getActiveKinfolkId: vi.fn<() => string | undefined>(),
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
    createShareLink: (taleId: string, familyId: string, options?: unknown) => mocks.createShareLink(taleId, familyId, options),
    revokeShareLink: (shareId: string) => mocks.revokeShareLink(shareId),
  };
});

vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => mocks.getActiveKinfolkId() }));
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
  mocks.revokeShareLink.mockReset();
  mocks.getActiveKinfolkId.mockReset();

  mocks.getMyKinTales.mockResolvedValue({ tales: [tale()], hasMore: false });
  mocks.getKinTaleReaction.mockResolvedValue({ loved: false, loveCount: 0 });
  mocks.getMyKinTaleComments.mockResolvedValue({ comments: [] });
  mocks.createShareLink.mockResolvedValue({ shareId: 'share-1', shareUrl: 'https://kinfolk.tribetails.com/share/share-1' });
  mocks.revokeShareLink.mockResolvedValue({ ok: true });
  mocks.getActiveKinfolkId.mockReturnValue('fam1');
});

// Full create/passcode/expiry/revoke behavior is covered by
// ShareKinTaleDialog.test.tsx against the dialog directly (its own mocked
// api/kinTalesApi module). These tests only cover the integration seam:
// TaleShare opens ShareKinTaleDialog wired to the right tale + tribe, and
// the fail-loud path when kinfolkId can't be resolved at all — the one
// error case the dialog itself can never reach, since it requires a
// non-null familyId prop.
describe('KinTales: Share', () => {
  it('opens the share dialog wired to the right tale + tribe, and a successful create shows the URL', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));

    expect(await screen.findByRole('dialog', { name: /Invite the Family/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Generate Link/i }));

    await waitFor(() =>
      expect(mocks.createShareLink).toHaveBeenCalledWith(
        't1',
        'fam1',
        expect.objectContaining({ includePhotos: true, expiresInDays: 7 }),
      ),
    );
    expect(await screen.findByDisplayValue('https://kinfolk.tribetails.com/share/share-1')).toBeInTheDocument();
  });

  it('error path: surfaces a rejection instead of swallowing it (fail loud), and does not reveal a link', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('kinTale not found'));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));
    await user.click(screen.getByRole('button', { name: /Generate Link/i }));

    expect(await screen.findByText('kinTale not found')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/https:\/\//)).not.toBeInTheDocument();
  });

  it('unauthorized path: surfaces the requirePrimary denial verbatim (a SECONDARY member is denied server-side)', async () => {
    mocks.createShareLink.mockRejectedValue(new Error('permission-denied'));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));
    await user.click(screen.getByRole('button', { name: /Generate Link/i }));

    expect(await screen.findByText('permission-denied')).toBeInTheDocument();
  });

  it('fails loud instead of opening the dialog when the tribe id cannot be resolved yet', async () => {
    mocks.getActiveKinfolkId.mockReturnValue(undefined);
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: SHARE_BUTTON }));

    expect(await screen.findByText('Could not tell which tribe this is. Reload the page and try again.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.createShareLink).not.toHaveBeenCalled();
  });
});
