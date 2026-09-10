// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type SessionEntry } from '../api/sessions';
import { type Kin, type Kinfolk } from '../api/directory';
import { type PagedCollection } from '../lib/usePagedCollection';
import { type CollectionSpec } from '../lib/firestore';

/**
 * ISSUE #703 REWROTE THIS SUITE, because it rewrote the screen. Auntie Time is
 * a day-of BOARD now, per `ui-ideas/auntieos-auntie-time-2026-05-27.html`: four
 * always-present phase groups of action cards. The stat strip, the filter tabs,
 * the Sort select and the DenPanel wrapper are gone, so the cases that asserted
 * them are gone too rather than left skipped. What replaced them is below: the
 * four groups, the card's own anatomy, and the lifecycle buttons the card now
 * carries.
 */
const { usePagedCollection } = vi.hoisted(() => ({ usePagedCollection: vi.fn() }));
vi.mock('../lib/usePagedCollection', () => ({ usePagedCollection }));
/**
 * The by-id read behind the deep link (#408), plus the two directory joins the
 * card needs (`kinfolk` for the service address, `kin` for the photos). Mocked
 * at the module boundary rather than stubbed out, because which spec each read
 * asks for is part of what these cases check.
 */
const { useDocById, useCollection } = vi.hoisted(() => ({
  useDocById: vi.fn(),
  useCollection: vi.fn(),
}));
vi.mock('../lib/firestore', () => ({ useDocById, useCollection }));
/**
 * The writes. `setVisitLifecycle` is the card's own clock (through
 * `lib/useVisitLifecycle.ts`, the hook SessionDetail shares) and
 * `transitionBookingStatus` is Complete, which is terminal and billable and so
 * goes through the booking state machine instead.
 */
const { setVisitLifecycle, transitionBookingStatus } = vi.hoisted(() => ({
  setVisitLifecycle: vi.fn(),
  transitionBookingStatus: vi.fn(),
}));
vi.mock('../api/sessionsWrite', () => ({
  setVisitLifecycle,
  updateKinCareSession: vi.fn(),
}));
vi.mock('../api/bookingsWrite', () => ({ transitionBookingStatus }));
vi.mock('../api/settings', () => ({
  getBusinessSettings: vi.fn().mockResolvedValue({ serviceRates: {}, serviceDurations: {} }),
}));
vi.mock('../lib/breadcrumbs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/breadcrumbs')>();
  return { ...actual, useBreadcrumbs: () => ({ points: [], error: null, ready: true }) };
});

import { Sessions } from './Sessions';

/**
 * Local wall-clock time [offset] days from today, as the UTC instant string a
 * real writer stamps (`approveBookingSeriesCore.ts`'s `toDate().toISOString()`).
 *
 * Fixtures are RELATIVE rather than absolute because the screen scopes itself to
 * a window around today: a hardcoded 2026-07-16 would quietly fall out of that
 * window and every assertion here would rot. The alternative, faking the system
 * clock for the whole file, is ruled out by userEvent's own setTimeout delays.
 */
function at(offset: number, hour = 12, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function entry(over: Partial<SessionEntry>): SessionEntry {
  return {
    _id: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: [],
    serviceType: 'Dog Walk',
    startTime: at(1, 14),
    arrivedAt: '',
    endTime: at(1, 15),
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

const loadMore = vi.fn();
const reload = vi.fn();

/** A settled first page. Overrides cover the in-flight, failed and more-to-come cases. */
function paged(
  rows: SessionEntry[],
  over: Partial<PagedCollection<SessionEntry>> = {},
): PagedCollection<SessionEntry> {
  return {
    state: { status: 'ready', data: rows },
    hasMore: false,
    more: { status: 'ready', data: null },
    loadMore,
    reload,
    ...over,
  };
}

/**
 * The two directory joins, answered by PATH. A single `mockReturnValue` would
 * hand the kin roster to the address lookup and vice versa, which is exactly the
 * confusion the card must never make.
 */
function directory(households: Kinfolk[] = [], kin: Kin[] = []) {
  useCollection.mockImplementation((spec: CollectionSpec) =>
    spec.path === 'kin'
      ? { status: 'ready', data: kin }
      : { status: 'ready', data: households },
  );
}

/** The spec the paged hook most recently asked for. */
function lastSpec(): { pageSize: number; filters?: [string, string, unknown][] } {
  return usePagedCollection.mock.calls.at(-1)![0] as {
    pageSize: number;
    filters?: [string, string, unknown][];
  };
}

/**
 * The four phase headings, count chip stripped, in render order. `queryAll`, not
 * `getAll`: several cases below assert that there are NONE, which is a real
 * answer the board gives (an error, a load in flight, the Archive).
 */
function phaseHeadings(): string[] {
  return screen
    .queryAllByRole('heading', { level: 3 })
    .map((h) => h.textContent?.replace(/\d+$/, '').trim() ?? '');
}

/** One phase group's count chip, read off the heading rather than off the cards. */
function phaseCount(label: string): string {
  const heading = screen.getByRole('heading', { level: 3, name: new RegExp(`^${label}`) });
  return heading.querySelector('.sessions__phase-count')?.textContent ?? '';
}

/** Press a card's lifecycle button and confirm the dialog it opens. */
async function act(button: RegExp, confirm: RegExp) {
  await user.click(screen.getByRole('button', { name: button }));
  await user.click(screen.getByRole('button', { name: confirm }));
}

// TZ pinned to a west-of-UTC zone so the AO-18 day assertions below are
// meaningful on any CI runner (see the identical rationale in
// lib/sessionFormat.test.ts). Restored afterAll for any sibling test file
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
  // 'loading' by default, which is what a just-mounted subscription really is:
  // the detail then renders the placeholder row the board already holds. A case
  // that cares what the LIVE document says sets this itself.
  useDocById.mockReset().mockReturnValue({ status: 'loading' });
  useCollection.mockReset();
  directory();
  loadMore.mockReset();
  reload.mockReset();
  setVisitLifecycle.mockReset().mockResolvedValue({
    ok: true,
    sessionId: 'sess1',
    action: 'ARRIVED',
    from: 'SCHEDULED',
    status: 'ARRIVED',
    changed: true,
    notified: true,
    notifySkipped: null,
  });
  transitionBookingStatus.mockReset().mockResolvedValue({
    ok: true,
    sessionId: 'sess1',
    action: 'COMPLETE',
    from: 'SCHEDULED',
    status: 'COMPLETED',
    changed: true,
  });
  usePagedCollection.mockReset().mockReturnValue(paged([]));
});

/**
 * THE BOARD. The operator's complaint in #703 was the frame that said "9 visits
 * fetched" over a single empty hint, because `groupSessionsByPhase` skipped
 * every empty phase. Four groups, always, with their counts.
 */
describe('Auntie Time: the four phase groups', () => {
  it('renders all four groups over NO data at all, each with a zero count', () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    expect(phaseHeadings()).toEqual(['Active', 'Overdue', 'Upcoming', 'Recent']);
    for (const label of ['Active', 'Overdue', 'Upcoming', 'Recent']) {
      expect(phaseCount(label)).toBe('0');
    }
  });

  it('says what each empty group COVERS, not four copies of "nothing here"', () => {
    // The count chip already reads 0. These lines answer the question the chip
    // cannot: whether Overdue is empty because nothing slipped, or because the
    // board is not looking.
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    expect(screen.getByText('No visit is in flight.')).toBeInTheDocument();
    expect(screen.getByText('No scheduled visit has slipped past its slot.')).toBeInTheDocument();
    expect(screen.getByText('Nothing booked in the next 14 days.')).toBeInTheDocument();
    expect(screen.getByText('Nothing wrapped today or yesterday.')).toBeInTheDocument();
  });

  it('still says where the older visits went, under the empty groups rather than instead of them', () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    expect(screen.getByText(/older visits are in the archive/i)).toBeInTheDocument();
    expect(phaseHeadings()).toHaveLength(4);
  });

  it('counts each phase from the rows it actually holds', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', kinfolkName: 'In Flight', status: 'ARRIVED', startTime: at(0, 9) }),
        entry({ _id: 'b', kinfolkName: 'Also Flying', status: 'DEPARTED', startTime: at(0, 10) }),
        entry({ _id: 'c', kinfolkName: 'Ten Days Late', status: 'SCHEDULED', startTime: at(-10) }),
        entry({ _id: 'd', kinfolkName: 'Next Up', status: 'SCHEDULED', startTime: at(1) }),
        entry({
          _id: 'e',
          kinfolkName: 'Just Wrapped',
          status: 'COMPLETED',
          startTime: at(-1),
          completedAt: at(-1, 14),
        }),
      ]),
    );
    render(<Sessions />);
    expect(phaseCount('Active')).toBe('2');
    expect(phaseCount('Overdue')).toBe('1');
    expect(phaseCount('Upcoming')).toBe('1');
    expect(phaseCount('Recent')).toBe('1');
  });

  it('sorts each visit into its own phase group', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', kinfolkName: 'In Flight', status: 'ARRIVED', startTime: at(0, 9) }),
        entry({ _id: 'b', kinfolkName: 'Ten Days Late', status: 'SCHEDULED', startTime: at(-10) }),
        entry({ _id: 'c', kinfolkName: 'Next Up', status: 'SCHEDULED', startTime: at(1) }),
        entry({
          _id: 'd',
          kinfolkName: 'Just Wrapped',
          status: 'COMPLETED',
          startTime: at(-1),
          completedAt: at(-1, 14),
        }),
      ]),
    );
    render(<Sessions />);
    const phaseOf = (name: string) => screen.getByText(name).closest('.sessions__phase')?.className;
    expect(phaseOf('In Flight')).toContain('sessions__phase--active');
    expect(phaseOf('Ten Days Late')).toContain('sessions__phase--overdue');
    expect(phaseOf('Next Up')).toContain('sessions__phase--upcoming');
    expect(phaseOf('Just Wrapped')).toContain('sessions__phase--recent');
  });

  it('Recent is today or yesterday, per the mock: a wrap from a week ago is not on the board', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'old',
          kinfolkName: 'Last Week',
          status: 'COMPLETED',
          startTime: at(-7),
          completedAt: at(-7, 14),
        }),
      ]),
    );
    render(<Sessions />);
    expect(screen.queryByText('Last Week')).toBeNull();
    expect(phaseCount('Recent')).toBe('0');
  });

  it('fetches a bounded date range rather than the flat latest 300', () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    const spec = lastSpec();
    // A PAGE size, not a cap: a busy window is reachable rather than silently
    // truncated at the far end of the sort.
    expect(spec.pageSize).toBe(100);
    expect(spec.filters?.map((f) => [f[0], f[1]])).toEqual([
      ['startTime', '>='],
      ['startTime', '<='],
    ]);
  });
});

/**
 * THE CARD. Every line the mock draws on one, against a row that carries all of
 * them at once: photos, name, "service · kin · when", status pill, the GPS live
 * line, the address, the household note, the invoice chip, and the actions.
 */
describe('Auntie Time: one fully populated action card', () => {
  const populated = entry({
    _id: 'sess-full',
    kinfolkId: 'kf-wren',
    kinfolkName: 'Lorna Wren',
    kinIds: ['kin-biscuit', 'kin-gravy'],
    kinNames: ['Biscuit', 'Gravy'],
    serviceType: 'Dog Walk',
    status: 'ARRIVED',
    startTime: at(0, 9),
    endTime: at(0, 9, 30),
    arrivedAt: at(0, 9),
    kinfolkNotes: 'Side gate, harness on the hook.',
    invoiceId: 'inv-77',
  });
  const households: Kinfolk[] = [{ _id: 'kf-wren', serviceAddress: '82 Creekside Ln' }];
  const kin: Kin[] = [
    { _id: 'kin-biscuit', name: 'Biscuit', profilePictureUrl: 'https://example.test/biscuit.jpg' },
    { _id: 'kin-gravy', name: 'Gravy' },
  ];

  function mount() {
    usePagedCollection.mockReturnValue(paged([populated]));
    directory(households, kin);
    render(<Sessions />);
    return screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
  }

  it('renders every line the mock draws', () => {
    const card = mount();
    // Kin photo circles, one per kin, each named for the animal it stands for
    // rather than left as a decorative blob.
    expect(within(card).getByAltText('Biscuit')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'Gravy' })).toBeInTheDocument();
    // Kinfolk name, service pill, and the "kin names · when" line.
    expect(within(card).getByText('Lorna Wren')).toBeInTheDocument();
    expect(within(card).getByText('Dog Walk')).toBeInTheDocument();
    expect(within(card).getByText('Biscuit & Gravy · Today · 09:00 to 09:30')).toBeInTheDocument();
    // Status pill, GPS live route, address, household note, invoice chip.
    expect(within(card).getByText('ARRIVED')).toBeInTheDocument();
    expect(within(card).getByText(/GPS tracking · live route/)).toBeInTheDocument();
    expect(within(card).getByText(/82 Creekside Ln/)).toBeInTheDocument();
    expect(within(card).getByText('Side gate, harness on the hook.')).toBeInTheDocument();
    expect(within(card).getByText('Invoice linked')).toBeInTheDocument();
    // And the ARRIVED card's own action row.
    expect(within(card).getByRole('button', { name: 'Departed' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Undo arrived' })).toBeInTheDocument();
  });

  it('falls back to the status glyph when no kin photo resolves, never a stock face', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SCHEDULED' })]));
    render(<Sessions />);
    const card = screen.getByText('The Whitfields').closest('.sessions__card') as HTMLElement;
    expect(card.querySelector('.sessions__glyph')).not.toBeNull();
    expect(within(card).queryByRole('img')).toBeNull();
  });

  it('omits the address line entirely when the household has none on file', () => {
    usePagedCollection.mockReturnValue(paged([populated]));
    directory([{ _id: 'kf-wren', serviceAddress: '' }], kin);
    render(<Sessions />);
    const card = screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
    expect(card.querySelector('.sessions__addr')).toBeNull();
  });

  it('claims a live GPS route only while ARRIVED, never on a departed visit', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'gone', kinfolkName: 'Clocked Out', status: 'DEPARTED', startTime: at(0, 8) })]),
    );
    render(<Sessions />);
    expect(screen.queryByText(/GPS tracking/)).toBeNull();
  });

  it('shows no invoice chip on a visit that has not been billed', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Sessions />);
    expect(screen.queryByText('Invoice linked')).toBeNull();
  });

  it('groups a late-evening local session under its LOCAL day, not the UTC-next day (AO-18)', () => {
    // 20:00 America/Chicago today round-trips as tomorrow's UTC date, which is
    // what reading a raw slice of the string would have wrongly used.
    const eveningToday = at(0, 20);
    expect(eveningToday.slice(0, 10)).not.toBe(at(0, 12).slice(0, 10));
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'ARRIVED', startTime: eveningToday, endTime: at(0, 21, 30) })]),
    );
    render(<Sessions />);
    expect(screen.getByText(/Today · 20:00 to 21:30/)).toBeInTheDocument();
    expect(screen.queryByText(/Tomorrow · 20:00/)).toBeNull();
  });

  it.each([
    ['SCHEDULED', 'SCHEDULED'],
    ['ON_MY_WAY', 'ON THE WAY'],
    ['ARRIVED', 'ARRIVED'],
    ['DEPARTED', 'DEPARTED'],
    ['COMPLETED', 'COMPLETED'],
    ['CANCELLED', 'CANCELLED'],
  ])('renders the %s status positively as its own pill', (status, chip) => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status, startTime: at(0, 9), completedAt: at(0, 10) })]),
    );
    render(<Sessions />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated SCHEDULED', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'some_new_code', startTime: at(1) })]));
    render(<Sessions />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });
});

/**
 * THE LIFECYCLE BUTTONS. The board hosts writes now, and every one of them goes
 * through the same handler `SessionDetail` uses: `setVisitLifecycle` for the
 * four in-visit actions, `transitionBookingStatus` for Complete.
 */
describe('Auntie Time: the card runs the visit', () => {
  function mount(over: Partial<SessionEntry>) {
    usePagedCollection.mockReturnValue(paged([entry(over)]));
    render(<Sessions />);
  }

  it('OMW on a scheduled card calls setVisitLifecycle with ON_MY_WAY', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await act(/^OMW$/, /yes, mark it on the way/i);
    expect(setVisitLifecycle).toHaveBeenCalledWith('sess1', 'ON_MY_WAY', expect.anything());
  });

  it('Arrived on a scheduled card calls setVisitLifecycle with ARRIVED', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await act(/^Arrived$/, /yes, clock in/i);
    expect(setVisitLifecycle).toHaveBeenCalledWith('sess1', 'ARRIVED', expect.anything());
  });

  it('Departed on an arrived card calls setVisitLifecycle with DEPARTED', async () => {
    mount({ status: 'ARRIVED', startTime: at(0, 9) });
    await act(/^Departed$/, /yes, clock out/i);
    expect(setVisitLifecycle).toHaveBeenCalledWith('sess1', 'DEPARTED', expect.anything());
  });

  it('Undo arrived on an arrived card calls setVisitLifecycle with UNDO_ARRIVAL', async () => {
    mount({ status: 'ARRIVED', startTime: at(0, 9) });
    await act(/^Undo arrived$/, /yes, undo the arrival/i);
    expect(setVisitLifecycle).toHaveBeenCalledWith('sess1', 'UNDO_ARRIVAL', expect.anything());
  });

  it('Complete goes through transitionBookingStatus, not the visit clock', async () => {
    mount({ status: 'ON_MY_WAY', startTime: at(0, 9) });
    await act(/^Complete$/, /yes, mark it completed/i);
    expect(transitionBookingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1', action: 'COMPLETE' }),
    );
    expect(setVisitLifecycle).not.toHaveBeenCalled();
  });

  it('refreshes the page after a write that changed the document, so the card stops lying', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await act(/^Arrived$/, /yes, clock in/i);
    expect(reload).toHaveBeenCalled();
  });

  it('surfaces a refusal beside the card rather than swallowing it', async () => {
    setVisitLifecycle.mockRejectedValue(new Error('Already departed.'));
    mount({ status: 'ARRIVED', startTime: at(0, 9) });
    await act(/^Departed$/, /yes, clock out/i);
    expect(await screen.findByText(/Already departed\./)).toBeInTheDocument();
  });

  it('writes nothing when the confirm is dismissed', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await user.click(screen.getByRole('button', { name: /^Arrived$/ }));
    await user.click(screen.getByRole('button', { name: /not yet/i }));
    expect(setVisitLifecycle).not.toHaveBeenCalled();
  });

  it('offers "Complete KinTale" on a departed card and routes it to the composer', async () => {
    const onComposeKinTale = vi.fn();
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'sess-dep', status: 'DEPARTED', startTime: at(0, 8) })]),
    );
    render(<Sessions onComposeKinTale={onComposeKinTale} />);
    await user.click(screen.getByRole('button', { name: 'Complete KinTale' }));
    expect(onComposeKinTale).toHaveBeenCalledWith('sess-dep');
  });

  it('offers "View KinTale" on a completed card that has a SENT report', async () => {
    const onViewKinTale = vi.fn();
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'sess-done',
          status: 'COMPLETED',
          startTime: at(0, 8),
          completedAt: at(0, 9),
          reportIds: ['rep-9'],
        }),
      ]),
    );
    render(<Sessions onViewKinTale={onViewKinTale} />);
    await user.click(screen.getByRole('button', { name: 'View KinTale' }));
    expect(onViewKinTale).toHaveBeenCalledWith('rep-9');
  });

  it('hides "View KinTale" when nothing has been sent, rather than offering a dead control', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'sess-done',
          status: 'COMPLETED',
          startTime: at(0, 8),
          completedAt: at(0, 9),
          reportIds: [],
        }),
      ]),
    );
    render(<Sessions onViewKinTale={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'View KinTale' })).toBeNull();
  });

  it('offers no clock action at all on a cancelled card', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'CANCELLED', startTime: at(0, 9) })]),
    );
    render(<Sessions />);
    const card = screen.getByText('The Whitfields').closest('.sessions__card') as HTMLElement;
    expect(card.querySelector('.sessions__acts')).toBeNull();
  });
});

/** What the mock does NOT have, asserted so it cannot creep back. */
describe('Auntie Time: the controls the mock does not have', () => {
  beforeEach(() => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'a', status: 'SCHEDULED', startTime: at(1) })]),
    );
  });

  it('has no filter tabs', () => {
    render(<Sessions />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('has no Sort select', () => {
    render(<Sessions />);
    expect(screen.queryByLabelText('Sort')).toBeNull();
  });

  it('has no stat strip and no "counts cover N visits" line', () => {
    render(<Sessions />);
    expect(screen.queryByText('In flight')).toBeNull();
    expect(screen.queryByText('Wrapped today')).toBeNull();
    expect(screen.queryByText(/These counts cover/)).toBeNull();
  });

  it('keeps Archive as a single link in the heading', () => {
    render(<Sessions />);
    const archive = screen.getByRole('button', { name: 'Archive' });
    expect(archive.closest('.den-heading')).not.toBeNull();
  });
});

describe('Auntie Time: opening one visit', () => {
  it('clicking a card calls onSelect with the session id', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'sess-42' })]));
    const onSelect = vi.fn();
    render(<Sessions onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelect).toHaveBeenCalledWith('sess-42');
  });

  it('propless, the card header opens the in-screen SessionDetail view', async () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    // The detail view has taken over the screen (Directory/KinfolkProfile
    // pattern): its Back control is present, and the household is its heading.
    expect(screen.getByRole('button', { name: /back to auntie time/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The Whitfields' })).toBeInTheDocument();
    // And the trail, which is how the operator knows the board is still behind
    // this view rather than replaced by it.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('the lifecycle buttons do NOT open the detail, so a clock press cannot lose the board', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SCHEDULED', startTime: at(1) })]));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: /^OMW$/ }));
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

describe('Auntie Time: reads that fail', () => {
  it('surfaces a read error, never a false empty', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'permission-denied' } }),
    );
    render(<Sessions />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    // Not even the four empty groups: an error means there is no fact about the
    // board, and four zero chips would be four claims.
    expect(document.querySelectorAll('.sessions__phase')).toHaveLength(0);
    expect(screen.queryByText(/nothing on the books/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'deadline-exceeded', retry: reload } }),
    );
    render(<Sessions />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('makes no board claim at all while the first page is in flight', () => {
    usePagedCollection.mockReturnValue(paged([], { state: { status: 'loading' } }));
    render(<Sessions />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(phaseHeadings()).toHaveLength(0);
  });
});

describe('Auntie Time: the Archive', () => {
  it('swaps in a date-ranged PAGED query over the operator-chosen range', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const spec = lastSpec();
    expect(spec.pageSize).toBe(100);
    expect(spec.filters).toHaveLength(2);
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('defaults to the range just BEFORE the day-of window, so it never re-shows the same rows', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const from = (screen.getByLabelText('From') as HTMLInputElement).value;
    const to = (screen.getByLabelText('To') as HTMLInputElement).value;
    expect(from < to).toBe(true);
    // The window fetches back 30 days; the archive starts where that stops.
    expect(new Date(`${to}T12:00:00`).getTime()).toBeLessThan(Date.now());
  });

  it('drops the phase groups and heads by DAY instead, with the year outside this one', async () => {
    const lastYear = new Date().getFullYear() - 1;
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'old',
          kinfolkName: 'Long Ago',
          status: 'COMPLETED',
          startTime: `${lastYear}-01-16T18:00:00.000Z`,
          completedAt: `${lastYear}-01-16T19:00:00.000Z`,
        }),
      ]),
    );
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(phaseHeadings()).toHaveLength(0);
    expect(
      screen.getByText(`Thu, Jan 16, ${lastYear}`, { selector: '.sessions__day-header' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Long Ago')).toBeInTheDocument();
  });

  it('drops the window rules in the Archive: an old wrap renders instead of vanishing', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'old',
          kinfolkName: 'Old News',
          status: 'COMPLETED',
          startTime: at(-120),
          completedAt: at(-120, 14),
        }),
      ]),
    );
    render(<Sessions />);
    expect(screen.queryByText('Old News')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Old News')).toBeInTheDocument();
  });

  it('goes back to the board, restoring the four groups', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(phaseHeadings()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /back to auntie time/i }));
    expect(phaseHeadings()).toEqual(['Active', 'Overdue', 'Upcoming', 'Recent']);
  });

  it('shows the ordinary empty state in the Archive, where there is no board to count', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('No Kin Cares in this range.')).toBeInTheDocument();
  });
});

/**
 * PHASE 4. Both modes page. The risk paging introduces on THIS screen is that
 * four group counts start describing a fragment of the window instead of the
 * window, which is why the page size covers a realistic book whole.
 */
describe('Auntie Time: paging', () => {
  it('offers Load more only while the cursor says there may be another page', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    const { unmount } = render(<Sessions />);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    unmount();
    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    render(<Sessions />);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('asks the hook for the next page, and never re-implements the cursor itself', async () => {
    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it('blocks a second request while one is in flight, and says it is working', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], { hasMore: true, more: { status: 'loading' } }),
    );
    render(<Sessions />);
    expect(screen.getByRole('button', { name: 'Loading more…' })).toBeDisabled();
  });

  it('pages in the Archive too, not only on the board', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'old', startTime: at(-120), status: 'COMPLETED', completedAt: at(-120, 14) })], {
        hasMore: true,
      }),
    );
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it('renders every visit of a large accumulated page, with no 300-row cap left anywhere', () => {
    // Cap regression guard. The old query took a flat 300 and a busier range was
    // silently truncated at the far end of the sort.
    const many = Array.from({ length: 250 }, (_, i) =>
      entry({
        _id: `s${String(i)}`,
        kinfolkName: `Household ${String(i)}`,
        startTime: at(1, 9, i % 60),
        endTime: at(1, 10, i % 60),
      }),
    );
    usePagedCollection.mockReturnValue(paged(many));
    render(<Sessions />);
    expect(document.querySelectorAll('.sessions__card')).toHaveLength(250);
    expect(phaseCount('Upcoming')).toBe('250');
    expect(screen.getByText('Household 249')).toBeInTheDocument();
  });
});

/**
 * ISSUE #702, kept: nine SCHEDULED visits all past their start (the walk's own
 * fixture). They used to be dropped outright, so the screen counted them and
 * rendered none of them.
 */
describe('Auntie Time: every fetched row lands in a group', () => {
  const nineOverdue = Array.from({ length: 9 }, (_, i) =>
    entry({
      _id: `overdue-${String(i)}`,
      kinfolkName: `Household ${String(i)}`,
      status: 'SCHEDULED',
      startTime: at(-(2 + i)),
    }),
  );

  it('renders all nine overdue rows under Overdue, with the count to match', () => {
    usePagedCollection.mockReturnValue(paged(nineOverdue));
    render(<Sessions />);
    expect(phaseCount('Overdue')).toBe('9');
    expect(document.querySelectorAll('.sessions__card')).toHaveLength(9);
    expect(screen.queryByText(/nothing on the books in this window/i)).toBeNull();
  });

  it('mixes them with an in-flight visit and a future one without losing any', () => {
    usePagedCollection.mockReturnValue(
      paged([
        ...nineOverdue,
        entry({ _id: 'active', kinfolkName: 'In Flight', status: 'ARRIVED', startTime: at(0, 9) }),
        entry({ _id: 'tomorrow', kinfolkName: 'Next Up', status: 'SCHEDULED', startTime: at(1) }),
      ]),
    );
    render(<Sessions />);
    expect(document.querySelectorAll('.sessions__card')).toHaveLength(11);
    expect(phaseCount('Active')).toBe('1');
    expect(phaseCount('Overdue')).toBe('9');
    expect(phaseCount('Upcoming')).toBe('1');
  });
});

describe('Auntie Time: a failed FIRST page is not a failed LATER page', () => {
  it('replaces the board when the first page fails, and offers a retry', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'permission-denied', retry: reload } }),
    );
    render(<Sessions />);
    expect(
      screen.getByText('permission-denied', { selector: '.async-error-detail' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(document.querySelectorAll('.sessions__card')).toHaveLength(0);
    expect(screen.queryByText(/nothing on the books in this window/i)).toBeNull();
  });

  it('KEEPS the visits when a later page fails, and reports the failure beside them', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ kinfolkName: 'Still Here' })], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    render(<Sessions />);
    expect(screen.getByText('Still Here')).toBeInTheDocument();
    expect(document.querySelectorAll('.sessions__card')).toHaveLength(1);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load more Kin Care sessions. deadline-exceeded');
    expect(alert).toHaveTextContent('The 1 already loaded are unaffected');
    expect(screen.queryByText('Kin Care sessions unavailable while the load is failing.')).toBeNull();
  });

  it('retries the failed page from where it stopped, not from the top', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    render(<Sessions />);
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: /retry/i }));
    expect(loadMore).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * #408: an invoice line drawn from a visit routes to `/sessions?sessionId=<id>`,
 * because a bound line's money is corrected on the visit and the invoice
 * follows. The link has to open work that is by definition old enough to have
 * been billed, which is exactly the work this screen's window does not hold.
 */
describe('Auntie Time: the deep link into one visit', () => {
  it('opens the named visit straight from the board when the window holds it', () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'vis_1', serviceType: 'Dog Walk' })]));
    // The subscription has not delivered yet; the row the board holds is the
    // placeholder, so the detail paints immediately instead of flashing
    // "unavailable".
    useDocById.mockReturnValue({ status: 'loading' });
    render(<Sessions initialSessionId="vis_1" />);
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.getByText(/Dog Walk/)).toBeInTheDocument();
  });

  /**
   * #397 L19. This read used to be a FALLBACK, running only when the paged rows
   * did not hold the id, and the streamed copy won otherwise. That was right
   * while the detail was read-only and wrong the moment it gained the visit
   * clock: `usePagedCollection` is a one-shot `getDocs`, so a clock-in would
   * have written the document and left the screen rendering the row it was
   * opened with. The live document is now what the detail renders, whether or
   * not the board happens to hold the same visit.
   */
  it('subscribes to the visit even when the board already holds it, because the detail writes', () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'vis_1', serviceType: 'Dog Walk' })]));
    useDocById.mockReturnValue({
      status: 'ready',
      data: entry({ _id: 'vis_1', serviceType: 'Dog Walk', status: 'ARRIVED' }),
    });
    render(<Sessions initialSessionId="vis_1" />);
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 'vis_1');
    // The LIVE status, not the one the paged row was fetched with.
    expect(screen.getByText('ARRIVED')).toBeInTheDocument();
  });

  it('READS a visit the window does not hold, rather than reporting it unavailable', () => {
    usePagedCollection.mockReturnValue(paged([]));
    useDocById.mockReturnValue({
      status: 'ready',
      data: entry({ _id: 'vis_old', serviceType: 'Overnight', startTime: at(-90, 20) }),
    });
    render(<Sessions initialSessionId="vis_old" />);
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 'vis_old');
    expect(screen.getByText(/Overnight/)).toBeInTheDocument();
  });

  it('issues no read at all when nobody deep-linked', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Sessions />);
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', null);
  });
});
