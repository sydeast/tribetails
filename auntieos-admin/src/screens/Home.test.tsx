// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { DashWidget } from '../lib/dashboardLayout';

const { useNavigate, navigate } = vi.hoisted(() => {
  const navigate = vi.fn();
  return { useNavigate: () => navigate, navigate };
});
vi.mock('@tanstack/react-router', () => ({ useNavigate }));

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('../lib/auth', () => ({ useAuth }));

const { getDashboardLayout, saveDashboardLayout } = vi.hoisted(() => ({
  getDashboardLayout: vi.fn(),
  saveDashboardLayout: vi.fn(),
}));
vi.mock('../api/dashboardLayout', () => ({ getDashboardLayout, saveDashboardLayout }));

// The seven live widgets each self-load from Firestore or a callable. This
// suite is about the BOARD (order, edit chrome, persistence), so each is stubbed
// down to a marker; every widget has its own suite next door.
vi.mock('./widgets/UnreadMessagesWidget', () => ({
  UnreadMessagesWidget: ({ onOpenInbox }: { onOpenInbox: () => void }) => (
    <button type="button" onClick={onOpenInbox}>
      open inbox
    </button>
  ),
}));
vi.mock('./widgets/SafeboxWidget', () => ({ SafeboxWidget: () => <p>safebox body</p> }));
vi.mock('./widgets/CareFlagsWidget', () => ({ CareFlagsWidget: () => <p>care flags body</p> }));
vi.mock('./widgets/ExpirationCountdownWidget', () => ({
  ExpirationCountdownWidget: () => <p>expirations body</p>,
}));
vi.mock('./widgets/RouteOptimizerWidget', () => ({ RouteOptimizerWidget: () => <p>route body</p> }));
vi.mock('./widgets/ExpenseQuickLogWidget', () => ({
  ExpenseQuickLogWidget: () => <p>expense body</p>,
}));
vi.mock('./widgets/SuppliesTrackerWidget', () => ({
  SuppliesTrackerWidget: () => <p>supplies body</p>,
}));

import { Home, WEB_DEFAULT_DASHBOARD } from './Home';

/** The widget keys currently on the board, in rendered order. */
function boardOrder(): string[] {
  return [...document.querySelectorAll('.home-dash__cell')].map(
    (el) => el.getAttribute('data-widget') ?? '',
  );
}

function w(key: string, size: 'compact' | 'wide' = 'compact'): DashWidget {
  return { key, size } as DashWidget;
}

beforeEach(() => {
  navigate.mockReset();
  getDashboardLayout.mockReset();
  saveDashboardLayout.mockReset();
  useAuth.mockReturnValue({ status: 'signedIn', user: { uid: 'op-1' } });
  getDashboardLayout.mockResolvedValue(WEB_DEFAULT_DASHBOARD.map((x) => ({ ...x })));
  saveDashboardLayout.mockImplementation((list: readonly DashWidget[]) =>
    Promise.resolve(list.map((x) => ({ ...x }))),
  );
});

describe('Home board order', () => {
  it('renders the widgets in the MODEL order, not in source order', async () => {
    // The proof that the board is model-driven: this order exists nowhere in
    // Home.tsx's markup, and no arrangement of that markup could produce it.
    getDashboardLayout.mockResolvedValue([w('supplies'), w('careFlags'), w('safebox')]);
    render(<Home />);

    await waitFor(() => expect(boardOrder()).toEqual(['supplies', 'careFlags', 'safebox']));
    expect(screen.queryByText('route body')).toBeNull();
  });

  it('gives a wide widget the full-width cell and a compact one a single track', async () => {
    getDashboardLayout.mockResolvedValue([w('supplies', 'wide'), w('careFlags')]);
    render(<Home />);

    await waitFor(() => expect(boardOrder()).toEqual(['supplies', 'careFlags']));
    expect(document.querySelector('[data-widget="supplies"]')).toHaveClass('home-dash__cell--wide');
    expect(document.querySelector('[data-widget="careFlags"]')).toHaveClass(
      'home-dash__cell--compact',
    );
  });

  it('keeps a card this surface has not ported, as a named placeholder', async () => {
    // Dropping it would delete the operator's phone board on their first web
    // reorder, because both surfaces write ONE list.
    getDashboardLayout.mockResolvedValue([w('cashFlow'), w('supplies')]);
    render(<Home />);

    await waitFor(() => expect(boardOrder()).toEqual(['cashFlow', 'supplies']));
    expect(screen.getByText('Cash Flow')).toBeInTheDocument();
    expect(screen.getByText(/built in the phone app/i)).toBeInTheDocument();
  });

  it('falls back to the seven cards this admin already had, only when nothing is stored', async () => {
    // getDashboardLayout resolves the SHIPPED default when the field is empty,
    // and that default names three cards the React admin has not built, so
    // honouring it literally would give a new operator an empty Home.
    render(<Home />);
    await waitFor(() =>
      expect(boardOrder()).toEqual(WEB_DEFAULT_DASHBOARD.map((x) => x.key)),
    );
  });
});

describe('Home customize mode', () => {
  it('toggles Customize and Done, showing the edit bar per widget', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies')]);
    render(<Home />);
    await screen.findByRole('button', { name: 'Customize' });

    expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Move Key & code safebox down' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Supplies tracker up' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull();
  });

  it('bounds the move controls at the ends of the board', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    expect(screen.getByRole('button', { name: 'Move Key & code safebox up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Supplies tracker down' })).toBeDisabled();
  });

  it('moves a widget, persists the new order and announces the move', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies'), w('careFlags')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    fireEvent.click(screen.getByRole('button', { name: 'Move Key & code safebox down' }));

    expect(boardOrder()).toEqual(['supplies', 'safebox', 'careFlags']);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Key & code safebox moved down to position 2 of 3.',
    );
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenCalledWith([
        w('supplies'),
        w('safebox'),
        w('careFlags'),
      ]),
    );
  });

  it('resizes a widget and says which way', async () => {
    getDashboardLayout.mockResolvedValue([w('supplies'), w('careFlags')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    fireEvent.click(screen.getByRole('button', { name: 'Make Supplies tracker full width' }));

    expect(document.querySelector('[data-widget="supplies"]')).toHaveClass('home-dash__cell--wide');
    expect(screen.getByRole('status')).toHaveTextContent('Supplies tracker is now full width.');
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenCalledWith([w('supplies', 'wide'), w('careFlags')]),
    );
  });

  it('removes a widget and offers it back from the hidden strip', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Supplies tracker from Home' }));
    expect(boardOrder()).toEqual(['safebox']);
    expect(screen.getByRole('status')).toHaveTextContent('Supplies tracker removed from Home.');

    const pill = screen.getByRole('button', { name: 'Add Supplies tracker to Home' });
    fireEvent.click(pill);
    expect(boardOrder()).toEqual(['safebox', 'supplies']);
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenLastCalledWith([w('safebox'), w('supplies')]),
    );
  });

  it('marks the hidden cards this surface cannot draw yet', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    const phoneOnly = screen.getByRole('button', { name: 'Add Cash Flow to Home' });
    expect(phoneOnly).toHaveTextContent('phone app only');
    expect(screen.getByRole('button', { name: 'Add Supplies tracker to Home' })).not.toHaveTextContent(
      'phone app only',
    );
  });

  it('hides the strip when every known card is on the board', async () => {
    const { DASH_KEYS } = await import('../lib/dashboardLayout');
    getDashboardLayout.mockResolvedValue(DASH_KEYS.map((k) => w(k)));
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    expect(screen.queryByText('Hidden cards')).toBeNull();
  });
});

describe('Home keyboard reorder', () => {
  it('keeps focus on the control that moved the widget', async () => {
    // A reorder that dumps focus back at the top of the document is unusable
    // with a keyboard: you cannot move a card two places without hunting for
    // the button again. Keying the cell by widget makes React MOVE the node.
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies'), w('careFlags')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    const down = screen.getByRole('button', { name: 'Move Key & code safebox down' });
    down.focus();
    fireEvent.click(down);

    expect(boardOrder()).toEqual(['supplies', 'safebox', 'careFlags']);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move Key & code safebox down' }),
    );
  });

  it('announces every kind of change through one polite region', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies')]);
    render(<Home />);
    // Present from the first render: a live region created at the same moment
    // as its text is not announced.
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Supplies tracker up' }));
    expect(region).toHaveTextContent('Supplies tracker moved up to position 1 of 2.');
  });
});

describe('Home layout persistence failures', () => {
  it('fails loud AND puts the board back when a save is rejected', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies'), w('careFlags')]);
    saveDashboardLayout.mockRejectedValue(new Error('permission-denied'));
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    fireEvent.click(screen.getByRole('button', { name: 'Move Key & code safebox down' }));
    expect(boardOrder()).toEqual(['supplies', 'safebox', 'careFlags']);

    // A board that LOOKS saved and is not is worse than one that visibly refused.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/permission-denied/);
    expect(alert).toHaveTextContent(/back the way it was/i);
    expect(boardOrder()).toEqual(['safebox', 'supplies', 'careFlags']);
  });

  it('abandons the rest of a queued run once one save has failed', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies'), w('careFlags')]);
    const rejecters: Array<(e: Error) => void> = [];
    saveDashboardLayout.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejecters.push(rej);
        }),
    );

    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    const down = screen.getByRole('button', { name: 'Move Key & code safebox down' });
    fireEvent.click(down);
    await waitFor(() => expect(saveDashboardLayout).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Move Key & code safebox down' }));
    expect(boardOrder()).toEqual(['supplies', 'careFlags', 'safebox']);

    await act(async () => {
      rejecters[0]?.(new Error('unavailable'));
      await Promise.resolve();
    });

    await screen.findByRole('alert');
    expect(boardOrder()).toEqual(['safebox', 'supplies', 'careFlags']);
    // The second move was already queued. Writing it now would persist an
    // arrangement the operator is no longer looking at.
    expect(saveDashboardLayout).toHaveBeenCalledTimes(1);
  });

  it('serializes saves so a fast run of moves cannot land out of order', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies'), w('careFlags')]);
    const sent: DashWidget[][] = [];
    const release: Array<() => void> = [];
    saveDashboardLayout.mockImplementation(
      (list: readonly DashWidget[]) =>
        new Promise((res) => {
          sent.push(list.map((x) => ({ ...x })));
          release.push(() => res(list.map((x) => ({ ...x }))));
        }),
    );

    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    const down = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Move Key & code safebox down' }));

    down();
    await waitFor(() => expect(sent).toHaveLength(1));
    down();
    // The second write has NOT been issued: it is waiting behind the first, so
    // the two cannot arrive at the server out of order.
    expect(sent).toHaveLength(1);

    await act(async () => {
      release[0]?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]?.map((x) => x.key)).toEqual(['supplies', 'safebox', 'careFlags']);
    expect(sent[1]?.map((x) => x.key)).toEqual(['supplies', 'careFlags', 'safebox']);
  });

  it('never reads the profile before writing, so it cannot clobber a field saved elsewhere', async () => {
    getDashboardLayout.mockResolvedValue([w('safebox'), w('supplies')]);
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    getDashboardLayout.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Move Supplies tracker up' }));

    await waitFor(() => expect(saveDashboardLayout).toHaveBeenCalledTimes(1));
    // One read at mount, none per save. A read-modify-write here would hand the
    // callable a stale copy of everything else on the document.
    expect(getDashboardLayout).not.toHaveBeenCalled();
    expect(saveDashboardLayout).toHaveBeenCalledWith([w('supplies'), w('safebox')]);
  });

  it('refuses to offer Customize while the stored layout is unknown', async () => {
    getDashboardLayout.mockRejectedValue(new Error('offline'));
    render(<Home />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/offline/);
    expect(alert).toHaveTextContent(/not the one you saved/i);
    // Saving over a layout we could not read would overwrite it with a guess.
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
    expect(boardOrder()).toEqual(WEB_DEFAULT_DASHBOARD.map((x) => x.key));
  });

  it('retries the load from the banner', async () => {
    getDashboardLayout.mockRejectedValueOnce(new Error('offline'));
    getDashboardLayout.mockResolvedValue([w('supplies')]);
    render(<Home />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(boardOrder()).toEqual(['supplies']));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Customize' })).toBeInTheDocument();
  });
});

describe('Home wiring that predates edit mode', () => {
  it('still opens the Inbox from the unread-messages widget', async () => {
    getDashboardLayout.mockResolvedValue([w('unreadMessages')]);
    render(<Home />);

    fireEvent.click(await screen.findByRole('button', { name: 'open inbox' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/inbox' });
  });
});
