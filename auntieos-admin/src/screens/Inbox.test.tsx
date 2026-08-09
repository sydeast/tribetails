// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ConversationSummary } from '../api/inbox';
import { type NotificationEntry } from '../api/notifications';
import { type Async } from '../lib/async';
import type { Timestamp } from 'firebase/firestore';

// TZ pinned to a west-of-UTC zone so the AO-18 day-grouping assertions below
// are meaningful on any CI runner (the identical rationale in
// lib/inboxFormat.test.ts / Sessions.test.tsx). Restored afterAll for any
// sibling test file sharing this worker.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const { listConversations } = vi.hoisted(() => ({ listConversations: vi.fn() }));
vi.mock('../api/inbox', async (orig) => ({
  ...(await orig<typeof import('../api/inbox')>()),
  listConversations,
}));

// The in-screen thread detail view (opened when propless) loads via this callable.
// `markAllThreadsRead` is the bulk clear behind the messages panel's header action.
const { getConversationThread, markAllThreadsRead } = vi.hoisted(() => ({
  getConversationThread: vi.fn(),
  markAllThreadsRead: vi.fn(),
}));
vi.mock('../api/inboxThread', async (orig) => ({
  ...(await orig<typeof import('../api/inboxThread')>()),
  getConversationThread,
  markAllThreadsRead,
}));

// FOUR bounded listeners come through this hook: the four Channels streams
// (voicemails, calls_log, sms_messages, emails). The mock dispatches on
// `spec.path` rather than answering every call the same way: a single
// mockReturnValue would hand voicemail documents to the call mapper. Note:
// Notifications were removed from Inbox in the product ruling D1 separation
// (Inbox = messages, Notifications screen = alerts). Tests still mock
// notifications for coverage of edge cases, but the component no longer
// subscribes to NOTIFICATIONS_QUERY.
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// The channel rows open this sheet, whose own behaviour is covered in
// components/ThreadActionsCard.test.tsx. Stubbed to a marker here so these
// tests assert the LIST's wiring, not the sheet's internals.
vi.mock('../components/ThreadActionsCard', () => ({
  ThreadActionsCard: ({ entry, onClose }: { entry: { id: string }; onClose: () => void }) => (
    <div data-testid="thread-actions">
      <span>actions for {entry.id}</span>
      <button type="button" onClick={onClose}>
        Dismiss actions
      </button>
    </div>
  ),
}));

const { bulkMarkNotificationsRead } = vi.hoisted(() => ({ bulkMarkNotificationsRead: vi.fn() }));
vi.mock('../api/notifications', async (orig) => ({
  ...(await orig<typeof import('../api/notifications')>()),
  bulkMarkNotificationsRead,
}));

import { Inbox } from './Inbox';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function notif(over: Partial<NotificationEntry>): NotificationEntry {
  return {
    _id: 'n1',
    key: 'kincare.booking.confirm',
    title: 'Booking confirmed',
    category: 'bookings',
    createdAt: fakeTs('2026-07-16T09:30:00Z'),
    ...over,
  };
}


function thread(over: Partial<ConversationSummary>): ConversationSummary {
  return {
    kinfolkId: 'k1',
    kinfolkName: 'The Alvarez Household',
    lastMessagePreview: 'Thanks for the update!',
    lastMessageAtMs: Date.parse('2026-07-16T20:00:00.000Z'),
    lastSenderRole: 'kinfolk',
    unreadForAdmin: true,
    messageCount: 4,
    ...over,
  };
}

/** Collection paths the screen listens to (keyed for the mock). Notifications
 * included for test setup but no longer subscribed by Inbox per product D1. */
type StreamPath = 'notifications' | 'voicemails' | 'calls_log' | 'sms_messages' | 'emails';

/**
 * Per-path listener states. Anything a test does not name resolves READY AND
 * EMPTY, which is the honest default: the section then renders its proven-empty
 * state rather than a spinner that never finishes.
 */
function streams(over: Partial<Record<StreamPath, Async<unknown[]>>> = {}) {
  const empty: Async<unknown[]> = { status: 'ready', data: [] };
  useCollection.mockImplementation((spec: { path: string }) => {
    return over[spec.path as StreamPath] ?? empty;
  });
}

const ready = (data: unknown[]): Async<unknown[]> => ({ status: 'ready', data });

beforeEach(() => {
  listConversations.mockReset();
  // Default: every listener resolves empty, so the message-thread assertions
  // below are unaffected by them unless a test says otherwise.
  useCollection.mockReset();
  streams();
  bulkMarkNotificationsRead.mockReset().mockResolvedValue(1);
  markAllThreadsRead.mockReset();
});

/**
 * Only the day-grouping/label tests fake the clock, and fake ONLY `Date`
 * (`toFake: ['Date']`), leaving `setTimeout`/`setInterval` real so RTL's
 * `findBy*`/`waitFor` polling (which the async `listConversations` load needs)
 * keeps working. This is the same split Sessions.test.tsx uses (there, fake
 * timers are avoided entirely for click-driven tests because full fake timers
 * don't mix with userEvent's own delays); faking only `Date` sidesteps that
 * tradeoff so this helper is safe to combine with `await screen.findByText`.
 */
async function withFixedToday(fixedNow: Date, run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixedNow);
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe('Inbox screen', () => {
  it('loads and renders a thread row with household, preview, and count', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    expect(await screen.findByText('The Alvarez Household')).toBeInTheDocument();
    expect(screen.getByText('Thanks for the update!')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('prefixes the preview with "You:" only when the last sender was the auntie', async () => {
    listConversations.mockResolvedValue([thread({ lastSenderRole: 'auntie', lastMessagePreview: 'On my way!' })]);
    render(<Inbox />);
    expect(await screen.findByText('You: On my way!')).toBeInTheDocument();
  });

  it('does not prefix "You:" for a kinfolk-sent message', async () => {
    listConversations.mockResolvedValue([thread({ lastSenderRole: 'kinfolk', lastMessagePreview: 'When can you come by?' })]);
    render(<Inbox />);
    expect(await screen.findByText('When can you come by?')).toBeInTheDocument();
    expect(screen.queryByText(/^You:/)).toBeNull();
  });

  it('falls back to the kinfolkId when kinfolkName is blank (defensive read)', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k-blank', kinfolkName: '' })]);
    render(<Inbox />);
    expect(await screen.findByText('k-blank')).toBeInTheDocument();
  });

  it('shows a placeholder rather than a blank line for an empty preview', async () => {
    listConversations.mockResolvedValue([thread({ lastMessagePreview: '' })]);
    render(<Inbox />);
    expect(await screen.findByText('(no message yet)')).toBeInTheDocument();
  });

  it('surfaces a load failure naming the callable, never a false empty list', async () => {
    listConversations.mockRejectedValueOnce(new Error('permission-denied'));
    render(<Inbox />);
    expect(await screen.findByText(/listConversations failed: permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
  });

  it('retries the load on demand via AsyncRegion', async () => {
    listConversations.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText(/listConversations failed/i);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('The Alvarez Household')).toBeInTheDocument();
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('renders the proven-empty state only when the load is ready and genuinely empty', async () => {
    listConversations.mockResolvedValue([]);
    render(<Inbox />);
    expect(await screen.findByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('reloads the list via the Reload button', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('shows an "N unread" badge counting only unread threads, never during loading', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k1', unreadForAdmin: true }),
      thread({ kinfolkId: 'k2', unreadForAdmin: false }),
    ]);
    streams({ notifications: { status: 'loading' } });
    render(<Inbox />);
    // Not present while BOTH sections are still loading (asyncScalar-style: a
    // claim only once something has actually resolved).
    expect(screen.queryByText(/\d+ unread/)).toBeNull();
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
  });

  it('the Unread filter tab shows only unread threads, scoped by row container', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k1', kinfolkName: 'Unread Household', unreadForAdmin: true }),
      thread({ kinfolkId: 'k2', kinfolkName: 'Read Household', unreadForAdmin: false }),
    ]);
    render(<Inbox />);
    await screen.findByText('Unread Household');
    expect(screen.getByText('Read Household')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByText('Unread Household')).toBeInTheDocument();
    expect(screen.queryByText('Read Household')).toBeNull();
  });

  it('the All tab is selected by default and Unread becomes selected on click', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows "Nothing matches this filter" rather than the top-level empty state when a filter empties the list', async () => {
    listConversations.mockResolvedValue([thread({ unreadForAdmin: false })]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByText('Nothing matches this filter.')).toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).toBeNull();
  });

  it('groups a late-evening local thread under its LOCAL day, not the UTC-next day a raw slice would give (AO-18)', async () => {
    await withFixedToday(new Date(2026, 6, 16, 12, 0, 0), async () => {
      // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips to this UTC
      // instant, the same shape appendMessage/Date.now() would produce for an
      // 8pm-local message. A raw `new Date(ms).toISOString().slice(0, 10)`
      // would wrongly group it under 2026-07-17.
      listConversations.mockResolvedValue([thread({ lastMessageAtMs: Date.parse('2026-07-17T01:00:00.000Z') })]);
      render(<Inbox />);
      expect(await screen.findByText('Today', { selector: '.inbox__day-header' })).toBeInTheDocument();
      expect(screen.queryByText('Tomorrow', { selector: '.inbox__day-header' })).toBeNull();
    });
  });

  it('shows the LOCAL clock time in the row, not the UTC hour', async () => {
    listConversations.mockResolvedValue([thread({ lastMessageAtMs: Date.parse('2026-07-17T01:00:00.000Z') })]);
    render(<Inbox />);
    expect(await screen.findByText('20:00')).toBeInTheDocument();
  });

  it('groups two threads on different LOCAL days under separate headers, newest day first', async () => {
    await withFixedToday(new Date(2026, 6, 20, 12, 0, 0), async () => {
      listConversations.mockResolvedValue([
        thread({
          kinfolkId: 'k-earlier',
          kinfolkName: 'Earlier Household',
          lastMessageAtMs: Date.parse('2026-07-16T20:00:00.000Z'),
        }),
        thread({
          kinfolkId: 'k-later',
          kinfolkName: 'Later Household',
          lastMessageAtMs: Date.parse('2026-07-18T20:00:00.000Z'),
        }),
      ]);
      render(<Inbox />);
      await screen.findByText('Later Household');
      // Both dates are >1 day from the fixed "today" (2026-07-20), so both
      // render as "Weekday, Mon DD" labels, never Today/Tomorrow/Yesterday,
      // newest first per groupThreadsByDay.
      //
      // Level FOUR, not three: the day groups now nest inside the waiting/
      // answered status sections, which own level three. `groupThreadsByDay`
      // still runs (the AO-18 local-day fix is unchanged), one level deeper.
      const headers = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
      expect(headers).toEqual(['Sat, Jul 18', 'Thu, Jul 16']);
    });
  });

  it('calls onSelectThread with the kinfolkId when a row is activated', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1' })]);
    const onSelectThread = vi.fn();
    render(<Inbox onSelectThread={onSelectThread} />);
    await userEvent.click(await screen.findByText('The Alvarez Household'));
    expect(onSelectThread).toHaveBeenCalledWith('k1');
  });

  it('propless, opening a row shows the in-screen ConversationThread (rows are interactive)', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1' })]);
    getConversationThread.mockResolvedValue([]);
    render(<Inbox />);
    // The row is now a real button (the thread detail view exists), not a static div.
    const row = (await screen.findByText('The Alvarez Household')).closest('.inbox__row-main');
    expect(row?.tagName).toBe('BUTTON');

    await userEvent.click(row as HTMLElement);
    // The thread detail view took over: its Back control + reply composer render.
    expect(await screen.findByRole('button', { name: /back to inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reply/i })).toBeInTheDocument();
    expect(getConversationThread).toHaveBeenCalledWith('k1');
  });

  it('renders a real <button> row once onSelectThread IS wired', async () => {
    listConversations.mockResolvedValue([thread({})]);
    render(<Inbox onSelectThread={vi.fn()} />);
    await screen.findByText('The Alvarez Household');
    const row = screen.getByText('The Alvarez Household').closest('.inbox__row-main');
    expect(row?.tagName).toBe('BUTTON');
  });
});

/**
 * Status grouping + the bulk clear (PR7 / item 6).
 *
 * The two are one feature: the operator's question on opening the Inbox is
 * "who is waiting on me", and the answer is either a short list to work or a
 * pile to clear. Day grouping stays underneath both sections, so the AO-18
 * local-day guarantee is untouched.
 */
describe('Inbox waiting/answered sections', () => {
  it('sorts the list into Waiting on a reply above Answered', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k-answered', kinfolkName: 'Answered Household', unreadForAdmin: false }),
      thread({ kinfolkId: 'k-waiting', kinfolkName: 'Waiting Household', unreadForAdmin: true }),
    ]);
    render(<Inbox />);
    await screen.findByText('Waiting Household');
    const sections = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(sections).toEqual(['Waiting on a reply', 'Answered']);
  });

  it('says a section is empty rather than dropping its header', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k1', kinfolkName: 'Answered Household', unreadForAdmin: false }),
    ]);
    render(<Inbox />);
    await screen.findByText('Answered Household');
    expect(screen.getByRole('heading', { level: 3, name: 'Waiting on a reply' })).toBeInTheDocument();
    expect(screen.getByText('Nothing is waiting on a reply.')).toBeInTheDocument();
  });

  it('drops the Answered header under the Unread chip rather than claiming nothing was answered', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k-waiting', kinfolkName: 'Waiting Household', unreadForAdmin: true }),
      thread({ kinfolkId: 'k-answered', kinfolkName: 'Answered Household', unreadForAdmin: false }),
    ]);
    render(<Inbox />);
    await screen.findByText('Answered Household');
    await userEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    // "Answered / Nothing answered yet" here would be a falsehood: the answered
    // thread exists, the filter is hiding it.
    expect(screen.queryByRole('heading', { level: 3, name: 'Answered' })).toBeNull();
    expect(screen.queryByText('No answered threads yet.')).toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Waiting on a reply' })).toBeInTheDocument();
  });

  it('still groups each section by LOCAL day underneath (groupThreadsByDay is not replaced)', async () => {
    await withFixedToday(new Date(2026, 6, 16, 12, 0, 0), async () => {
      listConversations.mockResolvedValue([
        thread({ kinfolkId: 'k1', lastMessageAtMs: Date.parse('2026-07-17T01:00:00.000Z') }),
      ]);
      render(<Inbox />);
      expect(await screen.findByText('Today', { selector: '.inbox__day-header' })).toBeInTheDocument();
    });
  });
});

describe('Inbox "Mark all read"', () => {
  it('clears the badge and reports the count after marking all read', async () => {
    listConversations
      .mockResolvedValueOnce([
        thread({ kinfolkId: 'k1', unreadForAdmin: true }),
        thread({ kinfolkId: 'k2', unreadForAdmin: true }),
      ])
      .mockResolvedValue([
        thread({ kinfolkId: 'k1', unreadForAdmin: false }),
        thread({ kinfolkId: 'k2', unreadForAdmin: false }),
      ]);
    markAllThreadsRead.mockResolvedValue({ cleared: 4 });
    render(<Inbox />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByRole('status')).toHaveTextContent('4 threads marked read');
    // The count came from a RELOAD, not an optimistic local edit.
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  it('leaves the badge alone and shows the error when the write fails', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: true })]);
    markAllThreadsRead.mockRejectedValue(new Error('unavailable'));
    render(<Inbox />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.getByText(/unread/)).toBeInTheDocument();
  });

  it('says "1 thread" for a single cleared thread, not "1 threads"', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: true })]);
    markAllThreadsRead.mockResolvedValue({ cleared: 1 });
    render(<Inbox />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 thread marked read');
  });

  it('is absent with nothing unread, rather than offering a control that would clear nothing', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: false })]);
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('does not fire the callable twice while the first write is still in flight', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: true })]);
    let release: (v: { cleared: number }) => void = () => {};
    markAllThreadsRead.mockReturnValue(
      new Promise<{ cleared: number }>((resolve) => {
        release = resolve;
      }),
    );
    render(<Inbox />);
    const button = await screen.findByRole('button', { name: 'Mark all read' });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(markAllThreadsRead).toHaveBeenCalledTimes(1);
    release({ cleared: 1 });
  });
});

/**
 * Badge semantics after separation: Inbox counts message threads only.
 * Notifications are on the Notifications screen per product ruling D1.
 */
describe('Inbox badge semantics', () => {
  it('badge counts unread message threads only, never notifications', async () => {
    listConversations.mockResolvedValue([
      thread({ kinfolkId: 'k1', unreadForAdmin: true }),
      thread({ kinfolkId: 'k2', unreadForAdmin: true }),
    ]);
    streams({ notifications: ready([notif({ _id: 'n1' }), notif({ _id: 'n2' }), notif({ _id: 'n3' })]) });
    render(<Inbox />);
    // 2 unread threads. The 3 notifications are on the Notifications screen, not here.
    expect(await screen.findByText('2 unread')).toBeInTheDocument();
    expect(screen.queryByText('5 unread')).toBeNull();
  });

  it('shows badge when threads load unread, even if notifications still loading', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: true })]);
    streams({ notifications: { status: 'loading' } });
    render(<Inbox />);
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
  });

  it('hides badge when threads load but none are unread, even with unread notifications present', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: false })]);
    streams({ notifications: ready([notif({ _id: 'n1' })]) });
    render(<Inbox />);
    await screen.findByText('The Alvarez Household');
    expect(screen.queryByText(/\d+ unread/)).toBeNull();
  });

  it('does NOT render the Notifications section, even when notifications present', async () => {
    listConversations.mockResolvedValue([]);
    streams({ notifications: ready([notif({ _id: 'n1', title: 'Invoice overdue' })]) });
    render(<Inbox />);
    expect(screen.queryByText('Invoice overdue')).toBeNull();
    expect(screen.queryByText('Notifications')).toBeNull();
  });
});
/**
 * Task 6.1: the four external channel streams and the unified list.
 *
 * Every listener here comes through `useCollection`, which is the ONLY reason a
 * Stage-0I sandbox account is safe on this screen: all four collections are
 * `isAuntie()`-only and already listed in `SUPPRESSED_IN_TEST_MODE`, and that
 * suppression lives inside the hook. `channelsUseCollectionPaths` below pins
 * that the screen never reaches around it.
 */
describe('Inbox channels', () => {
  const voicemail = (over: Record<string, unknown> = {}) => ({
    _id: 'vm1',
    kinfolkName: 'The Alvarez Household',
    callerNumber: '+15551234567',
    transcript: 'Can you come Thursday?',
    audioUrl: 'https://api.twilio.com/rec1',
    timestamp: '2026-07-20T14:00:00.000Z',
    replyStatus: 'unread',
    ...over,
  });
  it('opens exactly the four bounded channel listeners, all through useCollection', async () => {
    listConversations.mockResolvedValue([]);
    render(<Inbox />);
    await screen.findByText('Channels');
    const specs = useCollection.mock.calls.map((c) => c[0] as { path: string; order: [string, string]; max: number });
    const channels = specs.filter((s) => s.path !== 'notifications');
    expect([...new Set(channels.map((s) => s.path))].sort()).toEqual([
      'calls_log',
      'emails',
      'sms_messages',
      'voicemails',
    ]);
    // Bounded and server-ordered by construction (closes AO-29), and ordered on
    // the ISO-STRING `timestamp` every writer stamps, never on a Timestamp
    // bound, which would match nothing and would not error.
    for (const s of channels) {
      expect(s.order).toEqual(['timestamp', 'desc']);
      expect(s.max).toBe(200);
    }
  });
  it('merges the four streams into one list, newest first', async () => {
    listConversations.mockResolvedValue([]);
    streams({
      voicemails: ready([voicemail({ _id: 'vm1', timestamp: '2026-07-20T10:00:00.000Z' })]),
      calls_log: ready([
        { _id: 'c1', kinfolkName: 'Okafor Household', status: 'missed', timestamp: '2026-07-20T13:00:00.000Z' },
      ]),
      sms_messages: ready([
        { _id: 's1', kinfolkName: 'Bell Household', body: 'See you then', timestamp: '2026-07-20T12:00:00.000Z' },
      ]),
      emails: ready([
        { _id: 'm1', kinfolkName: 'Diaz Household', subject: 'Invoice', timestamp: '2026-07-20T11:00:00.000Z' },
      ]),
    });
    render(<Inbox />);
    const panel = (await screen.findByText('Channels')).closest('section') as HTMLElement;
    const names = [...panel.querySelectorAll('.inbox__row-name')].map((n) => n.textContent);
    expect(names).toEqual(['Okafor Household', 'Bell Household', 'Diaz Household', 'The Alvarez Household']);
  });
  it('filters to one channel, and back to all', async () => {
    listConversations.mockResolvedValue([]);
    streams({
      voicemails: ready([voicemail()]),
      calls_log: ready([{ _id: 'c1', kinfolkName: 'Okafor Household', timestamp: '2026-07-20T13:00:00.000Z' }]),
    });
    render(<Inbox />);
    await screen.findByText('Channels');
    await userEvent.click(screen.getByRole('tab', { name: 'Voicemails' }));
    expect(screen.queryByText('Okafor Household')).toBeNull();
    expect(screen.getByText('Can you come Thursday?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'All channels' }));
    expect(screen.getByText('Okafor Household')).toBeInTheDocument();
  });
  it('says so honestly when a filtered channel has nothing on it', async () => {
    listConversations.mockResolvedValue([]);
    streams({ voicemails: ready([voicemail()]) });
    render(<Inbox />);
    await screen.findByText('Channels');
    await userEvent.click(screen.getByRole('tab', { name: 'Emails' }));
    expect(screen.getByText('Nothing on this channel yet.')).toBeInTheDocument();
  });
  /**
   * Four streams, four independent outcomes. Collapsing them into one state
   * would let the worst of them decide what the operator sees.
   */
  it('names a single failing stream and still renders the three that loaded', async () => {
    listConversations.mockResolvedValue([]);
    streams({
      voicemails: ready([voicemail()]),
      emails: { status: 'error', message: 'Missing or insufficient permissions.' },
    });
    render(<Inbox />);
    await screen.findByText('Channels');
    expect(screen.getByText(/Couldn.t load emails: Missing or insufficient permissions\./)).toBeInTheDocument();
    expect(screen.getByText('The Alvarez Household')).toBeInTheDocument();
  });
  it('offers a per-stream retry that re-subscribes only that listener', async () => {
    listConversations.mockResolvedValue([]);
    const retry = vi.fn();
    streams({ calls_log: { status: 'error', message: 'listener detached', retry } });
    render(<Inbox />);
    await screen.findByText('Channels');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('never claims the channels are empty while a read is still failing', async () => {
    listConversations.mockResolvedValue([]);
    streams({ emails: { status: 'error', message: 'permission-denied' } });
    render(<Inbox />);
    await screen.findByText('Channels');
    expect(screen.queryByText(/No voicemails, calls, texts or emails yet/i)).toBeNull();
  });
  it('never claims the channels are empty while a read is still in flight', async () => {
    listConversations.mockResolvedValue([]);
    streams({ sms_messages: { status: 'loading' } });
    render(<Inbox />);
    await screen.findByText('Channels');
    expect(screen.getByText(/Still loading text messages/)).toBeInTheDocument();
    expect(screen.queryByText(/No voicemails, calls, texts or emails yet/i)).toBeNull();
  });
  it('shows the proven-empty state only once all four have really resolved empty', async () => {
    listConversations.mockResolvedValue([]);
    render(<Inbox />);
    await screen.findByText('Channels');
    expect(screen.getByText(/No voicemails, calls, texts or emails yet/i)).toBeInTheDocument();
  });
  /**
   * The badge in the Channels header says "waiting on a reply", NOT "unread".
   * The rail's number (lib/useUnreadInbox.ts) counts message threads off one
   * listener; a channel count sharing that word would put two numbers behind it.
   */
  it('counts voicemails waiting on a reply under their own noun, never as "unread"', async () => {
    listConversations.mockResolvedValue([]);
    streams({
      voicemails: ready([
        voicemail({ _id: 'a', replyStatus: 'unread' }),
        voicemail({ _id: 'b', replyStatus: 'UNREAD' }),
        voicemail({ _id: 'c', replyStatus: 'replied' }),
      ]),
    });
    render(<Inbox />);
    expect(await screen.findByText('2 waiting on a reply')).toBeInTheDocument();
  });
  it('badge counts threads only, excludes channels', async () => {
    listConversations.mockResolvedValue([thread({ kinfolkId: 'k1', unreadForAdmin: true })]);
    streams({
      notifications: ready([notif({ _id: 'n1' })]),
      voicemails: ready([voicemail({ _id: 'a' }), voicemail({ _id: 'b' })]),
    });
    render(<Inbox />);
    // 1 thread. Notifications and voicemails are NOT included in the badge.
    expect(await screen.findByText('1 unread')).toBeInTheDocument();
    expect(screen.queryByText('2 unread')).toBeNull();
    expect(screen.queryByText('3 unread')).toBeNull();
  });
  it('opens the actions sheet for the row that was clicked, and closes it again', async () => {
    listConversations.mockResolvedValue([]);
    streams({ voicemails: ready([voicemail({ _id: 'vm-clicked' })]) });
    render(<Inbox />);
    await screen.findByText('Channels');
    await userEvent.click(screen.getByText('The Alvarez Household'));
    expect(await screen.findByText('actions for vm-clicked')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss actions' }));
    expect(screen.queryByTestId('thread-actions')).toBeNull();
  });
  it('flags a missed call and an unanswered voicemail on their rows', async () => {
    listConversations.mockResolvedValue([]);
    streams({
      voicemails: ready([voicemail()]),
      // Stored capitalized: normalized in memory, never with a server equality.
      calls_log: ready([
        { _id: 'c1', kinfolkName: 'Okafor Household', status: 'Missed', timestamp: '2026-07-20T13:00:00.000Z' },
      ]),
    });
    render(<Inbox />);
    await screen.findByText('Channels');
    expect(screen.getByText('missed')).toBeInTheDocument();
    expect(screen.getByText('waiting on a reply')).toBeInTheDocument();
  });
  it('renders a row for a caller who matched no household rather than dropping it', async () => {
    listConversations.mockResolvedValue([]);
    // twilioInboundVoicemail writes a literal null kinfolkId on a no-match.
    streams({
      voicemails: ready([voicemail({ _id: 'vm9', kinfolkId: null, kinfolkName: '', callerNumber: '+15559998888' })]),
    });
    render(<Inbox />);
    await screen.findByText('Channels');
    expect(screen.getByText('+15559998888')).toBeInTheDocument();
  });
});
