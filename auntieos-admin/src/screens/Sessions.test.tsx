// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type SessionEntry } from '../api/sessions';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { Sessions } from './Sessions';

/**
 * Local wall-clock time [offset] days from today, as the UTC instant string a
 * real writer stamps (`approveBookingSeriesCore.ts`'s
 * `toDate().toISOString()`).
 *
 * Fixtures are RELATIVE rather than absolute now that the screen scopes itself
 * to a window around today (operator issue #17): a hardcoded 2026-07-16 would
 * quietly fall out of that window and every assertion here would rot. The
 * alternative, faking the system clock for the whole file, is what the original
 * comment here ruled out, since fake timers and userEvent's own setTimeout
 * delays do not mix. Relative fixtures need neither.
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

// TZ pinned to a west-of-UTC zone so the AO-18 day-grouping assertions below
// are meaningful on any CI runner (see the identical rationale in
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
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<SessionEntry[]>);
});

describe('Sessions screen', () => {
  it('renders a streamed row with its household, service, time window, and status chip', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Sessions />);
    // Scope by the row container: the household name also seeds the row button's
    // accessible name, so scoping keeps these assertions on the row's own cells.
    const row = screen.getByText('The Whitfields').closest('.sessions__row') as HTMLElement;
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    expect(within(row).getByText('Dog Walk')).toBeInTheDocument();
    expect(within(row).getByText('SCHEDULED')).toBeInTheDocument();
  });

  it('groups a late-evening local session under its LOCAL day, not the UTC-next day (AO-18)', () => {
    // 20:00 America/Chicago today round-trips as tomorrow's UTC date, which is
    // what grouping by a raw slice of the string would have wrongly used.
    const eveningToday = at(0, 20);
    expect(eveningToday.slice(0, 10)).not.toBe(at(0, 12).slice(0, 10));
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ startTime: eveningToday, endTime: at(0, 21, 30) })],
    });
    render(<Sessions />);
    // Scoped to the day-header specifically: the "Today" StatCard label is also
    // on the page and would otherwise make this an ambiguous match.
    expect(screen.getByText('Today', { selector: '.sessions__day-header' })).toBeInTheDocument();
    expect(screen.queryByText('Tomorrow', { selector: '.sessions__day-header' })).toBeNull();
  });

  it('shows the local clock time in the row, not the UTC hour', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ startTime: at(0, 20), endTime: at(0, 21, 30) })],
    });
    render(<Sessions />);
    expect(screen.getByText('20:00 to 21:30')).toBeInTheDocument();
  });

  it.each([
    ['SCHEDULED', 'SCHEDULED'],
    ['ON_MY_WAY', 'ON THE WAY'],
    ['ARRIVED', 'ARRIVED'],
    ['DEPARTED', 'DEPARTED'],
    ['COMPLETED', 'COMPLETED'],
    ['CANCELLED', 'CANCELLED'],
  ])('renders the %s status positively as its own chip', (status, chip) => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status, startTime: at(0, 9), completedAt: at(0, 10) })],
    });
    render(<Sessions />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated SCHEDULED', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: 'some_new_code', startTime: at(1) })],
    });
    render(<Sessions />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<Sessions />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/nothing on the books/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<Sessions />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Sessions />);
    expect(screen.getByText(/nothing on the books in this window/i)).toBeInTheDocument();
  });

  it('filter tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'CANCELLED', startTime: at(0, 9) }),
        entry({ _id: 'b', kinfolkName: 'Household B', status: 'SCHEDULED', startTime: at(1) }),
      ],
    });
    render(<Sessions />);
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.getByText('Household B')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.queryByText('Household B')).toBeNull();
  });

  it('shows a "nothing matches" hint (not the window empty state) when a filter excludes every row', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'SCHEDULED' })] });
    render(<Sessions />);
    await user.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing on the books in this window/i)).toBeNull();
  });

  it('clicking a row calls onSelect with the session id', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'sess-42' })] });
    const onSelect = vi.fn();
    render(<Sessions onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(onSelect).toHaveBeenCalledWith('sess-42');
  });

  it('propless, a row is now interactive and opens the in-screen SessionDetail view', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Sessions />);
    // No external onSelect: the row is a real <button> that opens SessionDetail
    // (fed from this same stream, no second fetch), NOT a static dead control.
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    // The detail view has taken over the screen (Directory/KinfolkProfile
    // pattern): its Back control is present, and the household is its heading.
    expect(screen.getByRole('button', { name: /back to auntie time/i })).toBeInTheDocument();
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
  });

  it('the "In flight" stat counts only the three active states', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'ON_MY_WAY' }),
        entry({ _id: 'b', status: 'ARRIVED' }),
        entry({ _id: 'c', status: 'SCHEDULED' }),
      ],
    });
    render(<Sessions />);
    const card = screen.getByText('In flight').closest('.den-stat, button.den-stat--button');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('the "Wrapped today" stat counts only sessions completed on the local today', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', status: 'COMPLETED', completedAt: at(0, 13) }),
        entry({ _id: 'b', status: 'COMPLETED', completedAt: at(-45, 13) }),
      ],
    });
    render(<Sessions />);
    const card = screen.getByText('Wrapped today').closest('.den-stat, button.den-stat--button');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});

/**
 * OPERATOR ISSUE #17. The sub-header promised "today and coming up, plus what
 * wrapped recently" while the screen streamed a flat 300 rows with no date
 * predicate. These cases assert the rendered list now matches that copy.
 */
describe('Sessions screen: the Auntie Time window', () => {
  const windowFixture = [
    entry({ _id: 'active', kinfolkName: 'In Flight', status: 'ARRIVED', startTime: at(0, 9) }),
    entry({ _id: 'tomorrow', kinfolkName: 'Next Up', status: 'SCHEDULED', startTime: at(1) }),
    entry({
      _id: 'threeDaysAgo',
      kinfolkName: 'Just Wrapped',
      status: 'COMPLETED',
      startTime: at(-3),
      completedAt: at(-3, 14),
    }),
    entry({
      _id: 'thirtyDaysAgo',
      kinfolkName: 'Old News',
      status: 'COMPLETED',
      startTime: at(-30),
      completedAt: at(-30, 14),
    }),
  ];

  it('fetches a bounded date range rather than the flat latest 300', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Sessions />);
    const spec = useCollection.mock.calls[0]![0] as {
      max: number;
      filters?: [string, string, unknown][];
    };
    expect(spec.max).toBe(300);
    expect(spec.filters?.map((f) => [f[0], f[1]])).toEqual([
      ['startTime', '>='],
      ['startTime', '<='],
    ]);
  });

  it('renders the three phase headings, and no fourth', () => {
    useCollection.mockReturnValue({ status: 'ready', data: windowFixture });
    render(<Sessions />);
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent?.replace(/\d+$/, '').trim());
    expect(headings).toEqual(['Active', 'Upcoming', 'Recent']);
  });

  it('sorts the in-flight visit, tomorrow, and the recent wrap into their own phases', () => {
    useCollection.mockReturnValue({ status: 'ready', data: windowFixture });
    render(<Sessions />);
    const phaseOf = (name: string) =>
      screen.getByText(name).closest('.sessions__phase')?.className;
    expect(phaseOf('In Flight')).toContain('sessions__phase--active');
    expect(phaseOf('Next Up')).toContain('sessions__phase--upcoming');
    expect(phaseOf('Just Wrapped')).toContain('sessions__phase--recent');
  });

  it('leaves a wrap from thirty days ago out of the default window', () => {
    useCollection.mockReturnValue({ status: 'ready', data: windowFixture });
    render(<Sessions />);
    expect(screen.queryByText('Old News')).toBeNull();
  });

  it('says where the older visits went, rather than just showing fewer rows', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Sessions />);
    expect(screen.getByText(/older visits are in the archive/i)).toBeInTheDocument();
  });
});

describe('Sessions screen: the sort control', () => {
  const twoDays = [
    entry({ _id: 'a', kinfolkName: 'First Up', status: 'SCHEDULED', startTime: at(1, 9) }),
    entry({ _id: 'b', kinfolkName: 'Later Same Day', status: 'SCHEDULED', startTime: at(1, 15) }),
    entry({ _id: 'c', kinfolkName: 'Day After', status: 'SCHEDULED', startTime: at(2, 9) }),
  ];

  function renderedOrder(): string[] {
    return Array.from(document.querySelectorAll('.sessions__row-name')).map(
      (n) => n.textContent ?? '',
    );
  }

  it('defaults to soonest first', () => {
    useCollection.mockReturnValue({ status: 'ready', data: twoDays });
    render(<Sessions />);
    expect(screen.getByLabelText('Sort')).toHaveValue('soonest');
    expect(renderedOrder()).toEqual(['First Up', 'Later Same Day', 'Day After']);
  });

  it('latest first reverses the order within the phase', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: twoDays });
    render(<Sessions />);
    await user.selectOptions(screen.getByLabelText('Sort'), 'latest');
    expect(renderedOrder()).toEqual(['Day After', 'Later Same Day', 'First Up']);
  });

  it('reverses within a phase without reordering the phases themselves', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'In Flight', status: 'ARRIVED', startTime: at(0, 9) }),
        entry({ _id: 'b', kinfolkName: 'Next Up', status: 'SCHEDULED', startTime: at(1) }),
      ],
    });
    render(<Sessions />);
    await user.selectOptions(screen.getByLabelText('Sort'), 'latest');
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent?.replace(/\d+$/, '').trim());
    expect(headings).toEqual(['Active', 'Upcoming']);
  });
});

describe('Sessions screen: the Archive', () => {
  it('swaps in a date-ranged query over the operator-chosen range', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    const spec = useCollection.mock.calls.at(-1)![0] as {
      max: number;
      filters?: [string, string, unknown][];
    };
    expect(spec.max).toBe(300);
    expect(spec.filters).toHaveLength(2);
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('defaults to the range just BEFORE the day-of window, so it never re-shows the same rows', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const from = (screen.getByLabelText('From') as HTMLInputElement).value;
    const to = (screen.getByLabelText('To') as HTMLInputElement).value;
    expect(from < to).toBe(true);
    // The window fetches back 30 days; the archive starts where that stops.
    expect(new Date(`${to}T12:00:00`).getTime()).toBeLessThan(Date.now());
  });

  it('shows the YEAR on a day header outside the current year', async () => {
    // The whole point of the Archive is reaching past the window, which is
    // where an undated "Thu, Jan 16" becomes ambiguous (operator issue #17).
    const lastYear = new Date().getFullYear() - 1;
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({
          _id: 'old',
          kinfolkName: 'Long Ago',
          status: 'COMPLETED',
          startTime: `${lastYear}-01-16T18:00:00.000Z`,
          completedAt: `${lastYear}-01-16T19:00:00.000Z`,
        }),
      ],
    });
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText(`Thu, Jan 16, ${lastYear}`, { selector: '.sessions__day-header' })).toBeInTheDocument();
    expect(screen.getByText('Long Ago')).toBeInTheDocument();
  });

  it('drops the window rules in the Archive: an old wrap renders instead of vanishing', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({
          _id: 'old',
          kinfolkName: 'Old News',
          status: 'COMPLETED',
          startTime: at(-120),
          completedAt: at(-120, 14),
        }),
      ],
    });
    render(<Sessions />);
    expect(screen.queryByText('Old News')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Old News')).toBeInTheDocument();
  });

  it('goes back to the day-of view, restoring the stat row', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Sessions />);
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.queryByText('In flight')).toBeNull();
    await user.click(screen.getByRole('button', { name: /back to auntie time/i }));
    expect(screen.getByText('In flight')).toBeInTheDocument();
  });
});
