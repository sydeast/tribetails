// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KinDetail } from './KinDetail';
import type { GetMyKinResult, KinDto } from '../api/types';
const mocks = vi.hoisted(() => ({
  getMyKin: vi.fn<() => Promise<GetMyKinResult>>(),
}));
vi.mock('../api/portal', () => ({ getMyKin: () => mocks.getMyKin() }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ kinId: 'k1' }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
function kin(overrides: Partial<KinDto> = {}): KinDto {
  return {
    id: 'k1',
    name: 'Buddy',
    species: 'Dog',
    breed: null,
    ageYears: 3,
    photoUrl: null,
    status: 'active',
    feedingInstructions: null,
    walkingInstructions: null,
    medications: null,
    allergies: null,
    emergencyNotes: null,
    sitterNotes: null,
    sex: null,
    weight: null,
    colorMarkings: null,
    spayedNeutered: false,
    vetInfo: null,
    ...overrides,
  };
}
function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <KinDetail />
    </QueryClientProvider>,
  );
}
describe('KinDetail shared facts (#1310)', () => {
  it('shows sex, weight, markings, fixed flag and vet', async () => {
    mocks.getMyKin.mockResolvedValue({
      kin: [kin({ sex: 'Female', weight: '52 lbs', colorMarkings: 'Black', spayedNeutered: true, vetInfo: 'Riverside Animal Hospital' })],
    });
    renderScreen();
    expect(await screen.findByText('Riverside Animal Hospital')).toBeInTheDocument();
    for (const text of ['Female', '52 lbs', 'Black', 'Yes']) expect(screen.getByText(text)).toBeInTheDocument();
  });
  it('shows Not set for the ones nobody filled in', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin()] });
    renderScreen();
    await screen.findByText('Spayed / neutered');
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(5);
  });
});

describe('KinDetail memorial (#1311)', () => {
  it('has no Memorial card, Suggestion badge or mark action for an active kin', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin()] });
    renderScreen();
    await screen.findByText('Buddy');
    expect(screen.queryByText('Memorial')).toBeNull();
    expect(screen.queryByText('Suggestion')).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark No Longer With Us/ })).toBeNull();
    expect(screen.queryByText('In our hearts')).toBeNull();
  });
  it('keeps the "In our hearts" band for a memorial kin but offers no Restore here', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ status: 'noLongerWithUs' })] });
    renderScreen();
    expect(await screen.findByText(/In our hearts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore as Active/ })).toBeNull();
    expect(screen.queryByText('Memorial')).toBeNull();
  });
});
