// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationQuickActions, type NotificationPendingKind } from './NotificationQuickActions';
import { type NotificationEntry } from '../api/notifications';

function entry(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return { _id: 'n1', key: 'kincare.booking.confirm', ...over };
}

/** #2069: the waiting booking requests, by household and batch. */
const WAITING: ReadonlySet<string> = new Set(['kf1/b1', 'kf1/req_1', 'k9/b1']);
/** No write in flight, unless a test overrides `pending`. */
const IDLE = new Set<NotificationPendingKind>();

function handlers() {
  return {
    // The default for every pre-existing case below: an ACTIVE, idle row. The
    // archived branch gets its own describe block at the bottom.
    archived: false,
    pending: IDLE,
    onToggleRead: vi.fn(),
    onNavigate: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onBookingAction: vi.fn(),
    // #2069: the live queue holds these requests, so they read as waiting.
    pendingRequests: WAITING as ReadonlySet<string> | null,
    pendingRequestsLoading: false,
  };
}

describe('NotificationQuickActions', () => {
  it('always offers the read toggle and Archive', () => {
    render(<NotificationQuickActions entry={entry()} read={false} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('flips the toggle label once the row is read', () => {
    render(<NotificationQuickActions entry={entry()} read {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeInTheDocument();
  });

  it('renders NO Open button for an unknown targetType', () => {
    render(
      <NotificationQuickActions
        entry={entry({ targetType: 'payout', targetId: 'p1' })}
        read={false}
        {...handlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('renders NO Open button when targetType is missing entirely', () => {
    render(<NotificationQuickActions entry={entry()} read={false} {...handlers()} />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it.each([
    ['invoice', 'inv1', { to: '/invoices', search: { invoiceId: 'inv1' } }],
    ['kintale', 't1', { to: '/kintales', search: { kinTaleId: 't1' } }],
    ['kinfolk', 'k1', { to: '/directory/$kinfolkId', params: { kinfolkId: 'k1' } }],
    // The envelope visit id is bridged to the flat session id here (issue #389);
    // see the round-trip suite in api/bookingIds.test.ts.
    ['booking', 'b1', { to: '/bookings', search: { bookingId: 'vis_b1' } }],
  ])('Open on a %s notification navigates to its detail', async (targetType, targetId, route) => {
    const h = handlers();
    render(<NotificationQuickActions entry={entry({ targetType, targetId })} read={false} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(h.onNavigate).toHaveBeenCalledWith(route);
  });

  // ISSUE #706: Approve/Deny is scoped to `kincare.requested`, the one key
  // that means a booking request is still waiting on a decision. See the
  // table in lib/notificationActions.test.ts for the full per-key accounting.
  it('offers Approve and Deny only for a pending booking request', async () => {
    const h = handlers();
    const { rerender } = render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'kf1' } })}
        read={false}
        {...h}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(h.onBookingAction).toHaveBeenCalledWith('b1', 'APPROVE');
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(h.onBookingAction).toHaveBeenCalledWith('b1', 'REJECT');

    rerender(
      <NotificationQuickActions entry={entry({ targetType: 'invoice', targetId: 'i1' })} read={false} {...h} />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('offers NO Approve/Deny on an already-confirmed booking, even though the target is still a booking', () => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.booking.confirm', targetType: 'booking', targetId: 'b1' })}
        read={false}
        {...handlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  // #1647: a request booked or declined anywhere stops offering a decision and
  // says how it ended.
  it.each([
    ['booked', 'Booked'],
    ['declined', 'Declined'],
    ['cancelled', 'Cancelled'],
  ])('an answered request (%s) shows "%s" and no Approve/Deny', (requestResolution, label) => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' }, requestResolution })}
        read={false}
        {...handlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByText(label)).toBeInTheDocument();
  });
  it('a waiting request shows no outcome', () => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' } })}
        read={false}
        {...handlers()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByText('Booked')).toBeNull();
  });
  it('Create quote jumps to the composer seeded with the household', async () => {
    const h = handlers();
    render(
      <NotificationQuickActions
        entry={entry({ key: 'quote.denied', targetType: 'invoice', targetId: 'i1', data: { kinfolkId: 'k9' } })}
        read={false}
        {...h}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(h.onNavigate).toHaveBeenCalledWith({
      to: '/invoices',
      search: { composeQuoteForKinfolkId: 'k9' },
    });
  });

  it('hides Create quote when no household can be identified', () => {
    render(
      <NotificationQuickActions entry={entry({ targetType: 'kintale', targetId: 't1' })} read={false} {...handlers()} />,
    );
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
  });
});

/**
 * ISSUE #707. Verbatim: "Marking Read greys everything out, but after a few
 * minutes all ctas and active again." `markNotificationRead` took 10+
 * seconds, and a single row-wide `busy` flag disabled every one of the six
 * buttons for that whole span, which read as the row hanging. `pending` now
 * names WHICH write is running, so only the buttons that write the same thing
 * show it.
 */
describe('NotificationQuickActions, pending state (issue #707)', () => {
  it('disables only Mark read, with an inline indicator, while a read write is pending', () => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'kf1' } })}
        read={false}
        {...handlers()}
        pending={new Set(['read'])}
      />,
    );
    const markRead = screen.getByRole('button', { name: 'Mark read' });
    expect(markRead).toBeDisabled();
    expect(markRead.querySelector('.notif-row__pending')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open' })).not.toBeDisabled();
  });

  it('disables only Approve/Deny, leaving Mark read and Archive live, while a booking write is pending', () => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'kf1' } })}
        read={false}
        {...handlers()}
        pending={new Set(['booking'])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark read' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open' })).not.toBeDisabled();
  });

  it('disables only Archive, with an inline indicator, while an archive write is pending', () => {
    render(
      <NotificationQuickActions entry={entry()} read={false} {...handlers()} pending={new Set(['archive'])} />,
    );
    const archiveButton = screen.getByRole('button', { name: 'Archive' });
    expect(archiveButton).toBeDisabled();
    expect(archiveButton.querySelector('.notif-row__pending')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Mark read' })).not.toBeDisabled();
  });

  it('never disables Open or Create quote, no matter what is pending', () => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'k9' } })}
        read={false}
        {...handlers()}
        pending={new Set(['booking'])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create quote' })).not.toBeDisabled();
  });

  // The set can genuinely hold more than one kind at once (mark read, then
  // archive, clicked before the first call resolves): both buttons show
  // pending together, and neither one's state overwrites the other's.
  it('disables both buttons when two kinds are pending at once', () => {
    render(
      <NotificationQuickActions
        entry={entry()}
        read={false}
        {...handlers()}
        pending={new Set(['read', 'archive'])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
  });
});

describe('NotificationQuickActions, the archive direction', () => {
  it('offers Restore instead of Archive on an archived row', () => {
    render(<NotificationQuickActions entry={entry()} read={false} {...handlers()} archived />);
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('calls onRestore, never onArchive, from the archived row', async () => {
    const h = handlers();
    render(<NotificationQuickActions entry={entry()} read={false} {...h} archived />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(h.onRestore).toHaveBeenCalledTimes(1);
    expect(h.onArchive).not.toHaveBeenCalled();
  });

  it('calls onArchive, never onRestore, from an active row', async () => {
    const h = handlers();
    render(<NotificationQuickActions entry={entry()} read={false} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(h.onArchive).toHaveBeenCalledTimes(1);
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it('disables Restore while an archive write for the row is pending', () => {
    render(
      <NotificationQuickActions
        entry={entry()}
        read={false}
        {...handlers()}
        pending={new Set(['archive'])}
        archived
      />,
    );
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('keeps the read toggle and the conditional actions on an archived row', () => {
    render(
      <NotificationQuickActions
        entry={entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'b1', data: { kinfolkId: 'kf1' } })}
        read={false}
        {...handlers()}
        archived
      />,
    );
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });
});

describe('NotificationQuickActions for an Auntie (#2200 / #2201)', () => {
  it('draws no Open on an invoice notice for her, and draws it for the owner', () => {
    const e = entry({ key: 'invoice.paid', targetType: 'invoice', targetId: 'inv_1' });
    const { rerender } = render(<NotificationQuickActions entry={e} read={false} {...handlers()} isAuntie />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    rerender(<NotificationQuickActions entry={e} read={false} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('draws no Create quote for her on a fresh request, and keeps Approve', () => {
    const e = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' } });
    const { rerender } = render(<NotificationQuickActions entry={e} read={false} {...handlers()} isAuntie />);
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    rerender(<NotificationQuickActions entry={e} read={false} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Create quote' })).toBeInTheDocument();
  });
});
/**
 * #2069 / #1875: Approve and Deny only on a request the live queue holds, and a
 * press only ASKS for the decision; the screen opens the confirm step.
 */
describe('NotificationQuickActions and the live request queue (#2069, #1875)', () => {
  const request = entry({ key: 'kincare.requested', targetType: 'booking', targetId: 'req_1', data: { kinfolkId: 'kf1' } });
  it('offers no Approve or Deny on a request the queue no longer holds, and says it was answered', () => {
    render(<NotificationQuickActions entry={request} read={false} {...handlers()} pendingRequests={new Set()} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });
  it('says it is checking while the queue reads, with no decision offered', () => {
    render(
      <NotificationQuickActions entry={request} read={false} {...handlers()} pendingRequests={null} pendingRequestsLoading />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Checking');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('shows no checking cue once the queue read has failed (the screen says so instead)', () => {
    render(<NotificationQuickActions entry={request} read={false} {...handlers()} pendingRequests={null} />);
    expect(screen.queryByText('Checking')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('a press of Approve or Deny only asks the screen for the decision', async () => {
    const h = handlers();
    render(<NotificationQuickActions entry={request} read={false} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(h.onBookingAction).toHaveBeenCalledWith('req_1', 'REJECT');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(h.onBookingAction).toHaveBeenCalledWith('req_1', 'APPROVE');
  });
  it('Open on a waiting request goes to its card on Bookings (#2028)', async () => {
    const h = handlers();
    render(<NotificationQuickActions entry={request} read={false} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(h.onNavigate).toHaveBeenCalledWith({ to: '/bookings', search: { requestId: 'req_1', requestKinfolkId: 'kf1' } });
  });
});
