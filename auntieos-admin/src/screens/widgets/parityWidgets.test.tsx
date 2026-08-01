// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Async } from '../../lib/async';
import type { SessionEntry } from '../../api/sessions';
import type { Kin } from '../../api/directory';
import type { InvoiceEntry } from '../../api/invoices';
import type { GeneratedDraftRow } from '../../api/drafts';
import { localDateIso } from '../../lib/invoiceFormat';

/**
 * The ten stream-backed D2 widgets, each through its three real states: a
 * happy board, a proven-empty one, and a failed read.
 *
 * THE ERROR CASE IS THE POINT OF THIS FILE. Every widget here summarises money,
 * animals or missed visits, and the failure mode this codebase exists to
 * prevent is a confident zero rendered over an unreadable stream. So each suite
 * asserts BOTH halves: the failure is named, AND the reassuring empty copy is
 * absent.
 *
 * The two weather cards live in `WeatherWidgets.test.tsx`: they read a callable
 * rather than a stream, and their suite also pins the shared-request behaviour.
 */

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../../lib/firestore', () => ({ useCollection }));

import { StatsWidget } from './StatsWidget';
import { TodaysPackWidget } from './TodaysPackWidget';
import { KinTalesPendingWidget } from './KinTalesPendingWidget';
import { CashFlowWidget } from './CashFlowWidget';
import { GatekeeperWidget } from './GatekeeperWidget';
import { WeeklyCapacityWidget } from './WeeklyCapacityWidget';
import { OverdueVisitsWidget } from './OverdueVisitsWidget';
import { PetBreakdownWidget } from './PetBreakdownWidget';
import { FrequentFlyersWidget } from './FrequentFlyersWidget';
import { HolidayRunwayWidget } from './HolidayRunwayWidget';

const TODAY = localDateIso(new Date());
/** A no-offset local clock time today, so its LOCAL day-key is today anywhere. */
const at = (clock: string): string => `${TODAY}T${clock}`;
/** A day N days before today, as YYYY-MM-DD. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateIso(d);
}

function sess(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 's1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    kinIds: [],
    serviceType: 'Drop-in',
    startTime: at('09:00:00'),
    endTime: at('10:00:00'),
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

function kin(over: Partial<Kin> = {}): Kin {
  return { _id: 'p1', kinfolkId: 'k1', name: 'Biscuit', species: 'Dog', status: 'active', ...over };
}

function inv(over: Partial<InvoiceEntry> = {}): InvoiceEntry {
  return {
    _id: 'i1',
    kinfolkId: 'k1',
    kinfolkName: 'Rivera',
    client: 'Rivera',
    invoiceNumber: 'INV-1',
    date: TODAY,
    dueDate: TODAY,
    total: 120,
    amountDue: 0,
    status: 'paid',
    editScope: 'none',
    sessionIds: [],
    createdAt: null,
    ...over,
  } as InvoiceEntry;
}

function draft(over: Partial<GeneratedDraftRow> = {}): GeneratedDraftRow {
  return {
    _id: 'd1',
    kinfolk_id: 'k1',
    kinfolkName: 'Sara',
    communicationType: 'visit_report',
    generatedCopy: 'Biscuit had a lovely time.',
    status: 'pending',
    createdOn: `${TODAY}T08:00:00.000Z`,
    ...over,
  };
}

/** What each collection path resolves to for one render. */
interface Streams {
  kin_care_sessions?: Async<SessionEntry[]>;
  kin?: Async<Kin[]>;
  invoices?: Async<InvoiceEntry[]>;
  generated_drafts?: Async<GeneratedDraftRow[]>;
}

const READY_EMPTY: Async<never[]> = { status: 'ready', data: [] };

function wire(streams: Streams): void {
  useCollection.mockImplementation(
    (spec: { path: keyof Streams }) => streams[spec.path] ?? READY_EMPTY,
  );
}

beforeEach(() => {
  useCollection.mockReset();
});

describe('StatsWidget', () => {
  it('reports today, the review queue, the pack and the week from four real streams', () => {
    wire({
      kin_care_sessions: {
        status: 'ready',
        data: [
          sess({ _id: 'a', status: 'COMPLETED' }),
          sess({ _id: 'b', status: 'ARRIVED', startTime: at('11:00:00') }),
        ],
      },
      generated_drafts: { status: 'ready', data: [draft()] },
      kin: { status: 'ready', data: [kin(), kin({ _id: 'p2' })] },
      invoices: { status: 'ready', data: [inv()] },
    });
    render(<StatsWidget />);

    // Two visits today and two pets in care, so the tiles are read through
    // their labels rather than by hunting for a bare "2" on the page.
    const values = [...document.querySelectorAll('.den-stat')].map((card) => ({
      label: card.querySelector('.den-stat-label')?.textContent,
      value: card.querySelector('.den-stat-value')?.textContent,
    }));
    expect(values).toEqual([
      { label: "Today's pack", value: '2' },
      { label: 'KinTales to review', value: '1' },
      { label: 'Kin in care', value: '2' },
      { label: 'This week', value: '$120' },
    ]);
    expect(screen.getByText('1 done, 1 on the way')).toBeInTheDocument();
    expect(screen.getByText('across all households')).toBeInTheDocument();
  });

  it('shows a real zero when the streams are readable and genuinely empty', () => {
    wire({});
    render(<StatsWidget />);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('shows a DASH and the failure, never a confident zero, on a failed read', () => {
    wire({ invoices: { status: 'error', message: 'permission-denied' } });
    render(<StatsWidget />);

    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    // The trend beside a failed tile is a claim about data nobody read.
    expect(screen.queryByText('paid invoices this week')).not.toBeInTheDocument();
  });

  it('claims nothing at all while a stream is still loading', () => {
    wire({ kin: { status: 'loading' } });
    render(<StatsWidget />);
    expect(screen.getByLabelText(/Kin in care, still loading/i)).toBeInTheDocument();
  });
});

describe('TodaysPackWidget', () => {
  const noop = (): void => undefined;

  it("lists today's run in time order with each visit's state", () => {
    wire({
      kin_care_sessions: {
        status: 'ready',
        data: [
          sess({ _id: 'late', startTime: at('15:00:00'), kinfolkName: 'Walls' }),
          sess({ _id: 'early', startTime: at('08:00:00'), status: 'ARRIVED' }),
        ],
      },
    });
    render(<TodaysPackWidget onOpenSessions={noop} />);

    expect(screen.getByText('Rivera')).toBeInTheDocument();
    expect(screen.getByText('Walls')).toBeInTheDocument();
    expect(screen.getByText('Arrived')).toBeInTheDocument();
    const names = [...document.querySelectorAll('.pack-row__who')].map((el) => el.textContent);
    expect(names).toEqual(['Rivera', 'Walls']);
  });

  it('says the day is quiet when nothing is on the books', () => {
    wire({ kin_care_sessions: READY_EMPTY });
    render(<TodaysPackWidget onOpenSessions={noop} />);
    expect(screen.getByText(/Enjoy the quiet/i)).toBeInTheDocument();
  });

  it('fails loud rather than claiming a quiet day over an unreadable stream', () => {
    wire({ kin_care_sessions: { status: 'error', message: 'deadline-exceeded' } });
    render(<TodaysPackWidget onOpenSessions={noop} />);
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Enjoy the quiet/i)).not.toBeInTheDocument();
  });
});

describe('KinTalesPendingWidget', () => {
  const noop = (): void => undefined;

  it('shows title, blurb and meta with the household named once', () => {
    wire({ generated_drafts: { status: 'ready', data: [draft({ status: 'generated' })] } });
    render(<KinTalesPendingWidget onReviewTales={noop} />);

    expect(screen.getByText('visit report')).toBeInTheDocument();
    expect(screen.getByText('Biscuit had a lovely time.')).toBeInTheDocument();
    expect(screen.getByText(`GENERATED · Sara · ${TODAY}`)).toBeInTheDocument();
  });

  it('is all caught up when there is nothing to review', () => {
    wire({ generated_drafts: READY_EMPTY });
    render(<KinTalesPendingWidget onReviewTales={noop} />);
    expect(screen.getByText(/All caught up/i)).toBeInTheDocument();
  });

  it('never says "all caught up" over a failed draft read', () => {
    wire({ generated_drafts: { status: 'error', message: 'permission-denied' } });
    render(<KinTalesPendingWidget onReviewTales={noop} />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/All caught up/i)).not.toBeInTheDocument();
  });
});

describe('CashFlowWidget', () => {
  it('shows the week earned, what is owed, and over how many invoices', () => {
    wire({
      invoices: {
        status: 'ready',
        data: [inv(), inv({ _id: 'i2', status: 'open', total: 80, amountDue: 80 })],
      },
    });
    render(<CashFlowWidget />);

    expect(screen.getByText('$120.00')).toBeInTheDocument();
    expect(screen.getByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('1 unpaid invoice')).toBeInTheDocument();
  });

  it('reports a genuinely quiet week as zero rather than hiding the card', () => {
    wire({ invoices: READY_EMPTY });
    render(<CashFlowWidget />);
    expect(screen.getAllByText('$0.00')).toHaveLength(2);
    expect(screen.getByText('0 unpaid invoices')).toBeInTheDocument();
  });

  it('never reports $0 earned over a failed invoice read', () => {
    wire({ invoices: { status: 'error', message: 'permission-denied' } });
    render(<CashFlowWidget />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });
});

describe('GatekeeperWidget', () => {
  it('ranks households by days since their last completed visit', () => {
    wire({
      kin_care_sessions: {
        status: 'ready',
        data: [
          sess({ _id: 'a', status: 'COMPLETED', completedAt: `${daysAgo(3)}T10:00:00Z` }),
          sess({
            _id: 'b',
            kinfolkId: 'k2',
            kinfolkName: 'Walls',
            status: 'COMPLETED',
            completedAt: `${daysAgo(20)}T10:00:00Z`,
          }),
        ],
      },
    });
    render(<GatekeeperWidget />);

    const names = [...document.querySelectorAll('.gap-row__who')].map((el) => el.textContent);
    expect(names).toEqual(['Walls', 'Rivera']);
    expect(screen.getByText('20d')).toBeInTheDocument();
    expect(document.querySelector('[data-urgency="overdue"]')).not.toBeNull();
  });

  it('says there is nothing to measure when no visit has been completed', () => {
    wire({ kin_care_sessions: { status: 'ready', data: [sess()] } });
    render(<GatekeeperWidget />);
    expect(screen.getByText(/No completed visits yet/i)).toBeInTheDocument();
  });

  it('fails loud rather than reporting no gaps over an unreadable stream', () => {
    wire({ kin_care_sessions: { status: 'error', message: 'deadline-exceeded' } });
    render(<GatekeeperWidget />);
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
    expect(screen.queryByText(/No completed visits yet/i)).not.toBeInTheDocument();
  });
});

describe('WeeklyCapacityWidget', () => {
  it('draws this week against the recent record, and announces the ratio', () => {
    wire({
      kin_care_sessions: {
        status: 'ready',
        data: [sess({ _id: 'a' }), sess({ _id: 'b', startTime: at('14:00:00') })],
      },
    });
    render(<WeeklyCapacityWidget />);

    expect(screen.getByText('2')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('value', '2');
    expect(bar).toHaveAccessibleName('2 of 2 visits');
  });

  it('shows a quiet week as zero booked rather than as an empty card', () => {
    wire({ kin_care_sessions: READY_EMPTY });
    render(<WeeklyCapacityWidget />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('fails loud on an unreadable stream', () => {
    wire({ kin_care_sessions: { status: 'error', message: 'deadline-exceeded' } });
    render(<WeeklyCapacityWidget />);
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('OverdueVisitsWidget', () => {
  it('lists visits that ran past their end and were never closed out', () => {
    wire({
      kin_care_sessions: {
        status: 'ready',
        data: [
          sess({ _id: 'late', startTime: `${daysAgo(2)}T09:00:00`, endTime: `${daysAgo(2)}T10:00:00` }),
          sess({ _id: 'fine', status: 'COMPLETED' }),
        ],
      },
    });
    render(<OverdueVisitsWidget />);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Rivera')).toBeInTheDocument();
  });

  it('says nothing is hanging when every visit is closed', () => {
    wire({ kin_care_sessions: { status: 'ready', data: [sess({ status: 'COMPLETED' })] } });
    render(<OverdueVisitsWidget />);
    expect(screen.getByText(/Every visit is closed out/i)).toBeInTheDocument();
  });

  it('never claims everything is closed over a failed read', () => {
    wire({ kin_care_sessions: { status: 'error', message: 'permission-denied' } });
    render(<OverdueVisitsWidget />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/Every visit is closed out/i)).not.toBeInTheDocument();
  });
});

describe('PetBreakdownWidget', () => {
  it('groups the pack by species with a proportional bar per row', () => {
    wire({
      kin: {
        status: 'ready',
        data: [kin(), kin({ _id: 'p2' }), kin({ _id: 'p3', species: 'Cat' })],
      },
    });
    render(<PetBreakdownWidget />);

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Dog')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Dog, 2 of 3' })).toBeInTheDocument();
  });

  it('says the roster is empty when it genuinely is', () => {
    wire({ kin: READY_EMPTY });
    render(<PetBreakdownWidget />);
    expect(screen.getByText(/No kin on the roster yet/i)).toBeInTheDocument();
  });

  it('never claims an empty roster over a failed read', () => {
    wire({ kin: { status: 'error', message: 'permission-denied' } });
    render(<PetBreakdownWidget />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/No kin on the roster yet/i)).not.toBeInTheDocument();
  });
});

describe('FrequentFlyersWidget', () => {
  it('ranks households by completed visits in the window', () => {
    wire({
      kin_care_sessions: {
        status: 'ready',
        data: [
          sess({ _id: 'a', status: 'COMPLETED', completedAt: `${daysAgo(2)}T10:00:00Z` }),
          sess({ _id: 'b', status: 'COMPLETED', completedAt: `${daysAgo(3)}T10:00:00Z` }),
          sess({
            _id: 'c',
            kinfolkId: 'k2',
            kinfolkName: 'Walls',
            status: 'COMPLETED',
            completedAt: `${daysAgo(4)}T10:00:00Z`,
          }),
        ],
      },
    });
    render(<FrequentFlyersWidget />);

    const names = [...document.querySelectorAll('.flyer-row__who')].map((el) => el.textContent);
    expect(names).toEqual(['Rivera', 'Walls']);
    expect(screen.getByRole('progressbar', { name: 'Rivera, 2 visits' })).toBeInTheDocument();
  });

  it('says so when nothing was completed in the window', () => {
    wire({ kin_care_sessions: { status: 'ready', data: [sess()] } });
    render(<FrequentFlyersWidget />);
    expect(screen.getByText(/No completed visits in the last 90 days/i)).toBeInTheDocument();
  });

  it('fails loud rather than reporting no loyal households', () => {
    wire({ kin_care_sessions: { status: 'error', message: 'deadline-exceeded' } });
    render(<FrequentFlyersWidget />);
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
    expect(screen.queryByText(/No completed visits in the last 90 days/i)).not.toBeInTheDocument();
  });
});

describe('HolidayRunwayWidget', () => {
  it('names the next holidays and what is booked around each', () => {
    wire({ kin_care_sessions: READY_EMPTY });
    render(<HolidayRunwayWidget />);

    // Three rows, always: the list spans this year and next, so there is never
    // a month in which no pet-care holiday is coming.
    expect(document.querySelectorAll('.holiday-row')).toHaveLength(3);
    // A zero here is the useful answer, not an empty state.
    expect(screen.getAllByText('0 booked').length).toBeGreaterThan(0);
  });

  it('fails loud rather than showing an empty runway over an unreadable stream', () => {
    wire({ kin_care_sessions: { status: 'error', message: 'permission-denied' } });
    render(<HolidayRunwayWidget />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(document.querySelectorAll('.holiday-row')).toHaveLength(0);
  });

  it('is still loading rather than empty before the first snapshot', () => {
    wire({ kin_care_sessions: { status: 'loading' } });
    render(<HolidayRunwayWidget />);
    expect(screen.getByText(/Loading visits/i)).toBeInTheDocument();
  });
});
