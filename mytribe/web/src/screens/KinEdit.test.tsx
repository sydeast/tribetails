// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KinEdit } from './KinEdit';
import type { GetMyKinResult, KinDto } from '../api/types';

const mocks = vi.hoisted(() => ({
  getMyKin: vi.fn<() => Promise<GetMyKinResult>>(),
  updateKin: vi.fn<(kinId: string, kin: unknown, kinfolkId?: string) => Promise<{ ok: true }>>(),
  navigate: vi.fn(),
  // The seeded breed bank behind the Breed dropdown, stubbed so no test in this
  // file reaches the `getBreeds` callable.
  getBreeds: vi.fn<() => Promise<{ dogBreeds: string[]; catBreeds: string[] }>>(),
}));

vi.mock('../api/portal', () => ({
  getMyKin: () => mocks.getMyKin(),
  updateKin: (kinId: string, kin: unknown, kinfolkId?: string) => mocks.updateKin(kinId, kin, kinfolkId),
}));
vi.mock('../api/breeds', async (orig) => ({
  ...(await orig<typeof import('../api/breeds')>()),
  BREEDS_QUERY: { queryKey: ['breeds'], queryFn: () => mocks.getBreeds(), staleTime: Infinity },
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ kinId: 'k1' }),
  useNavigate: () => mocks.navigate,
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
      <KinEdit />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getMyKin.mockReset();
  mocks.updateKin.mockReset();
  mocks.navigate.mockReset();
  mocks.getMyKin.mockResolvedValue({ kin: [kin()] });
  mocks.updateKin.mockResolvedValue({ ok: true });
  mocks.getBreeds.mockReset();
  mocks.getBreeds.mockResolvedValue({
    dogBreeds: ['Border Collie', 'Boxer'],
    catBreeds: ['Bengal'],
  });
});

describe('KinEdit', () => {
  it('opens a stored species the picker does not list on Other with its text intact (#1313)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ species: 'Ferret' })] });
    renderScreen();
    const picker = (await screen.findByLabelText(/^Species/i)) as HTMLSelectElement;
    expect(picker.value).toBe('Other');
    expect((screen.getByLabelText('Other species') as HTMLInputElement).value).toBe('Ferret');
  });
  it('matches a stored species case-insensitively without rewriting it (#1313)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ species: 'cat' })] });
    renderScreen();
    const picker = (await screen.findByLabelText(/^Species/i)) as HTMLSelectElement;
    expect(picker.value).toBe('Cat');
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
  });
  it('changing species through the picker sends only species', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText(/^Species/i), 'Cat');
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledTimes(1));
    expect(mocks.updateKin).toHaveBeenCalledWith('k1', { species: 'Cat' }, 'fam1');
  });
  it('shows the shared facts from the kin and saves only the one that changed (#1310)', async () => {
    mocks.getMyKin.mockResolvedValue({
      kin: [kin({ sex: 'Female', weight: '52 lbs', colorMarkings: 'Black', spayedNeutered: true, vetInfo: 'Dr A' })],
    });
    const user = userEvent.setup();
    renderScreen();
    expect(((await screen.findByLabelText('Sex')) as HTMLSelectElement).value).toBe('Female');
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('52 lbs');
    expect((screen.getByLabelText('Color / markings') as HTMLInputElement).value).toBe('Black');
    expect((screen.getByLabelText(/Spayed \/ neutered/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Vet') as HTMLTextAreaElement).value).toBe('Dr A');

    const weight = screen.getByLabelText('Weight');
    await user.clear(weight);
    await user.type(weight, '55 lbs');
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledTimes(1));
    expect(mocks.updateKin).toHaveBeenCalledWith('k1', { weight: '55 lbs' }, 'fam1');
  });

  it('edits sex, the fixed flag and the vet, and clears a field with an empty string (#1310)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ weight: '52 lbs' })] });
    const user = userEvent.setup();
    renderScreen();
    await user.selectOptions(await screen.findByLabelText('Sex'), 'Male');
    await user.click(screen.getByLabelText(/Spayed \/ neutered/));
    await user.type(screen.getByLabelText('Vet'), 'Riverside Animal Hospital');
    await user.clear(screen.getByLabelText('Weight'));
    await user.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledTimes(1));
    expect(mocks.updateKin).toHaveBeenCalledWith(
      'k1',
      { sex: 'Male', weight: '', vetInfo: 'Riverside Animal Hospital', spayedNeutered: true },
      'fam1',
    );
  });

  it('keeps a legacy sex value the admin wrote (F) selectable instead of rewriting it (#1310)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ sex: 'F' })] });
    renderScreen();
    expect(((await screen.findByLabelText('Sex')) as HTMLSelectElement).value).toBe('F');
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
  });

  it('prefills the form from the existing kin', async () => {
    renderScreen();
    const nameInput = (await screen.findByLabelText(/Name/i)) as HTMLInputElement;
    expect(nameInput.value).toBe('Buddy');
    expect((screen.getByLabelText(/Species/i) as HTMLSelectElement).value).toBe('Dog');
    expect((screen.getByLabelText(/Age/i) as HTMLInputElement).value).toBe('3');
  });

  it('sends only the changed field and navigates back to the kin detail on success', async () => {
    const user = userEvent.setup();
    renderScreen();
    const nameInput = await screen.findByLabelText(/Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Rex');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledTimes(1));
    expect(mocks.updateKin).toHaveBeenCalledWith('k1', { name: 'Rex' }, 'fam1');
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kin/$kinId', params: { kinId: 'k1' } }));
  });

  it('blocks submit and shows an inline error when the name is cleared', async () => {
    const user = userEvent.setup();
    renderScreen();
    const nameInput = await screen.findByLabelText(/Name/i);
    await user.clear(nameInput);

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
    expect(mocks.updateKin).not.toHaveBeenCalled();
  });

  it('rejects a non-http photo URL before calling updateKin', async () => {
    const user = userEvent.setup();
    renderScreen();
    const photo = await screen.findByLabelText(/Photo URL/i);
    await user.type(photo, 'javascript:alert(1)');

    expect(await screen.findByText(/must start with http/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
    expect(mocks.updateKin).not.toHaveBeenCalled();
  });

  it('surfaces a failed save instead of swallowing it (fail loud)', async () => {
    mocks.updateKin.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    const user = userEvent.setup();
    renderScreen();
    const nameInput = await screen.findByLabelText(/Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Rex');

    await user.click(screen.getByRole('button', { name: /Save/i }));

    expect(await screen.findByText('Missing or insufficient permissions.')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  describe('breed dropdown', () => {
    it('offers the seeded dog bank and sends the picked breed', async () => {
      const user = userEvent.setup();
      renderScreen();
      await user.click(await screen.findByLabelText('Breed'));
      await user.click(await screen.findByRole('option', { name: 'Boxer' }));
      await user.click(screen.getByRole('button', { name: /Save/i }));

      await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledTimes(1));
      expect(mocks.updateKin).toHaveBeenCalledWith('k1', { breed: 'Boxer' }, 'fam1');
    });

    it('follows Species to the cat bank', async () => {
      mocks.getMyKin.mockResolvedValue({ kin: [kin({ species: 'Cat' })] });
      const user = userEvent.setup();
      renderScreen();
      await user.click(await screen.findByLabelText('Breed'));
      const options = await screen.findAllByTestId('breedfield-option');
      expect(options.map((o) => o.textContent)).toEqual(['Bengal']);
    });

    it('still sends a breed the bank has never heard of', async () => {
      const user = userEvent.setup();
      renderScreen();
      await user.type(await screen.findByLabelText('Breed'), 'Lab / pit mix');
      await user.click(screen.getByRole('button', { name: /Save/i }));
      await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledTimes(1));
      expect(mocks.updateKin).toHaveBeenCalledWith('k1', { breed: 'Lab / pit mix' }, 'fam1');
    });

    it('discloses a failed bank load instead of showing an empty dropdown', async () => {
      mocks.getBreeds.mockRejectedValue(new Error('deadline-exceeded'));
      renderScreen();
      expect(await screen.findByTestId('breedfield-note')).toHaveTextContent(
        'Breed list unavailable right now, type it in.',
      );
      // The field still works: breed is free text either way.
      expect(await screen.findByLabelText('Breed')).toBeEnabled();
    });
  });
});
