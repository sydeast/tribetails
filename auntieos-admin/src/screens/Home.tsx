import { useNavigate } from '@tanstack/react-router';
import { DenScreenHeading } from '../components/DenScreenKit';
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
 * each a self-loading DenPanel in the responsive grid below; the pure logic
 * behind each lives in `lib/dashboardInsights.ts` (the React port of
 * `DashboardInsights.kt`) so it is unit-tested apart from the DOM.
 *
 * Live so far: Unread Client Messages (AO-38), Key & Code Safebox (AO-36), Care
 * Flags (AO-37), Expiration Countdown (AO-39), Route Optimizer (AO-35), Expense
 * Quick-Log (AO-40) and Supplies Tracker (AO-41). The last five call the new
 * MyTribe callables (`listExpirations`, `optimizeRoute`, `listExpenses` /
 * `logExpense`, `listSupplies` / `adjustSupply`); Care Flags needs no callable,
 * joining the `kin` and `kin_care_sessions` streams client-side.
 */
export function Home() {
  const navigate = useNavigate();

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
        />
      </div>

      <div className="home-dash d2">
        <SafeboxWidget />
        <UnreadMessagesWidget onOpenInbox={() => void navigate({ to: '/inbox' })} />
        <CareFlagsWidget />
        <ExpirationCountdownWidget />
        <RouteOptimizerWidget />
        <ExpenseQuickLogWidget />
        <SuppliesTrackerWidget />
      </div>
    </div>
  );
}
