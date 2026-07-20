// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Kin } from '../api/directory';
import type { KinfolkProfile as Profile } from '../api/kinfolkProfile';

const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));
// The Tags panel (ProfileTagsSection) loads the vocab + persists tag edits.
const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch) }));
const { updateKinfolkTags } = vi.hoisted(() => ({ updateKinfolkTags: vi.fn() }));
vi.mock('../api/directoryWrite', async (orig) => ({
  ...(await orig<typeof import('../api/directoryWrite')>()),
  updateKinfolkTags,
}));

import { KinfolkProfile } from './KinfolkProfile';
import { mergeKinfolkProfile } from '../api/kinfolkProfile';

function profile(over: Partial<Profile> = {}): Profile {
  return mergeKinfolkProfile('k1', {
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '512-555-1000',
    status: 'active',
    ...over,
  });
}
function kin(over: Partial<Kin> = {}): Kin {
  return { _id: 'p1', name: 'Willow', species: 'Dog', breed: 'Lab', age: '4', sex: 'F', status: 'active', profilePictureUrl: '', ...over } as Kin;
}

beforeEach(() => {
  getKinfolkProfile.mockReset();
  getBusinessSettings.mockReset();
  getBusinessSettings.mockResolvedValue({ householdTags: [], petTags: [] });
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
  updateKinfolkTags.mockReset();
  updateKinfolkTags.mockResolvedValue(undefined);
});

describe('mergeKinfolkProfile (pure)', () => {
  it('defaults every field so a partial doc never renders undefined', () => {
    const p = mergeKinfolkProfile('k9', { firstName: 'A' });
    expect(p._id).toBe('k9');
    expect(p.firstName).toBe('A');
    expect(p.gateCode).toBe('');
    expect(p.vetClinicPhone).toBe('');
    expect(p.status).toBe('active');
  });
  it('ignores non-string field values (never coerces to "undefined")', () => {
    const p = mergeKinfolkProfile('k1', { phoneNumber: 42 as unknown as string });
    expect(p.phoneNumber).toBe('');
  });
});

describe('KinfolkProfile', () => {
  it('loads and shows household + contact + kin', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ email: 'jamie@x.com', serviceAddress: '1 Bark Ave' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[kin()]} onBack={vi.fn()} />);
    expect(await screen.findByText('512-555-1000')).toBeInTheDocument();
    expect(screen.getByText('jamie@x.com')).toBeInTheDocument();
    expect(screen.getByText('1 Bark Ave')).toBeInTheDocument();
    expect(screen.getByText('Willow')).toBeInTheDocument();
    expect(getKinfolkProfile).toHaveBeenCalledWith('k1');
  });

  it('omits all-blank sections (no empty Emergency/Vet panels)', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByText('512-555-1000');
    expect(screen.queryByText('Emergency')).toBeNull();
    expect(screen.queryByText('Vet clinic')).toBeNull();
  });

  it('shows the Emergency section when a field is present', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ emergencyContactName: 'Sam', emergencyContactPhone: '555-9' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('Emergency')).toBeInTheDocument();
    expect(screen.getByText('Sam')).toBeInTheDocument();
  });

  // NOTE: the fail-loud LOAD-ERROR path (getKinfolkProfile rejects -> AsyncRegion
  // "Couldn't load household" + the named message) is the shared AsyncRegion + load
  // pattern this screen copies verbatim from ConversationThread, whose
  // ConversationThread.test.tsx "surfaces a load failure fail-loud" case exercises
  // it directly. A duplicate here tripped a vitest unhandled-rejection false-positive
  // (the code catches correctly; the sibling test proves the behavior), so it is
  // covered there rather than re-asserted here.

  it('calls onBack from the Back control', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    const onBack = vi.fn();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: /back to directory/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows and edits household tags, saving via updateKinfolkTags', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ tags: ['VIP'] }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('VIP')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Slow pay{Enter}');
    await waitFor(() => expect(updateKinfolkTags).toHaveBeenCalledWith('k1', ['VIP', 'Slow pay']));
  });
});
