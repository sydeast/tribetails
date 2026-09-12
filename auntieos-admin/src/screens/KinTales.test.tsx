// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { ReactNode } from 'react';
import { render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type KinTaleEntry } from '../api/kinTales';
import { GENERATED_DRAFTS_MAX, type GeneratedDraftRow } from '../api/drafts';
import { type Async } from '../lib/async';
import { type Kinfolk } from '../api/directory';
import { type PagedCollection } from '../lib/usePagedCollection';
import { ToastProvider } from '../components/Toast';

/**
 * The list is PAGED now, so this file mocks `usePagedCollection` rather than
 * `useCollection`. `useCollection` is still mocked because the screen reads TWO
 * live collections through it, the kinfolk directory behind the household facet
 * and `generated_drafts` (the draft half of a KinTale), and the three sources
 * must be told apart: a test that stubbed them as one would silently feed
 * household documents to the drafts join and call them KinTales.
 */
const { usePagedCollection } = vi.hoisted(() => ({ usePagedCollection: vi.fn() }));
vi.mock('../lib/usePagedCollection', () => ({ usePagedCollection }));

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// The head's "Edit templates" is a real route link, and a real `Link` wants a
// RouterProvider no suite in this tree mounts (HouseholdData.test.tsx idiom).
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * B2's "Needs triage" section (`NeedsTriageSection`, mounted inside `KinTales`)
 * reads through its own one-shot callable client rather than this screen's
 * paged stream. Mocked to a settled empty list here so every pre-existing test
 * below sees the section render nothing, exactly its own "quiet when proven
 * empty" behavior; `NeedsTriageSection.test.tsx` covers the section itself.
 */
const { listOrphanReports } = vi.hoisted(() => ({ listOrphanReports: vi.fn() }));
vi.mock('../api/kinTaleTriage', () => ({
  listOrphanReports,
  assignKinfolkToOrphanReport: vi.fn(),
  markOrphanReportAsDuplicate: vi.fn(),
  archiveOrphanReportAsBadData: vi.fn(),
}));

import { KinTales } from './KinTales';

/**
 * `NeedsTriageSection` calls `useToast()`, which throws outside a
 * `<ToastProvider>` (a swallowed confirmation is indistinguishable from a
 * triage action that never happened). Rendering the real provider keeps these
 * tests exercising the tree the app actually mounts, mirroring
 * HouseholdData.test.tsx.
 */
function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

function entry(over: Partial<KinTaleEntry>): KinTaleEntry {
  return {
    _id: 'tale1',
    sessionId: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    authorDisplayName: 'Auntie Jo',
    kinIds: [],
    serviceType: 'Dog Walk',
    visitDate: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    title: '',
    bodyCopy: 'Biscuit had a wonderful time at the park today.',
    mediaFileIds: [],
    status: 'DRAFT',
    sentAt: '',
    sentVia: '',
    createdAt: '2026-07-16T13:00:00.000Z',
    ...over,
  };
}

/**
 * One `generated_drafts` doc, the collection the KinTales screen now joins in
 * for its Drafts bucket.
 *
 * `createdOn` defaults to NOW rather than to a pinned literal, and that is not
 * laziness. The reports side is windowed by the SERVER (and the paged hook is
 * mocked, so no window is applied to it here at all), while the drafts side is
 * windowed client-side against the real `new Date()` the toolbar computes. A
 * fixture dated 2026-07-16 would silently fall outside the default "last 7
 * days" on any day but that one, and every drafts assertion would decay into a
 * test of the window instead.
 */
function draft(over: Partial<GeneratedDraftRow> = {}): GeneratedDraftRow {
  return {
    _id: 'draft1',
    kinfolk_id: 'kf1',
    kinfolkName: 'The Okafors',
    communicationType: 'visit_report',
    generatedCopy: 'Mabel napped in the sun for an hour.',
    status: 'generated',
    createdOn: new Date().toISOString(),
    ...over,
  };
}

const loadMore = vi.fn();
const reload = vi.fn();

/** A settled first page. Overrides cover the in-flight, failed and more-to-come cases. */
function paged(
  rows: KinTaleEntry[],
  over: Partial<PagedCollection<KinTaleEntry>> = {},
): PagedCollection<KinTaleEntry> {
  return {
    state: { status: 'ready', data: rows },
    hasMore: false,
    more: { status: 'ready', data: null },
    loadMore,
    reload,
    ...over,
  };
}

/** The spec the screen most recently asked the hook for. */
function lastSpec(): { pageSize: number; filters?: [string, string, unknown][] } {
  return usePagedCollection.mock.calls.at(-1)![0] as {
    pageSize: number;
    filters?: [string, string, unknown][];
  };
}

// TZ pinned to a west-of-UTC zone so the AO-18 assertions below are
// meaningful on any CI runner (identical rationale as Sessions.test.tsx /
// lib/kinTaleFormat.test.ts). Restored afterAll for any sibling test file
// sharing this worker.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const user = userEvent.setup();

/**
 * `useCollection` is called for two different collections, so the stub routes
 * on the spec's path rather than answering every call with one value. Setting
 * one of these does not disturb the other, which is the point: a test about
 * drafts must not accidentally empty the household facet, and a test about a
 * failed household read must not also fail the drafts read.
 */
let householdsState: Async<Kinfolk[]> = { status: 'ready', data: [] };
let draftsState: Async<GeneratedDraftRow[]> = { status: 'ready', data: [] };
const setHouseholds = (state: Async<Kinfolk[]>) => (householdsState = state);
const setDrafts = (rows: GeneratedDraftRow[], over?: Async<GeneratedDraftRow[]>) =>
  (draftsState = over ?? { status: 'ready', data: rows });

beforeEach(() => {
  loadMore.mockReset();
  reload.mockReset();
  usePagedCollection.mockReset().mockReturnValue(paged([]));
  householdsState = { status: 'ready', data: [] };
  draftsState = { status: 'ready', data: [] };
  useCollection.mockReset().mockImplementation((spec: { path: string }) =>
    spec.path === 'generated_drafts' ? draftsState : householdsState,
  );
  // NeedsTriageSection's own read. Empty unless a case needs it; see the note above.
  listOrphanReports.mockReset().mockResolvedValue([]);
});

/** The bucket panel headed by `label`, or null when the screen drew none. */
function bucket(label: string): HTMLElement | null {
  const heading = screen.queryByRole('heading', { name: label });
  return heading ? (heading.closest('.den-panel') as HTMLElement) : null;
}

describe('KinTales screen', () => {
  it('renders a paged row with its household, service, timestamp, and status pill', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<KinTales />);
    // Scope by the row container, not the button, the row is only a
    // <button> once a detail route wires onSelect; here (unwired) it renders
    // static.
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    expect(within(row).getByText('Dog Walk')).toBeInTheDocument();
    expect(within(row).getByText('DRAFT')).toHaveClass('den-statuspill', 'den-statuspill--compact');
  });

  it('draws the row as the mock does: a status tile, no headline line', () => {
    // The logs mock's `.row` carries the household, "service · when" and the
    // pips, and nothing of the body. Neither does Android's. The tale is read
    // on the detail screen.
    usePagedCollection.mockReturnValue(paged([entry({ title: 'A great day at the park' })]));
    render(<KinTales />);
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(row.querySelector('.icon-tile')).not.toBeNull();
    expect(within(row).queryByText('A great day at the park')).toBeNull();
    expect(within(row).queryByText('Biscuit had a wonderful time at the park today.')).toBeNull();
  });

  it('reads a blank household as the italic fallback, never as a household called that', () => {
    usePagedCollection.mockReturnValue(paged([entry({ kinfolkName: '' })]));
    render(<KinTales />);
    expect(screen.getByText('Unnamed Kinfolk')).toHaveClass('kintales__row-name--unnamed');
  });

  it('shows the LOCAL clock time in the row, not the UTC hour (AO-18)', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
    // instant.
    usePagedCollection.mockReturnValue(paged([entry({ visitDate: '2026-07-17T01:00:00.000Z' })]));
    render(<KinTales />);
    expect(screen.getByText('07-16 20:00')).toBeInTheDocument();
  });

  it('falls back to "Date TBD" when every timestamp field is blank, never a fabricated time', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ visitDate: '', arrivedAt: '', sentAt: '', createdAt: '' })]),
    );
    render(<KinTales />);
    expect(screen.getByText('Date TBD')).toBeInTheDocument();
  });

  it.each([
    ['DRAFT', 'DRAFT'],
    ['SENT', 'SENT'],
    ['FAILED', 'FAILED'],
  ])('renders the %s status positively as its own pill', (status, chip) => {
    usePagedCollection.mockReturnValue(paged([entry({ status })]));
    render(<KinTales />);
    expect(screen.getByText(chip)).toHaveClass('den-statuspill');
  });

  it.each([
    ['SENT', 'success'],
    ['FAILED', 'error'],
    ['DRAFT', 'neutral'],
  ])('tints the %s pill from the bucket tone (%s)', (status, tone) => {
    usePagedCollection.mockReturnValue(paged([entry({ status })]));
    render(<KinTales />);
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText(status)).toHaveAttribute('data-tone', tone);
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN in its own bucket, never a fabricated DRAFT', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'some_new_code' })]));
    render(<KinTales />);
    expect(screen.getByText('UNKNOWN')).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByText('DRAFT')).toBeNull();
    expect(bucket('Unknown status')).not.toBeNull();
    expect(bucket('Drafts')).toBeNull();
  });

  it('shows a media pip only when the report has attached media', () => {
    usePagedCollection.mockReturnValue(paged([entry({ mediaFileIds: ['m1', 'm2'] })]));
    render(<KinTales />);
    expect(screen.getByText('2 photos')).toBeInTheDocument();
  });

  it('omits the media pip entirely when there is no attached media (never "0 photos")', () => {
    usePagedCollection.mockReturnValue(paged([entry({ mediaFileIds: [] })]));
    render(<KinTales />);
    expect(screen.queryByText(/photos?/)).toBeNull();
  });

  it('shows the send channel only for a report that actually carries one', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'SENT', sentVia: 'email', sentAt: '2026-07-16T14:00:00.000Z' })]),
    );
    render(<KinTales />);
    expect(screen.getByText('email')).toBeInTheDocument();
  });

  it('a blank sentVia (a draft) never shows the misleading "imported" pip', () => {
    usePagedCollection.mockReturnValue(paged([entry({ sentVia: '' })]));
    render(<KinTales />);
    expect(screen.queryByText('imported')).toBeNull();
  });

  it('collapses a legacy backfill marker to "imported" rather than leaking the raw collection name', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'SENT', sentVia: 'legacy_visit_logs' })]),
    );
    render(<KinTales />);
    expect(screen.getByText('imported')).toBeInTheDocument();
  });

  it('marks a row whose createdAt is the IMPORT date, not a creation date', () => {
    // The list is ordered `createdAt desc`. On a row the migration could not
    // recover an original for, that date is the day it was imported. Unmarked,
    // it is indistinguishable from a tale genuinely written that day, which is
    // the operator's 2026-08-04 defect repeating one field along.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'SENT', sentVia: 'legacy_visit_logs', createdAtSource: 'import' })]),
    );
    render(<KinTales />);
    expect(screen.getByText('Imported, original date unknown')).toBeInTheDocument();
  });

  it('does NOT mark an imported row whose original creation instant was recovered', () => {
    // That row's date is a real creation date. A caveat on all 83 imported rows
    // would be noise that trains the operator to stop reading caveats.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'SENT', sentVia: 'legacy_visit_logs', createdAtSource: 'original' })]),
    );
    render(<KinTales />);
    expect(screen.queryByText(/original date unknown/i)).toBeNull();
  });

  it('does not mark a row this system created, whose createdAtSource is absent entirely', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<KinTales />);
    expect(screen.queryByText(/original date unknown/i)).toBeNull();
  });

  it('clicking a row calls onSelect with the KinTale id', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'tale-42' })]));
    const onSelect = vi.fn();
    render(<KinTales onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelect).toHaveBeenCalledWith('tale-42');
  });

  it('omitting onSelect renders each row STATIC (not a live no-op button)', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<KinTales />);
    // The row content renders, but it is NOT an interactive button when
    // unwired, a live button that no-ops on click is the dead-control
    // anti-pattern.
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /The Whitfields/i })).toBeNull();
  });

  it('offers no New KinTale: a KinTale starts from a Kin Care (#676), as the mock draws it', () => {
    render(<KinTales />);
    expect(screen.queryByText(/new kintale/i)).toBeNull();
  });
});

describe('KinTales screen: the head', () => {
  it('is the kit hero with the mock kicker, the plain title and the ClipboardList tile', () => {
    render(<KinTales />);
    const hero = document.querySelector('.den-heading') as HTMLElement;
    expect(within(hero).getByText('The Den · KinTales')).toHaveClass('den-heading-kicker');
    expect(within(hero).getByRole('heading', { level: 1 })).toHaveTextContent(/^KinTales$/);
    expect(hero.querySelector('.den-heading-leading .icon-tile')).not.toBeNull();
  });

  it("carries the mock's one control, Edit templates, as a link to the template editor", () => {
    render(<KinTales />);
    const link = screen.getByRole('link', { name: 'Edit templates' });
    expect(link).toHaveAttribute('href', '/kintale-templates');
    expect(link).toHaveClass('auntie-btn--ghost');
  });

  it('keeps the explanation as the heading tooltip, not a line of copy', () => {
    render(<KinTales />);
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(/Every recap that goes home/);
  });
});

describe('KinTales screen: the buckets', () => {
  it('draws one panel per bucket, in the mock order, with the count as the mono note', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'SENT' }),
        entry({ _id: 'b', kinfolkName: 'Household B', status: 'DRAFT' }),
        entry({ _id: 'c', kinfolkName: 'Household C', status: 'FAILED' }),
        entry({ _id: 'd', kinfolkName: 'Household D', status: 'SENT' }),
      ]),
    );
    render(<KinTales />);
    const titles = Array.from(document.querySelectorAll('.kintales__bucket .den-panel-title')).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(['Needs another look', 'Drafts', 'Sent']);
    expect(within(bucket('Sent')!).getByText('2')).toHaveClass('den-panel-meta');
    expect(within(bucket('Drafts')!).getByText('1')).toHaveClass('den-panel-meta');
    expect(within(bucket('Needs another look')!).getByText('1')).toHaveClass('den-panel-meta');
    expect(within(bucket('Sent')!).getByText('Household A')).toBeInTheDocument();
    expect(within(bucket('Sent')!).getByText('Household D')).toBeInTheDocument();
    expect(within(bucket('Drafts')!).getByText('Household B')).toBeInTheDocument();
    expect(within(bucket('Needs another look')!).getByText('Household C')).toBeInTheDocument();
  });

  it('draws no panel for an empty bucket, so an empty warning bucket is never a warning', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SENT' })]));
    render(<KinTales />);
    expect(bucket('Sent')).not.toBeNull();
    expect(bucket('Needs another look')).toBeNull();
    expect(bucket('Drafts')).toBeNull();
    expect(bucket('Unknown status')).toBeNull();
  });

  it('keeps every bucket a kit panel: nothing is a stat card or a status tab', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SENT' })]));
    render(<KinTales />);
    expect(document.querySelector('.den-stat')).toBeNull();
    // The only tabs left are the toolbar's date presets; no status tab.
    expect(screen.queryByRole('tab', { name: /^(All|Drafts|Sent|Failed)$/ })).toBeNull();
  });
});

describe('KinTales screen: the date window', () => {
  it('defaults to the last 7 days, and asks the server for exactly that', () => {
    render(<KinTales />);
    expect(screen.getByRole('tab', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(lastSpec().filters?.map((f) => [f[0], f[1]])).toEqual([['createdAt', '>=']]);
  });

  it('windows against an ISO string, which is what kin_care_reports.createdAt holds', () => {
    render(<KinTales />);
    const bound = lastSpec().filters?.[0]?.[2];
    expect(typeof bound).toBe('string');
    expect(String(bound)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('drops the predicate entirely for All (archive), never widening to an always-true one', async () => {
    render(<KinTales />);
    await user.click(screen.getByRole('tab', { name: 'All (archive)' }));
    expect(lastSpec().filters).toBeUndefined();
  });

  it('moves the bound out when a longer window is picked', async () => {
    render(<KinTales />);
    const sevenDays = String(lastSpec().filters?.[0]?.[2]);
    await user.click(screen.getByRole('tab', { name: 'Last 90 days' }));
    expect(String(lastSpec().filters?.[0]?.[2]) < sevenDays).toBe(true);
  });

  it('names the WINDOW in the empty state, never the collection', () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<KinTales />);
    // "No KinTales sent yet" would be a claim about the archive made from one
    // quiet week, which is the failure this screen was rewritten to stop making.
    expect(screen.getByText('No KinTales in the last 7 days.')).toBeInTheDocument();
  });

  it('renames the empty state with the window the operator chose', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<KinTales />);
    await user.click(screen.getByRole('tab', { name: 'All (archive)' }));
    expect(screen.getByText('No KinTales in the archive.')).toBeInTheDocument();
  });
});

describe('KinTales screen: the kinfolk facet', () => {
  it('offers the whole household directory, not just the households already loaded', () => {
    setHouseholds({
      status: 'ready',
      data: [
        { _id: 'kf1', firstName: 'Dana', lastName: 'Ruiz' },
        { _id: 'kf2', firstName: 'Sam', lastName: 'Okafor' },
      ],
    });
    usePagedCollection.mockReturnValue(paged([entry({ kinfolkId: 'kf1' })]));
    render(<KinTales />);
    const select = screen.getByLabelText('Household');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All households',
      'Dana Ruiz',
      'Sam Okafor',
    ]);
  });

  it('composes the facet with the window as a server predicate, in index order', async () => {
    setHouseholds({
      status: 'ready',
      data: [{ _id: 'kf2', firstName: 'Sam', lastName: 'Okafor' }],
    });
    render(<KinTales />);
    await user.selectOptions(screen.getByLabelText('Household'), 'kf2');

    const filters = lastSpec().filters ?? [];
    expect(filters.map((f) => [f[0], f[1]])).toEqual([
      ['kinfolkId', '=='],
      ['createdAt', '>='],
    ]);
    expect(filters[0]?.[2]).toBe('kf2');
  });

  it('says so when the household list itself failed, rather than offering an empty dropdown', () => {
    setHouseholds({ status: 'error', message: 'permission-denied' });
    render(<KinTales />);
    expect(screen.getByText(/Household list unavailable: permission-denied/)).toBeInTheDocument();
    // The list itself is unaffected: a facet that cannot load is not a failed list.
    expect(screen.queryByText(/Couldn’t load KinTales/)).toBeNull();
  });
});

describe('KinTales screen: search, and what it admits to searching', () => {
  const two = [
    entry({ _id: 'a', kinfolkName: 'Household A', title: 'Park day' }),
    entry({ _id: 'b', kinfolkName: 'Household B', title: 'Vet visit' }),
  ];

  it('narrows the loaded rows by household', async () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox', { name: 'Search KinTales' }), 'household b');
    expect(screen.queryByText('Household A')).toBeNull();
    expect(screen.getByText('Household B')).toBeInTheDocument();
  });

  it('narrows by title too', async () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'vet');
    expect(screen.getByText('Household B')).toBeInTheDocument();
    expect(screen.queryByText('Household A')).toBeNull();
  });

  it('states what is really being searched: the LOADED rows, and the window they came from', () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    expect(
      screen.getByText(
        'Searching the 2 KinTales loaded from the last 7 days, by household and title.',
      ),
    ).toBeInTheDocument();
  });

  it('admits there is more to search when the cursor has not been exhausted', () => {
    usePagedCollection.mockReturnValue(paged(two, { hasMore: true }));
    render(<KinTales />);
    expect(
      screen.getByText(
        'Searching the 2 KinTales loaded from the last 7 days, by household and title. Load more to reach further back.',
      ),
    ).toBeInTheDocument();
  });

  it('claims no count at all before the first page lands', () => {
    usePagedCollection.mockReturnValue(paged([], { state: { status: 'loading' } }));
    render(<KinTales />);
    expect(
      screen.getByText('Search covers household and title, within the last 7 days.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Searching the 0 KinTales/)).toBeNull();
  });

  it('distinguishes "nothing matched" from "the window is empty"', async () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(
      screen.getByText('Nothing in the loaded KinTales matches this search.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No KinTales in the last 7 days/)).toBeNull();
  });

  it('points at Load more when the non-match might only be a non-match SO FAR', async () => {
    usePagedCollection.mockReturnValue(paged(two, { hasMore: true }));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(
      screen.getByText(
        'Nothing in the loaded KinTales matches this search. Load more to reach further back.',
      ),
    ).toBeInTheDocument();
  });

  it('narrows every bucket at once, and drops a bucket the search emptied', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'SENT' }),
        entry({ _id: 'b', kinfolkName: 'Household A', status: 'DRAFT' }),
        entry({ _id: 'c', kinfolkName: 'Household B', status: 'SENT' }),
      ]),
    );
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'household a');
    expect(document.querySelectorAll('.kintales__row')).toHaveLength(2);
    expect(within(bucket('Sent')!).getByText('1')).toHaveClass('den-panel-meta');
    expect(within(bucket('Drafts')!).getByText('1')).toHaveClass('den-panel-meta');
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'household b');
    expect(bucket('Drafts')).toBeNull();
    expect(document.querySelectorAll('.kintales__row')).toHaveLength(1);
  });
});

/**
 * The mock's third SUGGESTION ("Result-count chip next to the heading"), which
 * the operator approved on 2026-08-09. It sits on the toolbar's scope line,
 * beside the search box that narrows it, because it is a fact about the rows
 * the buckets show: the joined reports+drafts list after the search, never the
 * orphan triage queue, which carries its own count.
 */
describe('KinTales screen: the result-count chip', () => {
  const two = [
    entry({ _id: 'a', kinfolkName: 'Household A', title: 'Park day' }),
    entry({ _id: 'b', kinfolkName: 'Household B', title: 'Vet visit' }),
  ];

  it('counts the loaded rows when nothing is narrowing them', () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    expect(screen.getByText('2 loaded')).toBeInTheDocument();
  });

  it('says the count is of LOADED rows, never of the collection', () => {
    usePagedCollection.mockReturnValue(paged(two, { hasMore: true }));
    render(<KinTales />);
    // The word that keeps the number honest while a cursor is still open.
    expect(screen.getByText('2 loaded')).toBeInTheDocument();
  });

  it('reports matches against the loaded total once a search narrows them', async () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'household b');
    expect(screen.getByText('1 of 2 loaded')).toBeInTheDocument();
  });

  it('reads as the plain count when a search excluded nothing after all', async () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'household');
    expect(screen.getByText('2 loaded')).toBeInTheDocument();
  });

  it('shows an honest zero against a known loaded total when nothing matched', async () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText('0 of 2 loaded')).toBeInTheDocument();
    // and the list still says WHY it is empty, rather than the chip alone.
    expect(
      screen.getByText('Nothing in the loaded KinTales matches this search.'),
    ).toBeInTheDocument();
  });

  it('claims NO count at all while the first page is still in flight', () => {
    usePagedCollection.mockReturnValue(paged([], { state: { status: 'loading' } }));
    render(<KinTales />);
    expect(screen.queryByText(/loaded$/)).toBeNull();
  });

  it('claims no count when the first page FAILED, rather than a confident 0', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'permission-denied' } }),
    );
    render(<KinTales />);
    expect(screen.queryByText(/loaded$/)).toBeNull();
  });

  it('announces itself, so a count that changes under the operator is heard', () => {
    usePagedCollection.mockReturnValue(paged(two));
    render(<KinTales />);
    expect(screen.getByText('2 loaded')).toHaveAttribute('role', 'status');
  });

  it('counts the joined drafts alongside the reports, the rows the list shows', () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'a', kinfolkName: 'Household A' })]));
    setDrafts([draft({ _id: 'd1' })]);
    render(<KinTales />);
    expect(screen.getByText('2 loaded')).toBeInTheDocument();
  });
});

describe('KinTales screen: the bucket counts say what they count', () => {
  const four = [
    entry({ _id: 'a', status: 'SENT' }),
    entry({ _id: 'b', status: 'SENT' }),
    entry({ _id: 'c', status: 'DRAFT' }),
    entry({ _id: 'd', status: 'FAILED' }),
  ];

  it('counts Sent, Draft, and Failed positively (never by negation)', () => {
    usePagedCollection.mockReturnValue(paged(four));
    render(<KinTales />);
    expect(within(bucket('Sent')!).getByText('2')).toHaveClass('den-panel-meta');
    expect(within(bucket('Drafts')!).getByText('1')).toHaveClass('den-panel-meta');
    expect(within(bucket('Needs another look')!).getByText('1')).toHaveClass('den-panel-meta');
  });

  it('claims the whole window only once the cursor is exhausted', () => {
    usePagedCollection.mockReturnValue(paged(four));
    render(<KinTales />);
    expect(
      screen.getByText('These counts cover all 4 KinTales in the last 7 days.'),
    ).toBeInTheDocument();
  });

  it('says the counts are partial while there are more pages to load', () => {
    usePagedCollection.mockReturnValue(paged(four, { hasMore: true }));
    render(<KinTales />);
    expect(
      screen.getByText(
        'These counts cover the 4 KinTales loaded so far, not all of the last 7 days.',
      ),
    ).toBeInTheDocument();
  });

  it('makes no claim at all while the first page is in flight', () => {
    usePagedCollection.mockReturnValue(paged([], { state: { status: 'loading' } }));
    render(<KinTales />);
    expect(screen.queryByText(/These counts cover/)).toBeNull();
  });
});

describe('KinTales screen: paging', () => {
  it('offers Load more only while the cursor says there may be another page', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    const { unmount } = render(<KinTales />);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    unmount();

    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    render(<KinTales />);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('asks the hook for the next page, and never re-implements the cursor itself', async () => {
    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    render(<KinTales />);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it('blocks a second request while one is in flight, and says it is working', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], { hasMore: true, more: { status: 'loading' } }),
    );
    render(<KinTales />);
    expect(screen.getByRole('button', { name: 'Loading more…' })).toBeDisabled();
  });

  it('renders every row of a large accumulated page, with no 200-row cap left anywhere', () => {
    // Cap regression guard. The old screen streamed a flat 200 and the 201st row
    // simply did not exist; paging means the loaded list can exceed that.
    const many = Array.from({ length: 250 }, (_, i) =>
      entry({ _id: `t${String(i)}`, kinfolkName: `Household ${String(i)}` }),
    );
    usePagedCollection.mockReturnValue(paged(many));
    render(<KinTales />);
    expect(document.querySelectorAll('.kintales__row')).toHaveLength(250);
    expect(screen.getByText('Household 249')).toBeInTheDocument();
    expect(screen.getByText('These counts cover all 250 KinTales in the last 7 days.')).toBeInTheDocument();
  });
});

describe('KinTales screen: a failed FIRST page is not a failed LATER page', () => {
  it('replaces the list when the first page fails, and offers a retry', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'permission-denied', retry: reload } }),
    );
    render(<KinTales />);
    expect(
      screen.getByText('permission-denied', { selector: '.async-error-detail' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // Never the empty state on top of a failure, and never a row.
    expect(screen.queryByText(/No KinTales in/)).toBeNull();
    expect(document.querySelectorAll('.kintales__row')).toHaveLength(0);
  });

  it('KEEPS the rows when a later page fails, and reports the failure beside them', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'a', kinfolkName: 'Still Here' })], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    render(<KinTales />);

    // The list the operator could already read is untouched.
    expect(screen.getByText('Still Here')).toBeInTheDocument();
    expect(document.querySelectorAll('.kintales__row')).toHaveLength(1);
    // And the failure is stated, inline, without the whole-region banner.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load more KinTales. deadline-exceeded');
    expect(alert).toHaveTextContent('The 1 already listed are unaffected');
    expect(screen.queryByText('KinTales unavailable while the load is failing.')).toBeNull();
  });

  it('retries the failed page from where it stopped, not from the top', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    render(<KinTales />);
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: /retry/i }));
    expect(loadMore).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
/**
 * THE REPORTED BUG. The screen showed "Sent 0 / Drafts 0 / Needs another look
 * 0" and "No KinTales in the last 30 days" while Home, on the same session,
 * listed KinTales. The two read different collections: this screen paged
 * `kin_care_reports`, Home's widget read `generated_drafts`. Operator ruling,
 * 2026-08-04, verbatim: "generated drafts are just drafts of the kintales".
 * So the Drafts bucket this screen already promised has to be filled from
 * there, and every claim the screen makes about its own counts has to stay
 * true while it is.
 */
describe('KinTales screen: a draft is a KinTale', () => {
  it('counts a generated draft in the Drafts bucket', () => {
    // Fails before the join: the screen read one collection and this bucket
    // could only ever be 0.
    setDrafts([draft()]);
    render(<KinTales />);
    expect(within(bucket('Drafts')!).getByText('1')).toHaveClass('den-panel-meta');
  });
  it('lists the draft as a row in the Drafts bucket, with its household and the draft pill', () => {
    setDrafts([draft()]);
    render(<KinTales />);
    const row = within(bucket('Drafts')!).getByText('The Okafors').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('DRAFT')).toHaveClass('den-statuspill');
  });
  it('stops claiming an empty window when the window holds drafts', () => {
    usePagedCollection.mockReturnValue(paged([]));
    setDrafts([draft()]);
    render(<KinTales />);
    expect(screen.queryByText(/No KinTales in the last 7 days/)).toBeNull();
  });
  it('files the draft under Drafts and the sent report under Sent, never the other way', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SENT' })]));
    setDrafts([draft()]);
    render(<KinTales />);
    expect(within(bucket('Drafts')!).getByText('The Okafors')).toBeInTheDocument();
    expect(within(bucket('Drafts')!).queryByText('The Whitfields')).toBeNull();
    expect(within(bucket('Sent')!).getByText('The Whitfields')).toBeInTheDocument();
    expect(within(bucket('Sent')!).queryByText('The Okafors')).toBeNull();
  });
  it('names the draft type on the row, so an sms draft never reads as a visit recap', () => {
    // `generated_drafts` holds drafts of every generator output, not only visit
    // recaps (generate.js's ALLOWED_TYPES). None is filtered out, so each says
    // which kind it is.
    setDrafts([draft({ communicationType: 'sms' })]);
    render(<KinTales />);
    const row = screen.getByText('The Okafors').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('sms')).toBeInTheDocument();
  });
  it('counts the draft in the total the honesty line quotes', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SENT' })]));
    setDrafts([draft()]);
    render(<KinTales />);
    expect(
      screen.getByText('These counts cover all 2 KinTales in the last 7 days.'),
    ).toBeInTheDocument();
  });
  it('searches drafts alongside reports, over the same loaded rows', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ kinfolkName: 'The Whitfields' })]));
    setDrafts([draft()]);
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox', { name: 'Search KinTales' }), 'okafor');
    expect(screen.getByText('The Okafors')).toBeInTheDocument();
    expect(screen.queryByText('The Whitfields')).toBeNull();
  });
  it('narrows drafts by the household facet too, not just the reports query', async () => {
    setHouseholds({
      status: 'ready',
      data: [{ _id: 'kf9', firstName: 'Sam', lastName: 'Okafor' }],
    });
    setDrafts([draft({ kinfolk_id: 'kf1' })]);
    render(<KinTales />);
    expect(screen.getByText('The Okafors')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Household'), 'kf9');
    // The reports side is narrowed server-side; the drafts side has to be
    // narrowed here, or the facet would silently lie about half the list.
    expect(screen.queryByText('The Okafors')).toBeNull();
  });
  it('applies the date window to drafts, and widens it with the archive preset', async () => {
    setDrafts([draft({ createdOn: '2019-01-01T00:00:00.000Z' })]);
    render(<KinTales />);
    expect(screen.queryByText('The Okafors')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'All (archive)' }));
    expect(screen.getByText('The Okafors')).toBeInTheDocument();
  });
  it('keeps an UNDATED draft visible rather than hiding a real row inside the window logic', () => {
    setDrafts([draft({ createdOn: '' })]);
    render(<KinTales />);
    expect(screen.getByText('The Okafors')).toBeInTheDocument();
    expect(screen.getByText('Date TBD')).toBeInTheDocument();
  });
  it('reads the snake_case fields generate.js writes, not just the migrated spelling', () => {
    setDrafts([
      {
        _id: 'gen1',
        kinfolk_id: 'kf1',
        kinfolk_name: 'The Ruiz Family',
        communication_type: 'visit_report',
        generated_copy: 'Comet chased every leaf in the yard.',
        status: 'generated',
        generated_at: new Date().toISOString(),
      },
    ]);
    render(<KinTales />);
    // The snake_case household lands in the Drafts bucket as a draft row; the
    // copy itself is read on the detail screen, the row carries no headline.
    const row = within(bucket('Drafts')!).getByText('The Ruiz Family').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('DRAFT')).toHaveClass('den-statuspill');
    expect(within(row).getByText('visit report')).toBeInTheDocument();
  });
  it('never counts an approved draft as Sent, because nothing on the doc proves a delivery', () => {
    setDrafts([draft({ status: 'approved' })]);
    render(<KinTales />);
    expect(bucket('Sent')).toBeNull();
    expect(bucket('Drafts')).toBeNull();
    // Still on screen, in its own honest bucket, exactly as an unrecognised
    // kin_care_reports status is.
    expect(within(bucket('Unknown status')!).getByText('UNKNOWN')).toBeInTheDocument();
  });
});
describe('KinTales screen: the drafts read states what it is worth', () => {
  it('says the drafts read FAILED rather than reporting a confident 0 drafts', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SENT' })]));
    setDrafts([], { status: 'error', message: 'permission-denied' });
    render(<KinTales />);
    expect(
      screen.getByText(
        'Drafts could not be loaded (permission-denied), so the Drafts count is missing them.',
      ),
    ).toBeInTheDocument();
    // And the report list it could read is untouched.
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
  });
  it('a failed drafts read is announced, not left as a quiet caption', () => {
    setDrafts([], { status: 'error', message: 'permission-denied' });
    render(<KinTales />);
    expect(screen.getByRole('alert')).toHaveTextContent('Drafts could not be loaded');
  });
  it('says the Drafts count is not final while the drafts read is still in flight', () => {
    setDrafts([], { status: 'loading' });
    render(<KinTales />);
    expect(
      screen.getByText('Drafts are still loading, so the Drafts count is not final yet.'),
    ).toBeInTheDocument();
  });
  it('admits the drafts side is capped once the listener comes back full', () => {
    setDrafts(
      Array.from({ length: GENERATED_DRAFTS_MAX }, (_, i) => draft({ _id: `d${String(i)}` })),
    );
    render(<KinTales />);
    expect(
      screen.getByText(
        `Drafts are the newest ${String(GENERATED_DRAFTS_MAX)} only; older drafts are not counted.`,
      ),
    ).toBeInTheDocument();
  });
  it('makes no drafts caveat at all when the whole queue fits under the cap', () => {
    setDrafts([draft()]);
    render(<KinTales />);
    expect(screen.queryByText(/Drafts are the newest/)).toBeNull();
    expect(screen.queryByText(/Drafts could not be loaded/)).toBeNull();
    expect(screen.queryByText(/Drafts are still loading/)).toBeNull();
  });
});
