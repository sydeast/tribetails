// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Gallery } from './Gallery';
import type { GetMyKinPhotosResult } from '../api/kinTalesApi';

/**
 * The Gallery screen (#399 item 1).
 *
 * The bug it closes: the Tribe hub's "All photos" was
 * `<span class="inert" title="Coming soon">`, and there was no portal media
 * callable that could have made it work. Each test below names a state the
 * screen has to have, and asserts a state carrier rather than visibility,
 * since jsdom reports collapsed content as visible.
 */
const mocks = vi.hoisted(() => ({ getMyKinPhotos: vi.fn<() => Promise<GetMyKinPhotosResult>>() }));

vi.mock('../api/kinTalesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/kinTalesApi')>('../api/kinTalesApi');
  return { ...actual, getMyKinPhotos: () => mocks.getMyKinPhotos() };
});
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
// `to` is carried into href, because a test that cannot see a link's
// destination cannot tell a working link from the inert span it replaced.
// `title` and `className` ride along too: the portrait tiles are identified by
// the Kin's name, and the video tile by its class. `aria-label` rides along
// for the same reason real @tanstack/react-router Link forwards it: once a
// broken portrait's fallback glyph carries no text of its own, this is the
// only thing left naming the link.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    title,
    className,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    to?: string;
    title?: string;
    className?: string;
    'aria-label'?: string;
  }) => (
    <a href={to} title={title} className={className} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

function page(overrides: Partial<GetMyKinPhotosResult> = {}): GetMyKinPhotosResult {
  return { photos: [], portraits: [], hasMore: false, nextBefore: null, ...overrides };
}

function photo(id: string, overrides: Partial<GetMyKinPhotosResult['photos'][number]> = {}) {
  return {
    id,
    url: `https://cdn/${id}.jpg`,
    contentType: 'image/jpeg',
    taleId: `t-${id}`,
    taleTitle: `Tale ${id}`,
    takenAtMs: Date.now(),
    ...overrides,
  };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Gallery />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getMyKinPhotos.mockReset();
});

describe('Gallery', () => {
  it('says it is loading before the first page lands', () => {
    mocks.getMyKinPhotos.mockReturnValue(new Promise(() => {}));
    renderScreen();
    expect(screen.getByTestId('gallery-loading')).toBeInTheDocument();
  });

  it('explains the empty archive instead of showing a bare grid', async () => {
    mocks.getMyKinPhotos.mockResolvedValue(page());
    renderScreen();
    const empty = await screen.findByTestId('gallery-empty');
    expect(empty.textContent).toMatch(/every kintale your auntie sends brings its pictures here/i);
    expect(screen.queryByTestId('gallery-grid')).toBeNull();
  });

  it('renders a tile per photo, captioned with the tale it came from', async () => {
    mocks.getMyKinPhotos.mockResolvedValue(page({ photos: [photo('a'), photo('b')] }));
    renderScreen();

    const grid = await screen.findByTestId('gallery-grid');
    const images = grid.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute('src')).toBe('https://cdn/a.jpg');
    expect(images[0]?.getAttribute('alt')).toBe('Tale a');
  });

  it('replaces a tile with the broken-photo glyph when its image fails to load (S9), never a dead browser glyph', async () => {
    mocks.getMyKinPhotos.mockResolvedValue(page({ photos: [photo('a')] }));
    renderScreen();

    const grid = await screen.findByTestId('gallery-grid');
    const img = grid.querySelector('img');
    expect(img).not.toBeNull();
    const caption = grid.querySelector('.gallery-tile__caption');
    expect(caption).not.toBeNull();

    // jsdom never actually fetches `src`, so it can't fail this on its own.
    // `fireEvent.error` dispatches a real DOM `error` Event at the real
    // `<img>` node, which is exactly what a 404/offline/deleted-asset load
    // failure delivers in a browser -- so this exercises the same onError
    // handler a live failure would, not a stand-in for it.
    fireEvent.error(img!);

    expect(grid.querySelectorAll('img')).toHaveLength(0);
    expect(grid.querySelector('.gallery-tile__broken')).not.toBeNull();
    // The caption is a sibling, unconditionally rendered -- it survives the
    // failure and keeps naming the tile, matching how the video branch
    // already relies on it rather than a per-state alt.
    expect(grid.querySelector('.gallery-tile__caption')).not.toBeNull();
  });

  it('draws a video as a video, never as an image that fails to load', async () => {
    mocks.getMyKinPhotos.mockResolvedValue(page({ photos: [photo('v', { contentType: 'video/mp4' })] }));
    renderScreen();

    const grid = await screen.findByTestId('gallery-grid');
    expect(grid.querySelectorAll('img')).toHaveLength(0);
    expect(grid.querySelector('.gallery-tile__video')).not.toBeNull();
  });

  it('shows Kin portraits with a link to each Kin', async () => {
    mocks.getMyKinPhotos.mockResolvedValue(
      page({ portraits: [{ kinId: 'k1', kinName: 'Biscuit', url: 'https://cdn/biscuit.jpg' }] }),
    );
    renderScreen();

    const portrait = await screen.findByTitle('Biscuit');
    expect(portrait.getAttribute('href')).toBe('/kin/$kinId');
    expect(portrait.querySelector('img')?.getAttribute('alt')).toBe('Biscuit');
  });

  it("keeps naming the Kin by aria-label when a portrait's image fails to load (S9)", async () => {
    mocks.getMyKinPhotos.mockResolvedValue(
      page({ portraits: [{ kinId: 'k1', kinName: 'Biscuit', url: 'https://cdn/biscuit.jpg' }] }),
    );
    renderScreen();

    const portrait = await screen.findByTitle('Biscuit');
    const img = portrait.querySelector('img');
    expect(img).not.toBeNull();

    fireEvent.error(img!);

    // The <img> and its alt are gone once the fallback glyph renders, so the
    // link's accessible name has to come from somewhere that survives the
    // failure -- its own aria-label, not a descendant that just disappeared.
    expect(portrait.querySelector('img')).toBeNull();
    expect(portrait.getAttribute('aria-label')).toBe('Biscuit');
  });

  it('offers older photos only when there are more, and appends them', async () => {
    mocks.getMyKinPhotos
      .mockResolvedValueOnce(page({ photos: [photo('a')], hasMore: true, nextBefore: 1000 }))
      .mockResolvedValueOnce(page({ photos: [photo('b')] }));
    renderScreen();

    const button = await screen.findByRole('button', { name: 'Show older photos' });
    await userEvent.click(button);

    await waitFor(() =>
      expect(screen.getByTestId('gallery-grid').querySelectorAll('img')).toHaveLength(2),
    );
    // The end of the archive is the end of the button too.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show older photos' })).toBeNull());
  });

  it('offers no older-photos button on a single page', async () => {
    mocks.getMyKinPhotos.mockResolvedValue(page({ photos: [photo('a')] }));
    renderScreen();
    await screen.findByTestId('gallery-grid');
    expect(screen.queryByRole('button', { name: 'Show older photos' })).toBeNull();
  });

  it('surfaces a failed read through LaunchError rather than an empty gallery', async () => {
    mocks.getMyKinPhotos.mockRejectedValue(new Error('network down'));
    renderScreen();
    expect(await screen.findByText(/trouble loading your tribe/i)).toBeInTheDocument();
  });

  it('surfaces a permission refusal the same way, never as "no photos yet"', async () => {
    mocks.getMyKinPhotos.mockRejectedValue(
      Object.assign(new Error('permission-denied'), { code: 'functions/permission-denied' }),
    );
    renderScreen();
    expect(await screen.findByText(/trouble loading your tribe/i)).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-empty')).toBeNull();
  });
});
