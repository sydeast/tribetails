// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsList } from './NotificationsList';
import type { ListMyNotificationsResult, NotificationItemDto } from '../api/notificationsApi';
import type { GetMyHomeResult } from '../api/types';

/**
 * The notifications list behind the bell (#1316).
 *
 * What a household sees: the rows, newest first as the server sent them, an
 * unread mark, a time; a loading cue while the read is out; one line when
 * there is nothing. What a tap does: marks the row read (the row and the bell
 * count at once, the server told), then opens the thing the row is about.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn<(kinfolkId: string | undefined, opts: { limit?: number; before?: number }) => Promise<ListMyNotificationsResult>>(),
  markRead: vi.fn<(id: string) => Promise<{ ok: true }>>(),
  navigate: vi.fn(),
}));

vi.mock('../api/notificationsApi', async () => {
  const actual = await vi.importActual<typeof import('../api/notificationsApi')>('../api/notificationsApi');
  return {
    ...actual,
    listMyNotifications: (kinfolkId: string | undefined, opts: { limit?: number; before?: number }) => mocks.list(kinfolkId, opts),
    markNotificationRead: (id: string) => mocks.markRead(id),
  };
});
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));

// Real clock: the rows are stamped relative to now, and "5m ago" survives the
// milliseconds between module load and render.
const NOW = Date.now();

function item(overrides: Partial<NotificationItemDto> = {}): NotificationItemDto {
  return {
    id: 'n1',
    key: 'invoice.new',
    category: 'invoice',
    title: 'New invoice',
    description: 'An invoice is ready.',
    actorName: '',
    actorPhotoUrl: '',
    targetType: 'invoice',
    targetId: 'inv-1',
    visitId: null,
    batchId: null,
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    readAt: null,
    ...overrides,
  };
}

function page(items: NotificationItemDto[], overrides: Partial<ListMyNotificationsResult> = {}): ListMyNotificationsResult {
  return { items, unreadCount: items.filter((i) => i.readAt === null).length, hasMore: false, nextBefore: null, ...overrides };
}

const ROWS = [
  item({ id: 'n-visit', key: 'kincare.booking.confirm', category: 'visit', title: 'Visit confirmed', description: 'Your visit is on the calendar.', targetType: 'booking', targetId: 'visit-1', visitId: 'visit-1', batchId: 'batch-1' }),
  item({ id: 'n-batch', key: 'kincare.requested', category: 'visit', title: 'Booking requested', description: 'We got your request.', targetType: 'booking', targetId: 'batch-2', visitId: null, batchId: 'batch-2' }),
  item({ id: 'n-invoice', title: 'New invoice', targetType: 'invoice', targetId: 'inv-9', readAt: new Date(NOW - 60_000).toISOString(), createdAt: new Date(NOW - 3 * 3_600_000).toISOString() }),
  item({ id: 'n-tale', key: 'kintale.posted', category: 'kintale', title: 'New KinTale', description: 'A tale was posted.', targetType: 'kintale', targetId: 'tale-2' }),
  item({ id: 'n-kinfolk', key: 'kinfolk.updated', category: 'account', title: 'Profile updated', description: '', targetType: 'kinfolk', targetId: 'fam1' }),
];

let queryClient: QueryClient;

function renderScreen(home: Partial<GetMyHomeResult> | null = { unreadNotifications: 4 }) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (home) queryClient.setQueryData(['myHome', 'fam1'], home);
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationsList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.markRead.mockReset();
  mocks.navigate.mockReset();
  mocks.markRead.mockResolvedValue({ ok: true });
});

describe('NotificationsList rows (#1316)', () => {
  it('shows a loading cue with the sentence while the read is out', () => {
    mocks.list.mockReturnValue(new Promise(() => undefined));
    renderScreen();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your notifications…');
    expect(screen.getByTestId('notifications-loading')).toBeTruthy();
  });

  it('asks for the tribe, a page of 50, and draws every row with its title, description and time', async () => {
    mocks.list.mockResolvedValue(page(ROWS));
    renderScreen();
    await screen.findByTestId('notifications-list');
    expect(mocks.list).toHaveBeenCalledWith('fam1', { limit: 50 });
    const buttons = within(screen.getByTestId('notifications-list')).getAllByRole('button');
    expect(buttons.map((b) => b.querySelector('.nl-row__title')?.textContent)).toEqual([
      'Unread: Visit confirmed',
      'Unread: Booking requested',
      'New invoice',
      'Unread: New KinTale',
      'Unread: Profile updated',
    ]);
    expect(screen.getByText('Your visit is on the calendar.')).toBeTruthy();
    expect(buttons[0]?.querySelector('.nl-row__when')?.textContent).toBe('5m ago');
    expect(buttons[2]?.querySelector('.nl-row__when')?.textContent).toBe('3h ago');
  });

  it("#2030: shows the office's note on the answer to a request, and nothing on a row without one", async () => {
    mocks.list.mockResolvedValue(
      page([
        item({ id: 'n-ok', key: 'kincare.booking.confirm', title: 'Booking confirmed', detail: { householdNote: '  Booked. Bring the spare key.  ' } }),
        item({ id: 'n-no', key: 'kincare.request.declined', title: 'Request declined', detail: { householdNote: 'We are full that week.' } }),
        item({ id: 'n-plain', key: 'kincare.booking.confirm', title: 'Plain', detail: { kinName: 'Rex' } }),
      ]),
    );
    renderScreen();
    await screen.findByTestId('notifications-list');
    const notes = screen.getAllByTestId('notification-household-note').map((n) => n.textContent);
    expect(notes).toEqual(['Booked. Bring the spare key.', 'We are full that week.']);
    expect(screen.getByRole('button', { name: /Plain/ }).querySelector('.nl-row__note')).toBeNull();
  });
  it('marks unread rows and leaves read rows plain', async () => {
    mocks.list.mockResolvedValue(page(ROWS));
    renderScreen();
    await screen.findByTestId('notifications-list');
    const visit = screen.getByRole('button', { name: /Visit confirmed/ });
    const invoice = screen.getByRole('button', { name: /^New invoice/ });
    expect(visit).toHaveAttribute('data-unread', 'true');
    expect(visit).toHaveClass('nl-row--unread');
    expect(invoice).toHaveAttribute('data-unread', 'false');
    expect(invoice).not.toHaveClass('nl-row--unread');
  });

  it('says so, in one line, when there is nothing yet', async () => {
    mocks.list.mockResolvedValue(page([]));
    renderScreen();
    expect(await screen.findByTestId('notifications-empty')).toHaveTextContent('No notifications yet.');
    expect(screen.queryByTestId('notifications-list')).toBeNull();
  });

  it('offers older rows when the server has more, and asks with the cursor', async () => {
    mocks.list.mockResolvedValueOnce(page([ROWS[0]!], { hasMore: true, nextBefore: 1_700_000_000_000 }));
    mocks.list.mockResolvedValueOnce(page([ROWS[3]!]));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith('fam1', { limit: 50, before: 1_700_000_000_000 }));
    await screen.findByRole('button', { name: /New KinTale/ });
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });
});

describe('NotificationsList tap (#1316)', () => {
  async function open(name: RegExp) {
    mocks.list.mockResolvedValue(page(ROWS));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name }));
  }

  it('marks the row read at once, tells the server, and drops the bell count by one', async () => {
    await open(/Visit confirmed/);
    const row = screen.getByRole('button', { name: /Visit confirmed/ });
    expect(row).toHaveAttribute('data-unread', 'false');
    expect(mocks.markRead).toHaveBeenCalledWith('n-visit');
    expect(queryClient.getQueryData<GetMyHomeResult>(['myHome', 'fam1'])?.unreadNotifications).toBe(3);
  });

  it('opens the visit for a per-visit booking row', async () => {
    await open(/Visit confirmed/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/schedule/$visitId', params: { visitId: 'visit-1' } });
  });

  it('opens Schedule for a row about a whole booking request', async () => {
    await open(/Booking requested/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/schedule' });
  });

  it('opens the invoice, and does not re-mark a row that was already read', async () => {
    await open(/^New invoice/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/invoices/$invoiceId', params: { invoiceId: 'inv-9' } });
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<GetMyHomeResult>(['myHome', 'fam1'])?.unreadNotifications).toBe(4);
  });

  it('opens the tale on the KinTales feed', async () => {
    await open(/New KinTale/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kintales', search: { tale: 'tale-2' } });
  });

  it('only marks a household row read, staying on the list', async () => {
    await open(/Profile updated/);
    expect(mocks.markRead).toHaveBeenCalledWith('n-kinfolk');
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Profile updated/ })).toHaveAttribute('data-unread', 'false');
  });

  it('keeps the row read on screen when the server refuses; the next load tells the truth', async () => {
    mocks.markRead.mockRejectedValue(new Error('permission-denied'));
    await open(/New KinTale/);
    expect(screen.getByRole('button', { name: /New KinTale/ })).toHaveAttribute('data-unread', 'false');
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kintales', search: { tale: 'tale-2' } });
  });
});
