// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TribeHub } from './TribeHub';

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
  getMyTribeProfile: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyKin: () => mocks.getMyKin(),
  getMyKinTales: () => mocks.getMyKinTales(),
}));
vi.mock('../api/tribeApi', () => ({ getMyTribeProfile: () => mocks.getMyTribeProfile() }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
// `to` is carried into href: a test that cannot see a link's destination cannot
// tell a working link from the inert span it replaced.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
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
  mocks.getMyTribeProfile.mockReset();
  mocks.getMyKinTales.mockResolvedValue({ tales: [], hasMore: false });
  mocks.getMyTribeProfile.mockRejectedValue(new Error('not needed here'));
});

describe('TribeHub gallery card', () => {
  it('sends "All photos" to the Gallery screen instead of nowhere', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [KIN_WITH_PHOTO] });
    renderScreen();

    const link = await screen.findByText('All photos');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/gallery');
    expect(link.getAttribute('title')).toBeNull();
  });

  it('shows no gallery card at all when no Kin has a photo yet', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [{ ...KIN_WITH_PHOTO, photoUrl: null }] });
    renderScreen();

    await screen.findByText('Biscuit');
    expect(screen.queryByText('All photos')).toBeNull();
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

  it('shows the species emoji, not a dead glyph, when a gallery thumb photo fails to load (S9)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [KIN_WITH_PHOTO] });
    renderScreen();

    const link = await screen.findByText('All photos');
    const card = link.closest('section');
    const thumb = card?.querySelector('.gallery-thumb');
    const img = thumb?.querySelector('img');
    expect(img).toBeTruthy();

    fireEvent.error(img!);

    expect(thumb?.querySelector('img')).toBeNull();
    expect(thumb?.textContent).toContain('\u{1F436}');
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
