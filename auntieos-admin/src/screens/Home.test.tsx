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

// All nineteen live widgets self-load from Firestore or a callable. This suite
// is about the BOARD (order, edit chrome, persistence), so each is stubbed down
// to a marker; every widget has its own suite next door.
vi.mock('./widgets/StatsWidget', () => ({ StatsWidget: () => <p>stats body</p> }));
vi.mock('./widgets/TodaysPackWidget', () => ({
  TodaysPackWidget: ({ onOpenSessions }: { onOpenSessions: () => void }) => (
    <button type="button" onClick={onOpenSessions}>
      todays pack body
    </button>
  ),
}));
vi.mock('./widgets/KinTalesPendingWidget', () => ({
  KinTalesPendingWidget: ({ onReviewTales }: { onReviewTales: () => void }) => (
    <button type="button" onClick={onReviewTales}>
      kintales body
    </button>
  ),
}));
vi.mock('./widgets/CashFlowWidget', () => ({ CashFlowWidget: () => <p>cash flow body</p> }));
vi.mock('./widgets/GatekeeperWidget', () => ({ GatekeeperWidget: () => <p>gatekeeper body</p> }));
vi.mock('./widgets/WeatherWidgets', () => ({
  WeatherWatchdogWidget: () => <p>watchdog body</p>,
  HeatIndexWidget: () => <p>heat index body</p>,
}));
vi.mock('./widgets/WeeklyCapacityWidget', () => ({
  WeeklyCapacityWidget: () => <p>capacity body</p>,
}));
vi.mock('./widgets/OverdueVisitsWidget', () => ({
  OverdueVisitsWidget: () => <p>overdue body</p>,
}));
vi.mock('./widgets/PetBreakdownWidget', () => ({
  PetBreakdownWidget: () => <p>pet breakdown body</p>,
}));
vi.mock('./widgets/FrequentFlyersWidget', () => ({
  FrequentFlyersWidget: () => <p>frequent flyers body</p>,
}));
vi.mock('./widgets/HolidayRunwayWidget', () => ({
  HolidayRunwayWidget: () => <p>holiday runway body</p>,
}));
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

import { Home } from './Home';
import { DASH_KEYS, DEFAULT_DASHBOARD } from '../lib/dashboardLayout';

/** The widget keys currently on the board, in rendered order. */
function boardOrder(): string[] {
  return [...document.querySelectorAll('.home-dash__cell')].map(
    (el) => el.getAttribute('data-widget') ?? '',
  );
}

/** Everything rendered inside one widget's cell, edit chrome included. */
function cellText(key: string): string {
  return document.querySelector(`[data-widget="${key}"]`)?.textContent ?? '';
}

/**
 * The marker each stubbed widget above renders. Finding it in a cell proves the
 * board reached the real component for that key rather than the placeholder.
 */
const BODY_MARKER: Readonly<Record<string, string>> = {
  stats: 'stats body',
  todaysPack: 'todays pack body',
  kintales: 'kintales body',
  cashFlow: 'cash flow body',
  gatekeeper: 'gatekeeper body',
  weatherWatchdog: 'watchdog body',
  heatIndex: 'heat index body',
  weeklyCapacity: 'capacity body',
  overdueTracker: 'overdue body',
  petBreakdown: 'pet breakdown body',
  frequentFlyers: 'frequent flyers body',
  holidayRunway: 'holiday runway body',
  unreadMessages: 'open inbox',
  safebox: 'safebox body',
  careFlags: 'care flags body',
  expirations: 'expirations body',
  routeOptimizer: 'route body',
  expenseLog: 'expense body',
  supplies: 'supplies body',
};

function w(key: string, size: 'compact' | 'wide' = 'compact'): DashWidget {
  return { key, size } as DashWidget;
}

/**
 * What `getDashboardLayout` resolves for an operator with a REAL, saved
 * layout. Most fixtures below represent that case. `isStored` is the bit C2
 * fixed: the API used to hand back only a widget list, so a caller could not
 * tell "genuinely saved" apart from "nothing saved, default substituted" when
 * the two happened to hold the same values, and the web screen used to guess
 * from the VALUES instead of being told. See `notStored` below for the other
 * case, and `api/dashboardLayout.test.ts` for the same contract at the API
 * boundary.
 */
function stored(widgets: DashWidget[]): { widgets: DashWidget[]; isStored: boolean } {
  return { widgets, isStored: true };
}

/** What `getDashboardLayout` resolves for an operator who has never customized. */
function notStored(widgets: DashWidget[]): { widgets: DashWidget[]; isStored: boolean } {
  return { widgets, isStored: false };
}

beforeEach(() => {
  navigate.mockReset();
  getDashboardLayout.mockReset();
  saveDashboardLayout.mockReset();
  useAuth.mockReturnValue({ status: 'signedIn', user: { uid: 'op-1' } });
  getDashboardLayout.mockResolvedValue(stored(DEFAULT_DASHBOARD.map((x) => ({ ...x }))));
  saveDashboardLayout.mockImplementation((list: readonly DashWidget[]) =>
    Promise.resolve(list.map((x) => ({ ...x }))),
  );
});

describe('Home board order', () => {
  it('renders the widgets in the MODEL order, not in source order', async () => {
    // The proof that the board is model-driven: this order exists nowhere in
    // Home.tsx's markup, and no arrangement of that markup could produce it.
    getDashboardLayout.mockResolvedValue(stored([w('supplies'), w('careFlags'), w('safebox')]));
    render(<Home />);

    await waitFor(() => expect(boardOrder()).toEqual(['supplies', 'careFlags', 'safebox']));
    expect(screen.queryByText('route body')).toBeNull();
  });

  it('gives a wide widget the full-width cell and a compact one a single track', async () => {
    getDashboardLayout.mockResolvedValue(stored([w('supplies', 'wide'), w('careFlags')]));
    render(<Home />);

    await waitFor(() => expect(boardOrder()).toEqual(['supplies', 'careFlags']));
    expect(document.querySelector('[data-widget="supplies"]')).toHaveClass('home-dash__cell--wide');
    expect(document.querySelector('[data-widget="careFlags"]')).toHaveClass(
      'home-dash__cell--compact',
    );
  });

  it('D2: draws a real card for a key that used to be phone-only', async () => {
    // Cash Flow was the stock example of a seat this surface could not draw,
    // so it is the one asserted here: the placeholder is gone and the card is
    // the widget.
    getDashboardLayout.mockResolvedValue(stored([w('cashFlow'), w('supplies')]));
    render(<Home />);

    await waitFor(() => expect(boardOrder()).toEqual(['cashFlow', 'supplies']));
    expect(cellText('cashFlow')).toContain('cash flow body');
    expect(screen.queryByText(/built in the phone app/i)).toBeNull();
  });

  it('D2: honours the SHIPPED default when nothing is stored, the same board the phone shows', async () => {
    // `getDashboardLayout` resolves { widgets: shipped default, isStored: false }
    // when the field is empty. This surface used to substitute its own richer
    // seven-card board there, because the shipped default named three cards it
    // could not draw. All three are real cards now, so the substitution is gone
    // and an operator who has never customized sees the same Home on both
    // surfaces.
    getDashboardLayout.mockResolvedValue(notStored(DEFAULT_DASHBOARD.map((x) => ({ ...x }))));
    render(<Home />);
    await waitFor(() => expect(boardOrder()).toEqual(DEFAULT_DASHBOARD.map((x) => x.key)));
    // And it is still never written back: an un-customized operator has nothing
    // stored, so a save here would invent a layout they did not choose.
    expect(saveDashboardLayout).not.toHaveBeenCalled();
  });

  it('C2: honours a REAL stored layout even when it matches the shipped default token for token, and never saves a substitute over it', async () => {
    // The clobber bug. An operator can genuinely save exactly stats +
    // Today's Pack + KinTales, in that order (that is android's whole board
    // before any customization, so it is a completely ordinary thing to have
    // saved). Before the fix, the web screen could not tell that apart from
    // "nothing is stored" because it compared VALUES against
    // `DEFAULT_DASHBOARD` instead of trusting `isStored`, so it painted its
    // own seven-card substitute here, and the first edit on this screen saved
    // seven widgets over the three the operator actually chose — quite
    // possibly on the phone, since this exact layout is what an
    // un-customized phone shows too.
    getDashboardLayout.mockResolvedValue(stored(DEFAULT_DASHBOARD.map((x) => ({ ...x }))));
    render(<Home />);

    // The board shown is the three the operator saved, and nothing else.
    await waitFor(() =>
      expect(boardOrder()).toEqual(DEFAULT_DASHBOARD.map((x) => x.key)),
    );
    expect(screen.queryByText('safebox body')).toBeNull();

    // Merely loading and sitting on the screen never calls the save path,
    // stored or not.
    expect(saveDashboardLayout).not.toHaveBeenCalled();

    // A deliberate edit against this REAL board persists a transform of
    // THOSE three widgets, never a substitute.
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove KinTales from Home' }));

    expect(boardOrder()).toEqual(['stats', 'todaysPack']);
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenCalledWith([
        { key: 'stats', size: 'wide' },
        { key: 'todaysPack', size: 'compact' },
      ]),
    );
  });
});

describe('Home first paint', () => {
  it('paints no board at all until the stored layout has arrived', async () => {
    // THE REPORTED REGRESSION. The board used to paint a guessed default
    // while the read was still in flight, so an operator whose stored layout
    // was something else watched one board render and then be replaced by
    // another a frame later. A first frame that guesses is a first frame that
    // has to be taken back.
    let land: (result: { widgets: DashWidget[]; isStored: boolean }) => void = () => undefined;
    getDashboardLayout.mockReturnValue(
      new Promise<{ widgets: DashWidget[]; isStored: boolean }>((resolve) => {
        land = resolve;
      }),
    );
    render(<Home />);

    expect(boardOrder()).toEqual([]);
    expect(screen.queryByText('safebox body')).toBeNull();
    expect(screen.queryByText('stats body')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      land(stored([w('cashFlow'), w('safebox')]));
      await Promise.resolve();
    });

    // The first board the operator sees is the one they actually have, and
    // nothing it shows is contradicted a frame later.
    await waitFor(() => expect(boardOrder()).toEqual(['cashFlow', 'safebox']));
    expect(cellText('cashFlow')).toContain('cash flow body');
    expect(cellText('safebox')).toContain('safebox body');
  });

  it('D2: draws ALL NINETEEN keys as real cards, with no placeholder left anywhere', async () => {
    // The whole of D2 in one assertion. Every key the shared model can hold
    // resolves to a component here, so a layout arranged on the phone opens as
    // the same board rather than as a wall of "built in the phone app".
    getDashboardLayout.mockResolvedValue(stored(DASH_KEYS.map((k) => w(k))));
    render(<Home />);
    await waitFor(() => expect(boardOrder()).toEqual([...DASH_KEYS]));
    for (const key of DASH_KEYS) {
      expect(cellText(key)).toContain(BODY_MARKER[key]);
    }
    expect(DASH_KEYS.length).toBe(19);
    expect(screen.queryByText(/built in the phone app/i)).toBeNull();
    expect(screen.queryByText(/under Customize, in Hidden cards/i)).toBeNull();
  });
});
describe('Home customize mode', () => {
  it('toggles Customize and Done, showing the edit bar per widget', async () => {
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies')]));
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));

    expect(screen.getByRole('button', { name: 'Move Key & code safebox up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Supplies tracker down' })).toBeDisabled();
  });

  it('moves a widget, persists the new order and announces the move', async () => {
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies'), w('careFlags')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('supplies'), w('careFlags')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies')]));
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

  it('D2: offers every hidden card plainly, with nothing marked phone-only', async () => {
    getDashboardLayout.mockResolvedValue(stored([w('safebox')]));
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    expect(screen.getByRole('button', { name: 'Add Cash Flow to Home' })).not.toHaveTextContent(
      'phone app only',
    );
    expect(
      screen.getByRole('button', { name: 'Add Supplies tracker to Home' }),
    ).not.toHaveTextContent('phone app only');
  });

  it('D2: a newly ported card survives add, hide and reorder through the shared model', async () => {
    // The layout machinery is not per widget, so this is asserted once against
    // a card that did not exist on this surface before. Gatekeeper is added
    // from the hidden strip, moved, and removed again, and every step persists
    // the SAME token list android reads.
    getDashboardLayout.mockResolvedValue(stored([w('stats', 'wide'), w('todaysPack')]));
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    // Add: appended at the end, drawn as a real card, and saved.
    fireEvent.click(screen.getByRole('button', { name: 'Add Gatekeeper to Home' }));
    expect(boardOrder()).toEqual(['stats', 'todaysPack', 'gatekeeper']);
    expect(cellText('gatekeeper')).toContain('gatekeeper body');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Gatekeeper added to Home at position 3 of 3.',
    );
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenLastCalledWith([
        w('stats', 'wide'),
        w('todaysPack'),
        w('gatekeeper'),
      ]),
    );
    // Reorder: the card moves and keeps its body with it.
    fireEvent.click(screen.getByRole('button', { name: 'Move Gatekeeper up' }));
    expect(boardOrder()).toEqual(['stats', 'gatekeeper', 'todaysPack']);
    expect(cellText('gatekeeper')).toContain('gatekeeper body');
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenLastCalledWith([
        w('stats', 'wide'),
        w('gatekeeper'),
        w('todaysPack'),
      ]),
    );
    // Resize: full width, persisted, and the cell says so.
    fireEvent.click(screen.getByRole('button', { name: 'Make Gatekeeper full width' }));
    expect(document.querySelector('[data-widget="gatekeeper"]')).toHaveClass(
      'home-dash__cell--wide',
    );
    // Hide: off the board, back in the strip, and saved without it.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Gatekeeper from Home' }));
    expect(boardOrder()).toEqual(['stats', 'todaysPack']);
    expect(screen.getByRole('button', { name: 'Add Gatekeeper to Home' })).toBeInTheDocument();
    await waitFor(() =>
      expect(saveDashboardLayout).toHaveBeenLastCalledWith([w('stats', 'wide'), w('todaysPack')]),
    );
  });
  it('hides the strip when every known card is on the board', async () => {
    getDashboardLayout.mockResolvedValue(stored(DASH_KEYS.map((k) => w(k))));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies'), w('careFlags')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies'), w('careFlags')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies'), w('careFlags')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies'), w('careFlags')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('safebox'), w('supplies')]));
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
    expect(boardOrder()).toEqual(DEFAULT_DASHBOARD.map((x) => x.key));
  });

  it('retries the load from the banner', async () => {
    getDashboardLayout.mockRejectedValueOnce(new Error('offline'));
    getDashboardLayout.mockResolvedValue(stored([w('supplies')]));
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
    getDashboardLayout.mockResolvedValue(stored([w('unreadMessages')]));
    render(<Home />);

    fireEvent.click(await screen.findByRole('button', { name: 'open inbox' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/inbox' });
  });
});
