// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { KinDetail } from '../api/kinView';
import type { Async } from '../lib/async';

// The household step is a real route link, and a real `Link` wants a
// RouterProvider no suite in this tree mounts (AppShell.test.tsx convention).
vi.mock('@tanstack/react-router', () => ({
  linkOptions: (o: unknown) => o,
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={hrefOf(to, params, search)}
      {...rest}
    >
      {children}
    </a>
  ),
}));

function hrefOf(
  to: string,
  params?: Record<string, string>,
  search?: Record<string, string>,
): string {
  const path = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
  const q = new URLSearchParams(search ?? {}).toString();
  return q === '' ? path : `${path}?${q}`;
}

const { getKin } = vi.hoisted(() => ({ getKin: vi.fn() }));
vi.mock('../api/kinView', async (orig) => ({
  ...(await orig<typeof import('../api/kinView')>()),
  getKin,
}));
// The 411 is its own point read (admin-only, `the_411/411_{kinId}`).
const { getKin411 } = vi.hoisted(() => ({ getKin411: vi.fn() }));
vi.mock('../api/recipientContext', async (orig) => ({
  ...(await orig<typeof import('../api/recipientContext')>()),
  getKin411,
}));
// The two feed panels stream the household's KinTales and sessions.
const useCollection = vi.fn();
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec) ?? { status: 'loading' },
}));
// The tag editor (ProfileTagsSection) loads the vocab + persists tag edits.
const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch) }));
const { updateKinTags } = vi.hoisted(() => ({ updateKinTags: vi.fn() }));
vi.mock('../api/directoryWrite', async (orig) => ({
  ...(await orig<typeof import('../api/directoryWrite')>()),
  updateKinTags,
}));

import { KinView, kinHeroLine } from './KinView';
import { mergeKinDetail } from '../api/kinView';

function kin(over: Partial<KinDetail> = {}): KinDetail {
  return mergeKinDetail('p1', {
    name: 'Willow',
    species: 'Dog',
    breed: 'Lab',
    age: '4',
    sex: 'F',
    kinfolkId: 'kf-1',
    ...over,
  });
}

function ready<T>(data: T[]): Async<T[]> {
  return { status: 'ready', data };
}

function mount(over: Partial<KinDetail> = {}) {
  getKin.mockResolvedValue(kin(over));
  return render(<KinView kinId="p1" kinName="Willow" openedFrom="directory" onBack={vi.fn()} />);
}

beforeEach(() => {
  getKin.mockReset();
  getKin411.mockReset();
  getKin411.mockResolvedValue(null);
  useCollection.mockReset();
  useCollection.mockReturnValue(ready([]));
  getBusinessSettings.mockReset();
  getBusinessSettings.mockResolvedValue({ householdTags: [], petTags: [] });
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
  updateKinTags.mockReset();
  updateKinTags.mockResolvedValue(undefined);
});

describe('mergeKinDetail (pure)', () => {
  it('defaults strings + coerces booleans, never undefined', () => {
    const k = mergeKinDetail('p9', { name: 'Rex', reactive: true, spayedNeutered: 'yes' as unknown as boolean });
    expect(k._id).toBe('p9');
    expect(k.name).toBe('Rex');
    expect(k.reactive).toBe(true);
    expect(k.spayedNeutered).toBe(false); // non-true value -> false, not "yes"
    expect(k.vetInfo).toBe('');
  });

  it('reads tags string-only, defaulting a missing/legacy field to []', () => {
    expect(mergeKinDetail('p1', {}).tags).toEqual([]); // legacy doc, no tags field
    expect(mergeKinDetail('p1', { tags: ['Reactive', 42, 'Meds'] }).tags).toEqual(['Reactive', 'Meds']);
    expect(mergeKinDetail('p1', { tags: 'nope' }).tags).toEqual([]); // not an array
  });
});

/**
 * The mock's line under the name: "Labrador Retriever · 5 yrs · neutered male
 * · 68 lbs".
 */
describe('kinHeroLine (pure)', () => {
  it('reads breed, age, fixed sex, weight and markings in the mock order', () => {
    expect(
      kinHeroLine(
        kin({ breed: 'Labrador Retriever', age: '5', sex: 'Male', spayedNeutered: true, weight: '68 lbs', colorMarkings: 'Yellow' }),
      ),
    ).toBe('Labrador Retriever · 5 yrs · neutered male · 68 lbs · Yellow');
    expect(kinHeroLine(kin({ sex: 'F', spayedNeutered: true }))).toBe('Lab · 4 yrs · spayed female');
  });

  it('falls back to the species when no breed is on file, and drops blanks', () => {
    expect(kinHeroLine(kin({ breed: '', age: '', sex: '' }))).toBe('Dog');
  });

  it('keeps a sex the two words do not fit, and takes the flag after it', () => {
    expect(kinHeroLine(kin({ sex: 'Unknown', spayedNeutered: true }))).toBe('Lab · 4 yrs · Unknown · spayed / neutered');
    expect(kinHeroLine(kin({ sex: '', spayedNeutered: true }))).toBe('Lab · 4 yrs · spayed / neutered');
  });
});

describe('KinView: hero', () => {
  it('names the pet in the heading and reads its line under it', async () => {
    mount({ weight: '52 lbs', colorMarkings: 'Black' });
    expect(await screen.findByText('Lab · 4 yrs · F · 52 lbs · Black')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Willow');
    expect(getKin).toHaveBeenCalledWith('p1');
  });

  it('has no "Kin profile." subtitle and no Basics panel: the line under the name carries those', async () => {
    mount();
    await screen.findByText('Care checklist');
    expect(screen.queryByText('Kin profile.')).toBeNull();
    expect(screen.queryByText('Basics')).toBeNull();
    expect(screen.queryByText('Species')).toBeNull();
  });

  it('links the pet to its household, the way the mock says "belongs to the Wrens"', async () => {
    getKin.mockResolvedValue(kin());
    render(
      <KinView
        kinId="p1"
        kinName="Willow"
        household={{ id: 'kf-1', name: 'the Wrens' }}
        openedFrom="directory"
        onBack={vi.fn()}
      />,
    );
    const owner = await screen.findByText(/belongs to/);
    expect(within(owner).getByRole('link', { name: 'the Wrens' })).toHaveAttribute('href', '/directory/kf-1');
  });

  it('closes back down to the household when a profile opened it, rather than linking to the page underneath', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(
      <KinView
        kinId="p1"
        kinName="Willow"
        household={{ id: 'kf-1', name: 'Sandy Demo' }}
        openedFrom="profile"
        onBack={onBack}
      />,
    );
    const owner = await screen.findByText(/belongs to/);
    await userEvent.click(within(owner).getByRole('button', { name: 'Sandy Demo' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows pet tags as kit pills next to the name, not a separate Tags panel', async () => {
    mount({ tags: ['Yellow lab', 'Microchipped'] });
    const pill = await screen.findByText('Yellow lab');
    expect(pill).toHaveClass('den-statuspill');
    expect(screen.getByText('Microchipped')).toHaveClass('den-statuspill');
    expect(screen.queryByText('Tags')).toBeNull();
    expect(screen.queryByLabelText(/add a pet tag/i)).toBeNull();
  });

  it('says nothing about status for an active pet, and pills any other status', async () => {
    const { unmount } = mount();
    await screen.findByText('Care checklist');
    expect(screen.queryByText('active')).toBeNull();
    unmount();

    mount({ status: 'archived' });
    expect(await screen.findByText('archived')).toHaveClass('den-statuspill');
  });

  it('marks a reactive pet with a warning pill under the identity block, not a page banner', async () => {
    mount({ reactive: true, routine: 'Slow approach' });
    const marker = await screen.findByText(/handle with care/i);
    expect(marker).toHaveClass('den-statuspill');
    expect(marker).toHaveAttribute('data-tone', 'warning');
    // No page-level banner: a banner carries role="alert" (Banner.tsx), the
    // marker does not. The kit's error hint carries it too, so none may show.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Slow approach')).toBeInTheDocument();
  });

  it('offers no New KinTale action: a KinTale is only ever started from a KinCare (#676)', async () => {
    mount();
    await screen.findByText('Care checklist');
    expect(screen.queryByRole('button', { name: /new kintale/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit kin' })).toBeInTheDocument();
  });

  it('calls onBack from the Back control', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(<KinView kinId="p1" kinName="Willow" openedFrom="directory" onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Back to Directory' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  /**
   * #689, the screen the operator marked. Closing lands on whichever screen
   * opened this one, so from a household profile "Back to Directory" named a
   * screen the click does not reach. The button now names the household.
   */
  it('names the household, not the Directory, when a profile opened it', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(
      <KinView
        kinId="p1"
        kinName="Willow"
        household={{ id: 'kf-1', name: 'Sandy Demo' }}
        openedFrom="profile"
        onBack={onBack}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Back to Directory' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Back to Sandy Demo' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('says "the household" when the profile that opened it could not be named', async () => {
    getKin.mockResolvedValue(kin());
    render(<KinView kinId="p1" kinName="Willow" openedFrom="profile" onBack={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Back to the household' })).toBeInTheDocument();
  });

  it('opens the tag editor from the Edit tags affordance and saves via updateKinTags', async () => {
    mount({ tags: ['Reactive'] });
    await screen.findByText('Reactive');
    expect(screen.queryByLabelText(/add a pet tag/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /edit tags/i }));
    await userEvent.type(await screen.findByLabelText(/add a pet tag/i), 'On meds{Enter}');
    await waitFor(() => expect(updateKinTags).toHaveBeenCalledWith('p1', ['Reactive', 'On meds']));
  });
});

/**
 * The mock's six panels, in its order: Care checklist, Medical, Auntie's notes
 * down the left, then The 411, the pet's KinTales and Upcoming KinCare down the
 * right. Every one renders whatever is on file, so the page keeps one shape.
 */
describe('KinView: panels', () => {
  it('renders the six panels in the mock order, each with its mock note', async () => {
    mount();
    await screen.findByText('Care checklist');
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'Care checklist',
      'Medical',
      "Auntie's notes",
      'The 411',
      "Willow's KinTales",
      'Upcoming KinCare',
    ]);
    expect(screen.getByText('per visit')).toBeInTheDocument();
    expect(screen.getByText('Willow only')).toBeInTheDocument();
    expect(screen.getByText('admin only')).toBeInTheDocument();
    expect(screen.getByText('auto-generated')).toBeInTheDocument();
    expect(screen.getByText('next 7 days')).toBeInTheDocument();
  });

  it('says what is missing rather than dropping a blank panel', async () => {
    mount();
    expect(await screen.findByText('No care notes for Willow yet.')).toBeInTheDocument();
    expect(screen.getByText('No medical notes for Willow yet.')).toBeInTheDocument();
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
    expect(screen.getByText('No 411 for Willow yet.')).toBeInTheDocument();
    expect(screen.getByText('No KinTales about Willow yet.')).toBeInTheDocument();
    expect(screen.getByText('No visits booked for Willow in the next 7 days.')).toBeInTheDocument();
  });

  it('puts the care instructions and the legacy checklist lines in Care checklist', async () => {
    mount({ staysAs: 'Indoor', routine: 'Walk at 7', feedingBrand: 'Orijen', checklist: 'Fresh water\n\nLock the side gate' });
    expect(await screen.findByText('Indoor')).toBeInTheDocument();
    expect(screen.getByText('Stays as')).toBeInTheDocument();
    expect(screen.getByText('Food / brand')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').filter((li) => li.classList.contains('kview__ck'));
    expect(rows.map((r) => r.textContent)).toEqual(['Fresh water', 'Lock the side gate']);
    expect(screen.queryByText('Behavior & care')).toBeNull();
    expect(screen.queryByText('Feeding')).toBeNull();
  });

  it('puts vaccinations, medication and vet info in Medical', async () => {
    mount({ vaccinations: 'Rabies 2027', vetInfo: 'Riverside Animal Hospital' });
    expect(await screen.findByText('Rabies 2027')).toBeInTheDocument();
    expect(screen.getByText('Riverside Animal Hospital')).toBeInTheDocument();
    expect(screen.queryByText('Health')).toBeNull();
  });

  it("renders office notes as Auntie's notes, with the staff-only note as the meta and not a subtitle", async () => {
    mount({ officeNotes: 'Treats in the blue tin.' });
    expect(await screen.findByText('Treats in the blue tin.')).toHaveClass('kview__notebox');
    expect(screen.queryByText('Office notes')).toBeNull();
    expect(screen.queryByText('Staff-only.')).toBeNull();
  });

  it('renders the 411 as question and answer rows', async () => {
    getKin411.mockResolvedValue({
      tldr: 'Easygoing and eager.',
      rawSummary: '',
      breed: '',
      personality: 'Lights up for walks.',
      quirksAndPreferences: 'Sticks, the creek loop.',
      medicalNotes: '',
      dietaryDetails: '',
    });
    mount();
    expect(await screen.findByText('Easygoing and eager.')).toBeInTheDocument();
    expect(screen.getByText('Personality')).toBeInTheDocument();
    expect(screen.getByText('Lights up for walks.')).toBeInTheDocument();
    expect(screen.getByText('Quirks and preferences')).toBeInTheDocument();
    expect(screen.queryByText('Medical notes')).toBeNull();
    expect(getKin411).toHaveBeenCalledWith('p1');
  });

  it('says a failed 411 read failed, on its own panel, while the rest of the page stands', async () => {
    getKin411.mockRejectedValue(new Error('permission-denied'));
    mount({ routine: 'Walk at 7' });
    expect(await screen.findByRole('alert')).toHaveTextContent('permission-denied');
    expect(screen.getByText('Walk at 7')).toBeInTheDocument();
    expect(screen.queryByText('No 411 for Willow yet.')).toBeNull();
  });

  it('narrows the household feeds to this pet', async () => {
    useCollection.mockImplementation((spec: { path: string }) =>
      spec.path === 'kin_care_reports'
        ? ready([
            { _id: 'r1', kinfolkId: 'kf-1', status: 'SENT', title: 'Hit the trail', kinIds: ['p1'], sentAt: '2026-08-10T09:42:00Z' },
            { _id: 'r2', kinfolkId: 'kf-1', status: 'SENT', title: 'Only Gravy', kinIds: ['p2'], sentAt: '2026-08-09T09:00:00Z' },
          ])
        : ready([]),
    );
    mount();
    expect(await screen.findByText('Hit the trail')).toBeInTheDocument();
    expect(screen.queryByText('Only Gravy')).toBeNull();
    expect(useCollection).toHaveBeenCalledWith(expect.objectContaining({ filters: [['kinfolkId', '==', 'kf-1']] }));
  });

  it('says so when the pet has no household to match feeds against', async () => {
    mount({ kinfolkId: '' });
    expect(await screen.findByText(/No household on file for Willow/)).toBeInTheDocument();
    expect(useCollection).not.toHaveBeenCalled();
    expect(screen.queryByText(/belongs to/)).toBeNull();
  });

  it('renders no Owner contact panel, even when the stored doc still carries the fields', async () => {
    // mergeKinDetail no longer reads ownerEmail/ownerPhone at all; a raw doc
    // that still has them (an untouched legacy value) must not surface either.
    getKin.mockResolvedValue(
      mergeKinDetail('p1', { name: 'Willow', ownerEmail: 'a@b.com', ownerPhone: '5551234567' }),
    );
    render(<KinView kinId="p1" kinName="Willow" openedFrom="directory" onBack={vi.fn()} />);
    await screen.findByText('Care checklist');
    expect(screen.queryByText('Owner contact')).toBeNull();
    expect(screen.queryByText('a@b.com')).toBeNull();
    expect(screen.queryByText('5551234567')).toBeNull();
  });
});

/**
 * Item 7b, against `auntieos-kin-detail-2026-05-27.html`, whose trail reads
 * `Directory / Lorna Wren / Biscuit`.
 */
describe('KinView: breadcrumbs', () => {
  it('puts the household between the Directory and the pet', async () => {
    getKin.mockResolvedValue(kin());
    render(
      <KinView
        kinId="p1"
        kinName="Willow"
        household={{ id: 'kf-1', name: 'the Wrens' }}
        openedFrom="directory"
        onBack={vi.fn()}
      />,
    );
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    // A real route link, because this view sits on /directory and the household
    // profile is somewhere else.
    expect(within(nav).getByRole('link', { name: 'the Wrens' })).toHaveAttribute(
      'href',
      '/directory/kf-1',
    );
    expect(within(nav).getByText('Willow')).toHaveAttribute('aria-current', 'page');
  });

  /**
   * The household step is DROPPED, not filled in, when the Directory could not
   * resolve which home the pet lives in. A trail step is a claim about where
   * you are, and a guessed one points at a household the pet does not live in,
   * which is worse than a shorter trail.
   */
  it('omits the household step rather than guessing at one', async () => {
    getKin.mockResolvedValue(kin());
    render(<KinView kinId="p1" kinName="Willow" openedFrom="directory" onBack={vi.fn()} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
    expect(within(nav).getAllByRole('listitem')).toHaveLength(2);
  });

  it('walks back to the list from the trail', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(<KinView kinId="p1" kinName="Willow" openedFrom="directory" onBack={onBack} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await userEvent.click(within(nav).getByRole('button', { name: 'Directory' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  /**
   * #689. Which step is an anchor follows the address this view opened on: a
   * `<Link>` to the page you are already standing on is a step that does
   * nothing when clicked. Opened from a household profile the URL is already
   * `/directory/{id}`, so the roles swap over.
   */
  it('anchors the Directory and closes down to the household, when a profile opened it', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(
      <KinView
        kinId="p1"
        kinName="Willow"
        household={{ id: 'kf-1', name: 'Sandy Demo' }}
        openedFrom="profile"
        onBack={onBack}
      />,
    );
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Directory' })).toHaveAttribute(
      'href',
      '/directory',
    );
    // Not an anchor: the profile is the page underneath this view, and its URL
    // is the one already in the address bar.
    await userEvent.click(within(nav).getByRole('button', { name: 'Sandy Demo' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
