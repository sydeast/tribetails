// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type Kinfolk, type Kin } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// The in-screen KinfolkProfile (opened by a card when propless) reads the full doc.
const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));

import { Directory } from './Directory';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function kinfolkRow(over: Partial<Kinfolk>): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '(512) 555-1234',
    email: 'jamie@example.com',
    profilePictureUrl: '',
    status: 'active',
    joinDate: '2026-01-01',
    ...over,
  };
}

function kinRow(over: Partial<Kin>): Kin {
  return {
    _id: 'k1',
    kinfolkId: 'kf1',
    name: 'Biscuit',
    species: 'Dog',
    breed: 'Corgi',
    age: '3',
    sex: 'Female',
    status: 'active',
    profilePictureUrl: '',
    updatedAt: fakeTs('2026-07-01T00:00:00Z'),
    ...over,
  };
}

let kinfolkAsync: Async<Kinfolk[]>;
let kinAsync: Async<Kin[]>;

beforeEach(() => {
  kinfolkAsync = { status: 'ready', data: [] };
  kinAsync = { status: 'ready', data: [] };
  useCollection.mockReset().mockImplementation((spec: { path: string }) =>
    spec.path === 'kinfolk' ? kinfolkAsync : kinAsync,
  );
});

describe('Directory screen, Kinfolk tab', () => {
  it('renders a household card with its active pets as chips', () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({})] };
    kinAsync = {
      status: 'ready',
      data: [kinRow({ _id: 'a', name: 'Biscuit' }), kinRow({ _id: 'b', name: 'Gravy' })],
    };
    render(<Directory />);
    expect(screen.getByText('Jamie Halbrook')).toBeInTheDocument();
    expect(screen.getByText('the Halbrooks')).toBeInTheDocument();
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText('Gravy')).toBeInTheDocument();
  });

  it('AO-11: shows a household\'s 4th+ pet via a visible overflow chip, never clipped', () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({})] };
    kinAsync = {
      status: 'ready',
      data: [
        kinRow({ _id: 'a', name: 'Biscuit' }),
        kinRow({ _id: 'b', name: 'Gravy' }),
        kinRow({ _id: 'c', name: 'Nacho' }),
        kinRow({ _id: 'd', name: 'Waffles' }),
      ],
    };
    render(<Directory />);
    // First three shown by name...
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText('Gravy')).toBeInTheDocument();
    expect(screen.getByText('Nacho')).toBeInTheDocument();
    // ...the 4th surfaces through the overflow chip, not its own name.
    expect(screen.queryByText('Waffles')).toBeNull();
    const overflow = screen.getByText('+1 more');
    expect(overflow).toBeInTheDocument();
    expect(overflow).toBeVisible();
  });

  it('excludes archived kin from a household\'s pet chips', () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({})] };
    kinAsync = {
      status: 'ready',
      data: [
        kinRow({ _id: 'a', name: 'Biscuit' }),
        kinRow({ _id: 'b', name: 'Gravy', status: 'archived' }),
      ],
    };
    render(<Directory />);
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.queryByText('Gravy')).toBeNull();
  });

  it('a kinfolk load failure is surfaced, never rendered as an empty or "Unnamed" list', () => {
    kinfolkAsync = { status: 'error', message: 'permission-denied' };
    render(<Directory />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/unnamed/i)).toBeNull();
    expect(screen.queryByText(/no kinfolk on file/i)).toBeNull();
    expect(screen.queryByText(/no matches/i)).toBeNull();
  });

  it('a broken Kin stream is disclosed by a banner rather than silently rendering every household as pet-less', () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({})] };
    kinAsync = { status: 'error', message: 'deadline-exceeded' };
    render(<Directory />);
    // The household still renders...
    expect(screen.getByText('Jamie Halbrook')).toBeInTheDocument();
    // ...but the failure is disclosed, not hidden behind a false "No kin on file".
    expect(screen.getByText(/couldn.t load pet data/i)).toBeInTheDocument();
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    kinfolkAsync = { status: 'ready', data: [] };
    render(<Directory />);
    expect(screen.getByText(/no kinfolk on file yet/i)).toBeInTheDocument();
  });

  it('search filters kinfolk by name, phone, or email', async () => {
    kinfolkAsync = {
      status: 'ready',
      data: [kinfolkRow({ _id: 'a', firstName: 'Jamie' }), kinfolkRow({ _id: 'b', firstName: 'Amy', lastName: 'Adams', email: 'amy@x.com' })],
    };
    render(<Directory />);
    await userEvent.type(screen.getByRole('searchbox'), 'amy');
    expect(screen.queryByText('Jamie Halbrook')).toBeNull();
    expect(screen.getByText('Amy Adams')).toBeInTheDocument();
  });

  it('clicking a household card calls onSelectKinfolk with its id', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    const onSelectKinfolk = vi.fn();
    render(<Directory onSelectKinfolk={onSelectKinfolk} />);
    await userEvent.click(screen.getByText('Jamie Halbrook'));
    expect(onSelectKinfolk).toHaveBeenCalledWith('kf1');
  });

  it('propless, a kinfolk card opens the in-screen KinfolkProfile', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    getKinfolkProfile.mockResolvedValue(
      (await import('../api/kinfolkProfile')).mergeKinfolkProfile('kf1', { firstName: 'Jamie', lastName: 'Halbrook' }),
    );
    render(<Directory />);
    // The card is now an interactive button (the profile detail view exists).
    const card = screen.getByRole('button', { name: /Jamie Halbrook/i });
    await userEvent.click(card);
    // The profile detail view took over.
    expect(await screen.findByRole('button', { name: /back to directory/i })).toBeInTheDocument();
    expect(getKinfolkProfile).toHaveBeenCalledWith('kf1');
  });

  it('the sort select reverses alphabetical order between A→Z and Z→A', async () => {
    kinfolkAsync = {
      status: 'ready',
      data: [
        kinfolkRow({ _id: 'a', firstName: 'Zack', lastName: 'Young' }),
        kinfolkRow({ _id: 'b', firstName: 'Amy', lastName: 'Adams' }),
      ],
    };
    render(<Directory />);
    const names = () => screen.getAllByText(/^(Zack Young|Amy Adams)$/).map((el) => el.textContent);
    expect(names()).toEqual(['Amy Adams', 'Zack Young']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /sort/i }), 'Z → A');
    expect(names()).toEqual(['Zack Young', 'Amy Adams']);
  });
});

describe('Directory screen, Kin tab', () => {
  async function openKinTab() {
    await userEvent.click(screen.getByRole('tab', { name: /^kin(\s|·|$)/i }));
  }

  it('renders every active kin as a standalone card', async () => {
    kinAsync = {
      status: 'ready',
      data: [kinRow({ _id: 'a', name: 'Biscuit' }), kinRow({ _id: 'b', name: 'Gravy', status: 'archived' })],
    };
    render(<Directory />);
    await openKinTab();
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.queryByText('Gravy')).toBeNull();
  });

  it('search filters kin by species or breed', async () => {
    kinAsync = {
      status: 'ready',
      data: [kinRow({ _id: 'a', name: 'Biscuit', species: 'Dog' }), kinRow({ _id: 'b', name: 'Whiskers', species: 'Cat', breed: 'Tabby' })],
    };
    render(<Directory />);
    await openKinTab();
    await userEvent.type(screen.getByRole('searchbox'), 'tabby');
    expect(screen.queryByText('Biscuit')).toBeNull();
    expect(screen.getByText('Whiskers')).toBeInTheDocument();
  });

  it('clicking a kin card calls onSelectKin with its id', async () => {
    kinAsync = { status: 'ready', data: [kinRow({ _id: 'k9', name: 'Biscuit' })] };
    const onSelectKin = vi.fn();
    render(<Directory onSelectKin={onSelectKin} />);
    await openKinTab();
    await userEvent.click(screen.getByText('Biscuit'));
    expect(onSelectKin).toHaveBeenCalledWith('k9');
  });

  it('a kin load failure is surfaced, never a false empty list', async () => {
    kinAsync = { status: 'error', message: 'insufficient permissions' };
    render(<Directory />);
    await openKinTab();
    expect(screen.getByText(/insufficient permissions/i)).toBeInTheDocument();
    expect(screen.queryByText(/no kin on file/i)).toBeNull();
  });

  it('does not offer "Recently Created" as a sort, no backing field on the Kin collection', async () => {
    render(<Directory />);
    await openKinTab();
    expect(screen.queryByRole('option', { name: 'Recently Created' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Recently Updated' })).toBeInTheDocument();
  });
});

describe('Directory screen, Add kinfolk / Add kin (the deferred create flows)', () => {
  it('the "Add kinfolk" header button opens the Add kinfolk dialog', async () => {
    render(<Directory />);
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    expect(screen.getByRole('dialog', { name: /^add kinfolk$/i })).toBeInTheDocument();
  });

  it('Cancel closes the Add kinfolk dialog without creating anything', async () => {
    render(<Directory />);
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /^add kinfolk$/i })).toBeNull();
  });

  it('the "Add kin" header button opens the Add kin dialog, offering every loaded household in its picker', async () => {
    kinfolkAsync = {
      status: 'ready',
      data: [
        kinfolkRow({ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook' }),
        kinfolkRow({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' }),
      ],
    };
    render(<Directory />);
    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));
    expect(screen.getByRole('dialog', { name: /^add kin$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Jamie Halbrook' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Amy Adams' })).toBeInTheDocument();
  });

  it('the Add kin household picker is empty while the Kinfolk stream is still loading, never fabricated', async () => {
    kinfolkAsync = { status: 'loading' };
    render(<Directory />);
    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));
    const householdSelect = screen.getByLabelText('Household');
    expect(householdSelect).toHaveValue('');
    // Only the "Choose a household…" placeholder, scoped to this select (the
    // page behind the dialog has its own <option>s, e.g. the sort dropdown).
    expect(within(householdSelect).getAllByRole('option')).toHaveLength(1);
  });

  it('Cancel closes the Add kin dialog without creating anything', async () => {
    render(<Directory />);
    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /^add kin$/i })).toBeNull();
  });
});
