// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type KinTaleEntry } from '../api/kinTales';
import { type PagedCollection } from '../lib/usePagedCollection';

/**
 * The list is PAGED now, so this file mocks `usePagedCollection` rather than
 * `useCollection`. `useCollection` is still mocked because the household facet
 * reads the kinfolk directory through it, and the two must be told apart: a test
 * that stubs only one of them would silently exercise the other for real.
 */
const { usePagedCollection } = vi.hoisted(() => ({ usePagedCollection: vi.fn() }));
vi.mock('../lib/usePagedCollection', () => ({ usePagedCollection }));

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { KinTales } from './KinTales';

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

beforeEach(() => {
  loadMore.mockReset();
  reload.mockReset();
  usePagedCollection.mockReset().mockReturnValue(paged([]));
  // The household directory behind the facet. Empty unless a case needs it.
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] });
});

describe('KinTales screen', () => {
  it('renders a paged row with its household, headline, service, timestamp, and status chip', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<KinTales />);
    // Scope by the row container, not the button, the row is only a
    // <button> once a detail route wires onSelect; here (unwired) it renders
    // static.
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    expect(within(row).getByText('Dog Walk')).toBeInTheDocument();
    expect(within(row).getByText('Biscuit had a wonderful time at the park today.')).toBeInTheDocument();
    expect(within(row).getByText('DRAFT')).toBeInTheDocument();
  });

  it('prefers a non-blank title over the body preview as the row headline', () => {
    usePagedCollection.mockReturnValue(paged([entry({ title: 'A great day at the park' })]));
    render(<KinTales />);
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('A great day at the park')).toBeInTheDocument();
    expect(within(row).queryByText('Biscuit had a wonderful time at the park today.')).toBeNull();
  });

  it('shows an honest "(empty body)" headline for a blank title and blank body, never a blank row', () => {
    usePagedCollection.mockReturnValue(paged([entry({ title: '', bodyCopy: '' })]));
    render(<KinTales />);
    const row = screen.getByText('The Whitfields').closest('.kintales__row') as HTMLElement;
    expect(within(row).getByText('(empty body)')).toBeInTheDocument();
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
  ])('renders the %s status positively as its own chip', (status, chip) => {
    usePagedCollection.mockReturnValue(paged([entry({ status })]));
    render(<KinTales />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated DRAFT', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'some_new_code' })]));
    render(<KinTales />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('DRAFT')).toBeNull();
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

  it('calls onNew when New KinTale is clicked', async () => {
    const onNew = vi.fn();
    render(<KinTales onNew={onNew} />);
    await user.click(screen.getByRole('button', { name: /new kintale/i }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('renders New KinTale STATIC (not a live no-op button) when unwired', () => {
    render(<KinTales />);
    expect(screen.getByText('New KinTale')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new kintale/i })).toBeNull();
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
    useCollection.mockReturnValue({
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
    useCollection.mockReturnValue({
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
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
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
      screen.getByText('Nothing in the loaded KinTales matches this filter.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No KinTales in the last 7 days/)).toBeNull();
  });

  it('points at Load more when the non-match might only be a non-match SO FAR', async () => {
    usePagedCollection.mockReturnValue(paged(two, { hasMore: true }));
    render(<KinTales />);
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(
      screen.getByText(
        'Nothing in the loaded KinTales matches this filter. Load more to reach further back.',
      ),
    ).toBeInTheDocument();
  });

  it('composes with the status tabs rather than replacing them', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'SENT' }),
        entry({ _id: 'b', kinfolkName: 'Household A', status: 'DRAFT' }),
        entry({ _id: 'c', kinfolkName: 'Household B', status: 'SENT' }),
      ]),
    );
    render(<KinTales />);
    await user.click(screen.getByRole('tab', { name: 'Sent' }));
    await user.type(screen.getByRole('searchbox'), 'household a');
    expect(document.querySelectorAll('.kintales__row')).toHaveLength(1);
  });
});

describe('KinTales screen: the filter tabs', () => {
  it('narrow the visible rows without hiding the others behind a false empty', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'SENT' }),
        entry({ _id: 'b', kinfolkName: 'Household B', status: 'DRAFT' }),
      ]),
    );
    render(<KinTales />);
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.getByText('Household B')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Sent' }));
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.queryByText('Household B')).toBeNull();
  });
});

describe('KinTales screen: the stat strip says what it counts', () => {
  const four = [
    entry({ _id: 'a', status: 'SENT' }),
    entry({ _id: 'b', status: 'SENT' }),
    entry({ _id: 'c', status: 'DRAFT' }),
    entry({ _id: 'd', status: 'FAILED' }),
  ];

  it('counts Sent, Draft, and Failed positively (never by negation)', () => {
    usePagedCollection.mockReturnValue(paged(four));
    render(<KinTales />);
    // Scoped to the stat-card label specifically: "Sent"/"Drafts" also name a
    // filter tab, and an unscoped getByText would be an ambiguous match.
    const cardFor = (label: string) =>
      screen
        .getByText(label, { selector: '.den-stat-label' })
        .closest('.den-stat, button.den-stat--button') as HTMLElement;
    expect(within(cardFor('Sent')).getByText('2')).toBeInTheDocument();
    expect(within(cardFor('Drafts')).getByText('1')).toBeInTheDocument();
    expect(within(cardFor('Needs another look')).getByText('1')).toBeInTheDocument();
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
