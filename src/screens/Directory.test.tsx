// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type Kinfolk, type Kin } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

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

  it('renders the card STATIC (not an interactive button) when onSelectKinfolk is omitted', () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Directory />);
    // Card content renders, but it is NOT a clickable button when unwired.
    expect(screen.getByText('Jamie Halbrook')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jamie Halbrook/i })).toBeNull();
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
