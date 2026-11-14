// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KinDetail } from './KinDetail';
import type { GetMyKinResult, KinDto } from '../api/types';
const mocks = vi.hoisted(() => ({
  getMyKin: vi.fn<() => Promise<GetMyKinResult>>(),
  getMyTribeProfile: vi.fn(),
  getVetClinics: vi.fn(),
}));
vi.mock('../api/portal', () => ({ getMyKin: () => mocks.getMyKin() }));
vi.mock('../api/tribeApi', async (orig) => ({
  ...(await orig<typeof import('../api/tribeApi')>()),
  getMyTribeProfile: () => mocks.getMyTribeProfile(),
  getVetClinics: () => mocks.getVetClinics(),
}));
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
    staysAs: null,
    routine: null,
    trainingCommands: null,
    feedingBrand: null,
    vaccinations: null,
    ownVetClinicId: '',
    vet: null,
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
describe('KinDetail browser tab (#2007)', () => {
  it('names the Kin once it has loaded, never the id from the address', async () => {
    document.title = '';
    mocks.getMyKin.mockResolvedValue({ kin: [kin()] });
    renderScreen();
    await screen.findByText('Spayed / neutered');
    expect(document.title).toBe('Buddy · MyTribe');
    expect(document.title).not.toContain('k1');
  });
});
describe('KinDetail shared facts (#1310)', () => {
  it('shows sex, weight, markings and the fixed flag', async () => {
    mocks.getMyKin.mockResolvedValue({
      kin: [kin({ sex: 'Female', weight: '52 lbs', colorMarkings: 'Black', spayedNeutered: true })],
    });
    renderScreen();
    expect(await screen.findByText('Female')).toBeInTheDocument();
    for (const text of ['52 lbs', 'Black', 'Yes']) expect(screen.getByText(text)).toBeInTheDocument();
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
describe('KinDetail #1908: the care facts and the one medications field', () => {
  it('shows each care fact the office or the household filled in, under the shared labels', async () => {
    mocks.getMyKin.mockResolvedValue({
      kin: [kin({ staysAs: 'Crate at night', routine: 'Walk at 7', trainingCommands: 'Sit, stay', feedingBrand: 'Acme kibble', vaccinations: 'Rabies 2027', medications: 'Thyroid tablet', sitterNotes: 'Leash by the door' })],
    });
    renderScreen();
    for (const text of ['Crate at night', 'Walk at 7', 'Sit, stay', 'Acme kibble', 'Rabies 2027', 'Thyroid tablet', 'Leash by the door']) {
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
    for (const label of ['Stays as', 'Routine', 'Training / commands', 'Food / brand', 'Vaccinations', 'Medications / health notes', 'Notes for your Auntie']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/sitter/i)).toBeNull();
  });
});
describe('KinDetail #1908 kin-vet: the vet the Kin goes to', () => {
  const HOME = { id: 'home', name: 'Cedar Animal Care', phone: '', address: '1 Main St', isEmergency: false };
  const OWN = { id: 'own', name: 'Riverside Vets', phone: '', address: '2 River Rd', isEmergency: false };
  it('the household vet, marked as from the Tribe Profile', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ vet: { clinic: HOME, fromHousehold: true } })] });
    renderScreen();
    expect(await screen.findByTestId('kin-vet')).toHaveTextContent('Cedar Animal Care · 1 Main St (your Tribe Profile vet)');
  });
  it('a vet of its own, not marked', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ ownVetClinicId: 'own', vet: { clinic: OWN, fromHousehold: false } })] });
    renderScreen();
    expect(await screen.findByTestId('kin-vet')).toHaveTextContent(/^Riverside Vets · 2 River Rd$/);
  });
  it('the old free-text note only when no clinic resolves', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ vet: null, vetInfo: 'Dr A, 555 0100' })] });
    renderScreen();
    expect(await screen.findByTestId('kin-vet')).toHaveTextContent('On file: Dr A, 555 0100');
  });
  it('a roster read straight from Firestore resolves the household vet from the Tribe Profile', async () => {
    const direct = { ...kin() } as Partial<KinDto>;
    delete direct.vet;
    mocks.getMyKin.mockResolvedValue({ kin: [direct as KinDto] });
    mocks.getMyTribeProfile.mockResolvedValue({ profile: { kinfolkId: 'fam1', displayName: 'X', customFields: [] }, vetClinic: HOME, homeAccess: {} });
    mocks.getVetClinics.mockResolvedValue({ clinics: [] });
    renderScreen();
    expect(await screen.findByText('Cedar Animal Care · 1 Main St (your Tribe Profile vet)')).toBeInTheDocument();
  });
});
