// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
 * The two directory joins the card needs (`kinfolk` for the service address,
 * `kin` for the photos). Mocked at the module boundary rather than stubbed out,
 * because which spec each read asks for is part of what these cases check.
 *
 * No by-id read here any more: opening a visit is a route now (#753), so the
 * `kin_care_sessions/{id}` subscription lives in `routes/SessionDetailView.tsx`
 * and is driven from `routes/SessionDetailView.test.tsx`.
 */
const { useCollection, useDocById } = vi.hoisted(() => ({
  useCollection: vi.fn(),
  // #2123: a DEPARTED card watches its own document until the server completes it.
  useDocById: vi.fn<(path: string, id: string | null | undefined) => unknown>(() => ({ status: 'loading' })),
}));
vi.mock('../lib/firestore', () => ({ useCollection, useDocById }));
// #2123: "KinTale required", read raw off the settings document. The rule
// itself stays real; only the read is stubbed.
const { useKinTaleRequired } = vi.hoisted(() => ({ useKinTaleRequired: vi.fn<() => boolean | null>(() => false) }));
vi.mock('../lib/kinTaleTask', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/kinTaleTask')>()),
  useKinTaleRequired,
}));
/**
 * The writes, and the split between them is the whole point of this block.
 * `patchVisitLifecycle` is the card's own clock (through
 * `lib/useVisitLifecycle.ts`, the hook SessionDetail shares) and it writes
 * Firestore DIRECTLY, so a field tap no longer waits out a Cloud Run cold
 * start. `transitionBookingStatus` is Complete, which is terminal and billable,
 * and it still goes through the booking state machine on the server.
 */
const { patchVisitLifecycle, transitionBookingStatus } = vi.hoisted(() => ({
  patchVisitLifecycle: vi.fn(),
  transitionBookingStatus: vi.fn(),
}));
vi.mock('../api/sessionsWrite', () => ({
  patchVisitLifecycle,
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

// The browser tracker (#772) is mocked whole: `useVisitTracking` feeds the
// card's live line, and the three clock hooks must exist so an Arrived click
// does not reach jsdom's missing `navigator.geolocation`.
const { useVisitTracking } = vi.hoisted(() => ({
  useVisitTracking: vi.fn<() => import('../lib/visitTracking').VisitTrackingStatus>(() => ({ phase: 'idle' })),
}));
vi.mock('../lib/visitTracking', () => ({
  useVisitTracking,
  beginVisitTracking: vi.fn(),
  endVisitTracking: vi.fn(),
  stopVisitTracking: vi.fn(),
}));
/**
 * #1608: the operator's arrival-and-departure rule, as the board reads it.
 * Mocked at the hook so no case reaches Firestore; null (unknown) by default,
 * which is the "let the server decide" path every older case was written for.
 */
const { useArrivalRule } = vi.hoisted(() => ({ useArrivalRule: vi.fn<() => boolean | null>(() => null) }));
vi.mock('../lib/useArrivalRule', () => ({ useArrivalRule }));
// #1744: services are named from the KinCare catalog. "Long walk" runs 45
// minutes, so a stored `visit_45` reads as "Long walk".
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: { 'Long walk': '45' }, serviceDurations: { 'Long walk': '45' }, timeBlocks: [] }),
}));
import { Sessions } from './Sessions';
import { businessTodayIso, businessWallClockToMs } from '../lib/businessZoneTime';
import { shiftDayIso } from '../lib/sessionFormat';
/** The zone the mocked settings resolve to: no `timeZone` stored, so the server default. */
const CHICAGO = 'America/Chicago';
/** A wall clock in the business zone, as the UTC instant string a server writer stamps (#2036). */
function chicago(day: string, hhmm: string): string {
  return new Date(businessWallClockToMs(day, hhmm, CHICAGO) ?? Number.NaN).toISOString();
}
/** Set the Archive's two date boxes. */
function pickRange(from: string, to: string): void {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
}

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
function directory(
  households: Kinfolk[] = [],
  kin: Kin[] = [],
  olderOverdue: SessionEntry[] = [],
  kinTalesDue: SessionEntry[] = [],
) {
  useCollection.mockImplementation((spec: CollectionSpec) =>
    spec.path === 'kin'
      ? { status: 'ready', data: kin }
      : // #2123: the visits the server left owing a KinTale.
        spec.path === 'kin_care_sessions' && spec.filters?.[0]?.[0] === 'kinTaleDue'
        ? { status: 'ready', data: kinTalesDue }
        : // #1607: the overdue visits from before the board's window.
          spec.path === 'kin_care_sessions'
          ? { status: 'ready', data: olderOverdue }
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
// lib/sessionFormat.test.ts). Pinned at MODULE scope, not in beforeAll: the
// `describe` bodies below build their fixtures with `at()` while the file is
// collected, which runs before any hook. With the pin in beforeAll, a UTC
// runner built "09:00" in UTC and rendered it in Chicago as "04:00"; the Mac
// runner never showed it because its machine zone was already Chicago.
// Restored afterAll for any sibling test file sharing this worker.
const originalTz: string | undefined = process.env.TZ;
process.env.TZ = 'America/Chicago';
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const user = userEvent.setup();
/**
 * Every case mounts the board the way the router does: with an `onSelect` that
 * opens the visit's own route (#753). It is required now, because a card head
 * that opened nothing would be a dead control, so the mock stands in for the
 * navigate `routes/SessionsView.tsx` passes.
 */
const onSelect = vi.fn();
function renderBoard(props: Partial<Parameters<typeof Sessions>[0]> = {}) {
  return render(<Sessions onSelect={onSelect} {...props} />);
}

beforeEach(() => {
  onSelect.mockReset();
  useCollection.mockReset();
  useDocById.mockReset().mockReturnValue({ status: 'loading' });
  useKinTaleRequired.mockReset().mockReturnValue(false);
  directory();
  loadMore.mockReset();
  reload.mockReset();
  patchVisitLifecycle.mockReset().mockResolvedValue({
    sessionId: 'sess1',
    action: 'ARRIVED',
    from: 'SCHEDULED',
    status: 'ARRIVED',
    changed: true,
    notification: Promise.resolve({ notified: true, notifySkipped: null }),
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
    renderBoard();
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
    renderBoard();
    expect(screen.getByText('No visit is in flight.')).toBeInTheDocument();
    expect(screen.getByText('No scheduled visit has slipped past its slot.')).toBeInTheDocument();
    expect(screen.getByText('Nothing booked in the next 14 days.')).toBeInTheDocument();
    expect(screen.getByText('Nothing wrapped today or yesterday.')).toBeInTheDocument();
  });

  it('still says where the older visits went, under the empty groups rather than instead of them', () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
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
    renderBoard();
    expect(phaseCount('Active')).toBe('2');
    expect(phaseCount('Overdue')).toBe('1');
    expect(phaseCount('Upcoming')).toBe('1');
    expect(phaseCount('Recent')).toBe('1');
  });

  /**
   * #1607: Bookings marked July and August visits OVERDUE while this board's
   * Overdue showed only six from October, because the board reads a window
   * from 30 days back. The older ones arrive through their own query and land
   * in the same group, counted once.
   */
  it('Overdue also holds the scheduled visits older than the board window, once each', () => {
    const july = entry({ _id: 'jul', kinfolkName: 'Left In July', status: 'SCHEDULED', startTime: at(-120) });
    const recent = entry({ _id: 'rec', kinfolkName: 'Left Last Week', status: 'SCHEDULED', startTime: at(-7) });
    directory([], [], [july, recent]);
    usePagedCollection.mockReturnValue(paged([recent]));
    renderBoard();
    expect(phaseCount('Overdue')).toBe('2');
    expect(screen.getByText('Left In July')).toBeInTheDocument();
    const spec = useCollection.mock.calls
      .map((c) => c[0] as CollectionSpec)
      .find((c) => c.path === 'kin_care_sessions');
    expect(spec?.filters).toEqual([
      ['status', '==', 'SCHEDULED'],
      ['startTime', '<', expect.any(String)],
    ]);
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
    renderBoard();
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
    renderBoard();
    expect(screen.queryByText('Last Week')).toBeNull();
    expect(phaseCount('Recent')).toBe('0');
  });

  it('fetches a bounded date range rather than the flat latest 300', () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
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
    renderBoard();
    return screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
  }

  it('renders every line the mock draws', () => {
    const card = mount();
    // Kin photo circles, one per kin, each named for the animal it stands for
    // rather than left as a decorative blob. They stand where the status tile
    // would, so no tile is drawn beside them.
    expect(within(card).getByAltText('Biscuit')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'Gravy' })).toBeInTheDocument();
    expect(card.querySelector('.sessions__glyph')).toBeNull();
    // Kinfolk name, then the mock's ONE dim line: "service · kin names · when".
    // No service pill on it (the #755 pass): the mock writes the service as a
    // word in the sentence.
    expect(within(card).getByText('Lorna Wren')).toBeInTheDocument();
    expect(
      within(card).getByText('Dog Walk · Biscuit & Gravy · Today · 09:00 to 09:30'),
    ).toBeInTheDocument();
    expect(card.querySelector('.den-pill')).toBeNull();
    // Status pill, GPS live route, address, household note, invoice chip.
    expect(within(card).getByText('ARRIVED')).toBeInTheDocument();
    expect(within(card).getByText(/GPS tracking · live route/)).toBeInTheDocument();
    expect(within(card).getByText(/82 Creekside Ln/)).toBeInTheDocument();
    expect(within(card).getByText('Side gate, harness on the hook.')).toBeInTheDocument();
    expect(within(card).getByText('Invoice linked')).toBeInTheDocument();
    // And the ARRIVED card's own action row. The undo glyph is decorative, so
    // the accessible name is still the two words.
    expect(within(card).getByRole('button', { name: 'Departed' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Undo arrived' })).toBeInTheDocument();
  });

  it('#1744: the card line names the KinCare, never the stored key', () => {
    usePagedCollection.mockReturnValue(paged([{ ...populated, serviceType: 'visit_45' }]));
    directory(households, kin);
    renderBoard();
    const card = screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
    expect(within(card).getByText('Long walk · Biscuit & Gravy · Today · 09:00 to 09:30')).toBeInTheDocument();
    expect(within(card).queryByText(/visit_45/)).toBeNull();
  });
  it('wears the kit status pill in the state tone, not a chip of its own', () => {
    // The #755 fidelity pass: one capsule for every screen that shows a visit.
    // The tone is the mock's own per-state palette (arrived is teal), resolved
    // through the kit's `data-tone`, so this file never names a colour.
    const card = mount();
    const pill = within(card).getByText('ARRIVED');
    expect(pill.classList.contains('den-statuspill')).toBe(true);
    expect(pill.getAttribute('data-tone')).toBe('teal');
    // At the kit's compact size (#780): the mock's card-row `.pill` is 9.5px.
    expect(pill.classList.contains('den-statuspill--compact')).toBe(true);
    // The kit pill is the only capsule; the old per-state chip classes are gone.
    expect(card.querySelector('[class*="sessions__chip--"]')).toBeNull();
  });

  it('paints the address chip as a directions link, the way the kinfolk profile does', () => {
    const card = mount();
    const addr = within(card).getByRole('link', { name: /82 Creekside Ln/ });
    expect(addr.getAttribute('href')).toContain('destination=82%20Creekside%20Ln');
    expect(addr.getAttribute('target')).toBe('_blank');
    // Outside the card head button, so the two controls never nest.
    expect(addr.closest('button')).toBeNull();
  });

  it('paints "Send the KinTale" teal, the mock\'s one button that is not orange or ghost', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'gone', kinfolkName: 'Clocked Out', status: 'DEPARTED', startTime: at(0, 8) })]),
    );
    renderBoard({ onComposeKinTale: vi.fn() });
    const button = screen.getByRole('button', { name: 'Send the KinTale' });
    expect(button.classList.contains('sessions__btn--teal')).toBe(true);
    expect(button.classList.contains('auntie-btn--primary')).toBe(true);
  });

  // #772: the live line is the browser tracker's status when THIS tab clocked
  // the visit in. The mock's own line above is the idle case: the phone may be
  // the tracker, and the card does not know.
  it('names this browser as the tracker on an arrived card while its watch is on', () => {
    useVisitTracking.mockReturnValue({ phase: 'on', fixes: 4 });
    const card = mount();
    expect(within(card).getByText('Tracking on from this browser · 4 pings saved')).toBeInTheDocument();
    expect(within(card).queryByText(/GPS tracking · live route/)).toBeNull();
    useVisitTracking.mockReturnValue({ phase: 'idle' });
  });
  it('says tracking is off for the visit, and why, when this browser was denied location', () => {
    useVisitTracking.mockReturnValue({
      phase: 'off',
      reason: 'denied',
      message: 'location was denied in this browser.',
    });
    const card = mount();
    expect(
      within(card).getByText('Tracking off for this visit: location was denied in this browser.'),
    ).toBeInTheDocument();
    expect(within(card).queryByText(/live route/)).toBeNull();
    useVisitTracking.mockReturnValue({ phase: 'idle' });
  });

  it('falls back to the status glyph when no kin photo resolves, never a stock face', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SCHEDULED' })]));
    renderBoard();
    const card = screen.getByText('The Whitfields').closest('.sessions__card') as HTMLElement;
    expect(card.querySelector('.sessions__glyph')).not.toBeNull();
    expect(within(card).queryByRole('img')).toBeNull();
  });

  it('tints the status glyph tile to the state, the way the mock tints its .sicon tiles', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'omw', kinfolkName: 'Bess Sparrow', status: 'ON_MY_WAY', startTime: at(0, 10) }),
        entry({ _id: 'done', kinfolkName: 'Ada Devlin', status: 'COMPLETED', startTime: at(0, 8), completedAt: at(0, 9) }),
      ]),
    );
    renderBoard();
    const omw = screen.getByText('Bess Sparrow').closest('.sessions__card') as HTMLElement;
    const done = screen.getByText('Ada Devlin').closest('.sessions__card') as HTMLElement;
    expect(omw.querySelector('.sessions__glyph')?.getAttribute('data-tone')).toBe('orange');
    expect(done.querySelector('.sessions__glyph')?.getAttribute('data-tone')).toBe('teal');
  });

  it('leaves a cancelled pill unstruck and the name undimmed, as this mock draws them', () => {
    // SessionDetail strikes its cancelled pill; this screen's mock draws the
    // cancelled card with the plain dim capsule and the name in full cream.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'CANCELLED', startTime: at(0, 9) })]),
    );
    renderBoard();
    const card = screen.getByText('The Whitfields').closest('.sessions__card') as HTMLElement;
    const pill = within(card).getByText('CANCELLED');
    expect(pill.classList.contains('den-statuspill--struck')).toBe(false);
    expect(pill.getAttribute('data-tone')).toBe('muted');
  });

  it('omits the address line entirely when the household has none on file', () => {
    usePagedCollection.mockReturnValue(paged([populated]));
    directory([{ _id: 'kf-wren', serviceAddress: '' }], kin);
    renderBoard();
    const card = screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
    expect(card.querySelector('.sessions__addr')).toBeNull();
  });

  /** #1602: the walk's chip read "18605" and nothing said it was incomplete. */
  it('#1602: says an address is incomplete when it is only a number', () => {
    usePagedCollection.mockReturnValue(paged([populated]));
    directory([{ _id: 'kf-wren', serviceAddress: '18605' }], kin);
    renderBoard();
    const card = screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
    expect(within(card).getByText('18605', { exact: false })).toBeInTheDocument();
    expect(within(card).getByRole('note')).toHaveTextContent('This address looks incomplete');
  });

  it('#1602: gives no hint for a full address', () => {
    usePagedCollection.mockReturnValue(paged([populated]));
    directory([{ _id: 'kf-wren', serviceAddress: '82 Creekside Ln, Austin TX' }], kin);
    renderBoard();
    const card = screen.getByText('Lorna Wren').closest('.sessions__card') as HTMLElement;
    expect(within(card).queryByText(/looks incomplete/)).toBeNull();
  });

  it('claims a live GPS route only while ARRIVED, never on a departed visit', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'gone', kinfolkName: 'Clocked Out', status: 'DEPARTED', startTime: at(0, 8) })]),
    );
    renderBoard();
    expect(screen.queryByText(/GPS tracking/)).toBeNull();
  });

  it('shows no invoice chip on a visit that has not been billed', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    renderBoard();
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
    renderBoard();
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
    renderBoard();
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated SCHEDULED', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'some_new_code', startTime: at(1) })]));
    renderBoard();
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });
});

/**
 * THE LIFECYCLE BUTTONS. The board hosts writes now, and every one of them goes
 * through the same handler `SessionDetail` uses: `patchVisitLifecycle` (a direct
 * Firestore write) for the four in-visit actions, `transitionBookingStatus` (a
 * callable) for Complete. Each assertion below names the row handed to the
 * write, not just an id: deciding from the row the card is already painting is
 * what removed the read that would otherwise have replaced the cold start.
 */
describe('Auntie Time: the card runs the visit', () => {
  function mount(over: Partial<SessionEntry>) {
    usePagedCollection.mockReturnValue(paged([entry(over)]));
    renderBoard();
  }

  it('OMW on a scheduled card writes ON_MY_WAY', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await act(/^OMW$/, /yes, mark it on the way/i);
    expect(patchVisitLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'sess1' }),
      'ON_MY_WAY',
      expect.anything(),
    );
  });

  it('Arrived on a scheduled card writes ARRIVED', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await act(/^Arrived$/, /yes, clock in/i);
    expect(patchVisitLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'sess1' }),
      'ARRIVED',
      expect.anything(),
    );
  });

  it('Departed on an arrived card writes DEPARTED', async () => {
    mount({ status: 'ARRIVED', startTime: at(0, 9) });
    await act(/^Departed$/, /yes, clock out/i);
    expect(patchVisitLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'sess1' }),
      'DEPARTED',
      expect.anything(),
    );
  });

  it('Undo arrived on an arrived card writes UNDO_ARRIVAL', async () => {
    mount({ status: 'ARRIVED', startTime: at(0, 9) });
    await act(/^Undo arrived$/, /yes, undo the arrival/i);
    expect(patchVisitLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'sess1' }),
      'UNDO_ARRIVAL',
      expect.anything(),
    );
  });

  it('Complete goes through transitionBookingStatus, not the visit clock', async () => {
    mount({ status: 'ON_MY_WAY', startTime: at(0, 9) });
    await act(/^Complete$/, /yes, mark it completed/i);
    expect(transitionBookingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1', action: 'COMPLETE' }),
    );
    expect(patchVisitLifecycle).not.toHaveBeenCalled();
  });

  // #1608: the rule is checked before the confirm, not 18 s after it.
  it('says what is missing instead of asking, when the rule refuses the Complete', async () => {
    useArrivalRule.mockReturnValue(true);
    mount({ status: 'ON_MY_WAY', startTime: at(0, 9), arrivedAt: '', departedAt: '' });
    await user.click(screen.getByRole('button', { name: /^Complete$/ }));
    expect(
      await screen.findByText(/This visit has no arrival and departure recorded, and your settings require both/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yes, mark it completed/i })).not.toBeInTheDocument();
    expect(transitionBookingStatus).not.toHaveBeenCalled();
    useArrivalRule.mockReturnValue(null);
  });

  it('asks as before when the rule is off', async () => {
    useArrivalRule.mockReturnValue(false);
    mount({ status: 'ON_MY_WAY', startTime: at(0, 9), arrivedAt: '', departedAt: '' });
    await act(/^Complete$/, /yes, mark it completed/i);
    expect(transitionBookingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1', action: 'COMPLETE' }),
    );
    useArrivalRule.mockReturnValue(null);
  });

  it('asks as before when the rule is on and both steps are stamped', async () => {
    useArrivalRule.mockReturnValue(true);
    mount({
      status: 'ON_MY_WAY',
      startTime: at(0, 9),
      arrivedAt: at(0, 9, 5),
      departedAt: at(0, 9, 35),
    });
    await act(/^Complete$/, /yes, mark it completed/i);
    expect(transitionBookingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess1', action: 'COMPLETE' }),
    );
    useArrivalRule.mockReturnValue(null);
  });

  it('refreshes the page after a write that changed the document, so the card stops lying', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await act(/^Arrived$/, /yes, clock in/i);
    expect(reload).toHaveBeenCalled();
  });

  it('surfaces a refusal beside the card rather than swallowing it', async () => {
    patchVisitLifecycle.mockRejectedValue(new Error('Already departed.'));
    mount({ status: 'ARRIVED', startTime: at(0, 9) });
    await act(/^Departed$/, /yes, clock out/i);
    expect(await screen.findByText(/Already departed\./)).toBeInTheDocument();
  });

  it('writes nothing when the confirm is dismissed', async () => {
    mount({ status: 'SCHEDULED', startTime: at(1) });
    await user.click(screen.getByRole('button', { name: /^Arrived$/ }));
    await user.click(screen.getByRole('button', { name: /not yet/i }));
    expect(patchVisitLifecycle).not.toHaveBeenCalled();
  });

  it('offers "Send the KinTale" on a departed card and routes it to the composer', async () => {
    const onComposeKinTale = vi.fn();
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'sess-dep', status: 'DEPARTED', startTime: at(0, 8) })]),
    );
    renderBoard({ onComposeKinTale });
    await user.click(screen.getByRole('button', { name: 'Send the KinTale' }));
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
          sentReportCount: 1,
        }),
      ]),
    );
    renderBoard({ onViewKinTale });
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
    renderBoard({ onViewKinTale: vi.fn() });
    expect(screen.queryByRole('button', { name: 'View KinTale' })).toBeNull();
  });

  // #2123 (operator ruling 2026-11-12): a visit is Completed at departure, and a
  // KinTale never decides it. Replaces #1793's "Complete once the tale is sent".
  describe('#2123: departure completes, the KinTale is its own step', () => {
    const departed = {
      _id: 'sess-dep',
      status: 'DEPARTED',
      startTime: at(0, 8),
      arrivedAt: at(0, 8, 2),
      departedAt: at(0, 8, 47),
    } satisfies Partial<SessionEntry>;

    it('a departed card with no KinTale offers Complete and Send the KinTale', async () => {
      usePagedCollection.mockReturnValue(paged([entry(departed)]));
      renderBoard({ onComposeKinTale: vi.fn(), onViewKinTale: vi.fn() });
      expect(screen.getByRole('button', { name: 'Send the KinTale' })).toBeInTheDocument();
      await act(/^Complete$/, /yes, mark it completed/i);
      expect(transitionBookingStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-dep', action: 'COMPLETE' }),
      );
      expect(reload).toHaveBeenCalled();
    });

    it('a refused Complete on a departed card shows the reason and keeps the card', async () => {
      transitionBookingStatus.mockRejectedValue(new Error('The arrival was recorded 900 m from the household.'));
      usePagedCollection.mockReturnValue(paged([entry(departed)]));
      renderBoard({ onComposeKinTale: vi.fn() });
      await act(/^Complete$/, /yes, mark it completed/i);
      expect(
        await screen.findByText(/couldn.t complete this visit\. The arrival was recorded 900 m from the household\./i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send the KinTale' })).toBeInTheDocument();
    });

    it('a departed card re-reads the board once the server has completed the visit', () => {
      useDocById.mockImplementation((_path: string, id: string | null | undefined) =>
        id === 'sess-dep' ? { status: 'ready', data: { ...entry(departed), status: 'COMPLETED' } } : { status: 'loading' },
      );
      usePagedCollection.mockReturnValue(paged([entry(departed)]));
      renderBoard({ onComposeKinTale: vi.fn() });
      expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 'sess-dep');
      expect(reload).toHaveBeenCalled();
    });

    it('a departed card the server has not moved yet does not re-read', () => {
      useDocById.mockReturnValue({ status: 'ready', data: entry(departed) });
      usePagedCollection.mockReturnValue(paged([entry(departed)]));
      renderBoard({ onComposeKinTale: vi.fn() });
      expect(reload).not.toHaveBeenCalled();
    });

    it('only a departed card watches its document', () => {
      usePagedCollection.mockReturnValue(paged([entry({ _id: 'sched', status: 'SCHEDULED', startTime: at(1) })]));
      renderBoard();
      expect(useDocById.mock.calls.every(([, id]) => id === null)).toBe(true);
    });

    it('a completed card with no KinTale sent offers Send the KinTale, required or not', async () => {
      const onComposeKinTale = vi.fn();
      usePagedCollection.mockReturnValue(
        paged([entry({ ...departed, status: 'COMPLETED', completedAt: at(0, 9) })]),
      );
      renderBoard({ onComposeKinTale, onViewKinTale: vi.fn() });
      await user.click(screen.getByRole('button', { name: 'Send the KinTale' }));
      expect(onComposeKinTale).toHaveBeenCalledWith('sess-dep');
      expect(screen.queryByRole('button', { name: /^Complete$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'View KinTale' })).toBeNull();
    });

    it('a draft listed on reportIds is not a sent KinTale', () => {
      usePagedCollection.mockReturnValue(
        paged([entry({ ...departed, status: 'COMPLETED', completedAt: at(0, 9), reportIds: ['draft-1'] })]),
      );
      renderBoard({ onComposeKinTale: vi.fn(), onViewKinTale: vi.fn() });
      expect(screen.getByRole('button', { name: 'Send the KinTale' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'View KinTale' })).toBeNull();
    });

    it('once sent, a departed or completed card offers View KinTale instead', async () => {
      const onViewKinTale = vi.fn();
      usePagedCollection.mockReturnValue(
        paged([entry({ ...departed, reportIds: ['rep-1'], sentReportCount: 1 })]),
      );
      renderBoard({ onComposeKinTale: vi.fn(), onViewKinTale });
      expect(screen.queryByRole('button', { name: 'Send the KinTale' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'View KinTale' }));
      expect(onViewKinTale).toHaveBeenCalledWith('rep-1');
    });

    it('an arrived card offers no Complete until she departs, KinTale or not', () => {
      usePagedCollection.mockReturnValue(
        paged([entry({ ...departed, status: 'ARRIVED', departedAt: '', sentReportCount: 1, reportIds: ['rep-1'] })]),
      );
      renderBoard({ onComposeKinTale: vi.fn(), onViewKinTale: vi.fn() });
      expect(screen.queryByRole('button', { name: /^Complete$/ })).toBeNull();
      expect(screen.getByRole('button', { name: /^Departed$/ })).toBeInTheDocument();
    });

    it('the clock-out confirm says the visit is marked Completed', async () => {
      usePagedCollection.mockReturnValue(
        paged([entry({ ...departed, status: 'ARRIVED', departedAt: '' })]),
      );
      renderBoard();
      await user.click(screen.getByRole('button', { name: /^Departed$/ }));
      expect(
        screen.getByText('The departure time is stamped now and the visit is marked Completed.', { exact: false }),
      ).toBeInTheDocument();
    });
  });

  // #2123: "KinTale required" on. The Auntie's task, until the KinTale is sent.
  describe('#2123: KinTales to send', () => {
    const owed = (id: string, extra: Partial<SessionEntry> = {}) =>
      entry({
        _id: id,
        kinfolkName: `Household ${id}`,
        status: 'COMPLETED',
        startTime: at(0, 8),
        completedAt: at(0, 9),
        kinTaleDue: true,
        ...extra,
      });

    it('with the switch on, an owed visit is listed under KinTales to send and not again in Recent', () => {
      useKinTaleRequired.mockReturnValue(true);
      usePagedCollection.mockReturnValue(paged([owed('o1'), entry({ _id: 'done', status: 'COMPLETED', startTime: at(0, 7), completedAt: at(0, 7, 30), sentReportCount: 1, reportIds: ['r'] })]));
      renderBoard({ onComposeKinTale: vi.fn(), onViewKinTale: vi.fn() });
      expect(phaseHeadings()[0]).toBe('KinTales to send');
      expect(phaseCount('KinTales to send')).toBe('1');
      expect(phaseCount('Recent')).toBe('1');
      expect(screen.getAllByText('Household o1')).toHaveLength(1);
    });

    it('reaches owed visits older than the board, and opens the composer from the task', async () => {
      useKinTaleRequired.mockReturnValue(true);
      directory([], [], [], [owed('old', { startTime: at(-20, 8), completedAt: at(-20, 9) })]);
      const onComposeKinTale = vi.fn();
      usePagedCollection.mockReturnValue(paged([]));
      renderBoard({ onComposeKinTale });
      expect(phaseCount('KinTales to send')).toBe('1');
      const group = screen.getByRole('heading', { level: 3, name: /^KinTales to send/ }).closest('li') as HTMLElement;
      await user.click(within(group).getByRole('button', { name: 'Send the KinTale' }));
      expect(onComposeKinTale).toHaveBeenCalledWith('old');
    });

    it('a sent KinTale leaves the list even before the server flag is cleared', () => {
      useKinTaleRequired.mockReturnValue(true);
      directory([], [], [], [owed('sent', { sentReportCount: 1, reportIds: ['r1'] })]);
      usePagedCollection.mockReturnValue(paged([]));
      renderBoard();
      expect(phaseCount('KinTales to send')).toBe('0');
      expect(screen.getByText('No KinTale is waiting to be sent.')).toBeInTheDocument();
    });

    it('a failed read of older owed visits says so, keeps the board rows and offers a retry', async () => {
      useKinTaleRequired.mockReturnValue(true);
      const retry = vi.fn();
      useCollection.mockImplementation((spec: CollectionSpec) =>
        spec.path === 'kin_care_sessions' && spec.filters?.[0]?.[0] === 'kinTaleDue'
          ? { status: 'error', message: 'permission-denied', retry }
          : { status: 'ready', data: [] },
      );
      usePagedCollection.mockReturnValue(paged([owed('o1')]));
      renderBoard({ onComposeKinTale: vi.fn() });
      expect(screen.getByText(/couldn.t load older kintales to send\. permission-denied/i)).toBeInTheDocument();
      expect(phaseCount('KinTales to send')).toBe('1');
      expect(screen.queryByText('No KinTale is waiting to be sent.')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(retry).toHaveBeenCalledOnce();
    });

    it('with the switch off there is no group, and the visit stays in Recent with its button', () => {
      useKinTaleRequired.mockReturnValue(false);
      usePagedCollection.mockReturnValue(paged([owed('o1')]));
      renderBoard({ onComposeKinTale: vi.fn() });
      expect(phaseHeadings()).not.toContain('KinTales to send');
      expect(phaseCount('Recent')).toBe('1');
      expect(screen.getByRole('button', { name: 'Send the KinTale' })).toBeInTheDocument();
    });

    it('while the switch is still loading, or could not be read, there is no group', () => {
      useKinTaleRequired.mockReturnValue(null);
      usePagedCollection.mockReturnValue(paged([owed('o1')]));
      renderBoard();
      expect(phaseHeadings()).not.toContain('KinTales to send');
    });
  });

  it('offers no clock action at all on a cancelled card', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'CANCELLED', startTime: at(0, 9) })]),
    );
    renderBoard();
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
    renderBoard();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('has no Sort select', () => {
    renderBoard();
    expect(screen.queryByLabelText('Sort')).toBeNull();
  });

  it('has no stat strip and no "counts cover N visits" line', () => {
    renderBoard();
    expect(screen.queryByText('In flight')).toBeNull();
    expect(screen.queryByText('Wrapped today')).toBeNull();
    expect(screen.queryByText(/These counts cover/)).toBeNull();
  });

  it('keeps Archive as a single link in the heading', () => {
    renderBoard();
    const archive = screen.getByRole('button', { name: 'Archive' });
    expect(archive.closest('.den-heading')).not.toBeNull();
  });
});

/**
 * THE #755 FIDELITY PASS: what the mock draws around the cards. Its heading is
 * "🐾 Auntie Time" with no italic accent (the Directory mock marks its last
 * word up; this one does not).
 */
describe('Auntie Time: the frame the mock draws', () => {
  it('titles the page the way the mock does, paw first and no accent tail', () => {
    renderBoard();
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.textContent).toBe('🐾 Auntie Time');
    expect(title.querySelector('.den-heading-accent')).toBeNull();
  });

  it('puts no entrance transform on a phase group, so a card dialog can still centre on the viewport', () => {
    // base.css's `d1`..`d4` fill `both` and leave `transform` pinned; a
    // transformed group would become the containing block of the fixed
    // `Dialog` every lifecycle button opens from inside its card.
    renderBoard();
    for (const phase of ['active', 'overdue', 'upcoming', 'recent']) {
      const group = document.querySelector(`.sessions__phase--${phase}`) as HTMLElement;
      expect([...group.classList].some((c) => /^d[1-4]$/.test(c))).toBe(false);
    }
  });
});

/**
 * #753 MOVED THE DETAIL OUT OF THIS SCREEN. A card head asks to open a visit and
 * nothing more; what that opens is `/sessions/{id}`, which
 * `routes/SessionDetailView.test.tsx` drives. So the cases here are about the
 * REQUEST, and about the one press that must not make it.
 */
describe('Auntie Time: opening one visit', () => {
  it('clicking a card asks for that session id, so the route is the only way in', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'sess-42' })]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelect).toHaveBeenCalledWith('sess-42');
  });
  it('renders no detail of its own, whatever is clicked', async () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    // The board is still the board: no Back control, no detail trail, and the
    // four phase groups still standing.
    expect(screen.queryByRole('button', { name: /back to auntie time/i })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(phaseHeadings()).toEqual(['Active', 'Overdue', 'Upcoming', 'Recent']);
  });
  it('the lifecycle buttons do NOT ask to open the visit, so a clock press cannot lose the board', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'SCHEDULED', startTime: at(1) })]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: /^OMW$/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Auntie Time: reads that fail', () => {
  it('surfaces a read error, never a false empty', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'permission-denied' } }),
    );
    renderBoard();
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
    renderBoard();
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('makes no board claim at all while the first page is in flight', () => {
    usePagedCollection.mockReturnValue(paged([], { state: { status: 'loading' } }));
    renderBoard();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(phaseHeadings()).toHaveLength(0);
  });
});

describe('Auntie Time: the Archive', () => {
  it('swaps in a date-ranged PAGED query over the operator-chosen range', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const spec = lastSpec();
    expect(spec.pageSize).toBe(100);
    expect(spec.filters).toHaveLength(2);
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('opens on the 30 business days that end where Recent stops (#2036)', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const today = businessTodayIso(CHICAGO);
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe(shiftDayIso(today, -2));
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe(shiftDayIso(today, -31));
  });
  it('shows a visit from 10 days ago without touching the dates (#2036)', async () => {
    const day = shiftDayIso(businessTodayIso(CHICAGO), -10);
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'ten',
          kinfolkName: 'Ten Days Back',
          status: 'COMPLETED',
          startTime: chicago(day, '18:30'),
          completedAt: chicago(day, '19:05'),
        }),
      ]),
    );
    renderBoard();
    expect(screen.queryByText('Ten Days Back')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Ten Days Back')).toBeInTheDocument();
  });
  it('asks for a day wider than the boxes on each side, never the bare picked days (#2036)', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    pickRange('2025-11-10', '2025-11-11');
    expect(lastSpec().filters).toEqual([
      ['startTime', '>=', '2025-11-09'],
      ['startTime', '<', '2025-11-13'],
    ]);
  });
  it('counts FROM and TO as whole business days: 23:30 on the TO day is in, 00:15 after it is out (#2036)', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'eve', kinfolkName: 'Evening Before', startTime: chicago('2025-11-09', '22:32') }),
        entry({ _id: 'first', kinfolkName: 'First Minute', startTime: chicago('2025-11-10', '00:00') }),
        entry({ _id: 'late', kinfolkName: 'Late Visit', startTime: chicago('2025-11-11', '23:30') }),
        entry({ _id: 'bare', kinfolkName: 'Bare Clock', startTime: '2025-11-11T21:00' }),
        entry({ _id: 'next', kinfolkName: 'Next Day', startTime: chicago('2025-11-12', '00:15') }),
      ]),
    );
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    pickRange('2025-11-10', '2025-11-11');
    expect(screen.getByText('First Minute')).toBeInTheDocument();
    expect(screen.getByText('Late Visit')).toBeInTheDocument();
    expect(screen.getByText('Bare Clock')).toBeInTheDocument();
    expect(screen.queryByText('Evening Before')).toBeNull();
    expect(screen.queryByText('Next Day')).toBeNull();
    // The 23:30 visit sits under Nov 11, the business day it happened on, not
    // under the Nov 12 its UTC instant falls on.
    const headers = [...document.querySelectorAll('.sessions__day-header')];
    const nov11 = headers.find((h) => /Nov 11/.test(h.textContent ?? ''));
    expect(nov11).toBeDefined();
    expect(within(nov11!.closest('.sessions__day-group') as HTMLElement).getByText('Late Visit')).toBeInTheDocument();
    expect(headers.some((h) => /Nov 12/.test(h.textContent ?? ''))).toBe(false);
  });
  it('says the range is empty when the fetch brought back only rows from outside it (#2036)', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'next', kinfolkName: 'Next Day', startTime: chicago('2025-11-12', '00:15') })]),
    );
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    pickRange('2025-11-10', '2025-11-11');
    expect(screen.getByText('No KinCares in this range.')).toBeInTheDocument();
    expect(screen.queryByText('Next Day')).toBeNull();
  });
  it('keeps the clock buttons on an old unfinished visit, as before (#2036)', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'open', kinfolkName: 'Still Open', status: 'SCHEDULED', startTime: chicago('2025-11-10', '09:00') })]),
    );
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    pickRange('2025-11-10', '2025-11-11');
    const card = screen.getByText('Still Open').closest('li') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'OMW' })).toBeInTheDocument();
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
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: `${lastYear}-01-01` } });
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
    renderBoard();
    expect(screen.queryByText('Old News')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: shiftDayIso(businessTodayIso(CHICAGO), -200) } });
    expect(screen.getByText('Old News')).toBeInTheDocument();
  });

  it('goes back to the board, restoring the four groups', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(phaseHeadings()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /back to auntie time/i }));
    expect(phaseHeadings()).toEqual(['Active', 'Overdue', 'Upcoming', 'Recent']);
  });

  it('shows the ordinary empty state in the Archive, where there is no board to count', async () => {
    usePagedCollection.mockReturnValue(paged([]));
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('No KinCares in this range.')).toBeInTheDocument();
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
    const { unmount } = renderBoard();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    unmount();
    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    renderBoard();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('asks the hook for the next page, and never re-implements the cursor itself', async () => {
    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it('blocks a second request while one is in flight, and says it is working', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], { hasMore: true, more: { status: 'loading' } }),
    );
    renderBoard();
    expect(screen.getByRole('button', { name: 'Loading more…' })).toBeDisabled();
  });

  it('pages in the Archive too, not only on the board', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'old', startTime: at(-120), status: 'COMPLETED', completedAt: at(-120, 14) })], {
        hasMore: true,
      }),
    );
    renderBoard();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: shiftDayIso(businessTodayIso(CHICAGO), -200) } });
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
    renderBoard();
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
    renderBoard();
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
    renderBoard();
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
    renderBoard();
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
    renderBoard();
    expect(screen.getByText('Still Here')).toBeInTheDocument();
    expect(document.querySelectorAll('.sessions__card')).toHaveLength(1);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load more KinCare sessions. deadline-exceeded');
    expect(alert).toHaveTextContent('The 1 already loaded are unaffected');
    expect(screen.queryByText('KinCare sessions unavailable while the load is failing.')).toBeNull();
  });

  it('retries the failed page from where it stopped, not from the top', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    renderBoard();
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: /retry/i }));
    expect(loadMore).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
