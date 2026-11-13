// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { DashWidget } from '../lib/dashboardLayout';

/**
 * #2208, with the REAL cards. `Home.test.tsx` stubs every card down to a
 * marker, so a missing marker there proves a card was not drawn but not that
 * its read never started. Here Cash Flow, Expense quick-log, Supplies and
 * Expirations are the real components over mocked reads: the invoice stream
 * (`lib/firestore#useCollection`) and the three callables. An Auntie's board
 * names all four and starts none of their reads; the owner's starts all four.
 */
const { useRouteContext } = vi.hoisted(() => ({ useRouteContext: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouteContext }));

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('../lib/auth', () => ({ useAuth }));

const { getDashboardLayout } = vi.hoisted(() => ({ getDashboardLayout: vi.fn() }));
vi.mock('../api/dashboardLayout', () => ({ getDashboardLayout, saveDashboardLayout: vi.fn() }));

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { listExpenses, listSupplies, listExpirations } = vi.hoisted(() => ({
  listExpenses: vi.fn(),
  listSupplies: vi.fn(),
  listExpirations: vi.fn(),
}));
vi.mock('../api/expenses', async (orig) => ({
  ...(await orig<typeof import('../api/expenses')>()),
  listExpenses,
}));
vi.mock('../api/supplies', async (orig) => ({
  ...(await orig<typeof import('../api/supplies')>()),
  listSupplies,
}));
vi.mock('../api/expirations', async (orig) => ({
  ...(await orig<typeof import('../api/expirations')>()),
  listExpirations,
}));

import { Home } from './Home';

const OWNER_CARDS: DashWidget[] = [
  { key: 'cashFlow', size: 'compact' },
  { key: 'expenseLog', size: 'compact' },
  { key: 'supplies', size: 'compact' },
  { key: 'expirations', size: 'compact' },
];
/** One of her own cards beside them, so her board is not the default fallback. */
const BOARD: DashWidget[] = [...OWNER_CARDS, { key: 'gatekeeper', size: 'compact' }];

function collectionPaths(): string[] {
  return useCollection.mock.calls.map(([spec]) => (spec as { path: string }).path);
}

beforeEach(() => {
  useAuth.mockReturnValue({ status: 'signedIn', user: { uid: 'uid-1' } });
  getDashboardLayout.mockReset();
  getDashboardLayout.mockResolvedValue({ widgets: BOARD.map((x) => ({ ...x })), isStored: true });
  useCollection.mockReset();
  useCollection.mockReturnValue({ status: 'ready', data: [] });
  listExpenses.mockReset();
  listExpenses.mockResolvedValue({ weekTotalCents: 0, monthTotalCents: 0, expenses: [] });
  listSupplies.mockReset();
  listSupplies.mockResolvedValue({ supplies: [], lowCount: 0 });
  listExpirations.mockReset();
  listExpirations.mockResolvedValue([]);
});

describe('Home owner cards, real reads (#2208)', () => {
  it('starts none of their reads for an Auntie whose layout names all four', async () => {
    useRouteContext.mockReturnValue({ access: { status: 'caretaker' } });
    render(<Home />);
    expect(await screen.findByRole('heading', { name: 'Gatekeeper' })).toBeInTheDocument();
    await act(async () => {});
    expect(document.querySelectorAll('.home-dash__cell')).toHaveLength(1);
    for (const title of ['Cash Flow', 'Expense quick-log', 'Supplies tracker', 'Expiration countdown']) {
      expect(screen.queryByRole('heading', { name: title })).toBeNull();
    }
    expect(listExpenses).not.toHaveBeenCalled();
    expect(listSupplies).not.toHaveBeenCalled();
    expect(listExpirations).not.toHaveBeenCalled();
    expect(collectionPaths()).not.toContain('invoices');
  });

  for (const access of [{ status: 'admin' }, { status: 'testAdmin', testTribeId: 'tribe-sandbox' }, null]) {
    const who = access === null ? 'the offline session' : access.status === 'admin' ? 'the owner' : 'the test admin';
    it(`starts all four reads for ${who}`, async () => {
      useRouteContext.mockReturnValue({ access });
      render(<Home />);
      await waitFor(() => expect(listExpirations).toHaveBeenCalled());
      expect(listExpenses).toHaveBeenCalled();
      expect(listSupplies).toHaveBeenCalled();
      expect(collectionPaths()).toContain('invoices');
      expect(document.querySelectorAll('.home-dash__cell')).toHaveLength(BOARD.length);
    });
  }
});
