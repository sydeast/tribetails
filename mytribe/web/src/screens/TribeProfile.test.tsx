// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TribeProfile } from './TribeProfile';
import type { FormFieldDto, FormSchemaDto, GetMyTribeProfileResult } from '../api/tribeApi';

/**
 * Regression cover for the schema-mode save path.
 *
 * A kinfolk whose Auntie has authored a homeAccess form schema edits
 * `homeValues`, while the static `gateCode` / `keyLocation` / `wifi` state
 * still holds whatever loaded from the server. The save used to read
 * `(homeValues[k] ?? '').trim() || staticValue.trim() || null`, so emptying a
 * schema input fell through to the static value and re-sent the old secret
 * under a "Saved." message: a compromised gate code could not be removed, and
 * only in schema mode, since the static path always cleared correctly.
 *
 * These tests pin the write payload, not the message, because the message was
 * never the thing that lied.
 */

vi.mock('../components/PortalNav', () => ({
  PortalNav: () => null,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'kin-fam-1',
}));

vi.mock('../api/tribeApi', async () => {
  const actual = await vi.importActual<typeof import('../api/tribeApi')>('../api/tribeApi');
  return {
    ...actual,
    getMyTribeProfile: vi.fn(),
    getFormSchema: vi.fn(),
    getVetClinics: vi.fn(),
    listMembers: vi.fn(),
    saveTribeProfile: vi.fn(),
    saveHomeAccess: vi.fn(),
    submitVetClinic: vi.fn(),
    addSecondaryContact: vi.fn(),
    updateSecondaryPermissions: vi.fn(),
    // #818's contacts card loads on this screen too. Mocked here so the real
    // callable never reaches `lib/fns` from a jsdom run; the card's own
    // behaviour is specced in TribeProfile.contacts.test.tsx.
    listHouseholdContacts: vi.fn(),
    saveHouseholdContact: vi.fn(),
    removeHouseholdContact: vi.fn(),
  };
});

vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn(),
}));

const PROFILE: GetMyTribeProfileResult = {
  profile: { kinfolkId: 'kin-fam-1', displayName: 'The Ramirez Tribe', customFields: [] },
  homeAccess: {
    gateCode: '4242',
    keyLocation: 'Under the blue planter',
    wifiPassword: 'hunter2-old',
    customFields: [],
    updatedAtMs: null,
  },
};

function textField(key: string, label: string): FormFieldDto {
  return { key, label, type: 'text', required: false, helperText: null, placeholder: null, options: null, defaultValue: null, group: null };
}

const HOME_SCHEMA: FormSchemaDto = {
  id: 'homeAccess',
  name: 'Home Access',
  description: null,
  appliesTo: 'homeAccess',
  sections: [
    {
      title: 'Getting in',
      description: null,
      fields: [textField('gateCode', 'Gate / Door Code'), textField('keyLocation', 'Key Location'), textField('wifiPassword', 'Wi-Fi Password')],
    },
  ],
  version: 1,
};

const PROFILE_SCHEMA: FormSchemaDto = {
  id: 'tribeProfile',
  name: 'Tribe Profile',
  description: null,
  appliesTo: 'tribeProfile',
  sections: [{ title: 'Family', description: null, fields: [textField('displayName', 'Family Display Name')] }],
  version: 1,
};

async function renderTribeProfile(opts: { profileSchema?: FormSchemaDto; homeSchema?: FormSchemaDto; clinics?: Parameters<typeof vi.fn>[0] extends never ? never : any[]; profile?: GetMyTribeProfileResult }) {
  const tribeApi = await import('../api/tribeApi');
  const portal = await import('../api/portal');

  vi.mocked(tribeApi.getMyTribeProfile).mockResolvedValue(opts.profile ?? PROFILE);
  vi.mocked(tribeApi.getVetClinics).mockResolvedValue({ clinics: opts.clinics ?? [] });
  vi.mocked(tribeApi.listMembers).mockResolvedValue({ members: [] });
  vi.mocked(tribeApi.listHouseholdContacts).mockResolvedValue([]);
  vi.mocked(tribeApi.saveTribeProfile).mockResolvedValue({ ok: true });
  vi.mocked(tribeApi.saveHomeAccess).mockResolvedValue({ ok: true });
  vi.mocked(portal.getBusinessContact).mockResolvedValue({ name: 'Tribe Tails Pet Care', email: '', phone: '', address: '' });
  // getFormSchema throws 'not-found' when no admin has authored that schema.
  // That throw is the fork this bug lives on.
  vi.mocked(tribeApi.getFormSchema).mockImplementation((schemaId) => {
    const schema = schemaId === 'homeAccess' ? opts.homeSchema : opts.profileSchema;
    return schema ? Promise.resolve(schema) : Promise.reject(new Error('not-found'));
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TribeProfile />
    </QueryClientProvider>,
  );
  return result;
}

async function saveHomeAccessArgs() {
  const { saveHomeAccess } = await import('../api/tribeApi');
  await waitFor(() => expect(saveHomeAccess).toHaveBeenCalledTimes(1));
  return vi.mocked(saveHomeAccess).mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TribeProfile: Emergency Contact follows Home access (#843)', () => {
  const WITH_EC: GetMyTribeProfileResult = {
    ...PROFILE,
    profile: {
      ...PROFILE.profile,
      customFields: [
        { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Rae Halbrook' },
        { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '555-0100' },
      ],
    },
  };

  it('locks the Emergency Contact inputs and says why when the member lacks Home access', async () => {
    const view = await renderTribeProfile({ profile: { ...WITH_EC, canEditHomeDetails: false } });
    await waitFor(() => expect(view.getByTestId('ec-locked')).toBeInTheDocument());
    expect(view.getByText('Only someone with Home access can change the Emergency Contact.')).toBeInTheDocument();
    for (const id of ['ecname', 'ecphone', 'ecrel']) {
      expect(view.container.querySelector(`#${id}`)).toHaveAttribute('readonly');
    }
    expect(view.container.querySelector('#ecname')).toHaveValue('Rae Halbrook');
  });

  it('leaves the inputs editable with Home access', async () => {
    const view = await renderTribeProfile({ profile: { ...WITH_EC, canEditHomeDetails: true } });
    await waitFor(() => expect(view.container.querySelector('#ecname')).toHaveValue('Rae Halbrook'));
    expect(view.queryByTestId('ec-locked')).toBeNull();
    expect(view.container.querySelector('#ecname')).not.toHaveAttribute('readonly');
  });

  it('leaves the inputs editable when an older backend sends no flag at all', async () => {
    const view = await renderTribeProfile({ profile: WITH_EC });
    await waitFor(() => expect(view.container.querySelector('#ecname')).toHaveValue('Rae Halbrook'));
    expect(view.queryByTestId('ec-locked')).toBeNull();
    expect(view.container.querySelector('#ecname')).not.toHaveAttribute('readonly');
  });
});

describe('TribeProfile secret field masking', () => {
  it('secret fields in the schema path are masked by default', async () => {
    const { findByDisplayValue } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    // The SecretField component renders inputs as type="password" by default
    const gateCodeInput = (await findByDisplayValue('4242')) as HTMLInputElement;
    expect(gateCodeInput.type).toBe('password');

    const keyLocationInput = (await findByDisplayValue('Under the blue planter')) as HTMLInputElement;
    expect(keyLocationInput.type).toBe('password');

    const wifiInput = (await findByDisplayValue('hunter2-old')) as HTMLInputElement;
    expect(wifiInput.type).toBe('password');
  });

  it('secret fields show a reveal toggle button', async () => {
    const { getAllByRole, findByDisplayValue } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    // Wait for the schema fields to load
    await findByDisplayValue('4242');

    // Each secret field should have a "Show" button
    const showButtons = getAllByRole('button', { name: /Show|Hide/i });
    // We should have at least 3 show buttons for the 3 secret fields
    expect(showButtons.length).toBeGreaterThanOrEqual(3);
  });

  it('secret field values round-trip correctly while masked', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    // Edit a secret field while it's masked
    const gateCodeInput = (await findByDisplayValue('4242')) as HTMLInputElement;
    expect(gateCodeInput.type).toBe('password');

    await userEvent.clear(gateCodeInput);
    await userEvent.type(gateCodeInput, '5555');
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    expect(await saveHomeAccessArgs()).toMatchObject({ gateCode: '5555' });
  });

  it('cleared secret field values round-trip correctly', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    const gateCodeInput = (await findByDisplayValue('4242')) as HTMLInputElement;
    await userEvent.clear(gateCodeInput);
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    expect(await saveHomeAccessArgs()).toMatchObject({ gateCode: null });
  });
});

describe('TribeProfile schema-mode save', () => {
  it('saves null for a gate code the kinfolk emptied, instead of re-sending the loaded value', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    await userEvent.clear(await findByDisplayValue('4242'));
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    expect(await saveHomeAccessArgs()).toMatchObject({ gateCode: null });
  });

  it('saves null for an emptied key location and Wi-Fi password too', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    await userEvent.clear(await findByDisplayValue('Under the blue planter'));
    await userEvent.clear(await findByDisplayValue('hunter2-old'));
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    expect(await saveHomeAccessArgs()).toMatchObject({ keyLocation: null, wifiPassword: null });
  });

  it('still saves an edited schema value, and leaves untouched fields alone', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({ homeSchema: HOME_SCHEMA });

    const gate = await findByDisplayValue('4242');
    await userEvent.clear(gate);
    await userEvent.type(gate, '9001');
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    expect(await saveHomeAccessArgs()).toMatchObject({
      gateCode: '9001',
      keyLocation: 'Under the blue planter',
      wifiPassword: 'hunter2-old',
    });
  });

  it('blocks the save when the schema display name is emptied, rather than re-sending the loaded one', async () => {
    // Display name is required (the callable's zod guard is min(1)), and the
    // static path has always blocked Save on an empty one. In schema mode the
    // guard was reading `displayName`, which still held the server value, so
    // the button stayed live on an empty input. It now reads the value that
    // will actually be sent, so both paths refuse the same edit.
    const { findByDisplayValue, findByRole, findByText } = await renderTribeProfile({ profileSchema: PROFILE_SCHEMA });
    const { saveTribeProfile } = await import('../api/tribeApi');

    await userEvent.clear(await findByDisplayValue('The Ramirez Tribe'));

    expect(await findByRole('button', { name: /Save Changes/ })).toBeDisabled();
    expect(await findByText('Add a display name to save.')).toBeTruthy();
    expect(saveTribeProfile).not.toHaveBeenCalled();
  });

  it('re-enables the save once a schema display name is typed back in', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({ profileSchema: PROFILE_SCHEMA });

    const name = await findByDisplayValue('The Ramirez Tribe');
    await userEvent.clear(name);
    await userEvent.type(name, 'The Okafor Tribe');
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    const { saveTribeProfile } = await import('../api/tribeApi');
    await waitFor(() => expect(saveTribeProfile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveTribeProfile).mock.calls[0]?.[0]).toMatchObject({ displayName: 'The Okafor Tribe' });
  });

  it('keeps clearing correctly with no schema at all (the path that was always right)', async () => {
    const { findByDisplayValue, findByRole } = await renderTribeProfile({});

    await userEvent.clear(await findByDisplayValue('4242'));
    await userEvent.click(await findByRole('button', { name: /Save Changes/ }));

    expect(await saveHomeAccessArgs()).toMatchObject({ gateCode: null, keyLocation: 'Under the blue planter' });
  });
});
/**
 * Operator ruling 2026-08-01. Two things this pins:
 *  - the vet is a search-and-select, not a free-text box, so the portal can no
 *    longer author a third, uncorrectable copy of a household's vet;
 *  - a near match OFFERS a choice. A picker that silently selects the first
 *    match defeats the whole design.
 */
describe('TribeProfile: the vet is chosen, never typed', () => {
  const RIVERSIDE = {
    id: 'c1',
    name: 'Riverside Animal Hospital',
    phone: '(512) 555 0100',
    address: '418 Mill St',
    website: '',
    googleMapsUrl: '',
    isEmergency: false,
  };
  it('offers no free-text clinic boxes', async () => {
    const { queryByLabelText, findByLabelText } = await renderTribeProfile({});
    await findByLabelText(/Search vet clinics/i);
    expect(queryByLabelText('Clinic Name')).toBeNull();
    expect(queryByLabelText('Clinic Phone')).toBeNull();
    expect(queryByLabelText('Clinic Address')).toBeNull();
  });
  it('puts the create affordance LAST, after the existing clinics', async () => {
    const { findByLabelText, container } = await renderTribeProfile({ clinics: [RIVERSIDE] });
    const search = await findByLabelText(/Search vet clinics/i);
    await userEvent.type(search, 'river');
    await waitFor(() => {
      const rows = [...container.querySelectorAll('.suggestrow b')].map((n) => n.textContent ?? '');
      expect(rows[0]).toContain('Riverside Animal Hospital');
      expect(rows[rows.length - 1]).toContain('as a new clinic');
    });
  });
  it('shows the candidates instead of selecting one, when the server asks', async () => {
    const tribeApi = await import('../api/tribeApi');
    vi.mocked(tribeApi.submitVetClinic).mockResolvedValue({
      status: 'needs_choice',
      clinicId: '',
      created: false,
      pending: false,
      candidates: [{ ...RIVERSIDE, verified: true, reason: 'name' as const }],
    });
    const { findByLabelText, findByText } = await renderTribeProfile({});
    const search = await findByLabelText(/Search vet clinics/i);
    await userEvent.type(search, 'Riverside Animal Hospital');
    await userEvent.click(await findByText(/as a new clinic/));
    expect(await findByText(/already on the shared list/i)).toBeTruthy();
    expect(await findByText(/as a different clinic/)).toBeTruthy();
  });
  it('echoes the offered ids when the user insists it is different', async () => {
    const tribeApi = await import('../api/tribeApi');
    // The echo is what the server checks. A boolean would let a client claim a
    // confirmation it never obtained.
    vi.mocked(tribeApi.submitVetClinic)
      .mockResolvedValueOnce({
        status: 'needs_choice',
        clinicId: '',
        created: false,
        pending: false,
        candidates: [{ ...RIVERSIDE, verified: true, reason: 'name' as const }],
      })
      .mockResolvedValueOnce({
        status: 'created',
        clinicId: 'new1',
        created: true,
        pending: true,
        candidates: [],
      });
    const { findByLabelText, findByText } = await renderTribeProfile({});
    const search = await findByLabelText(/Search vet clinics/i);
    await userEvent.type(search, 'Riverside Animal Hospital');
    await userEvent.click(await findByText(/as a new clinic/));
    await userEvent.click(await findByText(/as a different clinic/));
    await waitFor(() => expect(tribeApi.submitVetClinic).toHaveBeenCalledTimes(2));
    expect(vi.mocked(tribeApi.submitVetClinic).mock.calls[1]?.[0]).toMatchObject({
      acknowledgedMatchIds: ['c1'],
    });
  });
  it('sends NO acknowledgement on the first attempt, so the safe path is the default', async () => {
    const tribeApi = await import('../api/tribeApi');
    vi.mocked(tribeApi.submitVetClinic).mockResolvedValue({
      status: 'created',
      clinicId: 'new1',
      created: true,
      pending: true,
      candidates: [],
    });
    const { findByLabelText, findByText } = await renderTribeProfile({});
    const search = await findByLabelText(/Search vet clinics/i);
    await userEvent.type(search, 'Somewhere New');
    await userEvent.click(await findByText(/as a new clinic/));
    await waitFor(() => expect(tribeApi.submitVetClinic).toHaveBeenCalled());
    expect(vi.mocked(tribeApi.submitVetClinic).mock.calls[0]?.[0]).toMatchObject({
      acknowledgedMatchIds: [],
    });
  });
});
