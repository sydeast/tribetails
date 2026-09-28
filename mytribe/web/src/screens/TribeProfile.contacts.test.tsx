// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TribeProfile } from './TribeProfile';
import type { GetMyTribeProfileResult } from '../api/tribeApi';

/**
 * The portal Tribe profile has no contacts card (#829).
 *
 * Operator ruling 2026-09-27: "there is no true 'Contact List'. There can be
 * up to 3 ppl's contact info to a household: Primary Kinfolk (PK), Secondary
 * Kinfolk (SK), and Emergency Contact (EC)." It replaces the 2026-09-12 ruling
 * #818 built this card for. The card, its form and its remove confirm are gone,
 * and the screen never calls the three contact callables. They stay in
 * `api/tribeApi.ts` until the operator has read `report:household-contacts`
 * and ruled on the data.
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
    // 2026-09-27 Q3: the Secondary Kinfolk card reads its own callable.
    listSecondaryKinfolk: async () => [],
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMyTribeProfile.mockResolvedValue(PROFILE);
  mocks.getVetClinics.mockResolvedValue({ clinics: [] });
  mocks.listMembers.mockResolvedValue({ members: [] });
  mocks.getFormSchema.mockRejectedValue(new Error('not-found'));
  mocks.getBusinessContact.mockResolvedValue({ name: 'Tribe Tails Pet Care', email: '', phone: '', address: '' });
  mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
});

afterEach(() => {
  cleanup();
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

describe('TribeProfile has no contacts card (#829, ruling 2026-09-27)', () => {
  it('draws no contacts card, no add button and no contact form, and never reads the contacts', async () => {
    await renderProfile();
    // The screen did render: the invite card below the members list is there.
    expect(await screen.findByRole('button', { name: /send invite/i })).toBeInTheDocument();

    expect(screen.queryByRole('heading', { name: /contacts without an account/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save contact' })).toBeNull();
    expect(document.querySelector('#hc-name')).toBeNull();
    expect(mocks.listHouseholdContacts).not.toHaveBeenCalled();
    expect(mocks.saveHouseholdContact).not.toHaveBeenCalled();
    expect(mocks.removeHouseholdContact).not.toHaveBeenCalled();
  });
});
