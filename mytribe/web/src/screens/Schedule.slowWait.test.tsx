// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { SLOW_WAIT_MS } from '../lib/slowWait';
import { Schedule } from './Schedule';

/**
 * The line the 2026-09-12 ruling draws, asserted on a real screen: an offline
 * pause keeps the #805 OFFLINE treatment and must NEVER become the slow-server
 * one, however long it lasts.
 *
 * This is the case a unit test cannot settle on its own. `slowWait.test.ts`
 * proves `waitPhase` refuses to escalate when told the device is offline, and
 * `Loading.test.tsx` proves `LoadingLine` respects that. Neither proves the
 * thing that actually ships, which is that a paused query on a real screen
 * reaches `OfflineNotice` rather than `LoadingLine` at all: that depends on
 * `viewOfQuery` sorting `fetchStatus: 'paused'` out BEFORE the loading arm, one
 * layer above anything either of those specs can see.
 *
 * The pause is the REAL one, following `Schedule.test.tsx`: `onlineManager` is
 * driven offline before render, nothing about the component's state is stubbed,
 * and the query function is asserted never to have run. If the pause stopped
 * producing `fetchStatus: 'paused'` this spec would stop testing anything and
 * would say so.
 */

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn(),
  getMyVisits: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyVisits: (...args: unknown[]) => mocks.getMyVisits(...args),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../lib/breadcrumbs', () => ({ useBreadcrumbs: () => ({ points: [], error: null }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/RouteMap', () => ({ RouteMap: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  // Unmount FIRST: vitest runs afterEach in reverse registration order, so this
  // fires before test-setup.ts's cleanup(). Restoring the network while the
  // previous component is still mounted resumes its paused queries against
  // mocks the next test has not configured. `onlineManager` is a module
  // singleton, so leaving it offline would poison the rest of the run.
  cleanup();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.clearAllMocks();
});

function renderOffline() {
  onlineManager.setOnline(false);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Schedule />
    </QueryClientProvider>,
  );
}

describe('Schedule: an offline pause is not a slow server', () => {
  it('still renders OFFLINE past the slow-wait threshold, and never tap-to-sync', () => {
    renderOffline();

    // Long past the point a slow server would have escalated. Twice over, so a
    // one-shot timer that fired late would still be caught.
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS * 2));

    // The #805 treatment is what is on screen.
    expect(screen.getAllByText(/Your phone is offline|We can.t reach Tribe Tails/).length).toBeGreaterThan(0);

    // And the slow-server treatment is not, in any of its parts.
    expect(screen.queryByRole('button', { name: 'Tap to sync' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.queryByText('Tribe Tails has not answered yet.')).toBeNull();
    expect(document.querySelector('.slow-wait')).toBeNull();

    // The pause is genuine: the read was never even attempted.
    expect(mocks.getMyBookings).not.toHaveBeenCalled();
  });

  it('leaves no waiting region stuck in the slow phase while offline', () => {
    renderOffline();
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS * 2));

    // The state carrier, not `toBeVisible()`: jsdom computes no layout and
    // reports folded content as visible, so what it can honestly answer is
    // which phase each region believes it is in.
    for (const region of Array.from(document.querySelectorAll('[data-phase]'))) {
      expect(region.getAttribute('data-phase')).not.toBe('slow');
    }
  });
});
