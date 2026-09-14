// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Kin } from '../api/directory';
import type { KinfolkProfile as Profile } from '../api/kinfolkProfile';

const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
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
// `useRouter` is here for the Back control: it reads `history.canGoBack()` to
// decide between stepping back and the `onBack` fallback (#689). Default is a
// cold arrival (nothing behind us), which is what most of this file asserts.
const routerHistory = vi.hoisted(() => ({ canGoBack: vi.fn(() => false), back: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  linkOptions: (o: unknown) => o,
  useRouter: () => ({ history: routerHistory }),
  Link: ({
    to,
    params,
    search,
    className,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    className?: string;
    children: ReactNode;
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [k, v]) => p.replace(`$${k}`, v), to);
    const q = new URLSearchParams(search ?? {}).toString();
    return (
      <a href={q === '' ? path : `${path}?${q}`} className={className}>
        {children}
      </a>
    );
  },
}));
// The 411 (per-kin) and the dossier (per-household) are ADMIN-ONLY point reads.
// Both are stubbed so no spec here touches Firestore.
const { getKin411, getDossier } = vi.hoisted(() => ({
  getKin411: vi.fn(),
  getDossier: vi.fn(),
}));
vi.mock('../api/recipientContext', async (orig) => ({
  ...(await orig<typeof import('../api/recipientContext')>()),
  getKin411,
  getDossier,
}));
// The three feed cards and the vet panels each open a live collection. Held at
// `loading` by default so a spec that is not about them renders nothing from
// them; the feed specs below set a ready state per call.
const useCollection = vi.fn();
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec) ?? { status: 'loading' },
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
  getKin411.mockReset();
  getKin411.mockResolvedValue(null);
  getDossier.mockReset();
  getDossier.mockResolvedValue(null);
  useCollection.mockReset();
  useCollection.mockReturnValue({ status: 'loading' });
  routerHistory.canGoBack.mockReset();
  routerHistory.canGoBack.mockReturnValue(false);
  routerHistory.back.mockReset();
});

describe('mergeKinfolkProfile (pure)', () => {
  it('defaults every field so a partial doc never renders undefined', () => {
    const p = mergeKinfolkProfile('k9', { firstName: 'A' });
    expect(p._id).toBe('k9');
    expect(p.firstName).toBe('A');
    expect(p.gateCode).toBe('');
    expect(p.emergencyContacts).toEqual([]);
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

  it('omits the empty Vet panel, but still shows Emergency Contacts, flagged (#829)', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByText('512-555-1000');
    // #829: the Emergency Contacts panel is never omitted. A household with
    // none still needs it, it is where the flag saying so lives.
    expect(screen.getByRole('heading', { name: 'Emergency Contacts' })).toBeInTheDocument();
    expect(screen.getByText('No Emergency Contact')).toBeInTheDocument();
    expect(screen.queryByText('Vet clinic')).toBeNull();
  });

  it('shows the Emergency Contacts section when a field is present, renamed from "Emergency" (#680)', async () => {
    getKinfolkProfile.mockResolvedValue(
      profile({ emergencyContacts: [{ name: 'Sam', phone: '555-9', relationship: null, recordedAt: null, updatedAt: null }] }),
    );
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Emergency Contacts' })).toBeInTheDocument();
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

  // #689. Two halves of one control: on a cold arrival it falls back to the
  // Directory and says so; walked into, it returns to whatever the operator was
  // reading and drops the claim about where that is.
  it('falls back to the Directory, and names it, when nothing is behind this page', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    const onBack = vi.fn();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Back to Directory' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(routerHistory.back).not.toHaveBeenCalled();
  });

  it('steps back through history, under a plain label, when the operator walked here', async () => {
    routerHistory.canGoBack.mockReturnValue(true);
    getKinfolkProfile.mockResolvedValue(profile());
    const onBack = vi.fn();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={onBack} />);
    // Not "Back to Directory": the page behind this one may be the Schedule, an
    // invoice, or the Inbox, and the button no longer guesses.
    expect(screen.queryByRole('button', { name: /back to/i })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(routerHistory.back).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();
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

  it('shows household tags as read-only pills in the hero, with no editor on this screen (#681)', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ tags: ['VIP', 'Slow pay'] }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('Slow pay')).toBeInTheDocument();
    // Tag editing moved to the Edit form; the read-only profile offers no way
    // to add or remove one.
    expect(screen.queryByLabelText(/add a household tag/i)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tags' })).toBeNull();
  });

  it('shows no tag pills at all when the household has none', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ tags: [] }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByText('512-555-1000');
    expect(screen.queryByRole('heading', { name: 'Tags' })).toBeNull();
  });
});

describe('Emergency Contacts panel (#829)', () => {
  it('lists both contacts in call order under Emergency Contacts', async () => {
    getKinfolkProfile.mockResolvedValue(
      mergeKinfolkProfile('kf1', {
        firstName: 'Jamie',
        lastName: 'Halbrook',
        emergencyContacts: [
          { name: 'Rae Halbrook', phone: '+15125550190', relationship: 'Sister' },
          { name: 'Lee Park', phone: '+15125550177', relationship: null },
        ],
      }),
    );
    render(<KinfolkProfile kinfolkId="kf1" kinfolkName="Jamie Halbrook" kin={[]} onBack={vi.fn()} />);
    const panel = (await screen.findByText('Emergency Contacts')).closest('section') as HTMLElement;
    const names = within(panel).getAllByTestId('ec-name').map((n) => n.textContent);
    expect(names).toEqual(['Rae Halbrook', 'Lee Park']);
    expect(within(panel).queryByText('No Emergency Contact')).toBeNull();
  });

  it('flags a household with none, and still renders the panel', async () => {
    getKinfolkProfile.mockResolvedValue(mergeKinfolkProfile('kf1', { firstName: 'Jamie', lastName: 'Halbrook' }));
    render(<KinfolkProfile kinfolkId="kf1" kinfolkName="Jamie Halbrook" kin={[]} onBack={vi.fn()} />);
    const panel = (await screen.findByText('Emergency Contacts')).closest('section') as HTMLElement;
    expect(within(panel).getByText('No Emergency Contact')).toBeInTheDocument();
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
  /**
   * The Edit form's tag panel auto-saves on every add/remove (#681), so a
   * Cancel out of the editor can still leave a tag write behind it. This
   * re-reads so the hero's pills catch up rather than showing what loaded
   * before the visit to Edit.
   */
  it('re-reads the household on cancel, so a tag saved during the edit is not left stale', async () => {
    const user = userEvent.setup();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[kin()]} onBack={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    await user.click(screen.getByRole('button', { name: /stub cancel/i }));
    await screen.findByRole('button', { name: /back to directory/i });
    expect(getKinfolkProfile).toHaveBeenCalledTimes(2);
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

/**
 * Item 7b. This screen used to head itself "THE DEN · DIRECTORY", the same
 * words the list two levels up uses, so the kicker could not tell an operator
 * which of the two they were looking at.
 */
describe('KinfolkProfile: breadcrumbs', () => {
  beforeEach(() => getKinfolkProfile.mockResolvedValue(profile()));

  it('names the household as the current page under a Directory step', () => {
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[]} onBack={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('Jamie Halbrook')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText(/The Den/i)).not.toBeInTheDocument();
  });

  /**
   * A LINK, because this profile only mounts under `/directory/{id}`: the card
   * click navigates rather than swapping local state, so `/directory` is
   * genuinely somewhere else and the step is middle-clickable and copyable.
   * `KinView` next door still opens with no URL change, which is why the
   * primitive takes callbacks at all.
   */
  it('walks back to the list through a real anchor', () => {
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[]} onBack={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Directory' })).toHaveAttribute(
      'href',
      '/directory',
    );
  });
});
/**
 * MOCK PARITY (issue #407). Everything below is a difference between
 * `ui-ideas/auntieos-kinfolk-profile-2026-05-27.html` and what this screen
 * shipped, pinned so it cannot drift back.
 */
describe('KinfolkProfile: the mock', () => {
  it('names the household ONCE, in the hero, instead of heading it and then repeating it in a panel', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[]} onBack={vi.fn()} />);
    await screen.findByText('512-555-1000');
    expect(screen.getByRole('heading', { level: 1, name: 'Jamie Halbrook' })).toBeInTheDocument();
    // The old duplicate: a panel headed "Household" carrying the same avatar and
    // the same name a second time.
    expect(screen.queryByRole('heading', { name: 'Household' })).toBeNull();
  });
  it('offers Call and Text on the real number, and neither when there is none', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ phoneNumber: '512-555-1000' }));
    const { unmount } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    expect(await screen.findByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:512-555-1000');
    expect(screen.getByRole('link', { name: 'Text' })).toHaveAttribute('href', 'sms:512-555-1000');
    unmount();
    getKinfolkProfile.mockResolvedValue(profile({ phoneNumber: '' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByRole('heading', { level: 1, name: 'Jamie' });
    expect(screen.queryByRole('link', { name: 'Call' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Text' })).toBeNull();
  });
  it('wears the kit hero band, and pills the status, tenure and tags as the kit status capsule (#755)', async () => {
    const joined = new Date();
    joined.setMonth(joined.getMonth() - 14);
    const iso = `${joined.getFullYear()}-${String(joined.getMonth() + 1).padStart(2, '0')}-${String(joined.getDate()).padStart(2, '0')}`;
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: iso, tags: ['Cams on premise'] }));
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    await screen.findByText('14 months');
    // The band is the kit's `.den-heading`, not a flat local card, and the h1
    // takes the kit's title face with it.
    const hero = container.querySelector('header.den-heading');
    expect(hero).not.toBeNull();
    expect(within(hero as HTMLElement).getByRole('heading', { level: 1 })).toHaveClass('den-heading-title');
    // #780: the band is the kit's `DenScreenHeading` outright. The trail rides
    // inside it, the avatar is its `leading` slot at the mock's 84px, and the
    // pills are its `badges` row; nothing is laid out around the band.
    expect(within(hero as HTMLElement).getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    const avatar = hero!.querySelector('.den-heading-leading .avatar') as HTMLElement;
    expect(avatar).not.toBeNull();
    expect(avatar.style.getPropertyValue('--avatar-size')).toBe('84px');
    expect(avatar).toHaveAttribute('data-shape', 'rounded');
    const badges = hero!.querySelector('.den-heading-badges') as HTMLElement;
    expect(badges).not.toBeNull();
    // The mock's `.tag` row: status and tags teal, tenure purple (`.tag.loyal`).
    const pill = (text: string) => {
      const el = within(badges).getByText(text);
      expect(el).toHaveClass('den-statuspill');
      return el;
    };
    expect(pill('active')).toHaveAttribute('data-tone', 'teal');
    expect(pill('14 months')).toHaveAttribute('data-tone', 'purple');
    expect(pill('Cams on premise')).toHaveAttribute('data-tone', 'teal');
    // The actions ride in the band's trailing slot.
    expect(
      within(hero!.querySelector('.den-heading-trailing') as HTMLElement).getByRole('button', { name: 'Edit' }),
    ).toBeInTheDocument();
    // Nothing local is left painting a chip or laying the hero out.
    expect(container.querySelector('.kprofile__chip')).toBeNull();
    expect(container.querySelector('.kprofile__chips')).toBeNull();
    expect(container.querySelector('.kprofile__hero-text')).toBeNull();
  });
  it('gives a status other than active the neutral tone rather than a colour the mock never drew', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ status: 'prospect' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('prospect')).toHaveAttribute('data-tone', 'neutral');
  });
  it('chips the status and the tenure, and claims no tenure it cannot read', async () => {
    const joined = new Date();
    joined.setMonth(joined.getMonth() - 14);
    const iso = `${joined.getFullYear()}-${String(joined.getMonth() + 1).padStart(2, '0')}-${String(joined.getDate()).padStart(2, '0')}`;
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: iso }));
    const { unmount } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    expect(await screen.findByText('14 months')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    unmount();
    getKinfolkProfile.mockResolvedValue(profile({ joinDate: '07/24/2026' }));
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />,
    );
    await screen.findByText('Joined 07/24/2026');
    expect(container.textContent).not.toMatch(/\d+ months/);
  });
  it('walks Directory / Kinfolk / household, and the Kinfolk step goes back to the list', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    const onBack = vi.fn();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie Halbrook" kin={[]} onBack={onBack} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(within(nav).getByRole('button', { name: 'Kinfolk' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
  it('counts the kin in the panel meta rather than inside the panel heading', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(
      <KinfolkProfile
        kinfolkId="k1"
        kinfolkName="Jamie"
        kin={[kin(), kin({ _id: 'p2', name: 'Bramble' })]}
        onBack={vi.fn()}
      />,
    );
    // The heading is the section's name, full stop. The count sits beside it.
    expect(await screen.findByRole('heading', { name: 'Kin' })).toBeInTheDocument();
    expect(screen.getByText('2 kin')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Kin · 2/ })).toBeNull();
  });
  it('claims no kin count and no empty state while the kin stream is still loading', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} kinPending onBack={vi.fn()} />,
    );
    await screen.findByRole('heading', { name: 'Kin' });
    expect(container.textContent).not.toContain('0 kin');
    expect(screen.queryByText('No kin on file for this household.')).toBeNull();
    expect(screen.getByText('Loading kin…')).toBeInTheDocument();
  });
  it('opens a kin from its row, and renders a plain row when nothing can open it', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    const onOpenKin = vi.fn();
    const { unmount } = render(
      <KinfolkProfile
        kinfolkId="k1"
        kinfolkName="Jamie"
        kin={[kin()]}
        onBack={vi.fn()}
        onOpenKin={onOpenKin}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Willow/ }));
    expect(onOpenKin).toHaveBeenCalledWith(expect.objectContaining({ _id: 'p1' }));
    unmount();
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[kin()]} onBack={vi.fn()} />);
    await screen.findByText('Willow');
    expect(screen.queryByRole('button', { name: /Willow/ })).toBeNull();
  });
  it("carries the pet's own line from its 411, and says so when a 411 cannot be read", async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    getKin411.mockResolvedValue({
      tldr: 'Loves sticks, hates the mailman.',
      rawSummary: '',
      breed: '',
      personality: '',
      quirksAndPreferences: '',
      medicalNotes: '',
      dietaryDetails: '',
    });
    const { unmount } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[kin()]} onBack={vi.fn()} />,
    );
    expect(await screen.findByText('Loves sticks, hates the mailman.')).toBeInTheDocument();
    // ONE line under the name, the mock's `small`: the facts and the pet's own
    // line dotted together rather than stacked as two.
    expect(screen.getByText('Willow').nextElementSibling).toHaveTextContent(
      'Dog · Lab · 4 yrs · Loves sticks, hates the mailman.',
    );
    unmount();
    // Negative: the row still renders, and the gap is announced rather than
    // silently looking like a pet nobody has written about.
    getKin411.mockRejectedValue(new Error('permission-denied'));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[kin()]} onBack={vi.fn()} />);
    expect(await screen.findByText(/Some kin notes couldn’t be read/i)).toBeInTheDocument();
    expect(screen.getByText('Willow')).toBeInTheDocument();
  });
  /**
   * THE PANEL UNDER THE OPERATOR'S CURSOR AT THE MARK (#407). It used to
   * disappear whole when a household had no codes on file, so the screen gave
   * no sign an access detail was even a thing this household could have. The
   * service address itself moved out to Contact (#679), so this panel's empty
   * hint no longer mentions it.
   */
  it('keeps Home & access on screen with an empty hint when nothing is on file', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Home & access' })).toBeInTheDocument();
    expect(screen.getByText('No entry details on file.')).toBeInTheDocument();
  });
  it('lays each contact fact out as the mock field row: label, then value, one per line (#755)', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ email: 'jamie@example.com' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    const contact = (await screen.findByRole('heading', { name: 'Contact' })).closest('.den-panel');
    const rows = Array.from((contact as HTMLElement).querySelectorAll('.kprofile__fact'));
    expect(rows.map((r) => r.querySelector('dt')?.textContent)).toEqual(['Phone', 'Email']);
    // A row is a definition pair, label first, so the value sits opposite it.
    expect(rows[1]!.children[0]!.tagName).toBe('DT');
    expect(rows[1]!.children[1]!.tagName).toBe('DD');
    expect(rows[1]!.children[1]).toHaveTextContent('jamie@example.com');
  });
  it('folds the service address into Contact, not a separate panel (#679)', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ serviceAddress: '18609 Salt River Bay Dr' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    const contact = (await screen.findByRole('heading', { name: 'Contact' })).closest('.den-panel');
    expect(contact).not.toBeNull();
    expect(within(contact as HTMLElement).getByText('18609 Salt River Bay Dr')).toBeInTheDocument();
  });
  it('renders the service address as a Google Maps directions link (#685)', async () => {
    getKinfolkProfile.mockResolvedValue(profile({ serviceAddress: '18609 Salt River Bay Dr' }));
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    const link = await screen.findByRole('link', { name: '18609 Salt River Bay Dr' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=18609%20Salt%20River%20Bay%20Dr',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
  it('shows the admin-only dossier band, headed as admin only', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    getDossier.mockResolvedValue({
      tldr: 'Text when on the way.',
      rawSummary: '',
      communicationStyle: 'Short and warm.',
      householdNotes: 'Treats in the blue tin.',
      relationshipWithAuntie: '',
    });
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByText('Text when on the way.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Auntie’s notes/ })).toBeInTheDocument();
    expect(screen.getByText('admin only')).toBeInTheDocument();
    expect(screen.getByText('Treats in the blue tin.')).toBeInTheDocument();
    expect(screen.getByText('Short and warm.')).toBeInTheDocument();
  });
  it('no longer offers a hero "New KinTale" primary (#676)', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: /back to directory/i });
    expect(screen.queryByRole('button', { name: /new kintale/i })).toBeNull();
  });
  it('carries the three feed cards, Upcoming KinCare renamed from Upcoming visits (#682)', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Recent KinTales' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upcoming KinCare' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Upcoming visits' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
  });
  it('scopes every feed read to this household rather than filtering the whole collection in memory', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    render(<KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[]} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Invoices' });
    const specs = useCollection.mock.calls.map(([spec]) => spec as { path: string; filters?: unknown });
    for (const path of ['kin_care_reports', 'kin_care_sessions', 'invoices']) {
      const spec = specs.find((s) => s.path === path);
      expect(spec, `no read of ${path}`).toBeDefined();
      expect(spec?.filters).toEqual([['kinfolkId', '==', 'k1']]);
    }
  });
  it('orders the right column Kin, Upcoming KinCare, Recent KinTales, Invoices, Contact first and Auntie’s notes last on the left (#678/#679/#682/#683)', async () => {
    getKinfolkProfile.mockResolvedValue(profile());
    getDossier.mockResolvedValue({
      tldr: 'Text when on the way.',
      rawSummary: '',
      communicationStyle: '',
      householdNotes: '',
      relationshipWithAuntie: '',
    });
    const { container } = render(
      <KinfolkProfile kinfolkId="k1" kinfolkName="Jamie" kin={[kin()]} onBack={vi.fn()} />,
    );
    await screen.findByRole('heading', { name: 'Invoices' });
    // Auntie's notes loads on its own async read; wait for it too, or the
    // column's "last heading" can be sampled before it lands.
    await screen.findByText('Text when on the way.');

    const cols = Array.from(container.querySelectorAll('.kprofile__col'));
    expect(cols).toHaveLength(2);
    const [leftCol, rightCol] = cols as [Element, Element];

    const headingsIn = (col: Element) =>
      within(col as HTMLElement)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent);

    expect(headingsIn(rightCol)).toEqual(['Kin', 'Upcoming KinCare', 'Recent KinTales', 'Invoices']);
    const left = headingsIn(leftCol);
    expect(left[0]).toBe('Contact');
    expect(left[left.length - 1]).toBe('Auntie’s notes');
  });
});
