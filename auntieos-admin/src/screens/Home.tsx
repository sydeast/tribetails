import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DenPanel, DenScreenHeading } from '../components/DenScreenKit';
import { GhostButton } from '../components/Buttons';
import { WidgetEditBar } from '../components/WidgetEditBar';
import { useAuth } from '../lib/auth';
import { getDashboardLayout, saveDashboardLayout } from '../api/dashboardLayout';
import {
  DEFAULT_DASHBOARD,
  hiddenKeys,
  hideWidget,
  moveWidgetDown,
  moveWidgetUp,
  setWidgetSize,
  showWidget,
  type DashKey,
  type DashSize,
  type DashWidget,
} from '../lib/dashboardLayout';
import { UnreadMessagesWidget } from './widgets/UnreadMessagesWidget';
import { SafeboxWidget } from './widgets/SafeboxWidget';
import { CareFlagsWidget } from './widgets/CareFlagsWidget';
import { ExpirationCountdownWidget } from './widgets/ExpirationCountdownWidget';
import { RouteOptimizerWidget } from './widgets/RouteOptimizerWidget';
import { ExpenseQuickLogWidget } from './widgets/ExpenseQuickLogWidget';
import { SuppliesTrackerWidget } from './widgets/SuppliesTrackerWidget';
import { StatsWidget } from './widgets/StatsWidget';
import { TodaysPackWidget } from './widgets/TodaysPackWidget';
import { KinTalesPendingWidget } from './widgets/KinTalesPendingWidget';
import { CashFlowWidget } from './widgets/CashFlowWidget';
import { GatekeeperWidget } from './widgets/GatekeeperWidget';
import { HeatIndexWidget, WeatherWatchdogWidget } from './widgets/WeatherWidgets';
import { WeeklyCapacityWidget } from './widgets/WeeklyCapacityWidget';
import { OverdueVisitsWidget } from './widgets/OverdueVisitsWidget';
import { PetBreakdownWidget } from './widgets/PetBreakdownWidget';
import { FrequentFlyersWidget } from './widgets/FrequentFlyersWidget';
import { HolidayRunwayWidget } from './widgets/HolidayRunwayWidget';
import './Home.css';

/**
 * Home dashboard. The nav rail + topbar live in AppShell (the layout route), so
 * this is the page body rendered into the shell's <Outlet/>.
 *
 * This is the React rebuild of the android Home dashboard (`ui/home/`). Every
 * card is a self-loading DenPanel in the board below; the pure logic behind
 * each lives in `lib/dashboardInsights.ts` (the port of `DashboardInsights.kt`,
 * `HouseholdVisitGaps.kt` and the revenue half of `Stage2Step2Helpers.kt`) so
 * every rule is unit-tested apart from the DOM.
 *
 * ALL NINETEEN CARDS ARE LIVE HERE as of D2. The seven this admin had first
 * (Unread Messages AO-38, Safebox AO-36, Care Flags AO-37, Expirations AO-39,
 * Route Optimizer AO-35, Expense Quick-Log AO-40, Supplies AO-41) are joined by
 * the twelve that were phone-only: the stat row, Today's Pack, KinTales
 * pending, Cash Flow, Gatekeeper, Weather Watchdog, Heat Stroke Index, Weekly
 * capacity, Overdue visits, Kin by type, Frequent flyers and Holiday runway.
 *
 * WHAT A FULL BOARD COSTS. Eleven cards read one shared visit stream, three the
 * pet roster, two invoices and two drafts, all through `widgets/homeData.ts`,
 * which hands every caller the same `CollectionSpec` so the Firestore SDK
 * collapses them into ONE Watch target per collection. The two weather cards
 * share one `getLocalWeather` POST through `lib/useSharedOneShot.ts`. Adding
 * twelve cards therefore adds one callable, not twelve.
 *
 * 17.3 CUSTOMIZE MODE. The board's ORDER AND SIZES COME FROM THE MODEL, not
 * from the JSX below: `lib/dashboardLayout.ts` holds the operator's list and
 * every transform on it, `api/dashboardLayout.ts` persists it to the one field
 * android reads, and this screen only maps a key to a component. Adding a
 * widget means adding a row to WEB_WIDGETS, never re-ordering markup.
 */

/**
 * Human name per widget key, used by the edit bar, the hidden strip and every
 * announcement. Copied from android `HomeScreen.kt#dashLabel` verbatim, so the
 * two surfaces name the same card the same way; a key added to the model has to
 * gain a label in both.
 */
export const DASH_LABELS: Readonly<Record<DashKey, string>> = {
  stats: 'Stats',
  todaysPack: "Today's Pack",
  kintales: 'KinTales',
  cashFlow: 'Cash Flow',
  gatekeeper: 'Gatekeeper',
  weatherWatchdog: 'Weather Watchdog',
  heatIndex: 'Heat Stroke Index',
  weeklyCapacity: 'Weekly capacity',
  overdueTracker: 'Overdue visits',
  petBreakdown: 'Kin by type',
  frequentFlyers: 'Frequent flyers',
  holidayRunway: 'Holiday runway',
  unreadMessages: 'Unread messages',
  safebox: 'Key & code safebox',
  careFlags: 'Care flags',
  expirations: 'Expiration countdown',
  routeOptimizer: 'Route optimizer',
  expenseLog: 'Expense quick-log',
  supplies: 'Supplies tracker',
};

interface WidgetProps {
  onOpenInbox: () => void;
  onOpenSessions: () => void;
  onOpenCommunicate: () => void;
}

/**
 * ONE widget key to one component, and the only list of what this surface can
 * draw. As of D2 that is ALL NINETEEN: android and the React admin draw the
 * same board.
 *
 * The type is a TOTAL `Record<DashKey, …>`, not a `Partial`, and that is the
 * mechanism rather than a formality. It used to be partial because twelve keys
 * had no component, and the board carried a runtime placeholder for the gap. A
 * total record moves that check to the compiler: a key added to `DASH_KEYS`
 * cannot be shipped without a component here, so the two lists cannot drift and
 * the placeholder has nothing left to catch.
 */
const WEB_WIDGETS: Readonly<Record<DashKey, (props: WidgetProps) => ReactElement>> = {
  stats: () => <StatsWidget />,
  todaysPack: ({ onOpenSessions }) => <TodaysPackWidget onOpenSessions={onOpenSessions} />,
  kintales: ({ onOpenCommunicate }) => (
    <KinTalesPendingWidget onReviewTales={onOpenCommunicate} />
  ),
  cashFlow: () => <CashFlowWidget />,
  gatekeeper: () => <GatekeeperWidget />,
  weatherWatchdog: () => <WeatherWatchdogWidget />,
  heatIndex: () => <HeatIndexWidget />,
  weeklyCapacity: () => <WeeklyCapacityWidget />,
  overdueTracker: () => <OverdueVisitsWidget />,
  petBreakdown: () => <PetBreakdownWidget />,
  frequentFlyers: () => <FrequentFlyersWidget />,
  holidayRunway: () => <HolidayRunwayWidget />,
  unreadMessages: ({ onOpenInbox }) => <UnreadMessagesWidget onOpenInbox={onOpenInbox} />,
  safebox: () => <SafeboxWidget />,
  careFlags: () => <CareFlagsWidget />,
  expirations: () => <ExpirationCountdownWidget />,
  routeOptimizer: () => <RouteOptimizerWidget />,
  expenseLog: () => <ExpenseQuickLogWidget />,
  supplies: () => <SuppliesTrackerWidget />,
};

/**
 * `list` is what `getDashboardLayout` resolved; `isStored` is whether that came
 * off the document or is the shipped default substituted because nothing
 * readable was there (see `api/dashboardLayout.ts`'s `DashboardLayoutResult`).
 *
 * THE SUBSTITUTION IS GONE, and keeping this function is how that stays true.
 *
 * The web board used to carry its own seven-card default for the un-customized
 * case, because honouring the shared `DEFAULT_DASHBOARD` literally would have
 * handed a new operator three placeholders and no working card. That reason
 * expired with D2: stats, Today's Pack and KinTales are all real cards here
 * now, so the shipped default IS a working board and this surface can honour it
 * exactly as the phone does.
 *
 * Substituting on VALUE (the list happens to equal `DEFAULT_DASHBOARD`) rather
 * than on `isStored` was the C2 bug: an operator whose real saved layout is
 * exactly those three widgets, which is what an un-customized phone board looks
 * like, was indistinguishable from an operator with nothing stored. The web
 * board then painted its own richer default and the first edit here SAVED that
 * over the three they had arranged elsewhere. With no substitute left there is
 * nothing to save over a stored layout, which is a stronger guarantee than the
 * one this function used to make; it stays as the single, named place a future
 * default would have to go, so that guarantee is checked rather than assumed.
 */
function webResolved(list: readonly DashWidget[], isStored: boolean): DashWidget[] {
  const source = isStored ? list : DEFAULT_DASHBOARD;
  return source.map((w) => ({ ...w }));
}

export function Home() {
  const navigate = useNavigate();
  const auth = useAuth();
  const uid = auth.status === 'signedIn' ? auth.user.uid : '';

  // `null` = the stored layout is not known yet. NOTHING is drawn on the board
  // while that is true. Painting the web default meanwhile looks like a free
  // head start and is not: an operator whose stored layout names cards this
  // surface cannot draw watched seven working widgets render and then get
  // replaced by "built in the phone app" a frame later. A board that has to be
  // taken back is worse than a board that has not arrived. Customize also stays
  // off until we know what we would be writing over.
  const [layout, setLayout] = useState<DashWidget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  // The last layout the SERVER confirmed. A failed save reverts to this, not to
  // the step before the failed one: with several moves queued, the step before
  // is itself unsaved, and putting the board there would leave the operator
  // looking at an arrangement that also does not exist anywhere.
  const confirmedRef = useRef<DashWidget[]>([]);
  // Saves run strictly one after another off this chain, so a fast run of moves
  // cannot land out of order and leave the stored list disagreeing with the
  // screen. Nothing reads the profile before writing, so nothing here can
  // clobber a field saved concurrently from another screen; the callable
  // merge-writes its own two fields and the client sends only tokens.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const seqRef = useRef(0);
  // Saves issued at or below this sequence are abandoned: a failure has already
  // put the board back, so writing the rest of that run would persist an
  // arrangement nobody is looking at.
  const abandonThroughRef = useRef(0);

  useEffect(() => {
    if (uid === '') return;
    let live = true;
    setLoadError(null);
    void getDashboardLayout(uid)
      .then(({ widgets, isStored }) => {
        if (!live) return;
        const resolved = webResolved(widgets, isStored);
        confirmedRef.current = resolved;
        setLayout(resolved);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : 'Load failed');
      });
    return () => {
      live = false;
    };
  }, [uid, reloadNonce]);

  const commit = useCallback((next: DashWidget[], message: string) => {
    const seq = (seqRef.current += 1);
    setLayout(next);
    setAnnouncement(message);
    setSaveError(null);

    queueRef.current = queueRef.current.then(async () => {
      if (seq <= abandonThroughRef.current) return;
      try {
        const stored = await saveDashboardLayout(next);
        confirmedRef.current = stored;
        // Reconcile with what the server actually kept, but only when this is
        // the newest save. Reconciling an older one would yank the board back
        // over moves the operator has already made on screen.
        if (seq === seqRef.current) setLayout(stored.map((w) => ({ ...w })));
      } catch (err: unknown) {
        abandonThroughRef.current = seqRef.current;
        setLayout(confirmedRef.current.map((w) => ({ ...w })));
        setSaveError(
          `Couldn't save your dashboard: ${err instanceof Error ? err.message : 'Save failed'}. Your board is back the way it was.`,
        );
        setAnnouncement('');
      }
    });
  }, []);

  // A failed read is a different state from a slow one: the banner below says
  // the board is the standard one rather than the operator's, so drawing it is
  // disclosed rather than guessed. Only the not-yet-known case holds the board.
  const stillLoading = layout === null && loadError === null;
  const shown = layout ?? webResolved(DEFAULT_DASHBOARD, false);
  const canCustomize = layout !== null;
  const hidden = hiddenKeys(shown);

  const move = (index: number, direction: 'up' | 'down'): void => {
    const widget = shown[index];
    if (widget === undefined) return;
    const next = direction === 'up' ? moveWidgetUp(shown, index) : moveWidgetDown(shown, index);
    const at = next.findIndex((w) => w.key === widget.key);
    if (at === index) return;
    commit(
      next,
      `${DASH_LABELS[widget.key]} moved ${direction} to position ${String(at + 1)} of ${String(next.length)}.`,
    );
  };

  const resize = (key: DashKey, size: DashSize): void => {
    commit(
      setWidgetSize(shown, key, size),
      `${DASH_LABELS[key]} is now ${size === 'wide' ? 'full width' : 'half width'}.`,
    );
  };

  const remove = (key: DashKey): void => {
    commit(hideWidget(shown, key), `${DASH_LABELS[key]} removed from Home.`);
  };

  const add = (key: DashKey): void => {
    const next = showWidget(shown, key);
    commit(
      next,
      `${DASH_LABELS[key]} added to Home at position ${String(next.length)} of ${String(next.length)}.`,
    );
  };

  // Screens render a <div>, not <main>: AppShell owns the single <main> landmark
  // (B1). Nesting <main> in <main> is invalid and breaks landmark navigation, the
  // exact a11y this rebuild restores. Every screen follows this.
  return (
    <div className="screen">
      {/* d1 / d2: the Den entrance stagger (styles/base.css). Blocks settle in
          reading order, matching the mocks, which stagger BLOCKS and not the
          cards inside them, so a seven-widget board still arrives as one board. */}
      <div className="d1">
        <DenScreenHeading
          kicker="Overview"
          title="Home"
          subtitle="Today across the Den, at a glance."
          trailing={
            canCustomize ? (
              <GhostButton
                label={editing ? 'Done' : 'Customize'}
                onClick={() => setEditing((e) => !e)}
              />
            ) : undefined
          }
        />
      </div>

      {/* Present from the first render and never conditional: a live region
          added at the same moment its text arrives is not announced. */}
      <p className="home-dash__announce" role="status" aria-live="polite">
        {announcement}
      </p>

      {loadError !== null && (
        <div className="home-dash__banner" role="alert">
          <p className="home-dash__banner-text">
            Couldn&apos;t load your dashboard layout: {loadError}. This is the standard board, not
            the one you saved. Customizing stays off until yours loads.
          </p>
          <GhostButton label="Retry" onClick={() => setReloadNonce((n) => n + 1)} />
        </div>
      )}

      {saveError !== null && (
        <div className="home-dash__banner" role="alert">
          <p className="home-dash__banner-text">{saveError}</p>
          <GhostButton label="Dismiss" onClick={() => setSaveError(null)} />
        </div>
      )}

      <div className="home-dash d2" aria-busy={stillLoading}>
        {stillLoading ? (
          <p className="home-dash__loading">Loading your dashboard&hellip;</p>
        ) : (
          shown.map((w, i) => (
            // Keyed by widget, not by index, so a reorder MOVES the node instead
            // of rewriting two of them. That keeps the focused control focused
            // through a keyboard move, which is the difference between a usable
            // reorder and one that drops you back at the top of the page.
            <div
              key={w.key}
              className={`home-dash__cell home-dash__cell--${w.size}`}
              data-widget={w.key}
            >
              {editing && (
                <WidgetEditBar
                  label={DASH_LABELS[w.key]}
                  size={w.size}
                  canMoveUp={i > 0}
                  canMoveDown={i < shown.length - 1}
                  canResize={w.key !== 'stats'}
                  onMoveUp={() => move(i, 'up')}
                  onMoveDown={() => move(i, 'down')}
                  onResize={(size) => resize(w.key, size)}
                  onRemove={() => remove(w.key)}
                />
              )}
              <WidgetBody
                widgetKey={w.key}
                onOpenInbox={() => void navigate({ to: '/inbox' })}
                onOpenSessions={() => void navigate({ to: '/sessions' })}
                onOpenCommunicate={() => void navigate({ to: '/communicate' })}
              />
            </div>
          ))
        )}
      </div>

      {editing && hidden.length > 0 && (
        <div className="home-dash__hidden">
          <DenPanel title="Hidden cards" subtitle="Pick the widgets you want to see on Home.">
            <ul className="home-hidden__pills">
              {hidden.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    className="home-hidden__pill"
                    onClick={() => add(k)}
                    aria-label={`Add ${DASH_LABELS[k]} to Home`}
                  >
                    <span aria-hidden="true" className="home-hidden__pill-plus">
                      +
                    </span>
                    {DASH_LABELS[k]}
                  </button>
                </li>
              ))}
            </ul>
          </DenPanel>
        </div>
      )}
    </div>
  );
}

interface WidgetBodyProps extends WidgetProps {
  widgetKey: DashKey;
}

/**
 * The card in one seat.
 *
 * There is no placeholder branch and no `undefined` case to handle, because
 * `WEB_WIDGETS` is a total record over `DashKey`: every key the model can hold
 * has a component, checked at compile time. The nav callbacks are passed to
 * every card rather than only to the three that use one, so adding a widget
 * that needs to navigate is a one-line change here and not a signature change
 * through the board.
 */
function WidgetBody({ widgetKey, ...nav }: WidgetBodyProps) {
  const Draw = WEB_WIDGETS[widgetKey];
  return <Draw {...nav} />;
}
