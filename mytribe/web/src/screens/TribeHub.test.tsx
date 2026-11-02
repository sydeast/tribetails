// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GALLERY_CARD_PAGE, GALLERY_CARD_THUMBS, TribeHub } from './TribeHub';
import { PHOTO_UNAVAILABLE_GLYPH } from '../components/FallbackImage';

/**
 * The Tribe hub's Gallery card (#399 item 1).
 *
 * "All photos" was `<span class="inert" title="Coming soon">`: it looked like a
 * link, could not be focused or followed, and had nowhere to go because there
 * was no portal media callable at all. This file exists to keep it a link.
 */
const mocks = vi.hoisted(() => ({
  getMyKin: vi.fn(),
  getMyKinTales: vi.fn(),
  getMyKinPhotos: vi.fn(),
  getMyTribeProfile: vi.fn(),
}));

// getMyKinTales stays mocked so a test can prove the page never asks for it.
vi.mock('../api/portal', () => ({
  getMyKin: () => mocks.getMyKin(),
  getMyKinTales: () => mocks.getMyKinTales(),
}));
vi.mock('../api/kinTalesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/kinTalesApi')>('../api/kinTalesApi');
  return { ...actual, getMyKinPhotos: (...a: unknown[]) => mocks.getMyKinPhotos(...a) };
});
vi.mock('../api/tribeApi', () => ({ getMyTribeProfile: () => mocks.getMyTribeProfile() }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
// `to` is carried into href: a test that cannot see a link's destination cannot
// tell a working link from the inert span it replaced. The other props ride
// along too, so the #1454 specs below can read the button's class.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const KIN_WITH_PHOTO = {
  id: 'k1',
  name: 'Biscuit',
  species: 'dog',
  breed: 'Corgi',
  ageYears: 3,
  photoUrl: 'https://cdn/biscuit.jpg',
  status: 'active',
};

const EMPTY_MEDIA = { photos: [], portraits: [], hasMore: false, nextBefore: null };

function photo(id: string, contentType: string | null = 'image/jpeg') {
  return { id, url: `https://cdn/${id}.jpg`, contentType, taleId: `t-${id}`, taleTitle: `Tale ${id}`, takenAtMs: 1_700_000_000_000 };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TribeHub />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getMyKin.mockReset();
  mocks.getMyKinTales.mockReset();
  mocks.getMyKinPhotos.mockReset();
  mocks.getMyTribeProfile.mockReset();
  mocks.getMyKinTales.mockResolvedValue({ tales: [], hasMore: false });
  mocks.getMyKinPhotos.mockResolvedValue(EMPTY_MEDIA);
  mocks.getMyTribeProfile.mockRejectedValue(new Error('not needed here'));
});

/**
 * #1454 (operator ruling on #1295): "On full web, the edit Tribe can stay but
 * does not need to be at the very top as it is. Either off to the side or at
 * the bottom of the page. On Android/mobile web, the edit option should only be
 * under the account icon."
 *
 * So the page's own Edit Tribe Profile button comes after the last card, and at
 * phone width it is not shown at all; the avatar menu (AvatarMenu.test.tsx) is
 * the only entry there. jsdom has no layout and loads no stylesheet, so the
 * phone half is pinned the way styles/tabbarOwnership.test.ts pins the tab bar:
 * the button carries `.tribehub-edit`, and base.css hides that class under the
 * same `max-width: 880px` query that hides `.navlinks` for the phone tab bar.
 */
describe('TribeHub Edit Tribe Profile button (#1454)', () => {
  const stylesDir = resolve(__dirname, '../styles');
  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** Bodies of every `@media (max-width: 880px)` block in a sheet. */
  const phoneBlocks = (css: string) =>
    Array.from(stripComments(css).matchAll(/@media\s*\(max-width:\s*880px\)\s*\{([\s\S]*?)\n\}/g), (m) => m[1] ?? '');

  const editButton = async () => {
    const links = await screen.findAllByRole('link', { name: /Edit Tribe Profile/ });
    expect(links).toHaveLength(1);
    return links[0]!;
  };

  it('is a real link to the editor, after the last card and not under the heading', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [KIN_WITH_PHOTO] });
    renderScreen();
    const button = await editButton();
    expect(button.tagName).toBe('A');
    expect(button).toHaveAttribute('href', '/tribe/edit');
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['btn', 'ghost', 'tribehub-edit']));

    const heading = screen.getByRole('heading', { level: 1 });
    const cards = Array.from(document.querySelectorAll('section.glass.card'));
    expect(cards.length).toBeGreaterThan(0);
    const lastCard = cards[cards.length - 1]!;
    const follows = (a: Node, b: Node) => (b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(button, heading)).toBe(true);
    expect(follows(button, lastCard)).toBe(true);
    // Nothing between the heading and the first card is the button any more.
    expect(heading.closest('header')?.nextElementSibling?.classList.contains('stack')).toBe(true);
  });

  it('leaves the Home Information card its own Edit link', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    renderScreen();
    await editButton();
    const homeInfo = screen.getByText('Home Information').closest('section');
    const cardEdit = within(homeInfo!).getByRole('link', { name: 'Edit' });
    expect(cardEdit).toHaveAttribute('href', '/tribe/edit');
  });

  it('is hidden at phone width by base.css, under the same query that hides the desktop nav links', () => {
    const base = readFileSync(resolve(stylesDir, 'base.css'), 'utf8');
    const hidesEdit = phoneBlocks(base).filter((body) => /\.tribehub-edit\s*\{\s*display:\s*none;?\s*\}/.test(body));
    expect(hidesEdit).toHaveLength(1);
    expect(hidesEdit[0]).toMatch(/\.navlinks\s*\{\s*display:\s*none;?\s*\}/);
  });

  it('is declared by base.css alone, so no later sheet can show it on a phone again (#1419)', () => {
    const owners = readdirSync(stylesDir)
      .filter((f) => f.endsWith('.css') && f !== 'base.css')
      .filter((f) => /(^|[^\w-])\.tribehub-edit(?![\w-])[^{]*\{/m.test(stripComments(readFileSync(resolve(stylesDir, f), 'utf8'))));
    expect(owners).toEqual([]);
  });
});

describe('TribeHub gallery card', () => {
  const card = () => screen.getByTestId('tribe-gallery');

  it('sends "All photos" to the Gallery screen instead of nowhere', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [KIN_WITH_PHOTO] });
    renderScreen();

    const link = await screen.findByText('All photos');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/gallery');
    expect(link.getAttribute('title')).toBeNull();
  });

  // #1463: the card is always drawn, even before the household has any media.
  it('is drawn with a short empty line and the All photos link when there is no media yet', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [{ ...KIN_WITH_PHOTO, photoUrl: null }] });
    renderScreen();

    const empty = await screen.findByTestId('tribe-gallery-empty');
    expect(empty.textContent).toBe('No photos yet.');
    expect(within(card()).getByText('All photos')).toHaveAttribute('href', '/gallery');
    expect(card().querySelector('.gallery-thumb')).toBeNull();
  });

  it('does not claim there are no photos when only the newest tales lack them', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    mocks.getMyKinPhotos.mockResolvedValue({ ...EMPTY_MEDIA, hasMore: true, nextBefore: 1 });
    renderScreen();

    const empty = await screen.findByTestId('tribe-gallery-empty');
    expect(empty.textContent).toBe('No recent photos. Older ones are in All photos.');
  });

  it('shows a loading cue while the photos load, with All photos still there', () => {
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    mocks.getMyKinPhotos.mockReturnValue(new Promise(() => {}));
    renderScreen();

    expect(within(card()).getByRole('status').textContent).toContain('Loading your photos');
    expect(within(card()).getByText('All photos')).toHaveAttribute('href', '/gallery');
  });

  it('draws its thumbnails from getMyKinPhotos, KinTale media first, then portraits, not the roster', async () => {
    // The roster has a photo the server does not list, which proves the card
    // no longer reads the roster.
    mocks.getMyKin.mockResolvedValue({ kin: [{ ...KIN_WITH_PHOTO, photoUrl: 'https://cdn/roster-only.jpg' }] });
    mocks.getMyKinPhotos.mockResolvedValue({
      photos: [photo('m1'), photo('m2', 'video/mp4')],
      portraits: [{ kinId: 'k1', kinName: 'Biscuit', url: 'https://cdn/biscuit-portrait.jpg' }],
      hasMore: false,
      nextBefore: null,
    });
    renderScreen();

    await waitFor(() => expect(card().querySelectorAll('.gallery-thumb')).toHaveLength(3));
    const thumbs = Array.from(card().querySelectorAll('.gallery-thumb'));
    expect(thumbs.map((t) => t.getAttribute('title'))).toEqual(['Tale m1', 'Tale m2', 'Biscuit']);
    expect(thumbs[0]!.querySelector('img')).toHaveAttribute('src', 'https://cdn/m1.jpg');
    // A video is a play glyph, never an <img> pointed at an mp4.
    expect(thumbs[1]!.querySelector('img')).toBeNull();
    expect(thumbs[1]!.textContent).toContain('\u{25B6}');
    expect(thumbs[2]!.querySelector('img')).toHaveAttribute('src', 'https://cdn/biscuit-portrait.jpg');
    expect(card().innerHTML).not.toContain('roster-only.jpg');
    expect(mocks.getMyKinPhotos).toHaveBeenCalledWith('kin-fam-1', { limit: GALLERY_CARD_PAGE });
  });

  it(`draws at most ${GALLERY_CARD_THUMBS} thumbnails`, async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    mocks.getMyKinPhotos.mockResolvedValue({
      ...EMPTY_MEDIA,
      photos: Array.from({ length: GALLERY_CARD_THUMBS + 3 }, (_, i) => photo(`m${i}`)),
    });
    renderScreen();

    await waitFor(() => expect(card().querySelectorAll('.gallery-thumb')).toHaveLength(GALLERY_CARD_THUMBS));
  });

  // #1463: the KinTales section repeated the Tales tab and is gone.
  it('has no KinTales section and no "All tales" link, and never asks for KinTales', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [KIN_WITH_PHOTO] });
    renderScreen();

    await screen.findByTestId('tribe-gallery-empty');
    expect(screen.queryByText('KinTales')).toBeNull();
    expect(screen.queryByText('All tales')).toBeNull();
    expect(document.querySelector('a[href="/kintales"]')).toBeNull();
    expect(mocks.getMyKinTales).not.toHaveBeenCalled();
  });

  it('shows the species emoji, not a dead glyph, when a roster photo fails to load (S9)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [KIN_WITH_PHOTO] });
    renderScreen();

    const row = (await screen.findByText('Biscuit')).closest('a');
    const img = row?.querySelector('img');
    expect(img).toBeTruthy();

    fireEvent.error(img!);

    expect(row?.querySelector('img')).toBeNull();
    expect(row?.textContent).toContain('\u{1F436}');
  });

  it('shows the broken-photo glyph, not a dead browser glyph, when a gallery thumb fails to load (S9)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    mocks.getMyKinPhotos.mockResolvedValue({ ...EMPTY_MEDIA, photos: [photo('m1')] });
    renderScreen();

    await waitFor(() => expect(card().querySelector('.gallery-thumb img')).toBeTruthy());
    const thumb = card().querySelector('.gallery-thumb')!;
    fireEvent.error(thumb.querySelector('img')!);

    expect(thumb.querySelector('img')).toBeNull();
    expect(thumb.textContent).toContain(PHOTO_UNAVAILABLE_GLYPH);
  });

  // #1325: Home Information listed only "Key location on file" after a clinic was
  // chosen, because it read the pre-picker `vetClinicName` row.
  describe('the vet clinic (#1325)', () => {
    const PROFILE_BASE = {
      profile: { kinfolkId: 'kin-fam-1', displayName: 'The Ramirez Tribe', customFields: [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'm5rTfebiqMxckecn4OCM' }] },
      homeAccess: { gateCode: null, keyLocation: 'Under the planter', wifiPassword: null, customFields: [], updatedAtMs: null },
    };
    it('shows the chosen clinic by name, address and formatted phone, never its id', async () => {
      mocks.getMyKin.mockResolvedValue({ kin: [] });
      mocks.getMyTribeProfile.mockResolvedValue({
        ...PROFILE_BASE,
        vetClinic: { id: 'm5rTfebiqMxckecn4OCM', name: 'Banfield Pet Hospital', phone: '+18055550123', address: '1 Main St', isEmergency: false },
      });
      renderScreen();
      expect(await screen.findByText('Vet: Banfield Pet Hospital · 1 Main St · (805) 555-0123')).toBeInTheDocument();
      expect(screen.getByText('Key location on file')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('m5rTfebiqMxckecn4OCM');
      expect(document.body.textContent).not.toContain('+1805');
    });
    it('falls back to the pre-picker clinic name, and shows nothing for a bare id', async () => {
      mocks.getMyKin.mockResolvedValue({ kin: [] });
      mocks.getMyTribeProfile.mockResolvedValue({
        ...PROFILE_BASE,
        profile: { ...PROFILE_BASE.profile, customFields: [...PROFILE_BASE.profile.customFields, { key: 'vetClinicName', label: 'Vet', value: 'Old Town Vet' }] },
      });
      renderScreen();
      expect(await screen.findByText('Vet: Old Town Vet')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('m5rTfebiqMxckecn4OCM');
    });
  });
});
