// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KinTales } from './KinTales';
import type { GetMyKinTalesResult, KinTaleDto, TaleThumbDto } from '../api/types';
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

// task-24 (P3): the feed card shows its media up front instead of hiding it
// one click deep. The first tale in a list always renders as the `.feature`
// banner card; a second tale renders as a non-featured `.talecard` — tests
// that need `.tcstrip` (non-featured only, per scope) put their fixture
// second and give the featured slot a plain, medialess tale.
function thumb(overrides: Partial<TaleThumbDto> = {}): TaleThumbDto {
  return { id: 'm1', url: 'https://cdn.example/m1.jpg', contentType: 'image/jpeg', ...overrides };
}

describe('KinTales: photo-first cards', () => {
  it('a non-featured tale with 12 media renders 8 tiles in .tcstrip, each an img with the returned URL', async () => {
    const thumbs = Array.from({ length: 12 }, (_, i) => thumb({ id: `m${i + 1}`, url: `https://cdn.example/m${i + 1}.jpg` }));
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        tale({ id: 'featured', title: 'Featured Card', body: 'Featured, no photos.' }),
        tale({ id: 't2', title: 'Twelve Card', body: 'Twelve photos today.', mediaIds: thumbs.map((t) => t.id), thumbs }),
      ],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('Twelve photos today.');
    const strips = container.querySelectorAll('.tcstrip');
    expect(strips).toHaveLength(1);
    const imgs = strips[0]!.querySelectorAll('img');
    expect(imgs).toHaveLength(8);
    expect(Array.from(imgs).map((img) => img.getAttribute('src'))).toEqual(
      thumbs.slice(0, 8).map((t) => t.url),
    );
  });

  it('a tale with one photo renders one tile, not eight', async () => {
    const thumbs = [thumb({ id: 'only', url: 'https://cdn.example/only.jpg' })];
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        tale({ id: 'featured', title: 'Featured Card', body: 'Featured, no photos.' }),
        tale({ id: 't2', title: 'One Card', body: 'One photo today.', mediaIds: ['only'], thumbs }),
      ],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('One photo today.');
    const strip = container.querySelector('.tcstrip');
    expect(strip).not.toBeNull();
    expect(strip!.querySelectorAll('.sm')).toHaveLength(1);
    expect(strip!.querySelectorAll('img')).toHaveLength(1);
  });

  it('a video thumb renders with the play affordance and NOT as an img pointing at a video file', async () => {
    const thumbs = [thumb({ id: 'clip', url: 'https://cdn.example/clip.mp4', contentType: 'video/mp4' })];
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        tale({ id: 'featured', title: 'Featured Card', body: 'Featured, no photos.' }),
        tale({ id: 't2', title: 'Video Card', body: 'A video today.', mediaIds: ['clip'], thumbs }),
      ],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('A video today.');
    const strip = container.querySelector('.tcstrip')!;
    expect(strip.querySelectorAll('img')).toHaveLength(0);
    expect(within(strip as HTMLElement).getByText('\u{25B6}\u{FE0F}')).toBeInTheDocument();
  });

  it('a tale with no media renders no .tcstrip element at all, and still renders its title, body and footer', async () => {
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        tale({ id: 'featured', title: 'Featured Card', body: 'Featured, no photos.' }),
        tale({ id: 't2', title: 'Lore Only', body: 'Just a story, no photos.', mediaIds: [] }),
      ],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('Just a story, no photos.');
    expect(container.querySelectorAll('.tcstrip')).toHaveLength(0);
    expect(screen.getByText('Lore Only')).toBeInTheDocument();
    expect(screen.getByText('No photos this visit')).toBeInTheDocument();
  });

  it('the full-gallery button is present on a tale whose media all fit in the strip, and absent on a tale with none', async () => {
    const thumbs = [thumb({ id: 'a' }), thumb({ id: 'b', url: 'https://cdn.example/b.jpg' })];
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        tale({ id: 'featured', title: 'Featured Card', body: 'Featured, no photos.' }),
        tale({ id: 't2', title: 'Both Fit Card', body: 'Two photos, both fit.', mediaIds: ['a', 'b'], thumbs }),
        tale({ id: 't3', title: 'No Media Card', body: 'No photos at all.', mediaIds: [] }),
      ],
      hasMore: false,
    });
    renderScreen();

    await screen.findByText('Two photos, both fit.');
    const withMedia = screen.getByText('Two photos, both fit.').closest('section')!;
    expect(within(withMedia as HTMLElement).getByRole('button', { name: 'View Gallery' })).toBeInTheDocument();

    const withoutMedia = screen.getByText('No photos at all.').closest('section')!;
    expect(within(withoutMedia as HTMLElement).queryByRole('button', { name: 'View Gallery' })).not.toBeInTheDocument();
  });

  it('the featured tale with a photo shows it in the banner', async () => {
    const thumbs = [thumb({ id: 'hero', url: 'https://cdn.example/hero.jpg' })];
    mocks.getMyKinTales.mockResolvedValue({
      tales: [tale({ id: 'featured', title: 'Hero Card', body: 'Featured with a photo.', mediaIds: ['hero'], thumbs })],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('Featured with a photo.');
    const bav = container.querySelector('.bav')!;
    // alt="" (decorative, per scope) makes this a presentation-role image,
    // not an accessible "img" — queried directly rather than via getByRole.
    const img = bav.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://cdn.example/hero.jpg');
  });

  it('the featured tale without a photo is unchanged', async () => {
    mocks.getMyKinTales.mockResolvedValue({
      tales: [tale({ id: 'featured', title: 'No Hero Card', body: 'Featured, no photos.', mediaIds: [] })],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('Featured, no photos.');
    const bav = container.querySelector('.bav')!;
    expect(within(bav as HTMLElement).queryByRole('img')).not.toBeInTheDocument();
    expect(bav.textContent).toBe('\u{1F43E}');
  });

  it('a response with thumbs absent entirely (old deployed function) renders as no thumbnails and does not throw', async () => {
    const { thumbs: _drop, ...taleWithoutThumbsField } = tale({
      id: 't2',
      title: 'Legacy Card',
      body: 'Old function, no thumbs field.',
      mediaIds: ['legacy-1'],
    }) as KinTaleDto & { thumbs?: TaleThumbDto[] };
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        tale({ id: 'featured', title: 'Featured Card', body: 'Featured, no photos.' }),
        taleWithoutThumbsField as KinTaleDto,
      ],
      hasMore: false,
    });
    const { container } = renderScreen();

    await screen.findByText('Old function, no thumbs field.');
    expect(container.querySelectorAll('.tcstrip')).toHaveLength(0);
  });
});
