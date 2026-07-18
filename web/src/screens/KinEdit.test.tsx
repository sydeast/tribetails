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
}));

vi.mock('../api/portal', () => ({
  getMyKin: () => mocks.getMyKin(),
  updateKin: (kinId: string, kin: unknown, kinfolkId?: string) => mocks.updateKin(kinId, kin, kinfolkId),
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
    aiBlurb: null,
    feedingInstructions: null,
    walkingInstructions: null,
    medications: null,
    allergies: null,
    emergencyNotes: null,
    sitterNotes: null,
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
});

describe('KinEdit', () => {
  it('prefills the form from the existing kin', async () => {
    renderScreen();
    const nameInput = (await screen.findByLabelText(/Name/i)) as HTMLInputElement;
    expect(nameInput.value).toBe('Buddy');
    expect((screen.getByLabelText(/Species/i) as HTMLInputElement).value).toBe('Dog');
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
});
