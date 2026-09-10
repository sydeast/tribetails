// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type Kinfolk, type Kin } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// A household card NAVIGATES now, so the router is mocked the way Bookings.test
// and Schedule.test already mock it. `Link` is here because the profile this
// screen still renders from its route param has a real anchor to the members
// route inside it.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
const routerHistory = vi.hoisted(() => ({ canGoBack: vi.fn(() => false), back: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  // KinfolkProfile's Back reads `history.canGoBack()` (#689). Cold arrival by
  // default, which is what the profile assertions below expect to see named.
  useRouter: () => ({ history: routerHistory }),
  // Identity, the AppShell.test.tsx convention. KinfolkProfile builds its
  // breadcrumb's Directory step with `linkOptions`.
  linkOptions: (o: unknown) => o,
  Link: ({ to, children }: { to?: string; children: ReactNode }) => (
    <a href={to ?? '/household-members'}>{children}</a>
  ),
}));

// The in-screen KinfolkProfile (opened by a card when propless) reads the full doc.
const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));

// Wiring test only: KinView owns its own suite. What Directory owns is
// RESOLVING which household a kin card belongs to, since the kin doc holds an
// id and the breadcrumb needs a name.
vi.mock('./KinView', () => ({
  KinView: ({
    household,
    openedFrom,
  }: {
    household?: { id: string; name: string };
    openedFrom: 'directory' | 'profile';
  }) => (
    <p>
      STUB KinView household={household ? `${household.id}/${household.name}` : 'unresolved'}{' '}
      openedFrom={openedFrom}
    </p>
  ),
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
  navigate.mockReset();
  getKinfolkProfile.mockReset();
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
    expect(screen.getByText(/couldn.t load Kin data/i)).toBeInTheDocument();
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

  it('navigates to the profile route instead of swapping in-place state', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Directory />);
    // The card is an interactive button; activating it changes the URL rather
    // than swapping a sibling view in behind an unchanged `/directory`.
    await userEvent.click(screen.getByRole('button', { name: /Jamie Halbrook/i }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf1' },
    });
    // And it did NOT open the profile in place: no read was issued for it.
    expect(getKinfolkProfile).not.toHaveBeenCalled();
  });

  // The landing half of the Notifications feed's kinfolk deep link (issue #20):
  // /directory/{id} mounts this screen straight into the household profile.
  it('initialKinfolkId opens that household profile on mount, no click needed', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    getKinfolkProfile.mockResolvedValue(
      (await import('../api/kinfolkProfile')).mergeKinfolkProfile('kf1', { firstName: 'Jamie', lastName: 'Halbrook' }),
    );
    render(<Directory initialKinfolkId="kf1" />);
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

  /**
   * Item 7b. The kin detail's trail reads Directory / <household> / <kin>
   * (`auntieos-kin-detail-2026-05-27.html`), and only this screen holds both
   * streams needed to turn the kin's `kinfolkId` into a household name.
   */
  it('hands the kin detail the household the pet belongs to', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({})] };
    kinAsync = { status: 'ready', data: [kinRow({ _id: 'k9', name: 'Biscuit', kinfolkId: 'kf1' })] };
    render(<Directory />);
    await openKinTab();
    await userEvent.click(screen.getByText('Biscuit'));
    expect(screen.getByText(/household=kf1\/Jamie Halbrook/)).toBeInTheDocument();
    // Opened from the Kin TAB, so the URL is still /directory (#689).
    expect(screen.getByText(/openedFrom=directory/)).toBeInTheDocument();
  });
  /**
   * #689. The same view, drilled into from a household profile, is standing on
   * `/directory/{id}` instead, and only this screen knows which of the two
   * mounts it is: the profile is open underneath whenever the route named one.
   */
  it('tells the kin detail it was opened from a household profile', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    kinAsync = { status: 'ready', data: [kinRow({ _id: 'k9', name: 'Biscuit', kinfolkId: 'kf1' })] };
    getKinfolkProfile.mockResolvedValue(
      (await import('../api/kinfolkProfile')).mergeKinfolkProfile('kf1', {
        firstName: 'Jamie',
        lastName: 'Halbrook',
      }),
    );
    render(<Directory initialKinfolkId="kf1" />);
    await userEvent.click(await screen.findByText('Biscuit'));
    expect(screen.getByText(/openedFrom=profile/)).toBeInTheDocument();
  });
  /**
   * Unresolved, not invented. A kin whose `kinfolkId` names no household this
   * stream holds gets NO household step: a trail step is a claim about where
   * you are, and a guessed one points at a home the pet does not live in.
   */
  it('leaves the household unresolved rather than guessing at one', async () => {
    kinAsync = {
      status: 'ready',
      data: [kinRow({ _id: 'k9', name: 'Biscuit', kinfolkId: 'kf-gone' })],
    };
    render(<Directory />);
    await openKinTab();
    await userEvent.click(screen.getByText('Biscuit'));
    expect(screen.getByText(/household=unresolved/)).toBeInTheDocument();
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

/**
 * #713's second half: "tags are just labels and not actual tags which act like
 * a filter." Both lists narrow by tag now, client-side over the rows the screen
 * already streams.
 */
describe('Directory screen, tag filter', () => {
  it('narrows the household list to the chosen tag', async () => {
    kinfolkAsync = {
      status: 'ready',
      data: [
        kinfolkRow({ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook', tags: ['VIP'] }),
        kinfolkRow({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams', tags: ['Slow pay'] }),
        kinfolkRow({ _id: 'kf3', firstName: 'Ros', lastName: 'Vance' }),
      ],
    };
    render(<Directory />);
    expect(screen.getByText('Amy Adams')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Filter kinfolk by tag'), 'VIP');

    expect(screen.getByText('Jamie Halbrook')).toBeInTheDocument();
    expect(screen.queryByText('Amy Adams')).toBeNull();
    expect(screen.queryByText('Ros Vance')).toBeNull();
  });

  it('narrows the Kin list to the chosen tag', async () => {
    kinAsync = {
      status: 'ready',
      data: [
        kinRow({ _id: 'k1', name: 'Biscuit', tags: ['Reactive'] }),
        kinRow({ _id: 'k2', name: 'Gravy', tags: ['On meds'] }),
      ],
    };
    render(<Directory />);
    await userEvent.click(screen.getByRole('tab', { name: /^kin(\s|·|$)/i }));
    expect(screen.getByText('Gravy')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Filter kin by tag'), 'Reactive');

    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.queryByText('Gravy')).toBeNull();
  });

  it('offers each tab its own vocabulary, never the other list\'s tags', async () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1', tags: ['VIP'] })] };
    kinAsync = { status: 'ready', data: [kinRow({ _id: 'k1', tags: ['Reactive'] })] };
    render(<Directory />);

    const householdFilter = screen.getByLabelText('Filter kinfolk by tag');
    expect(within(householdFilter).getByRole('option', { name: 'VIP' })).toBeInTheDocument();
    expect(within(householdFilter).queryByRole('option', { name: 'Reactive' })).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /^kin(\s|·|$)/i }));
    const kinFilter = screen.getByLabelText('Filter kin by tag');
    expect(within(kinFilter).getByRole('option', { name: 'Reactive' })).toBeInTheDocument();
    expect(within(kinFilter).queryByRole('option', { name: 'VIP' })).toBeNull();
  });

  it('says the TAG is what emptied the list, not the search box', async () => {
    kinfolkAsync = {
      status: 'ready',
      data: [
        kinfolkRow({ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook', tags: ['VIP'] }),
        kinfolkRow({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' }),
      ],
    };
    render(<Directory />);
    await userEvent.selectOptions(screen.getByLabelText('Filter kinfolk by tag'), 'VIP');
    await userEvent.type(screen.getByLabelText(/search kinfolk/i), 'Amy');

    expect(screen.getByText('No matches for "Amy" tagged "VIP".')).toBeInTheDocument();
  });

  it('hides the filter entirely when nothing on the tab carries a tag', () => {
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Directory />);
    expect(screen.queryByLabelText('Filter kinfolk by tag')).toBeNull();
  });

  /**
   * The sequence this PR makes reachable: filter by a tag here, delete that tag
   * in Settings, and the live stream drops every assignment. The picker hides
   * itself, so a filter left standing would strand the list on an empty result
   * with no control left to clear it.
   */
  it('falls back to every row when the filtered tag stops existing', async () => {
    kinfolkAsync = {
      status: 'ready',
      data: [
        kinfolkRow({ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook', tags: ['VIP'] }),
        kinfolkRow({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' }),
      ],
    };
    const { rerender } = render(<Directory />);
    await userEvent.selectOptions(screen.getByLabelText('Filter kinfolk by tag'), 'VIP');
    expect(screen.queryByText('Amy Adams')).toBeNull();

    // The cascade lands: no household carries "VIP" any more.
    kinfolkAsync = {
      status: 'ready',
      data: [
        kinfolkRow({ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook' }),
        kinfolkRow({ _id: 'kf2', firstName: 'Amy', lastName: 'Adams' }),
      ],
    };
    rerender(<Directory />);

    expect(screen.queryByLabelText('Filter kinfolk by tag')).toBeNull();
    expect(screen.getByText('Jamie Halbrook')).toBeInTheDocument();
    expect(screen.getByText('Amy Adams')).toBeInTheDocument();
  });
});
