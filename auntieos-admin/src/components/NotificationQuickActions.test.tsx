// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationQuickActions } from './NotificationQuickActions';
import { type NotificationEntry } from '../api/notifications';

function entry(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return { _id: 'n1', key: 'kincare.booking.confirm', ...over };
}

function handlers() {
  return {
    onToggleRead: vi.fn(),
    onNavigate: vi.fn(),
    onArchive: vi.fn(),
    onBookingAction: vi.fn(),
  };
}

describe('NotificationQuickActions', () => {
  it('always offers the read toggle and Archive', () => {
    render(<NotificationQuickActions entry={entry()} read={false} busy={false} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('flips the toggle label once the row is read', () => {
    render(<NotificationQuickActions entry={entry()} read busy={false} {...handlers()} />);
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeInTheDocument();
  });

  it('renders NO Open button for an unknown targetType', () => {
    render(
      <NotificationQuickActions
        entry={entry({ targetType: 'payout', targetId: 'p1' })}
        read={false}
        busy={false}
        {...handlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('renders NO Open button when targetType is missing entirely', () => {
    render(<NotificationQuickActions entry={entry()} read={false} busy={false} {...handlers()} />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it.each([
    ['invoice', 'inv1', { to: '/invoices', search: { invoiceId: 'inv1' } }],
    ['kintale', 't1', { to: '/kintales', search: { kinTaleId: 't1' } }],
    ['kinfolk', 'k1', { to: '/directory/$kinfolkId', params: { kinfolkId: 'k1' } }],
    ['booking', 'b1', { to: '/bookings' }],
  ])('Open on a %s notification navigates to its detail', async (targetType, targetId, route) => {
    const h = handlers();
    render(
      <NotificationQuickActions
        entry={entry({ targetType, targetId })}
        read={false}
        busy={false}
        {...h}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(h.onNavigate).toHaveBeenCalledWith(route);
  });

  it('offers Approve and Deny only for a booking target', async () => {
    const h = handlers();
    const { rerender } = render(
      <NotificationQuickActions
        entry={entry({ targetType: 'booking', targetId: 'b1' })}
        read={false}
        busy={false}
        {...h}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(h.onBookingAction).toHaveBeenCalledWith('b1', 'APPROVE');
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(h.onBookingAction).toHaveBeenCalledWith('b1', 'REJECT');

    rerender(
      <NotificationQuickActions
        entry={entry({ targetType: 'invoice', targetId: 'i1' })}
        read={false}
        busy={false}
        {...h}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('Create quote jumps to the composer seeded with the household', async () => {
    const h = handlers();
    render(
      <NotificationQuickActions
        entry={entry({ targetType: 'invoice', targetId: 'i1', data: { kinfolkId: 'k9' } })}
        read={false}
        busy={false}
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
      <NotificationQuickActions
        entry={entry({ targetType: 'kintale', targetId: 't1' })}
        read={false}
        busy={false}
        {...handlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
  });

  it('disables every write action while one is in flight, but leaves navigation live', () => {
    render(
      <NotificationQuickActions
        entry={entry({ targetType: 'booking', targetId: 'b1' })}
        read={false}
        busy
        {...handlers()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open' })).not.toBeDisabled();
  });
});
