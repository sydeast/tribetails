// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { HoldLeaveWhile } from './HoldLeaveWhile';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The blocker is what awaits it; a test that never navigates must not warn.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function mountAt(work: Promise<unknown> | null) {
  const root = createRootRoute();
  const draft = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <>
        <p>Draft screen</p>
        <HoldLeaveWhile work={work} />
      </>
    ),
  });
  const list = createRoute({ getParentRoute: () => root, path: '/bookings', component: () => <p>List screen</p> });
  const router = createRouter({
    routeTree: root.addChildren([draft, list]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByText('Draft screen');
  return router;
}

describe('HoldLeaveWhile (#1895)', () => {
  it('holds a move until the work succeeds, then lets it through', async () => {
    const work = deferred();
    const router = await mountAt(work.promise);
    void router.navigate({ to: '/bookings' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Draft screen')).toBeInTheDocument();
    await act(async () => {
      work.resolve();
      await work.promise;
    });
    await waitFor(() => expect(screen.getByText('List screen')).toBeInTheDocument());
  });

  it('keeps the screen when the work fails, so its error is seen', async () => {
    const work = deferred();
    const router = await mountAt(work.promise);
    // A blocked navigate never settles, so it is not awaited.
    void router.navigate({ to: '/bookings' });
    await act(async () => {
      work.reject(new Error('refused'));
      await work.promise.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText('Draft screen')).toBeInTheDocument();
    expect(screen.queryByText('List screen')).toBeNull();
  });

  it('does not stand in the way when nothing is running', async () => {
    const router = await mountAt(null);
    await act(async () => {
      await router.navigate({ to: '/bookings' });
    });
    expect(await screen.findByText('List screen')).toBeInTheDocument();
  });

  it('renders nothing and does not throw outside a router', () => {
    const { container } = render(<HoldLeaveWhile work={Promise.resolve()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
