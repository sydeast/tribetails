// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { type SessionEntry } from '../api/sessions';
import { type PagedCollection } from '../lib/usePagedCollection';

/**
 * #753: A KIN CARE HAS ITS OWN URL. The operator: "KinCares should have their
 * own id numbers in the params. I don't want to refresh the KinCare."
 *
 * This is the first suite in the tree to mount a real `RouterProvider`
 * (`lib/useHistoryBack.test.tsx` says as much about its own stand-in), and it
 * has to be: what #753 changed is the ROUTING, so a test that stubbed the router
 * would assert the thing it replaced. The tree below mirrors `router.tsx` where
 * it matters -- the pathless `admin` layout, `sessions` and `sessions/$sessionId`
 * as siblings under it -- because `useParams({ from: '/admin/sessions/$sessionId' })`
 * is matched at runtime against the live route ids, not only at compile time.
 *
 * The screens are eager here rather than `lazyRouteComponent`, so a case reads
 * what the route rendered instead of what its chunk loader was doing.
 */
const { useDocById, useCollection } = vi.hoisted(() => ({
  useDocById: vi.fn(),
  useCollection: vi.fn(),
}));
vi.mock('../lib/firestore', () => ({ useDocById, useCollection }));
const { usePagedCollection } = vi.hoisted(() => ({ usePagedCollection: vi.fn() }));
vi.mock('../lib/usePagedCollection', () => ({ usePagedCollection }));
vi.mock('../api/sessionsWrite', () => ({
  setVisitLifecycle: vi.fn(),
  updateKinCareSession: vi.fn(),
}));
vi.mock('../api/bookingsWrite', () => ({ transitionBookingStatus: vi.fn() }));
vi.mock('../api/settings', () => ({
  getBusinessSettings: vi.fn().mockResolvedValue({ serviceRates: {}, serviceDurations: {} }),
}));
vi.mock('../lib/breadcrumbs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/breadcrumbs')>();
  return { ...actual, useBreadcrumbs: () => ({ points: [], error: null, ready: true }) };
});

import { SessionsView } from './SessionsView';
import { SessionDetailView } from './SessionDetailView';

function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 'vis_1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: [],
    kinNames: ['Biscuit'],
    serviceType: 'Dog Walk',
    startTime: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    endTime: '2026-07-16T15:00:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  } as SessionEntry;
}

function paged(rows: SessionEntry[]): PagedCollection<SessionEntry> {
  return {
    state: { status: 'ready', data: rows },
    hasMore: false,
    more: { status: 'idle' },
    loadMore: vi.fn(),
    reload: vi.fn(),
  } as unknown as PagedCollection<SessionEntry>;
}

/** The two routes under the same pathless `admin` layout `router.tsx` puts them under. */
function makeRouter(initialPath: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'admin',
    component: () => <Outlet />,
  });
  const sessionsRoute = createRoute({
    getParentRoute: () => adminRoute,
    path: 'sessions',
    component: SessionsView,
  });
  const sessionDetailRoute = createRoute({
    getParentRoute: () => adminRoute,
    path: 'sessions/$sessionId',
    component: SessionDetailView,
  });
  const routeTree = rootRoute.addChildren([
    adminRoute.addChildren([sessionsRoute, sessionDetailRoute]),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  }) as unknown as Parameters<typeof RouterProvider>[0]['router'];
}

beforeEach(() => {
  useDocById.mockReset();
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] });
  usePagedCollection.mockReset().mockReturnValue(paged([]));
});

describe('/sessions/$sessionId', () => {
  it('renders the named Kin Care from a cold arrival, which is what a refresh is', async () => {
    useDocById.mockReturnValue({ status: 'ready', data: entry({ status: 'ARRIVED' }) });
    const router = makeRouter('/sessions/vis_1');
    render(<RouterProvider router={router} />);

    // The visit, read by the id in the path. No board was mounted first, so this
    // is exactly the refresh the operator asked for.
    expect(await screen.findByRole('heading', { name: 'The Whitfields' })).toBeInTheDocument();
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 'vis_1');
    expect(screen.getByText('ARRIVED')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sessions/vis_1');
  });

  it('reads the id from the path, so two links open two different visits', async () => {
    useDocById.mockReturnValue({ status: 'ready', data: entry({ _id: 'vis_old' }) });
    render(<RouterProvider router={makeRouter('/sessions/vis_old')} />);
    await screen.findByRole('heading', { name: 'The Whitfields' });
    expect(useDocById).toHaveBeenCalledWith('kin_care_sessions', 'vis_old');
  });

  it('says an unknown id is not on file, with the way back to the board, never a blank screen', async () => {
    useDocById.mockReturnValue({ status: 'ready', data: null });
    render(<RouterProvider router={makeRouter('/sessions/vis_gone')} />);
    expect(
      await screen.findByText(/no Kin Care session is on file under this id/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to auntie time/i })).toBeInTheDocument();
  });

  it('does not report a session still loading as a session that is gone', async () => {
    useDocById.mockReturnValue({ status: 'loading' });
    render(<RouterProvider router={makeRouter('/sessions/vis_slow')} />);
    expect(await screen.findByText('Looking this Kin Care session up…')).toBeInTheDocument();
    expect(screen.queryByText(/not on file/i)).toBeNull();
  });

  it('Back returns to the board at /sessions', async () => {
    useDocById.mockReturnValue({ status: 'ready', data: entry() });
    const router = makeRouter('/sessions/vis_1');
    render(<RouterProvider router={router} />);
    await userEvent.click(await screen.findByRole('button', { name: /back to auntie time/i }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions');
    });
  });
});

describe('/sessions, opening a card', () => {
  it('changes the URL to the visit, which is what survives a refresh', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'sess-42' })]));
    useDocById.mockReturnValue({ status: 'ready', data: entry({ _id: 'sess-42' }) });
    const router = makeRouter('/sessions');
    render(<RouterProvider router={router} />);

    await userEvent.click(await screen.findByRole('button', { name: /The Whitfields/i }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions/sess-42');
    });
    // And the detail is what the new URL rendered, not a view the board kept.
    expect(await screen.findByRole('heading', { name: 'The Whitfields' })).toBeInTheDocument();
  });
});
