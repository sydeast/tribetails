// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #1833: the one listener behind the bell. These pin the query it opens (the
 * only form firestore.rules admits), who owns it, and what a failure does:
 * no badge, no banner, a console line and a Sentry report.
 */

const fs = vi.hoisted(() => ({
  onSnapshot: vi.fn(),
  stop: vi.fn(),
  next: null as null | ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void),
  fail: null as null | ((err: unknown) => void),
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ collection: name }),
  where: (field: string, op: string, value: unknown) => ({ where: [field, op, value] }),
  orderBy: (field: string, dir: string) => ({ orderBy: [field, dir] }),
  limit: (n: number) => ({ limit: n }),
  query: (...parts: unknown[]) => parts,
  onSnapshot: (...args: unknown[]) => fs.onSnapshot(...args),
}));
vi.mock('../lib/firebase', () => ({ firestore: {} }));

const authMock = vi.hoisted(() => ({ state: { status: 'signedOut' } as { status: string; user?: { uid: string } } }));
vi.mock('../lib/auth', () => ({
  useAuth: () => authMock.state,
  getAuthState: () => authMock.state,
}));
const sentry = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../lib/sentry', () => ({ reportError: sentry.reportError }));

import { UnreadNotificationsBridge } from './UnreadNotificationsBridge';
import { liveUnreadOf, resetUnreadBadge } from '../lib/unreadBadge';

const doc = (id: string, data: Record<string, unknown> = {}) => ({ id, data: () => ({ recipientUid: 'u1', ...data }) });

let queryClient: QueryClient;
function mount() {
  queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <UnreadNotificationsBridge />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  resetUnreadBadge();
  fs.onSnapshot.mockReset();
  fs.stop.mockReset();
  fs.next = null;
  fs.fail = null;
  fs.onSnapshot.mockImplementation((_q: unknown, next: typeof fs.next, fail: typeof fs.fail) => {
    fs.next = next;
    fs.fail = fail;
    return fs.stop;
  });
  sentry.reportError.mockReset();
  authMock.state = { status: 'signedIn', user: { uid: 'u1' } };
});

describe('UnreadNotificationsBridge (#1833)', () => {
  it("listens to the signed-in person's own newest 100 rows, newest first", () => {
    mount();
    expect(fs.onSnapshot).toHaveBeenCalledTimes(1);
    expect(fs.onSnapshot.mock.calls[0]?.[0]).toEqual([
      { collection: 'notifications' },
      { where: ['recipientUid', '==', 'u1'] },
      { orderBy: ['createdAt', 'desc'] },
      { limit: 100 },
    ]);
  });

  it('opens nothing while signed out', () => {
    authMock.state = { status: 'signedOut' };
    mount();
    expect(fs.onSnapshot).not.toHaveBeenCalled();
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
  });

  it('counts a new notice the moment its snapshot arrives', () => {
    mount();
    act(() => fs.next?.({ docs: [doc('a'), doc('b', { readAt: { seconds: 1 } })] }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 1 });
    act(() => fs.next?.({ docs: [doc('new'), doc('a'), doc('b', { readAt: { seconds: 1 } })] }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 2 });
  });

  it('goes to nothing unread when every row is marked read at once', () => {
    mount();
    act(() => fs.next?.({ docs: [doc('a'), doc('b'), doc('c')] }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 3 });
    const readAt = { seconds: 9 };
    act(() => fs.next?.({ docs: [doc('a', { readAt }), doc('b', { readAt }), doc('c', { readAt })] }));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'live', count: 0 });
  });

  it('refreshes the open notifications list on a change, not on the first snapshot', () => {
    mount();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => fs.next?.({ docs: [doc('a')] }));
    expect(invalidate).not.toHaveBeenCalled();
    act(() => fs.next?.({ docs: [doc('new'), doc('a')] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['myNotifications'] });
  });

  it('a failed listener is quiet on screen and reported: error state, console line, Sentry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = mount();
    act(() => fs.next?.({ docs: [doc('a')] }));
    const denied = new Error('Missing or insufficient permissions.');
    act(() => fs.fail?.(denied));
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'error' });
    expect(warn).toHaveBeenCalledWith('Bell unread count unavailable:', denied);
    expect(sentry.reportError).toHaveBeenCalledWith(denied, 'bellUnreadCount');
    // Nothing is drawn: no banner, no pill.
    expect(view.container.innerHTML).toBe('');
    warn.mockRestore();
  });

  it('does not report the denial that follows the end of the session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mount();
    authMock.state = { status: 'signedOut' };
    act(() => fs.fail?.(new Error('Missing or insufficient permissions.')));
    expect(sentry.reportError).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
    warn.mockRestore();
  });

  it('closes the listener and forgets the count on sign-out, and reopens for the next person', () => {
    const view = mount();
    act(() => fs.next?.({ docs: [doc('a')] }));
    authMock.state = { status: 'signedOut' };
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <UnreadNotificationsBridge />
      </QueryClientProvider>,
    );
    expect(fs.stop).toHaveBeenCalledTimes(1);
    expect(liveUnreadOf('fam1')).toEqual({ kind: 'waiting' });
    authMock.state = { status: 'signedIn', user: { uid: 'u2' } };
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <UnreadNotificationsBridge />
      </QueryClientProvider>,
    );
    expect(fs.onSnapshot).toHaveBeenCalledTimes(2);
    expect(fs.onSnapshot.mock.calls[1]?.[0]).toContainEqual({ where: ['recipientUid', '==', 'u2'] });
  });
});
