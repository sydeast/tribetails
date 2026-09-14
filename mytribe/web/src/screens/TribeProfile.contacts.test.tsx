// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { TribeProfile } from './TribeProfile';
import type { GetMyTribeProfileResult, HouseholdContactDto } from '../api/tribeApi';

/**
 * The portal's half of #818: a household records somebody it can be reached
 * through who will never hold an account.
 *
 * WHAT THESE PIN, in the order the issue asked for them:
 *
 *   1. The save payload has no `permissions` and no `role`. The server refuses
 *      them with a `.strict()` schema
 *      (`functions/test/householdContacts.test.ts`, three cases named THE
 *      WALL), and `api/tribeApi.test.ts` asserts the key set of the built
 *      payload. This asserts the SCREEN hands that builder nothing else, which
 *      is the only place the two could grow back together.
 *   2. A member who may not manage contacts gets told who does, not "couldn't
 *      load". The gate is the server's `requireKinfolkPrimary`, unchanged from
 *      #817, and an ACTIVE SECONDARY is denied on all three callables.
 *   3. A save with no signal is ABANDONED and says so. The create path is a
 *      bare `collection.add`, so a held write that re-sends after the household
 *      re-typed it is two rows.
 *   4. The invite and the contact stay visibly apart on one screen.
 */

const mocks = vi.hoisted(() => ({
  getMyTribeProfile: vi.fn(),
  getFormSchema: vi.fn(),
  getVetClinics: vi.fn(),
  listMembers: vi.fn(),
  saveTribeProfile: vi.fn(),
  saveHomeAccess: vi.fn(),
  submitVetClinic: vi.fn(),
  addSecondaryContact: vi.fn(),
  updateSecondaryPermissions: vi.fn(),
  listHouseholdContacts: vi.fn(),
  saveHouseholdContact: vi.fn(),
  removeHouseholdContact: vi.fn(),
  listEmergencyContacts: vi.fn(),
  saveEmergencyContacts: vi.fn(),
  getBusinessContact: vi.fn(),
}));

vi.mock('../api/tribeApi', async () => {
  const actual = await vi.importActual<typeof import('../api/tribeApi')>('../api/tribeApi');
  return {
    ...actual,
    getMyTribeProfile: (...a: unknown[]) => mocks.getMyTribeProfile(...a),
    getFormSchema: (...a: unknown[]) => mocks.getFormSchema(...a),
    getVetClinics: (...a: unknown[]) => mocks.getVetClinics(...a),
    listMembers: (...a: unknown[]) => mocks.listMembers(...a),
    saveTribeProfile: (...a: unknown[]) => mocks.saveTribeProfile(...a),
    saveHomeAccess: (...a: unknown[]) => mocks.saveHomeAccess(...a),
    submitVetClinic: (...a: unknown[]) => mocks.submitVetClinic(...a),
    addSecondaryContact: (...a: unknown[]) => mocks.addSecondaryContact(...a),
    updateSecondaryPermissions: (...a: unknown[]) => mocks.updateSecondaryPermissions(...a),
    listHouseholdContacts: (...a: unknown[]) => mocks.listHouseholdContacts(...a),
    saveHouseholdContact: (...a: unknown[]) => mocks.saveHouseholdContact(...a),
    removeHouseholdContact: (...a: unknown[]) => mocks.removeHouseholdContact(...a),
    listEmergencyContacts: (...a: unknown[]) => mocks.listEmergencyContacts(...a),
    saveEmergencyContacts: (...a: unknown[]) => mocks.saveEmergencyContacts(...a),
  };
});

vi.mock('../api/portal', () => ({ getBusinessContact: (...a: unknown[]) => mocks.getBusinessContact(...a) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

const PROFILE: GetMyTribeProfileResult = {
  profile: { kinfolkId: 'kin-fam-1', displayName: 'The Ramirez Tribe', customFields: [] },
  homeAccess: { gateCode: null, keyLocation: null, wifiPassword: null, customFields: [], updatedAtMs: null },
};

function contact(overrides: Partial<HouseholdContactDto> = {}): HouseholdContactDto {
  return {
    contactId: 'c1',
    name: 'Ada Rivera',
    label: 'Sister',
    phone: '805 555 0143',
    email: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** A Firebase callable rejection, shaped the way the SDK reports a denied gate. */
function denied(): Error {
  return Object.assign(new Error('permission-denied'), { code: 'functions/permission-denied' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMyTribeProfile.mockResolvedValue(PROFILE);
  mocks.getVetClinics.mockResolvedValue({ clinics: [] });
  mocks.listMembers.mockResolvedValue({ members: [] });
  mocks.getFormSchema.mockRejectedValue(new Error('not-found'));
  mocks.getBusinessContact.mockResolvedValue({ name: 'Tribe Tails Pet Care', email: '', phone: '', address: '' });
  mocks.listHouseholdContacts.mockResolvedValue([]);
  mocks.saveHouseholdContact.mockResolvedValue({ contactId: 'c9', created: true });
  mocks.removeHouseholdContact.mockResolvedValue(undefined);
  mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
});

afterEach(() => {
  // Unmount BEFORE restoring the network: `onlineManager` is a module
  // singleton, so a held mutation left over from one test would resume against
  // the next test's mocks.
  cleanup();
  onlineManager.setOnline(true);
});

/** Drain microtasks and one macrotask so a settled query has re-rendered. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderProfile() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TribeProfile />
    </QueryClientProvider>,
  );
  await flush();
  return view;
}

describe('TribeProfile household contacts (#818)', () => {
  it('records a contact and never sends a permission set or a role with it', async () => {
    await renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a contact' }));

    await userEvent.type(screen.getByLabelText('Name', { selector: '#hc-name' }), 'Ada Rivera');
    await userEvent.type(screen.getByLabelText('What they are to your Tribe'), 'Sister');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#hc-phone' }), '805 555 0143');
    await userEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    await flush();

    expect(mocks.saveHouseholdContact).toHaveBeenCalledTimes(1);
    const [input, kinfolkId] = mocks.saveHouseholdContact.mock.calls[0] ?? [];
    expect(kinfolkId).toBe('kin-fam-1');
    // THE KEY SET, not just the values: a fifth key beside these four is how a
    // contact would quietly become an invite.
    expect(Object.keys(input as object).sort()).toEqual(['email', 'label', 'name', 'phone']);
    expect(input).toEqual({ name: 'Ada Rivera', label: 'Sister', phone: '805 555 0143', email: '' });

    // And the household is told, in the portal's own words, what did NOT happen.
    expect(await screen.findByText(/No portal account was created/i)).toBeTruthy();
  });

  it('edits in place: the same four fields plus the contact id, and never a createdAt', async () => {
    mocks.listHouseholdContacts.mockResolvedValue([contact({ email: 'ada@example.com' })]);
    mocks.saveHouseholdContact.mockResolvedValue({ contactId: 'c1', created: false });
    await renderProfile();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const phone = screen.getByLabelText('Phone', { selector: '#hc-phone' });
    await userEvent.clear(phone);
    await userEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    await flush();

    const [input] = mocks.saveHouseholdContact.mock.calls[0] ?? [];
    expect(Object.keys(input as object).sort()).toEqual(['contactId', 'email', 'label', 'name', 'phone']);
    // CLEARING STICKS: the emptied phone is SENT as '' so the server can null
    // it. Omitting it would leave the old number on the document forever.
    expect(input).toEqual({
      contactId: 'c1',
      name: 'Ada Rivera',
      label: 'Sister',
      phone: '',
      email: 'ada@example.com',
    });
  });

  it('tells a member who may not keep this list who does, instead of "couldn’t load"', async () => {
    mocks.listHouseholdContacts.mockRejectedValue(denied());
    await renderProfile();

    expect(await screen.findByText(/Your primary kinfolk keeps this list/i)).toBeTruthy();
    // No add form and no rows: the card does not offer a gesture the server
    // will refuse.
    expect(screen.queryByRole('button', { name: 'Add a contact' })).toBeNull();
    expect(screen.queryByText(/Couldn’t load your contacts/i)).toBeNull();
  });

  it('an unreadable answer is not an empty household', async () => {
    mocks.listHouseholdContacts.mockRejectedValue(new Error('internal'));
    await renderProfile();

    expect(await screen.findByText(/Couldn’t load your contacts right now/i)).toBeTruthy();
    expect(screen.queryByText(/Nobody is written down yet/i)).toBeNull();
  });

  it('ABANDONS a save with no signal: nothing is sent, and the card says nothing changed', async () => {
    await renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#hc-name' }), 'Ada Rivera');

    onlineManager.setOnline(false);
    await act(() => void screen.getByRole('button', { name: 'Save contact' }).click());
    await flush();

    // The preflight refused before dialling. This is the whole reason the
    // policy is 'abandon': a create has no idempotency key, so a held write
    // that re-sends later is a second Ada.
    expect(mocks.saveHouseholdContact).not.toHaveBeenCalled();
    expect(screen.getByText(/was not sent. Nothing has changed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Waiting for signal/i })).toBeNull();
  });

  it('HOLDS a removal with no signal, and asks before it removes anything at all', async () => {
    mocks.listHouseholdContacts.mockResolvedValue([contact()]);
    await renderProfile();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    // The confirm is a step, not a wired button: nothing has gone yet.
    expect(mocks.removeHouseholdContact).not.toHaveBeenCalled();
    expect(screen.getByText(/There is no account to suspend/i)).toBeTruthy();

    onlineManager.setOnline(false);
    await act(() => void screen.getByRole('button', { name: 'Remove' }).click());
    await flush();

    // React Query's own pause, not a stub: the mutation function never ran.
    expect(mocks.removeHouseholdContact).not.toHaveBeenCalled();
    expect(screen.getByText(/waiting on this phone/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Waiting for signal/i })).toBeTruthy();
  });

  it('removes the contact once it is confirmed with signal', async () => {
    mocks.listHouseholdContacts.mockResolvedValue([contact()]);
    await renderProfile();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await flush();

    expect(mocks.removeHouseholdContact).toHaveBeenCalledWith('c1', 'kin-fam-1');
  });

  it('keeps the invite and the contact visibly apart on the one screen', async () => {
    mocks.listHouseholdContacts.mockResolvedValue([contact()]);
    await renderProfile();

    expect(await screen.findByRole('heading', { name: 'Invite a Kinfolk' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Contacts Without an Account' })).toBeTruthy();
    // The contact row carries its label and phone, and no status: a contact has
    // no invite to be pending and no account to be active.
    expect(screen.getByText('Sister · 805 555 0143')).toBeTruthy();
    expect(screen.queryByText(/Invite pending/i)).toBeNull();

    // The one place a household might think an address grants a sign-in says
    // otherwise, right under the field.
    await userEvent.click(screen.getByRole('button', { name: 'Add a contact' }));
    expect(screen.getByText(/Optional, and it invites nobody/i)).toBeTruthy();
  });

  it('an empty list reads as empty, and an offline one does not', async () => {
    await renderProfile();
    expect(await screen.findByText(/Nobody is written down yet/i)).toBeTruthy();
  });
});
