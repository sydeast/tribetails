// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RoutePlan } from '../../api/route';

const { optimizeRoute } = vi.hoisted(() => ({ optimizeRoute: vi.fn() }));
vi.mock('../../api/route', async (orig) => ({
  ...(await orig<typeof import('../../api/route')>()),
  optimizeRoute,
}));

import { RouteOptimizerWidget } from './RouteOptimizerWidget';

function plan(over: Partial<RoutePlan> = {}): RoutePlan {
  return {
    totalMiles: 12.34,
    totalMinutes: 65,
    stops: [
      { order: 1, sessionId: 'a', kinfolkId: 'k1', household: 'Rivera', address: '12 Oak St', arrivalEta: '09:15' },
      { order: 2, sessionId: 'b', kinfolkId: 'k2', household: 'Halbrook', address: '9 Elm Ave', arrivalEta: '09:50' },
    ],
    unroutable: [],
    ...over,
  };
}

beforeEach(() => {
  optimizeRoute.mockReset();
});

describe('RouteOptimizerWidget', () => {
  it('shows the totals and the ordered stops', async () => {
    optimizeRoute.mockResolvedValue(plan());
    render(<RouteOptimizerWidget />);

    expect(await screen.findByText('Rivera')).toBeInTheDocument();
    expect(screen.getByText('12.3 mi')).toBeInTheDocument();
    expect(screen.getByText(/1h 05m driving/)).toBeInTheDocument();
    expect(screen.getByText('09:50')).toBeInTheDocument();
  });

  it('lists unroutable visits fail-loud instead of dropping them', async () => {
    optimizeRoute.mockResolvedValue(
      plan({ stops: [], unroutable: [{ sessionId: 'z', household: 'Nomad', reason: 'No service address on file' }] }),
    );
    render(<RouteOptimizerWidget />);

    expect(await screen.findByText(/couldn.t route 1 visit/i)).toBeInTheDocument();
    expect(screen.getByText('Nomad')).toBeInTheDocument();
    expect(screen.getByText('No service address on file')).toBeInTheDocument();
  });

  it('shows the empty state when there is nothing to route', async () => {
    optimizeRoute.mockResolvedValue(plan({ stops: [], unroutable: [] }));
    render(<RouteOptimizerWidget />);
    expect(await screen.findByText(/no visits to route/i)).toBeInTheDocument();
  });

  it('fails loud (names the callable) when optimize rejects', async () => {
    optimizeRoute.mockRejectedValue(new Error('MAPBOX_TOKEN missing'));
    render(<RouteOptimizerWidget />);
    expect(await screen.findByText(/optimizeRoute:.*failed:.*MAPBOX_TOKEN missing/i)).toBeInTheDocument();
  });
});
