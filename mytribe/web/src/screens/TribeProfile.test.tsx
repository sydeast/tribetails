// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TribeProfile } from './TribeProfile';
import type { FormFieldDto, FormSchemaDto, GetMyTribeProfileResult, ListEmergencyContactsResult, MemberDto } from '../api/tribeApi';

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
    // #829: the Emergency Contacts card reads and writes through its own callables.
    listEmergencyContacts: vi.fn(),
    saveEmergencyContacts: vi.fn(),
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

async function renderTribeProfile(opts: {
  profileSchema?: FormSchemaDto;
  homeSchema?: FormSchemaDto;
  clinics?: Parameters<typeof vi.fn>[0] extends never ? never : any[];
  profile?: GetMyTribeProfileResult;
  emergencyContacts?: ListEmergencyContactsResult;
  members?: MemberDto[];
}) {
  const tribeApi = await import('../api/tribeApi');
  const portal = await import('../api/portal');

  vi.mocked(tribeApi.listEmergencyContacts).mockResolvedValue(opts.emergencyContacts ?? { contacts: [], canEdit: true, legacy: false });
  vi.mocked(tribeApi.getMyTribeProfile).mockResolvedValue(opts.profile ?? PROFILE);
  vi.mocked(tribeApi.getVetClinics).mockResolvedValue({ clinics: opts.clinics ?? [] });
  vi.mocked(tribeApi.listMembers).mockResolvedValue({ members: opts.members ?? [] });
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

describe('TribeProfile: Emergency Contacts follow Home access (#843, #829)', () => {
  const RAE = { name: 'Rae Halbrook', phone: '+18055550100', relationship: null, recordedAt: null, updatedAt: null };
  const STALE_EC: GetMyTribeProfileResult = {
    ...PROFILE,
    profile: {
      ...PROFILE.profile,
      customFields: [
        { key: 'vetClinicId', label: 'Vet Clinic', value: 'clinic-1' },
        { key: 'emergencyContactName', label: 'Emergency Contact', value: 'Stale' },
        { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '555-0100' },
      ],
    },
  };

  it('without Home access: the contacts show read-only and the card says why', async () => {
    const view = await renderTribeProfile({ emergencyContacts: { contacts: [RAE], canEdit: false, legacy: false } });
    await waitFor(() => expect(view.getByTestId('ec-locked')).toBeInTheDocument());
    expect(view.getByText('Only someone with Home access can change the Emergency Contact.')).toBeInTheDocument();
    expect(view.getByText('Rae Halbrook')).toBeInTheDocument();
    expect(view.container.querySelector('#ec-0-name')).toBeNull();
  });

  it('with Home access: the two-slot editor is there and nothing is locked', async () => {
    const view = await renderTribeProfile({ emergencyContacts: { contacts: [RAE], canEdit: true, legacy: false } });
    await waitFor(() => expect(view.container.querySelector('#ec-0-name')).toHaveValue('Rae Halbrook'));
    expect(view.queryByTestId('ec-locked')).toBeNull();
  });

  it('never reads the old customFields copy: a stale value there is not shown', async () => {
    const view = await renderTribeProfile({ profile: STALE_EC });
    await waitFor(() => expect(view.getByText('A household needs at least one Emergency Contact.')).toBeInTheDocument());
    expect(view.queryByDisplayValue('Stale')).toBeNull();
    expect(view.queryByText('Stale')).toBeNull();
  });

  it('#829: the profile save carries no emergencyContact key at all, and keeps the vet clinic', async () => {
    const view = await renderTribeProfile({ profile: STALE_EC });
    await userEvent.click(await view.findByRole('button', { name: /Save Changes/ }));
    const { saveTribeProfile, saveEmergencyContacts } = await import('../api/tribeApi');
    await waitFor(() => expect(saveTribeProfile).toHaveBeenCalledTimes(1));
    const keys = (vi.mocked(saveTribeProfile).mock.calls[0]?.[0].customFields ?? []).map((f) => f.key);
    expect(keys.filter((k) => k.startsWith('emergencyContact'))).toEqual([]);
    expect(keys).toContain('vetClinicId');
    expect(saveEmergencyContacts).not.toHaveBeenCalled();
  });

  it('#829: an edited contact is still unsaved after the page Save, and the page says so', async () => {
    const view = await renderTribeProfile({ emergencyContacts: { contacts: [RAE], canEdit: true, legacy: false } });
    const name = await view.findByDisplayValue('Rae Halbrook');
    expect(view.queryByTestId('ec-unsaved-page')).toBeNull();
    await userEvent.type(name, ' Jr');
    expect(view.getByTestId('ec-unsaved-page')).toHaveTextContent('Your Emergency Contacts have unsaved changes.');
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    const { saveTribeProfile, saveHomeAccess, saveEmergencyContacts } = await import('../api/tribeApi');
    await waitFor(() => expect(saveTribeProfile).toHaveBeenCalledTimes(1));
    expect(
      await view.findByText('Profile saved. Your Emergency Contacts are not saved yet: use Save Emergency Contacts.'),
    ).toBeInTheDocument();
    // #868: nothing in the home details changed, so no home access call.
    expect(saveHomeAccess).not.toHaveBeenCalled();
    // A saved profile is a success, whatever the sentence starts with.
    expect(view.getByTestId('page-save-status')).not.toHaveClass('err');
    expect(view.queryByText('Saved.')).toBeNull();
    expect(view.getByTestId('ec-unsaved')).toBeInTheDocument();
    expect(view.container.querySelector('#ec-0-name')).toHaveValue('Rae Halbrook Jr');
    expect(saveEmergencyContacts).not.toHaveBeenCalled();
  });

  it('a household with none is prompted, and the rest of the profile still saves', async () => {
    const view = await renderTribeProfile({});
    await waitFor(() => expect(view.getByText('A household needs at least one Emergency Contact.')).toBeInTheDocument());
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    const { saveTribeProfile, saveHomeAccess } = await import('../api/tribeApi');
    await waitFor(() => expect(saveTribeProfile).toHaveBeenCalledTimes(1));
    expect(await view.findByText('Saved.')).toBeInTheDocument();
    expect(saveHomeAccess).not.toHaveBeenCalled();
  });

  it('the page save status is coloured by outcome: a failure is an error, a success is not', async () => {
    const view = await renderTribeProfile({});
    const { saveTribeProfile } = await import('../api/tribeApi');
    vi.mocked(saveTribeProfile).mockRejectedValueOnce(new Error('nope'));
    await userEvent.click(await view.findByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText('Save failed: nope')).toBeInTheDocument();
    expect(view.getByTestId('page-save-status')).toHaveClass('err');
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText('Saved.')).toBeInTheDocument();
    expect(view.getByTestId('page-save-status')).not.toHaveClass('err');
  });

  it('#873: a save refused for the hourly limit says so plainly, as an error', async () => {
    const view = await renderTribeProfile({});
    const { saveTribeProfile, PROFILE_SAVE_RATE_LIMITED_MESSAGE } = await import('../api/tribeApi');
    const { FirebaseError } = await import('firebase/app');
    vi.mocked(saveTribeProfile).mockRejectedValueOnce(new FirebaseError('functions/resource-exhausted', 'Too many attempts. Try again later.'));
    await userEvent.click(await view.findByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText(PROFILE_SAVE_RATE_LIMITED_MESSAGE)).toBeInTheDocument();
    expect(view.getByTestId('page-save-status')).toHaveClass('err');
    expect(view.queryByText(/Too many attempts/)).not.toBeInTheDocument();
  });

  it('both Home access toggles, member row and invite, name Emergency Contacts', async () => {
    const view = await renderTribeProfile({
      members: [
        {
          uid: 'sec-1',
          role: 'SECONDARY',
          status: 'ACTIVE',
          invitedEmail: 'sam@example.com',
          secondaryLabel: 'Sam',
          permissions: { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, home_access: false },
        } as MemberDto,
      ],
    });
    await waitFor(() => expect(view.getAllByText('Home access (gate code, Wi-Fi, Emergency Contacts)')).toHaveLength(2));
    expect(view.queryByText('Home access (gate code, Wi-Fi)')).toBeNull();
  });
});

/**
 * #868. Save Changes called saveHomeAccess on every press, so a secondary kinfolk
 * without Home access had the profile written, the home half refused, and read
 * "Save failed". The home details now follow canEditHomeDetails, the home half is
 * sent only when it changed, and a partial result says which half saved.
 */
describe('TribeProfile: the home details follow Home access, and a partial save says so (#868)', () => {
  const WITH_HOME_ACCESS: GetMyTribeProfileResult = { ...PROFILE, canEditHomeDetails: true };
  const WITHOUT_HOME_ACCESS: GetMyTribeProfileResult = {
    profile: PROFILE.profile,
    // What getMyTribeProfile serves a viewer without the grant: no values at all.
    homeAccess: { gateCode: null, keyLocation: null, wifiPassword: null, customFields: [], updatedAtMs: null },
    canEditHomeDetails: false,
  };
  const REFUSED = 'You need Home access to change the home details. Ask your primary kinfolk to give you Home access.';

  type View = Awaited<ReturnType<typeof renderTribeProfile>>;

  async function renameFamily(view: View) {
    const name = await view.findByLabelText('Family Display Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'The Ramirez Household');
  }

  async function changeGateCode(view: View) {
    const gate = await view.findByDisplayValue('4242');
    await userEvent.clear(gate);
    await userEvent.type(gate, '9001');
  }

  async function save(view: View) {
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    return view.findByTestId('page-save-status');
  }

  it('primary kinfolk: a Family-only edit saves the profile and makes no home access call', async () => {
    const view = await renderTribeProfile({ profile: WITH_HOME_ACCESS });
    await view.findByDisplayValue('4242');
    expect(view.queryByTestId('home-locked')).toBeNull();
    await renameFamily(view);
    const status = await save(view);
    expect(status).toHaveTextContent('Saved.');
    const { saveTribeProfile, saveHomeAccess } = await import('../api/tribeApi');
    expect(vi.mocked(saveTribeProfile).mock.calls[0]?.[0]).toMatchObject({ displayName: 'The Ramirez Household' });
    expect(saveHomeAccess).not.toHaveBeenCalled();
  });

  it('secondary kinfolk with Home access: an edited gate code and after-hours phone go to saveHomeAccess', async () => {
    const view = await renderTribeProfile({ profile: WITH_HOME_ACCESS });
    await changeGateCode(view);
    await userEvent.type(view.getByLabelText('Emergency clinic phone'), '805-555-0100');
    const status = await save(view);
    expect(status).toHaveTextContent('Saved.');
    expect(status).not.toHaveClass('err');
    expect(await saveHomeAccessArgs()).toMatchObject({
      gateCode: '9001',
      keyLocation: 'Under the blue planter',
      wifiPassword: 'hunter2-old',
      customFields: [{ key: 'afterHoursVetPhone', label: 'After-hours Phone', value: '805-555-0100' }],
    });
  });

  it('secondary kinfolk without Home access: the home details are locked, the profile saves, and no home access call is made', async () => {
    const { HOME_DETAILS_LOCKED, saveTribeProfile, saveHomeAccess } = await import('../api/tribeApi');
    const view = await renderTribeProfile({ profile: WITHOUT_HOME_ACCESS });
    expect(await view.findByTestId('home-locked')).toHaveTextContent(HOME_DETAILS_LOCKED);
    expect(view.getByTestId('after-hours-locked')).toHaveTextContent(HOME_DETAILS_LOCKED);
    expect(view.queryByLabelText('Gate / Door Code')).toBeNull();
    expect(view.queryByLabelText('Key Location')).toBeNull();
    expect(view.queryByLabelText('Wi-Fi Password')).toBeNull();
    expect(view.queryByLabelText('Emergency clinic phone')).toBeNull();
    expect(view.queryByLabelText('Emergency clinic')).toBeNull();
    await renameFamily(view);
    const status = await save(view);
    expect(status).toHaveTextContent('Saved.');
    expect(status).not.toHaveClass('err');
    expect(saveTribeProfile).toHaveBeenCalledTimes(1);
    expect(saveHomeAccess).not.toHaveBeenCalled();
  });

  it('home details refused after the profile saved: says which half saved, never "Save failed", and keeps the home edit', async () => {
    const { saveHomeAccess, getMyTribeProfile } = await import('../api/tribeApi');
    const view = await renderTribeProfile({ profile: WITH_HOME_ACCESS });
    vi.mocked(saveHomeAccess).mockRejectedValueOnce(new Error(REFUSED));
    await changeGateCode(view);
    const status = await save(view);
    expect(status).toHaveTextContent(
      `Family and Vet Clinic saved. Home Information and the after-hours clinic did not save: ${REFUSED} Press Save Changes to try again. Your edits there are still on this page.`,
    );
    expect(status).toHaveClass('err');
    expect(view.queryByText(/^Save failed/)).toBeNull();
    // No reload after a partial result, so the edit that did not save is still in its field.
    expect(view.getByDisplayValue('9001')).toBeInTheDocument();
    expect(getMyTribeProfile).toHaveBeenCalledTimes(1);
  });

  it('profile refused while the home details saved: names both halves, as an error', async () => {
    const { saveTribeProfile } = await import('../api/tribeApi');
    const { FirebaseError } = await import('firebase/app');
    const view = await renderTribeProfile({ profile: WITH_HOME_ACCESS });
    vi.mocked(saveTribeProfile).mockRejectedValueOnce(new FirebaseError('functions/resource-exhausted', 'Too many attempts. Try again later.'));
    await changeGateCode(view);
    const status = await save(view);
    expect(status).toHaveTextContent(
      'Home Information and the after-hours clinic saved. Family and Vet Clinic did not save: this household has saved too many times in the last hour. Wait a little, then save again. Your edits there are still on this page.',
    );
    expect(status).toHaveClass('err');
    expect(view.queryByText(/^Save failed/)).toBeNull();
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
 * #873. With a form schema, this screen rebuilt `customFields` from the schema
 * keys alone and the callables replaced the stored list whole, so every stored
 * row outside the schema was deleted on save and untouched schema fields were
 * written back as ''. The save now starts from the stored rows and changes only
 * the rows this screen edits. Removal is always named in removeCustomFieldKeys.
 */
describe('TribeProfile: a schema-mode save keeps the rows it does not edit (#873)', () => {
  const OFFICE = { key: 'gateNote', label: 'Set by Auntie', value: 'Side gate sticks' };
  const ALLERGY = { key: 'allergy', label: 'Allergies', value: 'Chicken' };
  const VET = { key: 'vetClinicId', label: 'Vet Clinic', value: 'clinic-1' };
  const SHED = { key: 'shed', label: 'Set by Auntie', value: 'Left of the gate' };
  const ALARM = { key: 'alarm', label: 'Alarm Code', value: '5678' };
  const AFTER_PHONE = { key: 'afterHoursVetPhone', label: 'After-hours Phone', value: '805-555-0100' };

  const SCHEMA_PROFILE: GetMyTribeProfileResult = {
    profile: { kinfolkId: 'kin-fam-1', displayName: 'The Ramirez Tribe', customFields: [OFFICE, ALLERGY, VET] },
    homeAccess: { ...PROFILE.homeAccess, customFields: [SHED, ALARM, AFTER_PHONE] },
  };
  const PROFILE_FORM: FormSchemaDto = {
    ...PROFILE_SCHEMA,
    sections: [
      {
        title: 'Family',
        description: null,
        fields: [textField('displayName', 'Family Display Name'), textField('allergy', 'Allergies'), textField('color', 'Favorite color')],
      },
    ],
  };
  const HOME_FORM: FormSchemaDto = {
    ...HOME_SCHEMA,
    sections: [{ ...HOME_SCHEMA.sections[0]!, fields: [...HOME_SCHEMA.sections[0]!.fields, textField('alarm', 'Alarm Code'), textField('pool', 'Pool gate')] }],
  };

  async function saved() {
    const { saveTribeProfile, saveHomeAccess } = await import('../api/tribeApi');
    await waitFor(() => expect(saveHomeAccess).toHaveBeenCalledTimes(1));
    return { profile: vi.mocked(saveTribeProfile).mock.calls[0]![0], home: vi.mocked(saveHomeAccess).mock.calls[0]![0] };
  }

  it('an untouched save sends every stored row as stored, in order, and writes no empty row for an unstored schema field', async () => {
    const view = await renderTribeProfile({ profile: SCHEMA_PROFILE, profileSchema: PROFILE_FORM, homeSchema: HOME_FORM });
    await view.findByDisplayValue('Chicken');
    await view.findByDisplayValue('5678');
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText('Saved.')).toBeInTheDocument();
    const { saveTribeProfile, saveHomeAccess } = await import('../api/tribeApi');
    const profile = vi.mocked(saveTribeProfile).mock.calls[0]![0];
    expect(profile.customFields).toEqual([OFFICE, ALLERGY, VET]);
    expect(profile.removeCustomFieldKeys).toEqual([]);
    // #868: nothing in the home details changed, so no home access call.
    expect(saveHomeAccess).not.toHaveBeenCalled();
  });

  it('an edited schema field changes only its own row, in place', async () => {
    const view = await renderTribeProfile({ profile: SCHEMA_PROFILE, profileSchema: PROFILE_FORM, homeSchema: HOME_FORM });
    const allergy = await view.findByDisplayValue('Chicken');
    await userEvent.clear(allergy);
    await userEvent.type(allergy, 'Beef');
    await userEvent.type(await view.findByDisplayValue('5678'), '9');
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    const { profile, home } = await saved();
    expect(profile.customFields).toEqual([OFFICE, { ...ALLERGY, value: 'Beef' }, VET]);
    expect(home.customFields).toEqual([SHED, { ...ALARM, value: '56789' }, AFTER_PHONE]);
  });

  it("a cleared schema field is sent as a real clear: its row with value ''", async () => {
    const view = await renderTribeProfile({ profile: SCHEMA_PROFILE, profileSchema: PROFILE_FORM, homeSchema: HOME_FORM });
    await userEvent.clear(await view.findByDisplayValue('Chicken'));
    await userEvent.clear(await view.findByDisplayValue('5678'));
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    const { profile, home } = await saved();
    expect(profile.customFields).toEqual([OFFICE, { ...ALLERGY, value: '' }, VET]);
    expect(home.customFields).toEqual([SHED, { ...ALARM, value: '' }, AFTER_PHONE]);
  });

  it('a cleared after-hours phone is removed by name, since an omitted row is kept', async () => {
    const view = await renderTribeProfile({ profile: SCHEMA_PROFILE, profileSchema: PROFILE_FORM, homeSchema: HOME_FORM });
    await userEvent.clear(await view.findByDisplayValue('805-555-0100'));
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    const { home } = await saved();
    expect(home.customFields).toEqual([SHED, ALARM]);
    expect(home.removeCustomFieldKeys).toEqual(['afterHoursVetPhone']);
  });

  it('without a schema the stored rows go back the same way, and a stored duplicate vetClinicId folds into one row', async () => {
    const dupVet: GetMyTribeProfileResult = {
      ...SCHEMA_PROFILE,
      profile: { ...SCHEMA_PROFILE.profile, customFields: [VET, OFFICE, { ...VET, value: 'clinic-1' }] },
    };
    const view = await renderTribeProfile({ profile: dupVet });
    await userEvent.click(await view.findByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText('Saved.')).toBeInTheDocument();
    const { saveTribeProfile, saveHomeAccess } = await import('../api/tribeApi');
    expect(vi.mocked(saveTribeProfile).mock.calls[0]![0].customFields).toEqual([VET, OFFICE]);
    expect(saveHomeAccess).not.toHaveBeenCalled();
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
/**
 * #901. The screen seeded an empty schema field with the schema's `defaultValue`
 * as its VALUE, while `schemaFieldRow` sends nothing for a key that was never
 * stored and never typed. So the household read a value off the screen, pressed
 * Save, and stored nothing.
 *
 * The ruling is that a default is a HINT, not a value: it shows as a placeholder
 * on both clients. Saving it instead would write rows nobody typed, freeze
 * today's default into the record, and make the field impossible to empty.
 */
describe('a schema default is a hint, never a stored value (#901)', () => {
  function fieldWithDefault(key: string, label: string, defaultValue: string): FormFieldDto {
    return { ...textField(key, label), defaultValue };
  }
  const PROFILE_FORM: FormSchemaDto = {
    ...PROFILE_SCHEMA,
    sections: [
      {
        title: 'Family',
        description: null,
        fields: [textField('displayName', 'Family Display Name'), fieldWithDefault('feeding', 'Feeding notes', 'Twice a day')],
      },
    ],
  };
  it('shows the default as a placeholder on an empty field, not as its value', async () => {
    const view = await renderTribeProfile({ profileSchema: PROFILE_FORM });
    const input = (await view.findByPlaceholderText('Twice a day')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(view.queryByDisplayValue('Twice a day')).toBeNull();
  });
  it('a save over an untouched default stores nothing for that key, so the screen and the record agree', async () => {
    const view = await renderTribeProfile({ profileSchema: PROFILE_FORM });
    await view.findByPlaceholderText('Twice a day');
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText('Saved.')).toBeInTheDocument();
    const { saveTribeProfile } = await import('../api/tribeApi');
    const sent = vi.mocked(saveTribeProfile).mock.calls[0]![0];
    expect(sent.customFields?.find((f) => f.key === 'feeding')).toBeUndefined();
    expect(sent.removeCustomFieldKeys).toEqual([]);
  });
  it('a typed value is saved as usual: the placeholder does not swallow real input', async () => {
    const view = await renderTribeProfile({ profileSchema: PROFILE_FORM });
    const input = await view.findByPlaceholderText('Twice a day');
    await userEvent.type(input, 'Once at six');
    await userEvent.click(view.getByRole('button', { name: /Save Changes/ }));
    expect(await view.findByText('Saved.')).toBeInTheDocument();
    const { saveTribeProfile } = await import('../api/tribeApi');
    const sent = vi.mocked(saveTribeProfile).mock.calls[0]![0];
    expect(sent.customFields).toContainEqual({ key: 'feeding', label: 'Feeding notes', value: 'Once at six' });
  });
  it('a stored value still wins over the default', async () => {
    const stored = {
      ...PROFILE,
      profile: { ...PROFILE.profile, customFields: [{ key: 'feeding', label: 'Feeding notes', value: 'Three times' }] },
    };
    const view = await renderTribeProfile({ profile: stored, profileSchema: PROFILE_FORM });
    const input = (await view.findByDisplayValue('Three times')) as HTMLInputElement;
    expect(input.placeholder).toBe('Twice a day');
  });
});
