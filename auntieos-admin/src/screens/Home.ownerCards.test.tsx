// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import type { DashWidget } from '../lib/dashboardLayout';

/**
 * #2208, with the REAL cards. `Home.test.tsx` stubs every card down to a
 * marker, so a marker there proves a card was or was not drawn but not which
 * reads started. Here Cash Flow, Expense quick-log, Supplies and Expirations
 * are the real components over mocked reads: the invoice stream
 * (`lib/firestore#useCollection`) and the callables.
 *
 * Operator ruling 2026-11-14: an Auntie sees and works Supplies and
 * Expirations. Her board names all four cards; the two money cards are not
 * drawn and start no read, Supplies and Expirations are drawn, read, and her
 * +1 restock goes to the server. The owner's board starts all four reads.
 */
const { useRouteContext } = vi.hoisted(() => ({ useRouteContext: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouteContext }));

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('../lib/auth', () => ({ useAuth }));

const { getDashboardLayout } = vi.hoisted(() => ({ getDashboardLayout: vi.fn() }));
vi.mock('../api/dashboardLayout', () => ({ getDashboardLayout, saveDashboardLayout: vi.fn() }));

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { listExpenses, listSupplies, adjustSupply, listExpirations } = vi.hoisted(() => ({
  listExpenses: vi.fn(),
  listSupplies: vi.fn(),
  adjustSupply: vi.fn(),
  listExpirations: vi.fn(),
}));
vi.mock('../api/expenses', async (orig) => ({
  ...(await orig<typeof import('../api/expenses')>()),
  listExpenses,
}));
vi.mock('../api/supplies', async (orig) => ({
  ...(await orig<typeof import('../api/supplies')>()),
  listSupplies,
  adjustSupply,
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
  adjustSupply.mockReset();
  adjustSupply.mockResolvedValue({ onHand: 3 });
  listExpirations.mockReset();
  listExpirations.mockResolvedValue([]);
});


/** A date [days] from today, in the local YYYY-MM-DD the card compares against. */
function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const AUNTIE = { access: { status: 'caretaker' } };

describe('Home owner cards, real reads (#2208)', () => {
  it('draws Supplies and Expirations for an Auntie and reads both, and starts neither money read', async () => {
    useRouteContext.mockReturnValue(AUNTIE);
    listSupplies.mockResolvedValue({
      supplies: [{ _id: 's1', name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' }],
      lowCount: 1,
    });
    listExpirations.mockResolvedValue([
      { _id: 'x1', label: 'Side gate code', dateIso: isoInDays(3), kind: 'gateCode', kinfolkId: 'kf1' },
    ]);
    render(<Home />);
    expect(await screen.findByRole('heading', { name: 'Supplies tracker' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Expiration countdown' })).toBeInTheDocument();
    expect(await screen.findByText('Waste bags')).toBeInTheDocument();
    expect(screen.getByText('2 / 10 rolls')).toBeInTheDocument();
    expect(await screen.findByText('Side gate code')).toBeInTheDocument();
    expect(screen.getByText('in 3 days')).toBeInTheDocument();
    expect(document.querySelectorAll('.home-dash__cell')).toHaveLength(3);
    for (const title of ['Cash Flow', 'Expense quick-log']) {
      expect(screen.queryByRole('heading', { name: title })).toBeNull();
    }
    expect(listSupplies).toHaveBeenCalled();
    expect(listExpirations).toHaveBeenCalled();
    expect(listExpenses).not.toHaveBeenCalled();
    expect(collectionPaths()).not.toContain('invoices');
  });

  it('sends her +1 restock to the server and reloads the list', async () => {
    useRouteContext.mockReturnValue(AUNTIE);
    listSupplies.mockResolvedValue({
      supplies: [{ _id: 's1', name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' }],
      lowCount: 1,
    });
    render(<Home />);
    await screen.findByText('Waste bags');
    const readsBefore = listSupplies.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '+1' }));
    await waitFor(() => expect(adjustSupply).toHaveBeenCalledWith('s1', 1));
    await waitFor(() => expect(listSupplies.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('says so on the row when her restock is refused, and on the card when a list will not load', async () => {
    useRouteContext.mockReturnValue(AUNTIE);
    listSupplies.mockResolvedValue({
      supplies: [{ _id: 's1', name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' }],
      lowCount: 1,
    });
    adjustSupply.mockRejectedValue(new Error('permission-denied'));
    listExpirations.mockRejectedValue(new Error('permission-denied'));
    render(<Home />);
    await screen.findByText('Waste bags');
    fireEvent.click(screen.getByRole('button', { name: '+1' }));
    expect(await screen.findByText(/Could not save:.*permission-denied/i)).toBeInTheDocument();
    expect(await screen.findByText(/Could not load:.*permission-denied/i)).toBeInTheDocument();
  });

  it('shows her the empty states when nothing is low and nothing lapses soon', async () => {
    useRouteContext.mockReturnValue(AUNTIE);
    render(<Home />);
    expect(await screen.findByText(/stocked above par/i)).toBeInTheDocument();
    expect(await screen.findByText(/Nothing lapses in the next 60 days/i)).toBeInTheDocument();
    await act(async () => {});
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
