import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DenPanel, DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
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
import './Home.css';

/**
 * Home dashboard. The nav rail + topbar live in AppShell (the layout route), so
 * this is the page body rendered into the shell's <Outlet/>.
 *
 * This is the React rebuild of the Compose Home dashboard's insight widgets
 * (composeApp `screens/home/HomeInsightWidgets.kt`). Widgets land one at a time,
 * each a self-loading DenPanel in the board below; the pure logic behind each
 * lives in `lib/dashboardInsights.ts` (the React port of `DashboardInsights.kt`)
 * so it is unit-tested apart from the DOM.
 *
 * Live so far: Unread Client Messages (AO-38), Key & Code Safebox (AO-36), Care
 * Flags (AO-37), Expiration Countdown (AO-39), Route Optimizer (AO-35), Expense
 * Quick-Log (AO-40) and Supplies Tracker (AO-41).
 *
 * 17.3 CUSTOMIZE MODE. The board's ORDER AND SIZES COME FROM THE MODEL, not
 * from the JSX below: `lib/dashboardLayout.ts` holds the operator's list and
 * every transform on it, `api/dashboardLayout.ts` persists it to the one field
 * android reads, and this screen only maps a key to a component. Adding a
 * widget means adding a row to WIDGETS, never re-ordering markup.
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

/**
 * The keys this surface can actually draw. Android draws all nineteen; the
 * React admin has ported seven so far, and the rest are still to come in other
 * tasks. A stored layout naming an unported card is NOT dropped, because the
 * list is shared with android and quietly deleting the operator's phone board
 * on their first web reorder is the worst outcome available. It renders as a
 * named placeholder instead, so the seat it occupies is visible and movable.
 */
const PORTED: ReadonlySet<DashKey> = new Set<DashKey>([
  'unreadMessages',
  'safebox',
  'careFlags',
  'expirations',
  'routeOptimizer',
  'expenseLog',
  'supplies',
]);

/**
 * What an operator who has never customized ANYTHING sees here.
 *
 * `DEFAULT_DASHBOARD` (stats + Today's Pack + KinTales) is the shipped default
 * on the shared model, and honouring it literally on this surface would hand a
 * brand-new operator three placeholders and no working card, which is a
 * regression from the Home that shipped. So the un-customized case, and only
 * that case, resolves to the seven cards this admin already had, in the order
 * it already had them. The moment either surface saves a layout, that saved
 * layout is honoured verbatim, unported cards included. Divergence from android
 * is confined to the never-touched state.
 */
export const WEB_DEFAULT_DASHBOARD: readonly DashWidget[] = [
  { key: 'safebox', size: 'compact' },
  { key: 'unreadMessages', size: 'compact' },
  { key: 'careFlags', size: 'compact' },
  { key: 'expirations', size: 'compact' },
  { key: 'routeOptimizer', size: 'compact' },
  { key: 'expenseLog', size: 'compact' },
  { key: 'supplies', size: 'compact' },
];

/** True when a resolved layout is the shipped default, i.e. nothing is stored. */
function isShippedDefault(list: readonly DashWidget[]): boolean {
  return (
    list.length === DEFAULT_DASHBOARD.length &&
    list.every((w, i) => w.key === DEFAULT_DASHBOARD[i]?.key && w.size === DEFAULT_DASHBOARD[i]?.size)
  );
}

function webResolved(list: readonly DashWidget[]): DashWidget[] {
  const source = isShippedDefault(list) ? WEB_DEFAULT_DASHBOARD : list;
  return source.map((w) => ({ ...w }));
}

export function Home() {
  const navigate = useNavigate();
  const auth = useAuth();
  const uid = auth.status === 'signedIn' ? auth.user.uid : '';

  // `null` = the stored layout is not known yet. The board still paints the web
  // default meanwhile, because an empty page is a worse first frame than the
  // board the operator most likely has, but Customize stays off until we know
  // what we would be writing over.
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
      .then((stored) => {
        if (!live) return;
        const resolved = webResolved(stored);
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

  const shown = layout ?? webResolved(DEFAULT_DASHBOARD);
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

      <div className="home-dash d2">
        {shown.map((w, i) => (
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
            <WidgetBody widgetKey={w.key} onOpenInbox={() => void navigate({ to: '/inbox' })} />
          </div>
        ))}
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
                    {!PORTED.has(k) && (
                      <span className="home-hidden__pill-note">phone app only</span>
                    )}
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

interface WidgetBodyProps {
  widgetKey: DashKey;
  onOpenInbox: () => void;
}

/**
 * One widget key to one component. The only place a key and a component meet.
 * An unported key gets a named placeholder rather than nothing, so the operator
 * can see the card is holding its seat and can move or remove it here.
 */
function WidgetBody({ widgetKey, onOpenInbox }: WidgetBodyProps) {
  switch (widgetKey) {
    case 'safebox':
      return <SafeboxWidget />;
    case 'unreadMessages':
      return <UnreadMessagesWidget onOpenInbox={onOpenInbox} />;
    case 'careFlags':
      return <CareFlagsWidget />;
    case 'expirations':
      return <ExpirationCountdownWidget />;
    case 'routeOptimizer':
      return <RouteOptimizerWidget />;
    case 'expenseLog':
      return <ExpenseQuickLogWidget />;
    case 'supplies':
      return <SuppliesTrackerWidget />;
    default:
      return (
        <DenPanel title={DASH_LABELS[widgetKey]} subtitle="Not on the web dashboard yet.">
          <EmptyHint>
            This card is built in the phone app. It keeps its place in your layout here, so
            rearranging Home will not lose it.
          </EmptyHint>
        </DenPanel>
      );
  }
}
