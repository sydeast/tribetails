// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type NotificationEntry } from '../api/notifications';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));
// #1749: the KinCare list the Service row is named against.
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: { '60Minute': '40' }, serviceDurations: { '60Minute': '60' }, timeBlocks: [] }),
}));

// #1837: the feed is the signed-in staff member's own notices. `authState` is
// swapped per test to prove the listener follows the account.
const { authState } = vi.hoisted(() => ({
  authState: { current: { status: 'signedIn', user: { uid: 'staff-1' } } as unknown },
}));
vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
const { markNotificationRead, markNotificationUnread, bulkMarkNotificationsRead } = vi.hoisted(() => ({
  markNotificationRead: vi.fn(),
  markNotificationUnread: vi.fn(),
  bulkMarkNotificationsRead: vi.fn(),
}));
vi.mock('../api/notifications', async (orig) => ({
  ...(await orig<typeof import('../api/notifications')>()),
  markNotificationRead,
  markNotificationUnread,
  bulkMarkNotificationsRead,
}));

const {
  archiveNotification,
  bulkArchiveNotifications,
  unarchiveNotification,
  bulkUnarchiveNotifications,
} = vi.hoisted(() => ({
  archiveNotification: vi.fn(),
  bulkArchiveNotifications: vi.fn(),
  unarchiveNotification: vi.fn(),
  bulkUnarchiveNotifications: vi.fn(),
}));
vi.mock('../api/notificationsWrite', () => ({
  archiveNotification,
  bulkArchiveNotifications,
  unarchiveNotification,
  bulkUnarchiveNotifications,
}));

const { batchUpdateBookings } = vi.hoisted(() => ({ batchUpdateBookings: vi.fn() }));
vi.mock('../api/bookingsWrite', () => ({ batchUpdateBookings }));

// #1675: Approve / Deny on a waiting request answer it through `manageBookingSeries`.
const { approveBookingRequest, declineBookingRequest } = vi.hoisted(() => ({
  approveBookingRequest: vi.fn(),
  declineBookingRequest: vi.fn(),
}));
vi.mock('../api/bookingRequests', () => ({ approveBookingRequest, declineBookingRequest }));

// #2069: the live queue of waiting booking requests. Swapped per test; by
// default it holds the one request `waitingRequest()` names below.
const { pendingState } = vi.hoisted(() => ({ pendingState: { current: null as unknown } }));
vi.mock('../lib/pendingBookingRequests', () => ({
  usePendingBookingRequests: () => pendingState.current,
  usePollTick: () => 0,
  VISIT_REQUESTS_REFRESH_MS: 60_000,
}));
vi.mock('../lib/visitRequestSignal', () => ({ useVisitRequestSignal: () => 0 }));
/** The request the waiting row is about, as the Bookings queue lists it. */
const WAITING_REQUEST = {
  kinfolkId: 'kf1',
  batchId: 'req_b1',
  kinfolkName: 'The Wrens',
  serviceType: '60Minute',
  kinNames: ['Biscuit'],
  notes: null,
  visitCount: 1,
  firstStartTimeMs: new Date(2026, 10, 19, 11, 0).getTime(),
  lastStartTimeMs: new Date(2026, 10, 19, 11, 0).getTime(),
  startTimeMsList: [new Date(2026, 10, 19, 11, 0).getTime()],
  visits: [],
  requestedAtMs: new Date(2026, 10, 10, 10, 50).getTime(),
};
function queueHolding(...requests: (typeof WAITING_REQUEST)[]): Async<ReadonlyMap<string, unknown>> {
  return { status: 'ready', data: new Map(requests.map((r) => [`${r.kinfolkId}/${r.batchId}`, r])) };
}
beforeEach(() => {
  // The request rows the older cases below use (b1, b2) are waiting too.
  pendingState.current = queueHolding(
    WAITING_REQUEST,
    { ...WAITING_REQUEST, batchId: 'b1' },
    { ...WAITING_REQUEST, kinfolkId: 'kf2', batchId: 'b2' },
  );
});
const APPROVED = {
  ok: true,
  action: 'APPROVE',
  batchId: 'req_b1',
  affectedVisits: 1,
  sessionsCreated: 1,
  failedVisits: 0,
  householdNotified: true,
  newlyConfirmed: 1,
};

import { Notifications } from './Notifications';
import { KINFOLK_QUERY } from '../api/directory';
import type { CollectionSpec } from '../lib/firestore';

/**
 * The screen now runs TWO listeners: the notifications feed and the `kinfolk`
 * directory it resolves household names against. Tests that care about the
 * household name dispatch on the spec, the rest keep the single-mock idiom
 * (the directory read then yields notification rows, which produce no names and
 * so change nothing).
 */
function mockStreams(notifications: unknown, kinfolk: unknown = { status: 'ready', data: [] }) {
  useCollection.mockImplementation((spec: CollectionSpec) =>
    spec.path === KINFOLK_QUERY.path ? kinfolk : notifications,
  );
}

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<NotificationEntry>): NotificationEntry {
  return {
    _id: 'n1',
    key: 'kincare.booking.confirm',
    category: 'bookings',
    recipientUid: 'u1',
    createdAt: fakeTs('2026-07-16T09:30:00Z'),
    targetType: 'booking',
    targetId: 'b1',
    ...over,
  };
}

/**
 * A row carrying the server-resolved entity detail R5 added. Deliberately the
 * operator's own example, "I see the A KinCare visit was assigned ... but I do
 * not see the KinCare/Booking details", so the tests below read as the
 * complaint they close.
 */
function detailed(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return entry({
    title: 'A KinCare visit was assigned',
    detail: {
      requestedBy: 'Dana Ruiz',
      kinfolkName: 'The Rivera Home',
      kinName: 'Rex',
      serviceType: 'Drop-in visit',
      bookingDate: 'Mon, Jun 15',
      bookingTime: '2:30 PM',
      notes: 'Gate code is 4417.',
    },
    ...over,
  });
}

beforeEach(() => {
  authState.current = { status: 'signedIn', user: { uid: 'staff-1' } };
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<NotificationEntry[]>);
  markNotificationRead.mockReset().mockResolvedValue(undefined);
  markNotificationUnread.mockReset().mockResolvedValue(undefined);
  bulkMarkNotificationsRead.mockReset().mockResolvedValue(1);
  archiveNotification.mockReset().mockResolvedValue(1);
  bulkArchiveNotifications.mockReset().mockResolvedValue(1);
  unarchiveNotification.mockReset().mockResolvedValue(1);
  bulkUnarchiveNotifications.mockReset().mockResolvedValue(1);
  batchUpdateBookings.mockReset().mockResolvedValue({ ok: true, action: 'APPROVE', updated: 1, failed: [] });
  approveBookingRequest.mockReset().mockResolvedValue(APPROVED);
  declineBookingRequest.mockReset().mockResolvedValue({ ...APPROVED, action: 'CANCEL', householdNotified: true });
});

describe('Notifications screen', () => {
  it('renders streamed rows grouped by day, with the title and the category in words', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Notifications />);
    expect(screen.getByText('2026-07-16')).toBeInTheDocument();
    // #1592: a row with no title reads its key as words, never the key itself.
    expect(screen.getByText('Kincare booking confirm')).toBeInTheDocument();
    expect(screen.queryByText('kincare.booking.confirm')).toBeNull();
    // Scoped to the ROW: "Bookings" is also the text of the category filter
    // chip, and an unscoped getByText now matches both. It used to be unique
    // only because the meta line read "bookings · trigger", i.e. because the
    // delivery mode was on the card.
    expect(within(screen.getByRole('listitem')).getByText('Bookings')).toBeInTheDocument();
  });

  it('#1592: shows the catalog category as a word on the chip and the card', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ key: 'account.welcome.kinfolk', title: 'account.welcome.kinfolk', category: 'visit' })],
    });
    render(<Notifications />);
    expect(screen.getByRole('tab', { name: 'Visits' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'visit' })).toBeNull();
    expect(within(screen.getByRole('listitem')).getByText('Visits')).toBeInTheDocument();
    expect(screen.getByText('Account welcome kinfolk')).toBeInTheDocument();
    expect(screen.queryByText('account.welcome.kinfolk')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select Account welcome kinfolk' })).toBeInTheDocument();
  });

  /**
   * THE R5 REGRESSION GUARD, and the reason it is an assertion rather than a
   * deletion. Operator ruling, verbatim: "there are many Activity Log records
   * and workflow (Channels, trigger, and dispatched are activity log not
   * notification) in Notifications." Three tests used to assert these strings
   * WERE on the card; without something asserting they are not, the next person
   * to add a status pill "for debugging" reintroduces the whole complaint and
   * the suite stays green.
   *
   * The fixture deliberately carries the legacy fields, because production is
   * full of documents that still do (the split backfill is optional). Rendering
   * has to ignore them, not merely be starved of them.
   */
  it('never renders delivery workflow on a card, even for a legacy row that still carries it', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        {
          ...entry({}),
          // Cast: these are exactly the fields NotificationEntry no longer
          // declares, and the point is that a doc on the wire can still have
          // them.
          status: 'dispatched',
          mode: 'trigger',
          channels: ['email', 'sms'],
        } as NotificationEntry,
      ],
    });
    render(<Notifications />);
    expect(screen.queryByText('dispatched')).toBeNull();
    expect(screen.queryByText(/channels:/)).toBeNull();
    expect(screen.queryByText('bookings · trigger')).toBeNull();
  });

  it('shows an unread badge counting only unread rows', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1' }), entry({ _id: 'n2', readAt: fakeTs('2026-07-16T10:00:00Z') })],
    });
    render(<Notifications />);
    expect(screen.getByText('1 unread')).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'insufficient permissions' });
    render(<Notifications />);
    // Now reported in more than one place: the feed region AND each stat card,
    // which is the point of routing the counts through asyncScalar.
    expect(screen.getAllByText(/insufficient permissions/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no notifications yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<Notifications />);
    expect(screen.getAllByText(/deadline-exceeded/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('marks an unread row read via markNotificationRead', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark read/i }));
    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(markNotificationUnread).not.toHaveBeenCalled();
  });

  it('marks a read row unread via markNotificationUnread', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1', readAt: fakeTs('2026-07-16T10:00:00Z') })],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark unread/i }));
    expect(markNotificationUnread).toHaveBeenCalledWith('n1');
  });

  it('disables the row button while the call is in flight', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    let release!: () => void;
    markNotificationRead.mockReturnValue(
      new Promise<void>((r) => {
        release = () => r();
      }),
    );
    render(<Notifications />);
    const btn = screen.getByRole('button', { name: /mark read/i });
    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    release();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  // ISSUE #707. Verbatim: "Marking Read greys everything out, but after a few
  // minutes all ctas and active again." The 10s+ callable disabled all six
  // buttons; now only Mark read shows the wait, with a small inline indicator
  // rather than the row looking frozen.
  it('shows an inline pending indicator on Mark read and leaves the other CTAs live while it runs', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1', key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'kf1' } })],
    });
    let release!: () => void;
    markNotificationRead.mockReturnValue(
      new Promise<void>((r) => {
        release = () => r();
      }),
    );
    render(<Notifications />);
    const markRead = screen.getByRole('button', { name: /mark read/i });
    await userEvent.click(markRead);
    expect(markRead).toBeDisabled();
    expect(markRead.querySelector('.notif-row__pending')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled();
    release();
    await waitFor(() => expect(markRead).not.toBeDisabled());
  });

  // The regression this issue's fix could introduce: guarding by row id alone
  // (instead of row id AND write kind) would make Archive a silent no-op
  // while Mark read is still running for the same row, because the guard
  // would see the row as "already has a pending write" and refuse the click
  // outright. Archive must actually run.
  it('archives a row while its own mark-read call is still in flight', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    markNotificationRead.mockReturnValue(new Promise<void>(() => {}));
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark read/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archiveNotification).toHaveBeenCalledWith('n1');
  });

  it('fails loud (dismissible banner) when a single mark-read call rejects', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    markNotificationRead.mockRejectedValue(new Error('permission-denied'));
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /mark read/i }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    // the row button re-enables so the operator can retry
    await waitFor(() => expect(screen.getByRole('button', { name: /mark read/i })).not.toBeDisabled());
  });

  it('selecting rows shows the bulk bar and bulk-marks read via bulkMarkNotificationsRead', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ _id: 'n1' }), entry({ _id: 'n2' })],
    });
    render(<Notifications />);
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[0]!);
    await userEvent.click(checkboxes[1]!);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark 2 read' }));
    expect(bulkMarkNotificationsRead).toHaveBeenCalledWith(['n1', 'n2']);
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  });

  it('keeps the selection and fails loud when the bulk call rejects', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    bulkMarkNotificationsRead.mockRejectedValue(new Error('boom'));
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Mark 1 read' }));
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('Clear empties the selection without calling the backend', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'n1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(bulkMarkNotificationsRead).not.toHaveBeenCalled();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Notifications />);
    expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
  });
});

/**
 * Operator issue #20: the feed read like a second Activity Log, bare event lines
 * with no household, no links, nothing to act on. These cover the context and
 * the affordances that separate a notification from an audit entry.
 */
describe('Notifications feed context (issue #20)', () => {
  it('names the household on the row, resolved from the streamed directory', () => {
    mockStreams(
      { status: 'ready', data: [entry({ data: { kinfolkId: 'k1' } })] },
      { status: 'ready', data: [{ _id: 'k1', firstName: 'Dana', lastName: 'Ruiz' }] },
    );
    render(<Notifications />);
    expect(screen.getByText('Dana Ruiz')).toBeInTheDocument();
  });

  it('prefers a household name the emitter already put on the doc', () => {
    mockStreams({ status: 'ready', data: [entry({ data: { kinfolkName: 'The Ruiz Household' } })] });
    render(<Notifications />);
    expect(screen.getByText('The Ruiz Household')).toBeInTheDocument();
  });

  it('names the linked entity as a chip so the row says what it is about', () => {
    mockStreams({ status: 'ready', data: [entry({ targetType: 'invoice', targetId: 'inv1' })] });
    render(<Notifications />);
    expect(screen.getByText('Invoice')).toBeInTheDocument();
  });

  it('renders the catalog title and description, not just the raw key', () => {
    mockStreams({
      status: 'ready',
      data: [entry({ title: 'Visit confirmed', description: 'A KinCare visit was confirmed.' })],
    });
    render(<Notifications />);
    expect(screen.getByText('Visit confirmed')).toBeInTheDocument();
    expect(screen.getByText('A KinCare visit was confirmed.')).toBeInTheDocument();
  });

  it('groups the feed under day separators, newest day first', () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', createdAt: fakeTs('2026-07-16T15:00:00Z') }),
        entry({ _id: 'n2', createdAt: fakeTs('2026-07-16T12:00:00Z') }),
        entry({ _id: 'n3', createdAt: fakeTs('2026-07-15T12:00:00Z') }),
      ],
    });
    render(<Notifications />);
    const days = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(days).toEqual(['2026-07-16', '2026-07-15']);
  });

  it('filters the feed by category chip, and says so when nothing matches', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', category: 'bookings', title: 'Booking row' }),
        entry({ _id: 'n2', category: 'payments', title: 'Payment row' }),
      ],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    expect(screen.queryByText('Booking row')).toBeNull();
    expect(screen.getByText('Payment row')).toBeInTheDocument();
  });

  it('filters to unread on the Unread chip', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', title: 'Unread row' }),
        entry({ _id: 'n2', title: 'Read row', readAt: fakeTs('2026-07-16T10:00:00Z') }),
      ],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByText('Unread row')).toBeInTheDocument();
    expect(screen.queryByText('Read row')).toBeNull();
  });

  /**
   * The chip row was the one filter row in this admin built as a `role="group"`
   * of `aria-pressed` toggles rather than a roving `tablist`. Same look, a
   * different keyboard contract; these pin the convention it now follows.
   */
  it('exposes the filters as a tablist, matching every other chip row in the admin', () => {
    mockStreams({ status: 'ready', data: [entry({ category: 'bookings' })] });
    render(<Notifications />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['All', 'Unread', 'Bookings']);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves between filters with the arrow keys, and selects on arrival', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', category: 'bookings', title: 'Booking row' }),
        entry({ _id: 'n2', category: 'payments', title: 'Payment row' }),
      ],
    });
    render(<Notifications />);
    screen.getByRole('tab', { name: 'All' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveFocus();
  });

  it('keeps only the active tab in the tab order, per the roving convention', () => {
    mockStreams({ status: 'ready', data: [entry({ category: 'bookings' })] });
    render(<Notifications />);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Bookings' })).toHaveAttribute('tabindex', '-1');
  });
});

/**
 * THE STAT STRIP. Three DenScreenKit `StatCard`s, and the reason each figure is
 * routed through `asyncScalar` rather than computed with a `?? 0` fallback: on a
 * failed read the card must say it does not know, not zero.
 */
describe('Notifications stat strip', () => {
  /**
   * The third tile WAS "Dispatched", counting rows the sender had gotten out of
   * the door: the delivery pipeline's health, on a screen about the operator's
   * workload, and the tile R5 named. It now counts what is waiting on a
   * decision, from the same source as the Approve/Deny buttons, so the number
   * and the buttons cannot disagree.
   */
  it('counts the inbox, the unread, and the ones needing a decision separately', () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'kf1' } }),
        entry({ _id: 'n2', targetType: 'invoice', targetId: 'i1' }),
        entry({
          _id: 'n3',
          key: 'kincare.requested',
          targetType: 'booking',
          targetId: 'b2',
          data: { kinfolkId: 'kf2' },
          readAt: fakeTs('2026-07-16T10:00:00Z'),
        }),
      ],
    });
    render(<Notifications />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Needs a decision')).toBeInTheDocument();
    expect(screen.queryByText('Dispatched')).toBeNull();
    expect(screen.getByText('3')).toBeInTheDocument();
    // 2 unread (n1, n2) and 2 needing a decision (n1, n3): different axes, and
    // the two figures are allowed to be equal without being the same fact.
    expect(screen.getAllByText('2')).toHaveLength(2);
  });

  it('claims nothing while the stream is still loading', () => {
    mockStreams({ status: 'loading' });
    render(<Notifications />);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getAllByText('…').length).toBeGreaterThan(0);
  });

  it('renders a dash and the reason on a failed read, never a confident zero', () => {
    mockStreams({ status: 'error', message: 'insufficient permissions' });
    render(<Notifications />);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getAllByText(/couldn.t load unread/i).length).toBe(1);
  });

  it('reports a genuinely empty inbox as zero, because that IS the fact', () => {
    mockStreams({ status: 'ready', data: [] });
    render(<Notifications />);
    expect(screen.getAllByText('0').length).toBe(3);
  });

  it('re-describes itself when the archive facet changes, rather than counting rows off screen', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1' }),
        entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
        entry({ _id: 'n3', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    render(<Notifications />);
    expect(screen.getByText('Active')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    expect(screen.getByText('Filed away')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

/**
 * ARCHIVE IS NO LONGER A ONE-WAY DOOR. Before this change `archivedAt` could
 * only be stamped, and the feed hid the row, so a misfiled notification was
 * unreachable from every surface in the product.
 */
describe('Notifications archive facet and restore', () => {
  it('hides archived rows by default', () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', title: 'Active row' }),
        entry({ _id: 'n2', title: 'Filed row', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    render(<Notifications />);
    expect(screen.getByText('Active row')).toBeInTheDocument();
    expect(screen.queryByText('Filed row')).toBeNull();
  });

  it('shows archived rows alongside the active feed under Included, marked as archived', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', title: 'Active row' }),
        entry({ _id: 'n2', title: 'Filed row', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'include');
    expect(screen.getByText('Active row')).toBeInTheDocument();
    // The row says which one it is, so a Restore button beside an Archive button
    // is never a mystery. Scoped to the row, because "Archived" is also the
    // facet's own label.
    expect(screen.getByText('Filed row').closest('li')).toHaveTextContent('Archived');
    expect(screen.getByText('Active row').closest('li')).not.toHaveTextContent('Archived');
  });

  it('isolates archived rows under Only archived', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', title: 'Active row' }),
        entry({ _id: 'n2', title: 'Filed row', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    expect(screen.queryByText('Active row')).toBeNull();
    expect(screen.getByText('Filed row')).toBeInTheDocument();
  });

  it('restores one row via unarchiveNotification', async () => {
    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n2', title: 'Filed row', archivedAt: fakeTs('2026-07-16T11:00:00Z') })],
    });
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(unarchiveNotification).toHaveBeenCalledWith('n2');
    expect(archiveNotification).not.toHaveBeenCalled();
  });

  it('treats a restored row (archivedAt null) as active, not as still archived', () => {
    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n1', title: 'Restored row', archivedAt: null })],
    });
    render(<Notifications />);
    // The default facet hides archived rows. A `=== undefined` test would have
    // hidden this one forever, silently, which is the worst possible undo.
    expect(screen.getByText('Restored row')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('fails loud when a restore rejects', async () => {
    unarchiveNotification.mockRejectedValue(new Error('permission-denied'));
    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') })],
    });
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('fails loud when the server declines the restore (unarchived: 0)', async () => {
    unarchiveNotification.mockResolvedValue(0);
    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') })],
    });
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText(/nothing was restored/i)).toBeInTheDocument();
  });

  it('bulk-restores the selection under Only archived, never bulk-archiving it', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
        entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    bulkUnarchiveNotifications.mockResolvedValue(2);
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    await userEvent.click(screen.getByRole('button', { name: 'Select all 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore 2' }));
    expect(bulkUnarchiveNotifications).toHaveBeenCalledWith(['n1', 'n2']);
    expect(bulkArchiveNotifications).not.toHaveBeenCalled();
  });

  it('reports a partial bulk restore rather than reading it as done', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
        entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    bulkUnarchiveNotifications.mockResolvedValue(1);
    render(<Notifications />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    await userEvent.click(screen.getByRole('button', { name: 'Select all 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore 2' }));
    expect(await screen.findByText(/restored 1 of 2/i)).toBeInTheDocument();
  });

  it('clears the selection when the facet changes, so Restore never lands on rows picked elsewhere', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', title: 'Active row' }),
        entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    expect(screen.queryByText('1 selected')).toBeNull();
  });
});

/**
 * The bulk bar's counted buttons, and the reason the mark-read count is the
 * UNREAD subset: `bulkMarkNotificationsRead` skips rows that are already read
 * and reports how many it really marked, so sending the whole selection made a
 * completely successful batch report a partial failure.
 */
describe('Notifications bulk bar', () => {
  it('sends only the unread ids, so a mixed selection is not reported as a partial failure', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1' }),
        entry({ _id: 'n2', readAt: fakeTs('2026-07-16T10:00:00Z') }),
        entry({ _id: 'n3' }),
      ],
    });
    bulkMarkNotificationsRead.mockResolvedValue(2);
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Select all 3' }));
    expect(screen.getByRole('button', { name: 'Mark 2 read' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark 2 read' }));
    expect(bulkMarkNotificationsRead).toHaveBeenCalledWith(['n1', 'n3']);
    await waitFor(() => expect(screen.queryByText(/marked 2 of 3/i)).toBeNull());
  });

  it('disables mark-read when every selected row is already read', async () => {
    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n1', readAt: fakeTs('2026-07-16T10:00:00Z') })],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Mark 0 read' })).toBeDisabled();
  });

  it('still reports a genuine partial batch', async () => {
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1' }), entry({ _id: 'n2' })] });
    bulkMarkNotificationsRead.mockResolvedValue(1);
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Select all 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark 2 read' }));
    expect(await screen.findByText(/marked 1 of 2/i)).toBeInTheDocument();
  });

  it('Select all covers the rows in scope, and flips to clearing them', async () => {
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1' }), entry({ _id: 'n2' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Select all 2' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('2 selected')).toBeNull();
  });

  it('offers no Select all at all when the scope is empty', () => {
    mockStreams({ status: 'ready', data: [] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: /select all/i })).toBeNull();
  });

  it('Select all is limited to the rows the active filter chip shows (#1611)', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', category: 'bookings' }),
        entry({ _id: 'n2', category: 'payments' }),
        entry({ _id: 'n3', category: 'payments' }),
      ],
    });
    bulkArchiveNotifications.mockResolvedValue(2);
    render(<Notifications />);
    expect(screen.getByRole('button', { name: 'Select all 3' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    await userEvent.click(screen.getByRole('button', { name: 'Select all 2' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Archive 2' }));
    expect(bulkArchiveNotifications).toHaveBeenCalledWith(['n2', 'n3']);
  });
  it('changing the filter chip drops a selection made under the old one', async () => {
    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n1', category: 'bookings' }), entry({ _id: 'n2', category: 'payments' })],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Select all 2' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Select all 1' })).toBeInTheDocument();
  });
  it('Select all never reaches rows the archive facet has hidden', async () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1' }),
        entry({ _id: 'n2', archivedAt: fakeTs('2026-07-16T11:00:00Z') }),
      ],
    });
    bulkArchiveNotifications.mockResolvedValue(1);
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Select all 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archive 1' }));
    expect(bulkArchiveNotifications).toHaveBeenCalledWith(['n1']);
  });
});

describe('Notifications quick actions (issue #20)', () => {
  it.each([
    ['invoice', 'inv1', { to: '/invoices', search: { invoiceId: 'inv1' } }],
    ['kintale', 't1', { to: '/kintales', search: { kinTaleId: 't1' } }],
    ['kinfolk', 'k1', { to: '/directory/$kinfolkId', params: { kinfolkId: 'k1' } }],
    // The envelope visit id is bridged to the flat session id here (issue #389);
    // see the round-trip suite in api/bookingIds.test.ts.
    ['booking', 'b1', { to: '/bookings', search: { bookingId: 'vis_b1' } }],
  ])('Open routes a %s notification to its detail', async (targetType, targetId, route) => {
    const onNavigate = vi.fn();
    mockStreams({ status: 'ready', data: [entry({ targetType, targetId })] });
    render(<Notifications onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onNavigate).toHaveBeenCalledWith(route);
  });

  it('renders NO Open button for an unknown targetType (negative case)', () => {
    mockStreams({ status: 'ready', data: [entry({ targetType: 'payout', targetId: 'p1' })] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    // the row is still triageable
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('renders NO Open button when the doc carries no targetType at all', () => {
    mockStreams({ status: 'ready', data: [entry({ targetType: undefined, targetId: undefined })] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  // ISSUE #706: Approve/Deny only offers on a still-pending booking request
  // (key `kincare.requested`). See notificationActions.test.ts for the full
  // per-key table.
  //
  // #1675: that row's `targetId` is the REQUEST's envelope id (`batchId`), and
  // its household is in `data.kinfolkId` (onBookingEnvelopeCreate). The buttons
  // used to send the envelope id to `batchUpdateBookings`, which only knows
  // visit ids, so every press came back not-found. They answer the whole
  // request through `manageBookingSeries` now, as Bookings > Review does.
  const waitingRequest = (over: Partial<NotificationEntry> = {}) =>
    entry({
      key: 'kincare.requested',
      targetType: 'booking',
      targetId: 'req_b1',
      data: { kinfolkId: 'kf1' },
      ...over,
    });

  /** #1875: Approve and Deny open the confirm step; this presses its confirm. */
  async function confirmDecision(label: 'Book it' | 'Send the decline') {
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: label }));
  }

  it('#1675: Approve books the whole request by household and request id, not batchUpdateBookings', async () => {
    approveBookingRequest.mockResolvedValue(APPROVED);
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await confirmDecision('Book it');
    await waitFor(() => expect(approveBookingRequest).toHaveBeenCalledWith('kf1', 'req_b1'));
    expect(batchUpdateBookings).not.toHaveBeenCalled();
    expect(screen.queryByText('Notification action failed')).toBeNull();
  });

  it('#1675: Deny declines the whole request by household and request id', async () => {
    declineBookingRequest.mockResolvedValue({ ok: true, householdNotified: true });
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await confirmDecision('Send the decline');
    await waitFor(() => expect(declineBookingRequest).toHaveBeenCalledWith('kf1', 'req_b1', ''));
    expect(batchUpdateBookings).not.toHaveBeenCalled();
  });

  // #1875: one press of Deny declined the request and told the household, with
  // no confirm and no undo.
  it('#1875: Deny sends nothing until the confirm step, which names the household, the date and who is told', async () => {
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    const dialog = await screen.findByRole('dialog');
    expect(declineBookingRequest).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Turn down this request from The Wrens')).toBeInTheDocument();
    expect(within(dialog).getByText(/Nov 19.*will not be booked\. The household will be told\./)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Anything to add for the household (optional)')).toBeInTheDocument();
    // Backing out sends nothing at all.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(declineBookingRequest).not.toHaveBeenCalled();
  });

  it('#1875: Approve asks first too, and the note typed there goes to the household', async () => {
    approveBookingRequest.mockResolvedValue(APPROVED);
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(approveBookingRequest).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Book this request for The Wrens')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Note for the household (optional)'), 'See you then');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book it' }));
    await waitFor(() => expect(approveBookingRequest).toHaveBeenCalledWith('kf1', 'req_b1', { note: 'See you then' }));
    expect(await screen.findByText(/The Wrens: Approved\./)).toBeInTheDocument();
  });

  // #2069: the August rows kept Approve and Deny months after their visits
  // were booked, and "Needs a decision" read 19 against Bookings' 5.
  it('#2069: a request the live queue no longer holds offers Open only, and is not counted', () => {
    mockStreams({ status: 'ready', data: [waitingRequest({ _id: 'old', targetId: 'aug_req' })] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByText('Answered')).toBeInTheDocument();
  });

  it('#2069: while the queue reads, request rows say they are checking and offer no decision', () => {
    pendingState.current = { status: 'loading' };
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Checking')).toBeInTheDocument();
  });

  it('#2069: a queue that did not load says so, with a retry, and offers no decision', async () => {
    const retry = vi.fn();
    pendingState.current = { status: 'error', message: 'Could not load: offline', retry };
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    expect(screen.getByText('Waiting requests did not load')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('#2028: Open on a waiting request goes to its card on Bookings', async () => {
    const onNavigate = vi.fn();
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onNavigate).toHaveBeenCalledWith({
      to: '/bookings',
      search: { requestId: 'req_b1', requestKinfolkId: 'kf1' },
    });
  });

  it('#1675: offers no Approve/Deny on a request row that names no household, since it cannot be answered', () => {
    mockStreams({ status: 'ready', data: [waitingRequest({ data: {} })] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('offers no Approve/Deny on a booking notification whose event has already been decided', () => {
    mockStreams({
      status: 'ready',
      data: [entry({ key: 'kincare.booking.confirm', targetType: 'booking', targetId: 'b1' })],
    });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('fails loud on a partial approval, not a fake success', async () => {
    approveBookingRequest.mockResolvedValue({ ...APPROVED, affectedVisits: 2, failedVisits: 1 });
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await confirmDecision('Book it');
    expect(
      await screen.findByText(/Approved 2 of 3 visits\. The rest did not go through and the household has not been told/),
    ).toBeInTheDocument();
  });

  it('says so when the household was not told of an approval', async () => {
    approveBookingRequest.mockResolvedValue({ ...APPROVED, householdNotified: false });
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await confirmDecision('Book it');
    expect(await screen.findByText(/did not go out, so tell them another way/)).toBeInTheDocument();
  });

  it('#1098: a quick approve of an Overnight with no start time shows the server refusal, not a generic error', async () => {
    approveBookingRequest.mockRejectedValue(new Error('Set a start time for the Overnight on Nov 9 before approving.'));
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await confirmDecision('Book it');
    expect(
      await screen.findByText(/Set a start time for the Overnight on Nov 9 before approving\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('Answering the request failed.')).toBeNull();
  });

  it('#1099: a quick approve the server refused for a busy block shows that sentence', async () => {
    approveBookingRequest.mockRejectedValue(new Error('That time overlaps a busy block on your Google Calendar.'));
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await confirmDecision('Book it');
    expect(
      await screen.findByText(/That time overlaps a busy block on your Google Calendar\./),
    ).toBeInTheDocument();
  });
  it('fails loud when the decline call rejects', async () => {
    declineBookingRequest.mockRejectedValue(new Error('permission-denied'));
    mockStreams({ status: 'ready', data: [waitingRequest()] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await confirmDecision('Send the decline');
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('Create quote seeds the Invoices composer with the household', async () => {
    const onNavigate = vi.fn();
    mockStreams({
      status: 'ready',
      data: [
        entry({ key: 'quote.denied', targetType: 'invoice', targetId: 'inv1', data: { kinfolkId: 'k9' } }),
      ],
    });
    render(<Notifications onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(onNavigate).toHaveBeenCalledWith({
      to: '/invoices',
      search: { composeQuoteForKinfolkId: 'k9' },
    });
  });

  // #2200 / #2201: Invoices sends an Auntie Home, so her rows offer neither a
  // Create quote nor an Open that lands there. Approve / Deny stays hers.
  it('offers an Auntie no Create quote and no Open into Invoices', () => {
    mockStreams({
      status: 'ready',
      data: [
        waitingRequest(),
        entry({ _id: 'n2', key: 'quote.denied', targetType: 'invoice', targetId: 'inv1', data: { kinfolkId: 'k9' } }),
      ],
    });
    render(<Notifications onNavigate={vi.fn()} isAuntie />);
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    // The waiting request still opens its booking; the quote row opens nothing.
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1);
  });

  it('offers no Create quote on a plain invoice notification, even with a household in data', () => {
    mockStreams({
      status: 'ready',
      data: [entry({ key: 'invoice.new', targetType: 'invoice', targetId: 'inv1', data: { kinfolkId: 'k9' } })],
    });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
  });

  it('archives a row: calls the callable, and the row leaves the feed once archivedAt lands', async () => {
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1', title: 'Doomed row' })] });
    const { rerender } = render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(archiveNotification).toHaveBeenCalledWith('n1');

    mockStreams({
      status: 'ready',
      data: [entry({ _id: 'n1', title: 'Doomed row', archivedAt: fakeTs('2026-07-16T11:00:00Z') })],
    });
    rerender(<Notifications />);
    await waitFor(() => expect(screen.queryByText('Doomed row')).toBeNull());
  });

  it('fails loud when archiving rejects', async () => {
    archiveNotification.mockRejectedValue(new Error('permission-denied'));
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('fails loud when the server declines the archive (archived: 0), rather than looking done', async () => {
    archiveNotification.mockResolvedValue(0);
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/nothing was archived/i)).toBeInTheDocument();
  });

  it('bulk-archives the selection via bulkArchiveNotifications', async () => {
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1' }), entry({ _id: 'n2' })] });
    bulkArchiveNotifications.mockResolvedValue(2);
    render(<Notifications />);
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[0]!);
    await userEvent.click(checkboxes[1]!);
    await userEvent.click(screen.getByRole('button', { name: /^archive \d+$/i }));
    expect(bulkArchiveNotifications).toHaveBeenCalledWith(['n1', 'n2']);
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  });

  it('keeps the selection and fails loud when the bulk archive rejects', async () => {
    mockStreams({ status: 'ready', data: [entry({ _id: 'n1' })] });
    bulkArchiveNotifications.mockRejectedValue(new Error('boom'));
    render(<Notifications />);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /^archive \d+$/i }));
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});
/**
 * THE CARD OPENS (operator ruling R5, 2026-08-03).
 *
 * Verbatim: "CTAs on the Notifications have nothing to do with the actual
 * notification nor am I able to open card to view more details. I see the A
 * KinCare visit was assigned and the CTAs for the workflow but I do not see the
 * KinCare/Booking details. Who requested, For which kinfolk, what date, what
 * time, wheres the notes."
 *
 * One assertion per question the operator asked, because that list is the
 * acceptance criterion, plus the negative case that matters most: a row whose
 * server-side resolution came back empty offers no control at all rather than a
 * control that opens onto nothing.
 */
describe('Notifications card detail', () => {
  it('summarises kin, date and time on the collapsed row, so rows are told apart at a glance', () => {
    mockStreams({ status: 'ready', data: [detailed()] });
    render(<Notifications />);
    expect(screen.getByText('Rex · Mon, Jun 15 · 2:30 PM')).toBeInTheDocument();
  });
  it('opens to answer who requested it, for which kinfolk, which kin, the date, the time and the notes', async () => {
    mockStreams({ status: 'ready', data: [detailed()] });
    render(<Notifications />);
    const opener = screen.getByRole('button', { name: /A KinCare visit was assigned/ });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Requested by')).toBeInTheDocument();
    expect(screen.getByText('Dana Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Household')).toBeInTheDocument();
    expect(screen.getByText('The Rivera Home')).toBeInTheDocument();
    expect(screen.getByText('Kin')).toBeInTheDocument();
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Mon, Jun 15')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
    expect(screen.getByText('2:30 PM')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Gate code is 4417.')).toBeInTheDocument();
  });
  it('closes again, because triage means comparing rows and not living inside one', async () => {
    mockStreams({ status: 'ready', data: [detailed()] });
    render(<Notifications />);
    const opener = screen.getByRole('button', { name: /A KinCare visit was assigned/ });
    await userEvent.click(opener);
    expect(screen.getByText('Requested by')).toBeInTheDocument();
    await userEvent.click(opener);
    expect(screen.queryByText('Requested by')).toBeNull();
  });
  it('offers no opener at all when the server resolved nothing, rather than an empty box', () => {
    mockStreams({ status: 'ready', data: [entry({ title: 'Something happened' })] });
    render(<Notifications />);
    expect(screen.queryByRole('button', { name: /Something happened/ })).toBeNull();
    expect(screen.getByText('Something happened')).toBeInTheDocument();
  });
  it('names the KinCare on a card stored with the visit key (#1749)', async () => {
    mockStreams({ status: 'ready', data: [detailed({ detail: { kinName: 'Biscuit', serviceType: 'visit_60' } })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /A KinCare visit was assigned/ }));
    expect(screen.getByText('Service')).toBeInTheDocument();
    expect(screen.getByText('60Minute')).toBeInTheDocument();
    expect(screen.queryByText('visit_60')).toBeNull();
  });
  it('shows only the fields that resolved, never a labelled blank', async () => {
    mockStreams({
      status: 'ready',
      data: [detailed({ detail: { kinName: 'Rex', requestedBy: 'Dana Ruiz' } })],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /A KinCare visit was assigned/ }));
    expect(screen.getByText('Kin')).toBeInTheDocument();
    expect(screen.getByText('Requested by')).toBeInTheDocument();
    expect(screen.queryByText('Date')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });
  /**
   * The CTAs were never the broken half: `NotificationQuickActions` has always
   * acted on the entity via batchUpdateBookings. The complaint was that they sat
   * beside a card that would not say what entity they would act ON. So opening
   * must not disturb them.
   */
  it('keeps the entity CTAs working while the card is open', async () => {
    mockStreams({ status: 'ready', data: [detailed({ key: 'kincare.requested', data: { kinfolkId: 'kf1' } })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: /A KinCare visit was assigned/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    // #1875: through the confirm step.
    approveBookingRequest.mockResolvedValue(APPROVED);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Book it' }));
    await waitFor(() => expect(approveBookingRequest).toHaveBeenCalledWith('kf1', 'b1'));
  });
});

/**
 * ISSUE #705. Verbatim: "The notification boxes still don't open." Only the
 * title text carried an onClick; the summary line, the description and the
 * rest of the card body were inert, so the operator clicking where they
 * naturally would (the summary) got nothing.
 */
describe('Notifications card body click (issue #705)', () => {
  it('opens the detail when the summary line is clicked, not just the title', async () => {
    mockStreams({ status: 'ready', data: [detailed()] });
    render(<Notifications />);
    expect(screen.queryByText('Requested by')).toBeNull();
    await userEvent.click(screen.getByText('Rex · Mon, Jun 15 · 2:30 PM'));
    expect(screen.getByText('Requested by')).toBeInTheDocument();
  });

  it('opens the detail when the description is clicked', async () => {
    mockStreams({
      status: 'ready',
      data: [detailed({ description: 'A KinCare visit needs your review.' })],
    });
    render(<Notifications />);
    await userEvent.click(screen.getByText('A KinCare visit needs your review.'));
    expect(screen.getByText('Requested by')).toBeInTheDocument();
  });

  it('toggles once per click rather than firing twice, even when the title itself is clicked', async () => {
    mockStreams({ status: 'ready', data: [detailed()] });
    render(<Notifications />);
    const opener = screen.getByRole('button', { name: /A KinCare visit was assigned/ });
    await userEvent.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Requested by')).toBeInTheDocument();
  });

  it('does not toggle when a card with nothing to disclose is clicked', async () => {
    mockStreams({ status: 'ready', data: [entry({ title: 'Something happened' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByText('Something happened'));
    expect(screen.queryByRole('button', { name: /Something happened/ })).toBeNull();
  });

  it('does not toggle when a quick-action button inside the card is clicked', async () => {
    mockStreams({ status: 'ready', data: [detailed({ key: 'kincare.requested', data: { kinfolkId: 'kf1' } })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.queryByText('Requested by')).toBeNull();
  });
});

/**
 * ISSUE #707, the other half. Verbatim: the only visual difference between a
 * read and an unread row was a faint accent border on the unread one, so a
 * read row looked exactly like every other row rather than looking read.
 */
describe('Notifications read-row styling (issue #707)', () => {
  it('marks a read row with its own class, distinct from unread', () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'unread' }),
        entry({ _id: 'read', readAt: fakeTs('2026-07-16T10:00:00Z') }),
      ],
    });
    const { container } = render(<Notifications />);
    const rows = container.querySelectorAll('li.notif-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('notif-row--unread');
    expect(rows[0]).not.toHaveClass('notif-row--read');
    expect(rows[1]).toHaveClass('notif-row--read');
    expect(rows[1]).not.toHaveClass('notif-row--unread');
  });
});
/**
 * #1837. The screen listed every household's notices, and its buttons changed
 * them for the Kinfolk. The feed is now the signed-in staff member's own.
 */
describe('Notifications: only the signed-in staff members own notices (#1837)', () => {
  function notificationSpecs(): CollectionSpec[] {
    return useCollection.mock.calls
      .map((c) => c[0] as CollectionSpec)
      .filter((spec) => spec.path === 'notifications');
  }
  it('listens with recipientUid == the signed-in uid, newest first, capped', () => {
    render(<Notifications />);
    const specs = notificationSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).toEqual({
        path: 'notifications',
        order: ['createdAt', 'desc'],
        max: 200,
        filters: [['recipientUid', '==', 'staff-1']],
      });
    }
  });
  it('never opens an unfiltered listener on the collection', () => {
    render(<Notifications />);
    const unfiltered = notificationSpecs().filter(
      (spec) => !(spec.filters ?? []).some((f) => f[0] === 'recipientUid' && f[1] === '=='),
    );
    expect(unfiltered).toEqual([]);
  });
  it('follows the account: another staff member gets their own filter', () => {
    authState.current = { status: 'signedIn', user: { uid: 'auntie-7' } };
    render(<Notifications />);
    expect(notificationSpecs().every((spec) => spec.filters?.[0]?.[2] === 'auntie-7')).toBe(true);
  });
  it('keeps the recipient filter when no account is resolved, so it cannot widen to the collection', () => {
    authState.current = { status: 'loading' };
    render(<Notifications />);
    const specs = notificationSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.filters).toEqual([['recipientUid', '==', '']]);
  });
  it('counts and tiles describe only the rows the scoped listener returned', () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'mine-1', recipientUid: 'staff-1', title: 'A KinCare visit was requested' }),
        entry({ _id: 'mine-2', recipientUid: 'staff-1', title: 'Invoice paid', readAt: fakeTs('2026-07-16T10:00:00Z') }),
      ],
    });
    render(<Notifications />);
    expect(document.querySelectorAll('.notif-row')).toHaveLength(2);
    expect(screen.getByText('1 unread')).toBeTruthy();
  });
});
