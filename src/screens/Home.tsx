import { useNavigate } from '@tanstack/react-router';
import { DenScreenHeading } from '../components/DenScreenKit';
import { UnreadMessagesWidget } from './widgets/UnreadMessagesWidget';
import { SafeboxWidget } from './widgets/SafeboxWidget';
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
 * Live so far: Unread Client Messages (AO-38), Key & Code Safebox (AO-36). Still
 * to port: Care Flags (AO-37), Expiration Countdown (AO-39), Route Optimizer
 * (AO-35, needs the `optimizeRoute` callable), Expense Quick-Log (AO-40) and
 * Supplies Tracker (AO-41), the last two of which need new backend models.
 */
export function Home() {
  const navigate = useNavigate();

  // Screens render a <div>, not <main>: AppShell owns the single <main> landmark
  // (B1). Nesting <main> in <main> is invalid and breaks landmark navigation, the
  // exact a11y this rebuild restores. Every screen follows this.
  return (
    <div className="screen">
      <DenScreenHeading
        kicker="Overview"
        title="Home"
        subtitle="Today across the Den, at a glance."
      />

      <div className="home-dash">
        <SafeboxWidget />
        <UnreadMessagesWidget onOpenInbox={() => void navigate({ to: '/inbox' })} />
      </div>
    </div>
  );
}
