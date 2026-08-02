// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type NotificationEntry } from '../api/notifications';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

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
    status: 'dispatched',
    mode: 'trigger',
    channels: ['email', 'sms'],
    createdAt: fakeTs('2026-07-16T09:30:00Z'),
    targetType: 'booking',
    targetId: 'b1',
    ...over,
  };
}

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<NotificationEntry[]>);
  markNotificationRead.mockReset().mockResolvedValue(undefined);
  markNotificationUnread.mockReset().mockResolvedValue(undefined);
  bulkMarkNotificationsRead.mockReset().mockResolvedValue(1);
  archiveNotification.mockReset().mockResolvedValue(1);
  bulkArchiveNotifications.mockReset().mockResolvedValue(1);
  unarchiveNotification.mockReset().mockResolvedValue(1);
  bulkUnarchiveNotifications.mockReset().mockResolvedValue(1);
  batchUpdateBookings.mockReset().mockResolvedValue({ ok: true, action: 'APPROVE', updated: 1, failed: [] });
});

describe('Notifications screen', () => {
  it('renders streamed rows grouped by day, with key/category/mode/channels/status', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Notifications />);
    expect(screen.getByText('2026-07-16')).toBeInTheDocument();
    expect(screen.getByText('kincare.booking.confirm')).toBeInTheDocument();
    expect(screen.getByText('bookings · trigger')).toBeInTheDocument();
    expect(screen.getByText('channels: email, sms')).toBeInTheDocument();
    expect(screen.getByText('dispatched')).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('tab', { name: 'payments' }));
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
    expect(tabs).toEqual(['All', 'Unread', 'bookings']);
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
    expect(screen.getByRole('tab', { name: 'bookings' })).toHaveAttribute('tabindex', '-1');
  });
});

/**
 * THE STAT STRIP. Three DenScreenKit `StatCard`s, and the reason each figure is
 * routed through `asyncScalar` rather than computed with a `?? 0` fallback: on a
 * failed read the card must say it does not know, not zero.
 */
describe('Notifications stat strip', () => {
  it('counts the inbox, the unread, and the dispatched separately', () => {
    mockStreams({
      status: 'ready',
      data: [
        entry({ _id: 'n1', status: 'dispatched' }),
        entry({ _id: 'n2', status: 'pending' }),
        entry({ _id: 'n3', status: 'dispatched', readAt: fakeTs('2026-07-16T10:00:00Z') }),
      ],
    });
    render(<Notifications />);
    expect(screen.getByText('In your inbox')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // 2 unread (n1, n2) and 2 dispatched (n1, n3): different axes, and the two
    // figures are deliberately allowed to be equal without being the same fact.
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
    expect(screen.getByText('In your inbox')).toBeInTheDocument();

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
    ['booking', 'b1', { to: '/bookings' }],
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

  it('Approve calls batchUpdateBookings with the booking id and APPROVE', async () => {
    mockStreams({ status: 'ready', data: [entry({ targetType: 'booking', targetId: 'b1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(batchUpdateBookings).toHaveBeenCalledWith(['b1'], 'APPROVE');
  });

  it('Deny calls batchUpdateBookings with the booking id and REJECT', async () => {
    mockStreams({ status: 'ready', data: [entry({ targetType: 'booking', targetId: 'b1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(batchUpdateBookings).toHaveBeenCalledWith(['b1'], 'REJECT');
  });

  it('fails loud when the booking batch resolves with a per-id failure, not a fake success', async () => {
    batchUpdateBookings.mockResolvedValue({
      ok: true,
      action: 'APPROVE',
      updated: 0,
      failed: [{ id: 'b1', error: 'not found' }],
    });
    mockStreams({ status: 'ready', data: [entry({ targetType: 'booking', targetId: 'b1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it('fails loud when the booking call rejects', async () => {
    batchUpdateBookings.mockRejectedValue(new Error('permission-denied'));
    mockStreams({ status: 'ready', data: [entry({ targetType: 'booking', targetId: 'b1' })] });
    render(<Notifications />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('Create quote seeds the Invoices composer with the household', async () => {
    const onNavigate = vi.fn();
    mockStreams({
      status: 'ready',
      data: [entry({ targetType: 'invoice', targetId: 'inv1', data: { kinfolkId: 'k9' } })],
    });
    render(<Notifications onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(onNavigate).toHaveBeenCalledWith({
      to: '/invoices',
      search: { composeQuoteForKinfolkId: 'k9' },
    });
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
