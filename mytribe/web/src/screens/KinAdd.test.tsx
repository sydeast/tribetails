// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KinAdd } from './KinAdd';

const mocks = vi.hoisted(() => ({
  addKin: vi.fn<(kin: unknown, kinfolkId?: string) => Promise<{ kinId: string }>>(),
  navigate: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  addKin: (kin: unknown, kinfolkId?: string) => mocks.addKin(kin, kinfolkId),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <KinAdd />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.addKin.mockReset();
  mocks.navigate.mockReset();
  mocks.addKin.mockResolvedValue({ kinId: 'new-1' });
});

describe('KinAdd', () => {
  it('starts with every field blank and no error showing before the user has typed anything (#1312)', () => {
    renderScreen();
    expect((screen.getByLabelText(/^Name/i) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Name is required.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Fix the highlighted fields/i)).not.toBeInTheDocument();
  });
  it('shows the name error after the field is left empty, and on an Add tap, without calling addKin (#1312)', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByLabelText(/^Name/i));
    await user.tab();
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(mocks.addKin).not.toHaveBeenCalled();
  });
  it('an Add tap on the untouched form reveals the error instead of doing nothing (#1312)', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(mocks.addKin).not.toHaveBeenCalled();
  });
  it('species is a picker, and Other opens a free-text box whose text is what is saved (#1313)', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText(/^Name/i), 'Moss');
    const picker = screen.getByLabelText(/^Species/i) as HTMLSelectElement;
    expect(picker.tagName).toBe('SELECT');
    expect(Array.from(picker.options).map((o) => o.text)).toEqual([
      'Choose a species', 'Dog', 'Cat', 'Bird', 'Rabbit', 'Reptile', 'Small mammal', 'Other',
    ]);
    expect(screen.queryByLabelText('Other species')).not.toBeInTheDocument();
    await user.selectOptions(picker, 'Other');
    await user.type(screen.getByLabelText('Other species'), 'Ferret');
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    await waitFor(() => expect(mocks.addKin).toHaveBeenCalledTimes(1));
    expect(mocks.addKin).toHaveBeenCalledWith(expect.objectContaining({ name: 'Moss', species: 'Ferret' }), 'fam1');
  });
  it('does not render the card-head explanatory copy', () => {
    renderScreen();
    expect(screen.queryByText(/The basics your Aunties see first/i)).not.toBeInTheDocument();
  });

  it('happy path: submits the full payload and navigates to the new profile', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.selectOptions(screen.getByLabelText(/^Species/i), 'Dog');
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));

    await waitFor(() => expect(mocks.addKin).toHaveBeenCalledTimes(1));
    expect(mocks.addKin).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Rex', species: 'Dog', breed: null, ageYears: null }),
      'fam1',
    );
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kin/$kinId', params: { kinId: 'new-1' } }));
  });

  it('sad / negative path: blocks submit and shows an inline error for a whitespace-only name', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), '   ');
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    expect(mocks.addKin).not.toHaveBeenCalled();
  });

  it('rejects a non-http photo URL before calling addKin', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.type(screen.getByLabelText(/Photo URL/i), 'javascript:alert(1)');

    expect(await screen.findByText(/must start with http/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    expect(mocks.addKin).not.toHaveBeenCalled();
  });

  it('error path: surfaces a failed save instead of swallowing it (fail loud)', async () => {
    mocks.addKin.mockRejectedValue(new Error('Could not reach the server. Try again.'));
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));

    expect(await screen.findByText('Could not reach the server. Try again.')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('unauthorized path: surfaces a permission-denied rejection verbatim', async () => {
    mocks.addKin.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));

    expect(await screen.findByText('Missing or insufficient permissions.')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
