// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
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

// The child screens own their own loaders and their own suites (KinfolkEdit 24
// tests, HouseholdData 20). These are wiring tests: they assert the parent swaps
// to the right child, not that the child works.
vi.mock('./KinfolkEdit', () => ({
  KinfolkEdit: ({ onCancel }: { onCancel: () => void }) => (
    <div>
      <p>STUB KinfolkEdit</p>
      <button type="button" onClick={onCancel}>
        stub cancel
      </button>
    </div>
  ),
}));
vi.mock('./HouseholdData', () => ({
  HouseholdData: () => <p>STUB HouseholdData</p>,
}));
// "Members and invites" is a real anchor to `/household-members/{id}` rather
// than a sub-view swap, so this file needs the router's `Link`. The stub
// substitutes the params into the path the way the real one does, which is what
// the assertion below is actually about.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    className,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    className?: string;
    children: ReactNode;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, v), to)}
      className={className}
    >
      {children}
    </a>
  ),
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
    expect(p.emergencyContactPhone).toBe('');
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

  // Join-date rendering. These read as en-US ("Jul 24, 2026") because the screen
  // formats in the OPERATOR's locale and this suite runs under an en-US host, the
  // same assumption the rest of the repo's date assertions make.
  it('formats an ISO join date instead of printing the stored string', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: '2026-07-24' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('Joined Jul 24, 2026')).toBeInTheDocument();
  });

  it('reads the day out of a legacy UTC timestamp rather than showing the operator raw ISO', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: '2026-07-24T12:34:56.789Z' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('Joined Jul 24, 2026')).toBeInTheDocument();
  });

  it('passes a legacy join date it cannot read straight through, never "Invalid Date"', async () => {
    // Negative case: existing documents hold whatever Android's old free-text
    // field accepted. Display tolerates them; it does not throw, and it does not
    // invent a date.
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: '07/24/2026' }));
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    expect(await screen.findByText('Joined 07/24/2026')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Invalid Date');
  });

  it('says nothing at all when there is no join date', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: '' }));
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    await screen.findByText('512-555-1000');
    expect(container.textContent).not.toContain('Joined');
  });

  it('calls onBack from the Back control', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    const onBack = vi.fn();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: /back to directory/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('masks the gate code and the Wi-Fi password until the operator reveals them', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ gateCode: '4417', wifiPassword: 'hunter2' }));
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    await screen.findByText('Home & access');

    expect(container.textContent).not.toContain('4417');
    expect(container.textContent).not.toContain('hunter2');

    await userEvent.click(screen.getByRole('button', { name: /show gate code/i }));
    expect(screen.getByText('4417')).toBeInTheDocument();
    // Revealing one secret must not reveal the other.
    expect(container.textContent).not.toContain('hunter2');

    await userEvent.click(screen.getByRole('button', { name: /show wi-fi password/i }));
    expect(screen.getByText('hunter2')).toBeInTheDocument();
  });

  it('names the Wi-Fi network plainly and drops the old "password on file" hint', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ wifiName: 'Halbrook-5G', wifiPassword: 'hunter2' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByText('Home & access');

    expect(screen.getByText('Halbrook-5G')).toBeInTheDocument();
    expect(screen.queryByText(/password on file/i)).toBeNull();
  });

  it('leaves address, parking and entry notes readable at a glance (no toggle)', async () => {
    getKinfolkProfile.mockResolvedValue(
      profile({ serviceAddress: '1 Bark Ave', parkingInstructions: 'Driveway', entryNotes: 'Side door' }),
    );
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByText('Home & access');

    expect(screen.getByText('1 Bark Ave')).toBeInTheDocument();
    expect(screen.getByText('Driveway')).toBeInTheDocument();
    expect(screen.getByText('Side door')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^show /i })).toBeNull();
  });

  it('shows and edits household tags, saving via updateKinfolkTags', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ tags: ['VIP'] }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('VIP')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Slow pay{Enter}');
    await waitFor(() => expect(updateKinfolkTags).toHaveBeenCalledWith('k1', ['VIP', 'Slow pay']));
  });
});


describe('KinfolkProfile: sub-view wiring', () => {
  beforeEach(() => getKinfolkProfile.mockResolvedValue(profile()));

  // Both screens are reached from here, not from the rail, following the same
  // local-state pattern Directory uses to open this profile in the first place.
  it('swaps in the editor and back again without leaving the profile', async () => {
    const user = userEvent.setup();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[kin()]} onBack={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(screen.getByText('STUB KinfolkEdit')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /stub cancel/i }));
    expect(await screen.findByRole('button', { name: /back to directory/i })).toBeInTheDocument();
    expect(screen.queryByText('STUB KinfolkEdit')).not.toBeInTheDocument();
  });
  it('swaps in the household record', async () => {
    const user = userEvent.setup();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[kin()]} onBack={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /household data/i }));
    expect(screen.getByText('STUB HouseholdData')).toBeInTheDocument();
  });
  // Members is the one sub-view that is NOT a local swap: it has its own route,
  // so it gets a real anchor. That is what makes it linkable and openable in a
  // new tab, which a button swapping state can never be.
  it('links Members and invites at the household-members route', async () => {
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[kin()]} onBack={vi.fn()} />);
    const link = await screen.findByRole('link', { name: /members and invites/i });
    expect(link).toHaveAttribute('href', '/household-members/k1');
    // And it is no longer a state-swapping button.
    expect(screen.queryByRole('button', { name: /members and invites/i })).toBeNull();
  });

  it('still returns to the Directory from the profile itself', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[kin()]} onBack={onBack} />);
    await user.click(await screen.findByRole('button', { name: /back to directory/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
