// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type SessionEntry } from '../api/sessions';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { Sessions } from './Sessions';

function entry(over: Partial<SessionEntry>): SessionEntry {
  return {
    _id: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: [],
    serviceType: 'Dog Walk',
    startTime: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    endTime: '2026-07-16T15:00:00.000Z',
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

/**
 * Only the two tests that actually assert against "today" fake the system
 * clock, fake timers and userEvent's own internal setTimeout-based delays
 * don't mix reliably, so every OTHER test (including all click-driven ones)
 * runs on the real clock, same as Invoices.test.tsx/Directory.test.tsx.
 */
function withFixedToday(run: () => void): void {
  vi.useFakeTimers();
  try {
    // Fixed LOCAL "now" (constructed via local ctor args, so it means the same
    // wall-clock instant regardless of the runner's real-world date).
    vi.setSystemTime(new Date(2026, 6, 16, 12, 0, 0));
    run();
  } finally {
    vi.useRealTimers();
  }
}

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
    withFixedToday(() => {
      // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC
      // instant (approveBookingSeriesCore.ts's toDate().toISOString() writer path).
      useCollection.mockReturnValue({
        status: 'ready',
        data: [entry({ startTime: '2026-07-17T01:00:00.000Z', endTime: '2026-07-17T02:30:00.000Z' })],
      });
      render(<Sessions />);
      // "Today" per the fixed system clock (2026-07-16 local), not "Tomorrow",
      // which is what grouping by a raw slice of the UTC string ("2026-07-17")
      // would have wrongly produced. Scoped to the day-header specifically:
      // the "Today" StatCard label is also on the page and would otherwise
      // make this an ambiguous match.
      expect(screen.getByText('Today', { selector: '.sessions__day-header' })).toBeInTheDocument();
      expect(screen.queryByText('Tomorrow', { selector: '.sessions__day-header' })).toBeNull();
    });
  });

  it('shows the local clock time in the row, not the UTC hour', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ startTime: '2026-07-17T01:00:00.000Z', endTime: '2026-07-17T02:30:00.000Z' })],
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
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status })] });
    render(<Sessions />);
    expect(screen.getByText(chip)).toBeInTheDocument();
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated SCHEDULED', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'some_new_code' })] });
    render(<Sessions />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<Sessions />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/nothing on the books yet/i)).toBeNull();
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
    expect(screen.getByText(/nothing on the books yet/i)).toBeInTheDocument();
  });

  it('filter tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', kinfolkName: 'Household A', status: 'CANCELLED' }),
        entry({ _id: 'b', kinfolkName: 'Household B', status: 'SCHEDULED' }),
      ],
    });
    render(<Sessions />);
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.getByText('Household B')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(screen.getByText('Household A')).toBeInTheDocument();
    expect(screen.queryByText('Household B')).toBeNull();
  });

  it('shows a "nothing matches" hint (not the top-level empty state) when a filter excludes every row', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ status: 'SCHEDULED' })] });
    render(<Sessions />);
    await user.click(screen.getByRole('tab', { name: 'Cancelled' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing on the books yet/i)).toBeNull();
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
    // The list-only STATIC-row behavior this used to assert is now inverted:
    // the detail view it opens has shipped.
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
    withFixedToday(() => {
      useCollection.mockReturnValue({
        status: 'ready',
        data: [
          // 13:00 local (America/Chicago, CDT) on the fixed "today".
          entry({ _id: 'a', status: 'COMPLETED', completedAt: '2026-07-16T18:00:00.000Z' }),
          entry({ _id: 'b', status: 'COMPLETED', completedAt: '2026-06-01T18:00:00.000Z' }),
        ],
      });
      render(<Sessions />);
      const card = screen.getByText('Wrapped today').closest('.den-stat, button.den-stat--button');
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText('1')).toBeInTheDocument();
    });
  });
});
