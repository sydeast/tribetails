// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import type { KinfolkProfile } from '../api/kinfolkProfile';

const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));

const { updateKinfolkProfile, archiveKinfolk, unarchiveKinfolk } = vi.hoisted(() => ({
  updateKinfolkProfile: vi.fn(),
  archiveKinfolk: vi.fn(),
  unarchiveKinfolk: vi.fn(),
}));
vi.mock('../api/kinfolkProfileWrite', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfileWrite')>()),
  updateKinfolkProfile,
  archiveKinfolk,
  unarchiveKinfolk,
}));

// Service address is an AddressAutofillField now, which debounces a real
// `mapboxSearch` callable. Stubbed so this suite never reaches for Firebase.
const { mapboxSuggest, mapboxRetrieve } = vi.hoisted(() => ({
  mapboxSuggest: vi.fn(),
  mapboxRetrieve: vi.fn(),
}));
vi.mock('../api/mapbox', async (orig) => ({
  ...(await orig<typeof import('../api/mapbox')>()),
  mapboxSuggest,
  mapboxRetrieve,
}));

// The vet panel opens a live `vet_clinics` listener. Stubbed so this suite
// never touches Firestore, and so a test can hand the picker an exact catalog.
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));
import { KinfolkEdit } from './KinfolkEdit';
import type { VetClinic } from '../api/vetClinics';
import { mergeKinfolkProfile } from '../api/kinfolkProfile';
import { KINFOLK_EDIT_FIELDS } from '../api/kinfolkProfileWrite';
import { ToastProvider } from '../components/Toast';

function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

function household(over: Record<string, unknown> = {}): KinfolkProfile {
  return mergeKinfolkProfile('kf1', {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'jamie@example.com',
    status: 'active',
    serviceAddress: '123 Bark Ave',
    gateCode: '4242',
    wifiPassword: 'sunflower-porch',
    emergencyContactName: 'Rae Halbrook',
    emergencyContactPhone: '512-555-9090',
    ...over,
  });
}

const CLINICS: VetClinic[] = [
  {
    _id: 'riverside',
    name: 'Riverside Animal Hospital',
    phone: '(512) 555-0100',
    address: '1 Mill St',
    isEmergency: false,
    verified: true,
  },
  {
    _id: 'er1',
    name: 'Austin Pet ER',
    phone: '(512) 555-0300',
    address: '4 Night Ln',
    isEmergency: true,
    verified: true,
  },
];
function mount(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  getKinfolkProfile.mockResolvedValue(household(over));
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={onDone} onCancel={onCancel} {...props} />);
  return { onDone, onCancel };
}

/** The input under a given visible label. */
function fieldByLabel(label: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
}

beforeEach(() => {
  getKinfolkProfile.mockReset();
  updateKinfolkProfile.mockReset();
  archiveKinfolk.mockReset();
  unarchiveKinfolk.mockReset();
  mapboxSuggest.mockReset().mockResolvedValue([]);
  mapboxRetrieve.mockReset();
  useCollection.mockReset();
  useCollection.mockReturnValue({ status: 'ready', data: CLINICS });
  updateKinfolkProfile.mockResolvedValue(undefined);
  archiveKinfolk.mockResolvedValue(undefined);
  unarchiveKinfolk.mockResolvedValue(undefined);
});

describe('KinfolkEdit: rendering from data', () => {
  it('loads the household into the form', async () => {
    mount();
    expect(await screen.findByLabelText('First name')).toHaveValue('Jamie');
    expect(fieldByLabel('Last name')).toHaveValue('Halbrook');
    expect(fieldByLabel('Primary phone')).toHaveValue('(512) 555-1234');
    expect(fieldByLabel('Service address')).toHaveValue('123 Bark Ave');
    expect(fieldByLabel('Emergency contact name')).toHaveValue('Rae Halbrook');
  });

  it('shows the loading skeleton, not an empty state, while the read is in flight', async () => {
    getKinfolkProfile.mockReturnValue(new Promise(() => undefined));
    render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(/no details on file/i)).not.toBeInTheDocument();
  });

  it('marks the current status as the selected option', async () => {
    mount({ status: 'prospect' });
    await screen.findByLabelText('First name');
    expect(screen.getByRole('radio', { name: 'Prospect' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('KinfolkEdit: service address autofill (#12)', () => {
  it('does not spend a Mapbox lookup on the address the household loaded with', async () => {
    mount();
    await screen.findByLabelText('First name');
    expect(mapboxSuggest).not.toHaveBeenCalled();
  });
  it('suggests, resolves, and SAVES the picked address', async () => {
    mapboxSuggest.mockResolvedValue([
      { name: 'Bark House', fullAddress: '123 Bark Ave, Austin TX 78701', mapboxId: 'id-1', placeFormatted: 'Austin TX' },
    ]);
    mapboxRetrieve.mockResolvedValue('123 Bark Ave, Austin TX 78701');
    mount();
    await screen.findByLabelText('First name');
    await userEvent.type(fieldByLabel('Service address'), 'nue');
    await userEvent.click(await screen.findByRole('button', { name: /Bark House/ }));
    await waitFor(() => expect(fieldByLabel('Service address')).toHaveValue('123 Bark Ave, Austin TX 78701'));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKinfolkProfile).toHaveBeenCalledWith(
        'kf1',
        expect.objectContaining({ serviceAddress: '123 Bark Ave, Austin TX 78701' }),
      ),
    );
  });
  it('saves a hand-typed address after a failed lookup (autofill never blocks the save)', async () => {
    mapboxSuggest.mockRejectedValue(new Error('mapbox_502'));
    mount();
    await screen.findByLabelText('First name');
    await userEvent.type(fieldByLabel('Service address'), 'nue, Austin TX');
    expect(await screen.findByText(/address lookup failed: mapbox_502/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKinfolkProfile).toHaveBeenCalledWith(
        'kf1',
        expect.objectContaining({ serviceAddress: '123 Bark Avenue, Austin TX' }),
      ),
    );
  });
});
describe('KinfolkEdit: vet clinic picker (#13)', () => {
  it('offers a searchable catalog rather than plain clinic text boxes', async () => {
    mount();
    await screen.findByLabelText('First name');
    expect(screen.getByLabelText('Vet clinic')).toHaveAttribute('placeholder', 'Type to search 2 clinics');
    expect(screen.queryByLabelText('Clinic name')).not.toBeInTheDocument();
  });
  it('filters the EMERGENCY picker to emergency-flagged clinics only', async () => {
    mount();
    await screen.findByLabelText('First name');
    // One of the two catalog rows is flagged, so the emergency box says one.
    expect(screen.getByLabelText('Emergency vet')).toHaveAttribute(
      'placeholder',
      'Type to search 1 clinics',
    );
    await userEvent.type(screen.getByLabelText('Emergency vet'), 'a');
    const names = screen.getAllByTestId('vetpick-option').map((el) => el.textContent).join('|');
    expect(names).toContain('Austin Pet ER');
    expect(names).not.toContain('Riverside');
  });
  it('saves the clinic id ALONGSIDE the denormalized name, phone and address', async () => {
    mount();
    await screen.findByLabelText('First name');
    await userEvent.type(screen.getByLabelText('Vet clinic'), 'riverside');
    await userEvent.click(screen.getByRole('button', { name: /Riverside Animal Hospital/ }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKinfolkProfile).toHaveBeenCalledWith(
        'kf1',
        expect.objectContaining({
          vetClinicId: 'riverside',
          vetClinicName: 'Riverside Animal Hospital',
          vetClinicPhone: '(512) 555-0100',
          vetClinicAddress: '1 Mill St',
        }),
      ),
    );
  });
  it('saves an emergency vet into its own four fields', async () => {
    mount();
    await screen.findByLabelText('First name');
    await userEvent.type(screen.getByLabelText('Emergency vet'), 'austin');
    await userEvent.click(screen.getByRole('button', { name: /Austin Pet ER/ }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKinfolkProfile).toHaveBeenCalledWith(
        'kf1',
        expect.objectContaining({
          emergencyVetClinicId: 'er1',
          emergencyVetClinicName: 'Austin Pet ER',
          emergencyVetClinicPhone: '(512) 555-0300',
          emergencyVetClinicAddress: '4 Night Ln',
        }),
      ),
    );
  });
});
describe('KinfolkEdit: LEGACY string-only vet fields', () => {
  /**
   * Every household on file predates `vetClinicId`. The picker has to open,
   * render the name that is there, and save it back untouched, without ever
   * treating "no id" as "no vet".
   */
  it('renders a legacy household whose vet is a bare string, with no crash', async () => {
    mount({
      vetClinicName: 'Old Corner Vet',
      vetClinicPhone: 'after hours: 512-555-0000',
      vetClinicAddress: 'behind the feed store',
    });
    await screen.findByLabelText('First name');
    const selected = screen.getAllByTestId('vetpick-selected')[0]!;
    expect(selected).toHaveTextContent('Old Corner Vet');
    expect(selected).toHaveTextContent('after hours: 512-555-0000');
    expect(screen.getByText(/not linked to the shared catalog/i)).toBeInTheDocument();
  });
  it('saves a legacy household unchanged, with an empty id rather than a fabricated one', async () => {
    mount({ vetClinicName: 'Old Corner Vet', vetClinicPhone: '512-555-0000' });
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKinfolkProfile).toHaveBeenCalledWith(
        'kf1',
        expect.objectContaining({
          vetClinicId: '',
          vetClinicName: 'Old Corner Vet',
          vetClinicPhone: '512-555-0000',
        }),
      ),
    );
  });
  it('renders a household with NO vet at all, and no linkage warning', async () => {
    mount();
    await screen.findByLabelText('First name');
    expect(screen.queryAllByTestId('vetpick-selected')).toHaveLength(0);
    expect(screen.queryByText(/not linked to the shared catalog/i)).not.toBeInTheDocument();
  });
  /**
   * A catalog outage is not missing household data. The clinic on file must
   * still be visible and still save; only SEARCHING is unavailable.
   */
  it('still shows and saves the vet on file when the clinic catalog fails to load', async () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied', retry: vi.fn() });
    mount({ vetClinicName: 'Old Corner Vet', vetClinicPhone: '512-555-0000' });
    await screen.findByLabelText('First name');
    expect(screen.getByText(/shared clinic catalog didn't load/i)).toBeInTheDocument();
    expect(screen.getAllByTestId('vetpick-selected')[0]).toHaveTextContent('Old Corner Vet');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(updateKinfolkProfile).toHaveBeenCalledWith(
        'kf1',
        expect.objectContaining({ vetClinicName: 'Old Corner Vet', vetClinicId: '' }),
      ),
    );
  });
});
describe('KinfolkEdit: join date', () => {
  it('is a date picker, not a free text box', async () => {
    mount({ joinDate: '2026-07-24' });
    const field = await screen.findByLabelText('Join date');
    expect(field).toHaveAttribute('type', 'date');
    expect(field).toHaveValue('2026-07-24');
  });

  it('opens a legacy UTC timestamp on the right day and says the time is dropped', async () => {
    mount({ joinDate: '2026-07-24T12:34:56.789Z' });
    expect(await screen.findByLabelText('Join date')).toHaveValue('2026-07-24');
    expect(screen.getByText(/2026-07-24T12:34:56\.789Z/)).toBeInTheDocument();
  });

  /**
   * The trap this guards against: a stricter schema plus a legacy value the
   * picker cannot render would leave the operator staring at an error on a field
   * they never touched, unable to save the phone number they came to fix.
   */
  it('lets an unreadable legacy value be fixed rather than blocking the save', async () => {
    mount({ joinDate: '07/24/2026' });
    const field = await screen.findByLabelText('Join date');
    expect(field).toHaveValue('');
    expect(screen.getByText(/07\/24\/2026/)).toBeInTheDocument();
    expect(screen.queryByText(/pick a join date/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateKinfolkProfile).toHaveBeenCalledTimes(1));
    expect(updateKinfolkProfile.mock.calls[0]![1].joinDate).toBe('');
  });

  it('saves a picked day as a plain calendar date', async () => {
    mount({ joinDate: '' });
    const field = await screen.findByLabelText('Join date');
    await userEvent.type(field, '2026-07-24');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateKinfolkProfile).toHaveBeenCalledTimes(1));
    expect(updateKinfolkProfile.mock.calls[0]![1].joinDate).toBe('2026-07-24');
  });
});

describe('KinfolkEdit: secrets', () => {
  it('does not put a gate code or Wi-Fi password in the DOM before reveal', async () => {
    mount();
    await screen.findByLabelText('First name');
    expect(screen.queryByText('4242')).not.toBeInTheDocument();
    expect(screen.queryByText('sunflower-porch')).not.toBeInTheDocument();
    // The masked affordance is there, so the operator knows a code exists.
    expect(screen.getByRole('button', { name: /show gate code/i })).toBeInTheDocument();
  });

  it('reveals the gate code only when asked', async () => {
    mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /show gate code/i }));
    expect(screen.getByText('4242')).toBeInTheDocument();
  });

  it('swaps in a typeable input once the operator chooses to change the secret', async () => {
    mount();
    await screen.findByLabelText('First name');
    expect(screen.queryByLabelText('Gate code')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /change gate code/i }));
    expect(fieldByLabel('Gate code')).toHaveValue('4242');
  });
});

describe('KinfolkEdit: blur validation', () => {
  it('reveals a required-field error on blur, before any save attempt', async () => {
    mount();
    const first = await screen.findByLabelText('First name');
    await userEvent.clear(first);
    expect(screen.queryByText(/first name can't be blank/i)).not.toBeInTheDocument();
    await userEvent.tab();
    expect(await screen.findByText(/first name can't be blank/i)).toBeInTheDocument();
  });

  it('does not leak one field’s blur into another field’s error', async () => {
    mount({ serviceAddress: '' });
    const first = await screen.findByLabelText('First name');
    await userEvent.click(first);
    await userEvent.tab();
    // Service address is genuinely blank, but untouched, so it stays quiet.
    expect(screen.queryByText(/a service address is required/i)).not.toBeInTheDocument();
  });

  it('flags a malformed phone on blur', async () => {
    mount();
    const phone = await screen.findByLabelText('Primary phone');
    await userEvent.clear(phone);
    await userEvent.type(phone, '123');
    await userEvent.tab();
    expect(await screen.findByText(/10 digit phone number/i)).toBeInTheDocument();
  });

  it('reveals every outstanding error at once when Save is pressed', async () => {
    mount({ serviceAddress: '', emergencyContactName: '' });
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/a service address is required/i)).toBeInTheDocument();
    expect(screen.getByText(/an emergency contact name is required/i)).toBeInTheDocument();
    expect(updateKinfolkProfile).not.toHaveBeenCalled();
  });
});

describe('KinfolkEdit: save', () => {
  it('sends the edited fields and signals done', async () => {
    const { onDone } = mount();
    const first = await screen.findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, 'Jaime');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateKinfolkProfile).toHaveBeenCalledTimes(1));
    const [id, patch] = updateKinfolkProfile.mock.calls[0]!;
    expect(id).toBe('kf1');
    expect(patch.firstName).toBe('Jaime');
    expect(patch.lastName).toBe('Halbrook');
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  /**
   * The merge contract, asserted at the SCREEN boundary too: the api module
   * proves updateDoc cannot touch an unnamed field, and this proves the screen
   * never hands it one to begin with. Both halves have to hold.
   */
  it('sends only the managed fields, so an unmanaged field cannot be overwritten', async () => {
    mount({
      // Present on the loaded doc, never editable here.
      preferredContactMethod: 'Text',
      bestTimeToContact: 'Evenings',
      tags: ['VIP'],
      profilePictureUrl: 'https://example.test/photo.jpg',
    });
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateKinfolkProfile).toHaveBeenCalledTimes(1));
    const patch = updateKinfolkProfile.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual([...KINFOLK_EDIT_FIELDS].sort());
    expect(patch).not.toHaveProperty('preferredContactMethod');
    expect(patch).not.toHaveProperty('bestTimeToContact');
    expect(patch).not.toHaveProperty('tags');
    expect(patch).not.toHaveProperty('profilePictureUrl');
    expect(patch).not.toHaveProperty('_id');
  });

  it('changes the status through the picker', async () => {
    mount({ status: 'active' });
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('radio', { name: 'Inactive' }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateKinfolkProfile).toHaveBeenCalledTimes(1));
    expect(updateKinfolkProfile.mock.calls[0]![1].status).toBe('inactive');
  });

  it('confirms with a toast on success', async () => {
    mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/saved jamie halbrook/i)).toBeInTheDocument();
  });

  it('fails loud, names the write, and does not signal done', async () => {
    updateKinfolkProfile.mockRejectedValue(new Error('permission-denied'));
    const { onDone } = mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(
      await screen.findByText(/updateKinfolkProfile failed:.*permission-denied/i),
    ).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('KinfolkEdit: archive', () => {
  it('names the Kinfolk in the confirm dialog', async () => {
    mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Jamie Halbrook')).toBeInTheDocument();
  });

  it('archives with the typed reason, then signals done', async () => {
    const { onDone } = mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.type(screen.getByLabelText(/reason/i), 'moved away');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^archive$/i }));

    await waitFor(() => expect(archiveKinfolk).toHaveBeenCalledWith('kf1', 'moved away'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it('does not archive when the confirm is cancelled', async () => {
    mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(archiveKinfolk).not.toHaveBeenCalled();
  });

  it('offers Restore and no status picker for an archived household', async () => {
    mount({ status: 'archived' });
    await screen.findByLabelText('First name');
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^archive$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByText(/is archived/i)).toBeInTheDocument();
  });

  it('restores an archived household', async () => {
    const { onDone } = mount({ status: 'archived' });
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => expect(unarchiveKinfolk).toHaveBeenCalledWith('kf1'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it('fails loud when an archive rejects', async () => {
    archiveKinfolk.mockRejectedValue(new Error('permission-denied'));
    const { onDone } = mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^archive$/i }));
    expect(await screen.findByText(/archiveKinfolk failed:.*permission-denied/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('KinfolkEdit: load failure', () => {
  it('shows the failure and never a false empty', async () => {
    getKinfolkProfile.mockRejectedValue(new Error('permission-denied'));
    render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByText(/couldn.t load household/i)).toBeInTheDocument();
    expect(screen.getByText(/getKinfolkProfile failed:.*permission-denied/i)).toBeInTheDocument();
    // The forms must not render as a set of blank inputs that look saveable.
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument();
    expect(screen.queryByText(/no details on file/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('retries the read', async () => {
    getKinfolkProfile.mockRejectedValueOnce(new Error('offline'));
    getKinfolkProfile.mockResolvedValueOnce(household());
    render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText(/couldn.t load household/i);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByLabelText('First name')).toHaveValue('Jamie');
  });
});

describe('KinfolkEdit: cancel', () => {
  it('calls onCancel from the header', async () => {
    const { onCancel } = mount();
    await screen.findByLabelText('First name');
    await userEvent.click(screen.getAllByRole('button', { name: /^cancel$/i })[0]!);
    expect(onCancel).toHaveBeenCalled();
  });
});
