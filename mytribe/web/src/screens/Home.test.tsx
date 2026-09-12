// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { Home } from './Home';

/**
 * Home's version of the false-empty defect, plus the gated-query half that is
 * unique to this screen.
 *
 * `bookings`, `kinTales` and `kin` are all `enabled: home.isSuccess`. When the
 * signal drops, `home` pauses, so those three never even reach 'paused': they
 * sit at pending/idle, which is just as invisible. The household was greeted
 * "Hi , your tribe is in good hands." above three sections each claiming there
 * was nothing there.
 *
 * The pause is the real one, driven through `onlineManager`; the query
 * functions are asserted never to run.
 */

const mocks = vi.hoisted(() => ({
  getMyHome: vi.fn(),
  getMyBookings: vi.fn(),
  getMyKin: vi.fn(),
  getMyKinTales: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyHome: (...args: unknown[]) => mocks.getMyHome(...args),
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyKin: (...args: unknown[]) => mocks.getMyKin(...args),
  getMyKinTales: (...args: unknown[]) => mocks.getMyKinTales(...args),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/PushPrompt', () => ({ PushPrompt: () => null }));
vi.mock('../components/AddToHomeScreen', () => ({ AddToHomeScreen: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

afterEach(() => {
  // Unmount FIRST. Vitest runs afterEach hooks in reverse registration order,
  // so this one fires before test-setup.ts's `cleanup()`: putting the network
  // back while the previous test's component is still mounted resumes its
  // paused queries against mocks the next test has not configured yet, and the
  // leaked render then answers the next test's queries. `onlineManager` is a
  // module singleton, so leaving it offline would poison the rest of the run.
  cleanup();
  onlineManager.setOnline(true);
  vi.clearAllMocks();
});

function renderOffline() {
  onlineManager.setOnline(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>,
  );
}

describe('Home, signal lost with the tab open', () => {
  it('the identity query really is paused, and the three gated ones never start', () => {
    renderOffline();
    expect(mocks.getMyHome).not.toHaveBeenCalled();
    expect(mocks.getMyBookings).not.toHaveBeenCalled();
    expect(mocks.getMyKinTales).not.toHaveBeenCalled();
    expect(mocks.getMyKin).not.toHaveBeenCalled();
  });

  it('does not greet a household by a name it never loaded', () => {
    renderOffline();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/We can.t reach your tribe right now/);
    expect(screen.queryByText(/your tribe is in good hands/)).not.toBeInTheDocument();
  });

  it('every gated section says the read could not be reached, not that it is empty', () => {
    renderOffline();

    expect(screen.getByText(/your schedule has not loaded/)).toBeInTheDocument();
    expect(screen.getByText(/your KinTales has not loaded/)).toBeInTheDocument();
    expect(screen.getByText(/your kin has not loaded/)).toBeInTheDocument();

    expect(screen.queryByText('Nothing on the calendar yet.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your first KinTale will show up here after a visit/)).not.toBeInTheDocument();
  });

  it('gives the live-visit slot a cue rather than silently omitting it', () => {
    renderOffline();
    expect(screen.getByText(/we can.t check whether a visit is under way right now/i)).toBeInTheDocument();
  });
});

describe('Home, online and genuinely empty', () => {
  it('still shows the empty copy when the server answers with nothing', async () => {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    mocks.getMyKin.mockResolvedValue({ kin: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Nothing on the calendar yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Hi Wren, your tribe is in good hands/);
    expect(screen.queryByText(/We can.t reach Tribe Tails/)).not.toBeInTheDocument();
  });
});
