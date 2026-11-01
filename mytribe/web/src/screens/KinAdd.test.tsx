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
  uploadKinPhotoSigned: vi.fn<(kinId: string, file: File, kinfolkId?: string) => Promise<string>>(),
}));

vi.mock('../api/portal', () => ({
  addKin: (kin: unknown, kinfolkId?: string) => mocks.addKin(kin, kinfolkId),
}));
vi.mock('../api/kinPhotoApi', async (orig) => ({
  ...(await orig<typeof import('../api/kinPhotoApi')>()),
  uploadKinPhotoSigned: (kinId: string, file: File, kinfolkId?: string) =>
    mocks.uploadKinPhotoSigned(kinId, file, kinfolkId),
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

const PHOTO = new File(['bytes'], 'rex.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  mocks.uploadKinPhotoSigned.mockReset();
  mocks.uploadKinPhotoSigned.mockResolvedValue('https://res.cloudinary.com/demo/image/upload/v1/rex.jpg');
  // jsdom has no object URLs; the preview only needs a stable string.
  URL.createObjectURL = vi.fn(() => 'blob:preview-1');
  URL.revokeObjectURL = vi.fn();
  mocks.addKin.mockReset();
  mocks.navigate.mockReset();
  mocks.addKin.mockResolvedValue({ kinId: 'new-1' });
});

describe('KinAdd', () => {
  it('starts with every field blank and Save disabled (name required)', () => {
    renderScreen();
    expect((screen.getByLabelText(/^Name/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /Add Kin/i })).toBeDisabled();
  });

  it('happy path: submits the full payload and navigates to the new profile', async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.type(screen.getByLabelText(/^Species/i), 'Dog');
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
    expect(screen.getByRole('button', { name: /Add Kin/i })).toBeDisabled();
    expect(mocks.addKin).not.toHaveBeenCalled();
  });

  it('#1291: has no Photo URL text box, and sends no photoUrl when no photo was picked', async () => {
    const user = userEvent.setup();
    renderScreen();
    expect(screen.queryByLabelText(/Photo URL/i)).toBeNull();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    await waitFor(() => expect(mocks.addKin).toHaveBeenCalledTimes(1));
    expect(mocks.addKin.mock.calls[0]![0]).not.toHaveProperty('photoUrl');
    expect(mocks.uploadKinPhotoSigned).not.toHaveBeenCalled();
  });

  it('#1291: a picked photo previews before saving, then uploads for the NEW kinId after addKin', async () => {
    const user = userEvent.setup();
    const { container } = renderScreen();

    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, PHOTO);
    await waitFor(() => expect(container.querySelector('img.siu-img')?.getAttribute('src')).toBe('blob:preview-1'));
    // Nothing leaves the device until the household taps Add Kin.
    expect(mocks.uploadKinPhotoSigned).not.toHaveBeenCalled();
    expect(mocks.addKin).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    await waitFor(() => expect(mocks.uploadKinPhotoSigned).toHaveBeenCalledWith('new-1', PHOTO, 'fam1'));
    expect(mocks.addKin.mock.invocationCallOrder[0]!).toBeLessThan(mocks.uploadKinPhotoSigned.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kin/$kinId', params: { kinId: 'new-1' } }));
  });

  it('#1291: shows an upload cue on the button while the photo is going up', async () => {
    let finish: (url: string) => void = () => {};
    mocks.uploadKinPhotoSigned.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    const { container } = renderScreen();
    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, PHOTO);
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    expect(await screen.findByRole('button', { name: /Uploading photo…/ })).toBeDisabled();
    finish('https://res.cloudinary.com/demo/image/upload/v1/rex.jpg');
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
  });

  it('#1291: Remove Photo before saving drops the picked file', async () => {
    const user = userEvent.setup();
    const { container } = renderScreen();
    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, PHOTO);
    await user.click(await screen.findByRole('button', { name: 'Remove Photo' }));
    await waitFor(() => expect(container.querySelector('img.siu-img')).toBeNull());
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.uploadKinPhotoSigned).not.toHaveBeenCalled();
  });

  it('#1291: rejects a non-image file at pick time and keeps Add Kin usable', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderScreen();
    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['%PDF'], 'vet.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText('Use a JPG, PNG, WebP, or GIF image.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Kin/i })).toBeEnabled();
  });

  it('#1291: a failed photo upload never fails the add; it lands on the edit screen flagged photo=failed', async () => {
    mocks.uploadKinPhotoSigned.mockRejectedValue(new Error('Upload failed, try again.'));
    const user = userEvent.setup();
    const { container } = renderScreen();
    await user.type(screen.getByLabelText(/^Name/i), 'Rex');
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, PHOTO);
    await user.click(screen.getByRole('button', { name: /Add Kin/i }));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/kin/$kinId/edit',
        params: { kinId: 'new-1' },
        search: { photo: 'failed' },
      }),
    );
    // Exactly one Kin: the add is not retried.
    expect(mocks.addKin).toHaveBeenCalledTimes(1);
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
