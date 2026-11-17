// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsList } from './NotificationsList';
import type { ListMyNotificationsResult, NotificationItemDto } from '../api/notificationsApi';
import type { GetMyHomeResult } from '../api/types';
import { liveUnreadOf, resetUnreadBadge, setLiveRows } from '../lib/unreadBadge';

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
  search: vi.fn<() => { entry?: string }>(() => ({})),
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
  useSearch: () => mocks.search(),
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
  resetUnreadBadge();
  mocks.list.mockReset();
  mocks.markRead.mockReset();
  mocks.navigate.mockReset();
  mocks.search.mockReset();
  mocks.search.mockReturnValue({});
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

  it('#2321: a row shows punctuation and typed markup as characters, never as codes or as markup', async () => {
    const title = "O'Malley & Sue's visit";
    const description = 'Bob & Sue said "<b>bold</b> &amp; <img src=x onerror=alert(1)>"';
    mocks.list.mockResolvedValue(page([item({ title, description })]));
    const { container } = renderScreen();
    const list = await screen.findByTestId('notifications-list');
    expect(list.querySelector('.nl-row__title')?.textContent).toBe(`Unread: ${title}`);
    const line = list.querySelector('.nl-row__desc');
    // The words are one text node: nothing typed became an element.
    expect(line?.textContent).toBe(description);
    expect(line?.children).toHaveLength(0);
    expect(container.querySelector('img[src="x"]')).toBeNull();
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
/**
 * #1833: the bell's live count follows a tap at once, and a refused read puts
 * the row back on it. The rows below are what the bell's listener holds.
 */
describe('NotificationsList tap and the live bell count (#1833)', () => {
  const live = (ids: string[]) => ids.map((id) => ({ id, unread: true, archived: false, tribeId: 'fam1' }));
  it('takes the tapped row off the bell before the server answers', async () => {
    let settle: (v: { ok: true }) => void = () => undefined;
    mocks.markRead.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    mocks.list.mockResolvedValue(page(ROWS));
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    renderScreen();
    await screen.findByTestId('notifications-list');
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 4 });
    await userEvent.click(screen.getByRole('button', { name: /Visit confirmed/ }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 3 });
    settle({ ok: true });
  });
  it('puts the row back on the bell when the server refuses the read', async () => {
    mocks.markRead.mockRejectedValue(new Error('permission-denied'));
    mocks.list.mockResolvedValue(page(ROWS));
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: /New KinTale/ }));
    await waitFor(() => expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 4 }));
  });
  it('leaves the bell alone for a row that was already read', async () => {
    mocks.list.mockResolvedValue(page(ROWS));
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: /^New invoice/ }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 4 });
  });
});
/**
 * #2328: a re-read that fails once rows are on screen used to replace the
 * whole list with the error screen. The rows stay; the failure is one quiet
 * line with Try again; a failed "Show older" still says it failed.
 */
describe('NotificationsList keeps its rows when a later read fails (#2328)', () => {
  const ERROR_SCREEN = "We're having trouble loading your tribe.";
  it('a first load that fails takes the screen, with Try again', async () => {
    mocks.list.mockRejectedValueOnce(new Error('unavailable'));
    mocks.list.mockResolvedValueOnce(page(ROWS));
    renderScreen();
    expect(await screen.findByText(ERROR_SCREEN)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByTestId('notifications-list');
    expect(screen.queryByText(ERROR_SCREEN)).toBeNull();
  });
  it('a failed background re-read keeps the rows on screen and says so quietly', async () => {
    mocks.list.mockResolvedValueOnce(page(ROWS));
    mocks.list.mockRejectedValueOnce(new Error('unavailable'));
    renderScreen();
    await screen.findByTestId('notifications-list');
    // The bell's listener saw a notice arrive, and the re-read failed.
    await act(() => queryClient.invalidateQueries({ queryKey: ['myNotifications'] }));
    const quiet = await screen.findByTestId('notifications-refresh-failed');
    expect(quiet).toHaveTextContent('Could not check for new notifications.');
    expect(quiet).toHaveAttribute('role', 'status');
    expect(screen.queryByText(ERROR_SCREEN)).toBeNull();
    expect(screen.getByRole('button', { name: /Visit confirmed/ })).toBeTruthy();
    expect(within(screen.getByTestId('notifications-list')).getAllByRole('button')).toHaveLength(ROWS.length);
    expect(screen.queryByTestId('notifications-loading')).toBeNull();
    expect(screen.queryByTestId('notifications-older-failed')).toBeNull();
  });
  it('Try again on the quiet line reads again, shows the wait, and the line goes once it works', async () => {
    const arrived = item({ id: 'n-omw', title: 'Your Auntie is on the way', createdAt: new Date(NOW).toISOString() });
    let answer: (v: ListMyNotificationsResult) => void = () => undefined;
    mocks.list.mockResolvedValueOnce(page(ROWS));
    mocks.list.mockRejectedValueOnce(new Error('unavailable'));
    mocks.list.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await act(() => queryClient.invalidateQueries({ queryKey: ['myNotifications'] }));
    await screen.findByTestId('notifications-refresh-failed');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const busy = await screen.findByRole('button', { name: /Checking/ });
    expect(busy).toBeDisabled();
    // The rows stay up while it is out.
    expect(screen.getByRole('button', { name: /Visit confirmed/ })).toBeTruthy();
    await act(async () => answer(page([arrived, ...ROWS])));
    await screen.findByRole('button', { name: /Your Auntie is on the way/ });
    expect(screen.queryByTestId('notifications-refresh-failed')).toBeNull();
  });
  it('a failed re-read of an empty list keeps the empty line and says so quietly', async () => {
    mocks.list.mockResolvedValueOnce(page([]));
    mocks.list.mockRejectedValueOnce(new Error('unavailable'));
    renderScreen();
    await screen.findByTestId('notifications-empty');
    await act(() => queryClient.invalidateQueries({ queryKey: ['myNotifications'] }));
    await screen.findByTestId('notifications-refresh-failed');
    expect(screen.getByTestId('notifications-empty')).toHaveTextContent('No notifications yet.');
    expect(screen.queryByText(ERROR_SCREEN)).toBeNull();
  });
  it('a failed "Show older" keeps the rows, says it failed, and asks again from the same place', async () => {
    mocks.list.mockResolvedValueOnce(page([ROWS[0]!], { hasMore: true, nextBefore: 1_700_000_000_000 }));
    mocks.list.mockRejectedValueOnce(new Error('unavailable'));
    mocks.list.mockResolvedValueOnce(page([ROWS[3]!]));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    const failed = await screen.findByTestId('notifications-older-failed');
    expect(failed).toHaveTextContent('Could not load older notifications.');
    expect(failed).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(ERROR_SCREEN)).toBeNull();
    expect(screen.getByRole('button', { name: /Visit confirmed/ })).toBeTruthy();
    // Not the quiet line: this was asked for, and it says so plainly.
    expect(screen.queryByTestId('notifications-refresh-failed')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await screen.findByRole('button', { name: /New KinTale/ });
    expect(mocks.list).toHaveBeenLastCalledWith('fam1', { limit: 50, before: 1_700_000_000_000 });
    expect(screen.queryByTestId('notifications-older-failed')).toBeNull();
  });
  it('a good re-read after a failed "Show older" takes the failed line away', async () => {
    mocks.list.mockResolvedValueOnce(page([ROWS[0]!], { hasMore: true, nextBefore: 1_700_000_000_000 }));
    mocks.list.mockRejectedValueOnce(new Error('unavailable'));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await screen.findByTestId('notifications-older-failed');
    // A notice arrived and the newest page now holds everything there is.
    mocks.list.mockResolvedValue(page([ROWS[0]!, ROWS[3]!]));
    await act(() => queryClient.invalidateQueries({ queryKey: ['myNotifications'] }));
    await screen.findByRole('button', { name: /New KinTale/ });
    expect(screen.queryByTestId('notifications-older-failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(screen.queryByTestId('notifications-refresh-failed')).toBeNull();
  });
});
/**
 * #2329: once the server has taken the read, the bell believes the next
 * snapshot, so a notice the office marked unread again in between counts.
 */
describe("NotificationsList tap, the server's answer and the bell (#2329)", () => {
  const live = (ids: string[]) => ids.map((id) => ({ id, unread: true, archived: false, tribeId: 'fam1', issuedAtMs: 100 }));
  it('after the server takes the read, a snapshot that still reads unread counts the row again', async () => {
    mocks.list.mockResolvedValue(page(ROWS));
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: /Visit confirmed/ }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 3 });
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith('n-visit'));
    // Let the answer land before the next snapshot.
    await act(async () => undefined);
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 4 });
  });
  it('before the server answers, the same snapshot leaves the tap off the bell', async () => {
    mocks.markRead.mockReturnValue(new Promise(() => undefined));
    mocks.list.mockResolvedValue(page(ROWS));
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name: /Visit confirmed/ }));
    setLiveRows(live(['n-visit', 'n-batch', 'n-tale', 'n-kinfolk']));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 3 });
  });
});
describe('#1831, #1898, #1913: each notice says what happened and opens what it is about', () => {
  const NOTICES = [
    item({ id: 'n-arrived', key: 'kincare.auntie.arrived', category: 'visit', title: 'Your Auntie has arrived', description: 'Drop-in visit for Rex on Tue, Nov 17 at 9:00 AM', targetType: 'booking', targetId: 'v7', visitId: 'v7', batchId: 'b7' }),
    item({ id: 'n-comments', key: 'kintale.comment.added', category: 'kintale', title: 'New comment on your KinTale', description: 'Jamie and Sam commented on 2 KinTales', targetType: 'kintale', targetId: '' }),
    item({ id: 'n-kin', key: 'kin.removal.declined', category: 'account', title: 'Your Kin removal request was declined', description: 'Mochi is staying on your profile', targetType: 'kin', targetId: 'kin-2', detail: { householdNote: 'Mochi still has a visit booked.' } }),
    item({ id: 'n-gone', key: 'kin.removal.archived', category: 'account', title: 'A Kin you asked to remove was removed', description: 'Pip is no longer on your profile', targetType: 'kin', targetId: '' }),
    item({ id: 'n-profile', key: 'profile.updated', category: 'account', title: 'Your profile was updated', description: '', targetType: 'household', targetId: '' }),
  ];
  async function tap(name: RegExp) {
    mocks.list.mockResolvedValue(page(NOTICES));
    renderScreen();
    await screen.findByTestId('notifications-list');
    await userEvent.click(screen.getByRole('button', { name }));
  }
  it('draws the content line under each title, and a row with no facts as its title alone', async () => {
    mocks.list.mockResolvedValue(page(NOTICES));
    renderScreen();
    await screen.findByTestId('notifications-list');
    const row = (name: RegExp) => screen.getByRole('button', { name });
    expect(row(/has arrived/).querySelector('.nl-row__desc')?.textContent).toBe('Drop-in visit for Rex on Tue, Nov 17 at 9:00 AM');
    expect(row(/removal request was declined/).querySelector('.nl-row__desc')?.textContent).toBe('Mochi is staying on your profile');
    expect(row(/removal request was declined/).querySelector('.nl-row__note')?.textContent).toBe('Mochi still has a visit booked.');
    expect(row(/profile was updated/).querySelector('.nl-row__desc')).toBeNull();
  });
  it('opens the visit the Auntie arrived for', async () => {
    await tap(/has arrived/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/schedule/$visitId', params: { visitId: 'v7' } });
  });
  it('#1898: comments across tales open the KinTales list', async () => {
    await tap(/New comment on your KinTale/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kintales', search: {} });
  });
  it('#1913: the declined removal opens that Kin', async () => {
    await tap(/removal request was declined/);
    expect(mocks.markRead).toHaveBeenCalledWith('n-kin');
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kin/$kinId', params: { kinId: 'kin-2' } });
  });
  it('a Kin that was removed opens the Kin list', async () => {
    await tap(/asked to remove was removed/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/kin' });
  });
  it('a profile change opens Tribe', async () => {
    await tap(/profile was updated/);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/tribe' });
  });
});


/**
 * A household push whose line was cut, or whose notice carries the office's
 * note, opens the list at that notice (`/notifications?entry=<id>`), where the
 * whole message is. jsdom draws nothing, so the row's own mark is what is read.
 */
describe('NotificationsList opened at one entry by a tapped push', () => {
  const declined = item({
    id: 'n-declined',
    key: 'kincare.request.declined',
    title: 'Your visit request was declined',
    description: 'Nov 20 to Nov 22',
    targetType: 'booking',
    targetId: 'b1',
    batchId: 'b1',
    detail: { householdNote: 'We are away that week. Please ask again for December.' },
  });
  const other = item({ id: 'n-other', title: 'New invoice' });
  const opened = () => document.querySelectorAll('[data-opened="true"]');
  it('marks that entry, gives it focus, and shows its whole message', async () => {
    mocks.search.mockReturnValue({ entry: 'n-declined' });
    mocks.list.mockResolvedValue(page([other, declined]));
    renderScreen();
    const row = await screen.findByRole('button', { name: /visit request was declined/ });
    await waitFor(() => expect(row).toHaveAttribute('data-opened', 'true'));
    expect(opened()).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(within(row).getByTestId('notification-household-note')).toHaveTextContent(
      'We are away that week. Please ask again for December.',
    );
  });
  it('opening the list at an entry does not mark it read or leave the list', async () => {
    mocks.search.mockReturnValue({ entry: 'n-declined' });
    mocks.list.mockResolvedValue(page([other, declined]));
    renderScreen();
    const row = await screen.findByRole('button', { name: /visit request was declined/ });
    await waitFor(() => expect(row).toHaveAttribute('data-opened', 'true'));
    expect(row).toHaveAttribute('data-unread', 'true');
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('an entry that is not on the list marks nothing: the list reads as it always does', async () => {
    mocks.search.mockReturnValue({ entry: 'another-households-entry' });
    mocks.list.mockResolvedValue(page([other, declined]));
    renderScreen();
    await screen.findByRole('button', { name: /visit request was declined/ });
    expect(opened()).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /declined|invoice/ })).toHaveLength(2);
  });
  it('no entry marks nothing', async () => {
    mocks.list.mockResolvedValue(page([other, declined]));
    renderScreen();
    await screen.findByRole('button', { name: /visit request was declined/ });
    expect(opened()).toHaveLength(0);
  });
  it('an empty list with an entry still says there is nothing', async () => {
    mocks.search.mockReturnValue({ entry: 'n-declined' });
    mocks.list.mockResolvedValue(page([]));
    renderScreen();
    expect(await screen.findByTestId('notifications-empty')).toBeInTheDocument();
  });
});

/**
 * #2368: a push cut to its short line opens its entry, and the entry shows the
 * rest of the message, as text. Older entries look as they always have.
 */
describe('NotificationsList shows the whole message of a cut push', () => {
  const whole = "Your visit request was declined.\n\nO'Malley & Rex <b>loved</b> it &amp; more. We are away that week.";
  const cut = item({
    id: 'n-cut',
    key: 'kincare.request.declined',
    title: 'Your visit request was declined',
    description: 'Nov 20 to Nov 22',
    targetType: 'booking',
    targetId: 'b1',
    batchId: 'b1',
    detail: { householdNote: 'We are away that week.' },
    fullMessage: whole,
  });
  const older = item({ id: 'n-old', title: 'New invoice', description: 'An invoice is ready.' });
  it('draws the whole message under the facts line, as typed, with no markup made of it', async () => {
    mocks.search.mockReturnValue({ entry: 'n-cut' });
    mocks.list.mockResolvedValue(page([older, cut]));
    renderScreen();
    const row = await screen.findByRole('button', { name: /visit request was declined/ });
    const message = within(row).getByTestId('notification-full-message');
    // textContent keeps the line breaks; the tag and the entity are text.
    expect(message.textContent).toBe(whole);
    expect(message.querySelector('b')).toBeNull();
    expect(within(row).getByText('Nov 20 to Nov 22')).toBeInTheDocument();
    // The note is in the message already, so it is not drawn twice.
    expect(within(row).queryByTestId('notification-household-note')).toBeNull();
    // No id reaches the screen.
    expect(row.textContent).not.toMatch(/n-cut|\bb1\b/);
  });
  it('an entry with no whole message reads as before: title and facts line only', async () => {
    mocks.list.mockResolvedValue(page([older, cut]));
    renderScreen();
    const row = await screen.findByRole('button', { name: /New invoice/ });
    expect(within(row).queryByTestId('notification-full-message')).toBeNull();
    expect(within(row).getByText('An invoice is ready.')).toBeInTheDocument();
  });
  it('a tap on that entry still marks it read and opens what it is about; the bell drops by one only', async () => {
    mocks.list.mockResolvedValue(page([older, cut]));
    renderScreen({ unreadNotifications: 2 });
    await userEvent.click(await screen.findByRole('button', { name: /visit request was declined/ }));
    expect(mocks.markRead).toHaveBeenCalledWith('n-cut');
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/schedule' });
    expect(queryClient.getQueryData<GetMyHomeResult>(['myHome', 'fam1'])?.unreadNotifications).toBe(1);
  });
});
