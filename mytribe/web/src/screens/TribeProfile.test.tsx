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

async function renderTribeProfile(opts: { profileSchema?: FormSchemaDto; homeSchema?: FormSchemaDto }) {
  const tribeApi = await import('../api/tribeApi');
  const portal = await import('../api/portal');

  vi.mocked(tribeApi.getMyTribeProfile).mockResolvedValue(PROFILE);
  vi.mocked(tribeApi.getVetClinics).mockResolvedValue({ clinics: [] });
  vi.mocked(tribeApi.listMembers).mockResolvedValue({ members: [] });
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
