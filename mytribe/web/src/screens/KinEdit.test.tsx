// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  search: {} as { photo?: 'failed' },
  signKinPhotoUpload: vi.fn(),
  confirmKinPhotoUpload: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyKin: () => mocks.getMyKin(),
  updateKin: (kinId: string, kin: unknown, kinfolkId?: string) => mocks.updateKin(kinId, kin, kinfolkId),
}));
vi.mock('../api/breeds', async (orig) => ({
  ...(await orig<typeof import('../api/breeds')>()),
  BREEDS_QUERY: { queryKey: ['breeds'], queryFn: () => mocks.getBreeds(), staleTime: Infinity },
}));
vi.mock('../api/kinPhotoApi', async (orig) => ({
  ...(await orig<typeof import('../api/kinPhotoApi')>()),
  signKinPhotoUpload: (kinId: string, kinfolkId?: string) => mocks.signKinPhotoUpload(kinId, kinfolkId),
  confirmKinPhotoUpload: (kinId: string, secureUrl: string, kinfolkId?: string) =>
    mocks.confirmKinPhotoUpload(kinId, secureUrl, kinfolkId),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ kinId: 'k1' }),
  useSearch: () => mocks.search,
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

const NEW_URL = 'https://res.cloudinary.com/demo/image/upload/v2/tribetails/kinfolks/fam1/kin/k1/new.jpg';
const PHOTO = new File(['bytes'], 'buddy.jpg', { type: 'image/jpeg' });
// Shape-only test values: no real Cloudinary key or signature.
const SIGNED = {
  cloudName: 'demo',
  apiKey: 'test-key',
  timestamp: 1700000000,
  signature: 'test-signature',
  folder: 'tribetails/kinfolks/fam1/kin/k1',
  allowedFormats: 'jpg,png,webp,gif',
  transformation: 'fl_force_strip',
};

/** XHR stand-in: SignedImageUpload posts with XHR so it can report progress. */
function installFakeXhr() {
  const original = globalThis.XMLHttpRequest;
  const state = {
    instances: [] as Fake[],
    restore: () => {
      globalThis.XMLHttpRequest = original;
    },
  };
  class Fake {
    url = '';
    status = 200;
    responseText = '';
    body: FormData | null = null;
    upload = {
      onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string) {
      this.url = url;
    }
    send(body: FormData) {
      this.body = body;
      state.instances.push(this);
    }
    progress(loaded: number, total: number) {
      act(() => this.upload.onprogress?.({ lengthComputable: true, loaded, total }));
    }
    succeed(secureUrl: string) {
      this.responseText = JSON.stringify({ secure_url: secureUrl });
      this.onload?.();
    }
  }
  globalThis.XMLHttpRequest = Fake as unknown as typeof XMLHttpRequest;
  return state;
}

beforeEach(() => {
  mocks.search = {};
  mocks.signKinPhotoUpload.mockReset();
  mocks.confirmKinPhotoUpload.mockReset();
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

  it('#1291: has no Photo URL text box; the photo is a file picker', async () => {
    const { container } = renderScreen();
    await screen.findByLabelText(/Name/i);
    expect(screen.queryByLabelText(/Photo URL/i)).toBeNull();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain('image/jpeg');
  });

  it('#1291: an existing photoUrl (any http URL, not only Cloudinary) still renders as the preview', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ photoUrl: 'https://example.com/legacy/buddy.png' })] });
    const { container } = renderScreen();
    await screen.findByLabelText(/Name/i);
    await waitFor(() =>
      expect(container.querySelector('img.siu-img')?.getAttribute('src')).toBe('https://example.com/legacy/buddy.png'),
    );
    expect(screen.getByRole('button', { name: 'Remove Photo' })).toBeInTheDocument();
  });

  it('#1291: picking a photo signs for THIS kin, uploads with a progress cue, confirms, and shows the new photo', async () => {
    const xhr = installFakeXhr();
    try {
      mocks.signKinPhotoUpload.mockResolvedValue(SIGNED);
      mocks.confirmKinPhotoUpload.mockResolvedValue({ photoUrl: NEW_URL });
      const user = userEvent.setup();
      const { container } = renderScreen();
      await screen.findByLabelText(/Name/i);

      await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, PHOTO);
      await waitFor(() => expect(mocks.signKinPhotoUpload).toHaveBeenCalledWith('k1', 'fam1'));
      await waitFor(() => expect(xhr.instances).toHaveLength(1));
      const req = xhr.instances[0]!;
      expect(req.url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
      // The signed metadata strip rides along on the POST.
      expect(req.body!.get('transformation')).toBe('fl_force_strip');
      expect(req.body!.get('folder')).toBe('tribetails/kinfolks/fam1/kin/k1');
      req.progress(40, 100);
      expect(await screen.findByText(/Uploading… 40%/)).toBeInTheDocument();
      act(() => req.succeed(NEW_URL));

      await waitFor(() => expect(mocks.confirmKinPhotoUpload).toHaveBeenCalledWith('k1', NEW_URL, 'fam1'));
      await waitFor(() => expect(container.querySelector('img.siu-img')?.getAttribute('src')).toBe(NEW_URL));
      // Already saved by confirm: the text form has nothing to send.
      expect(screen.getByText('No changes yet.')).toBeInTheDocument();
      expect(mocks.updateKin).not.toHaveBeenCalled();
    } finally {
      xhr.restore();
    }
  });

  it('#1291: rejects a non-image file before signing anything', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderScreen();
    await screen.findByLabelText(/Name/i);
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['%PDF'], 'vet.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText('Use a JPG, PNG, WebP, or GIF image.')).toBeInTheDocument();
    expect(mocks.signKinPhotoUpload).not.toHaveBeenCalled();
  });

  it('#1291: a refused signature (not this household, no kin_edit) surfaces as an error and changes nothing', async () => {
    mocks.signKinPhotoUpload.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    const user = userEvent.setup();
    const { container } = renderScreen();
    await screen.findByLabelText(/Name/i);
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, PHOTO);
    expect(await screen.findByText('Missing or insufficient permissions.')).toBeInTheDocument();
    expect(mocks.confirmKinPhotoUpload).not.toHaveBeenCalled();
    expect(mocks.updateKin).not.toHaveBeenCalled();
  });

  it('#1291: Remove Photo clears photoUrl through updateKin and drops the preview', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ photoUrl: 'https://res.cloudinary.com/demo/image/upload/v1/old.jpg' })] });
    const user = userEvent.setup();
    const { container } = renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Remove Photo' }));
    await waitFor(() => expect(mocks.updateKin).toHaveBeenCalledWith('k1', { photoUrl: null }, 'fam1'));
    await waitFor(() => expect(container.querySelector('img.siu-img')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Remove Photo' })).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('#1291: a failed removal says so and keeps the photo', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [kin({ photoUrl: 'https://res.cloudinary.com/demo/image/upload/v1/old.jpg' })] });
    mocks.updateKin.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Remove Photo' }));
    expect(await screen.findByText('Missing or insufficient permissions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Photo' })).toBeInTheDocument();
  });

  it('#1291: ?photo=failed from Add New Kin says the photo did not upload', async () => {
    mocks.search = { photo: 'failed' };
    renderScreen();
    expect(
      await screen.findByText('Buddy was added, but the photo did not upload. Pick it again here.'),
    ).toBeInTheDocument();
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
