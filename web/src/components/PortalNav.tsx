import { Link } from '@tanstack/react-router';
import { useAuth, useSignOut } from '../lib/auth';
import { useAccessState } from '../lib/activeTribe';

export type PortalNavTab = 'home' | 'tribe' | 'schedule' | 'kintales' | 'invoices' | 'account' | 'messages';

type NavPath = '/home' | '/tribe' | '/schedule' | '/kintales' | '/invoices' | '/account' | '/messages';
type NavItem = { id: PortalNavTab; label: string; to: NavPath | null };

/**
 * Desktop top nav: Home / Tribe / Schedule / KinTales / Invoices. "Tribe"
 * goes to the Tribe hub (dashboard), not the Kin roster directly — the Kin
 * roster is reachable from within the hub, per every S3 mockup's nav bar
 * (confirmed identical across mytribe-kintales/tribe/account/invoices/
 * notifications-2026-05-31.html) and Compose's ShellDestination.Tribe ->
 * TribeRoute -> TribeHubScreen.
 */
const NAV_LINKS: NavItem[] = [
  { id: 'home', label: 'Home', to: '/home' },
  { id: 'tribe', label: 'Tribe', to: '/tribe' },
  { id: 'schedule', label: 'Schedule', to: '/schedule' },
  { id: 'kintales', label: 'KinTales', to: '/kintales' },
  { id: 'invoices', label: 'Invoices', to: '/invoices' },
  // S5: no mockup exists for a Messages nav entry (Message Auntie has no
  // mockup at all — see web/src/screens/Messages.tsx's own header comment).
  // Desktop-only, like Account — mobile reaches it one tap deeper via Home's
  // "Message your Auntie" quick-start, matching how Invoices already skips
  // the fixed 5-slot bottom tab bar.
  { id: 'messages', label: 'Messages', to: '/messages' },
];

/** Mobile bottom tab bar: Home / Tribe / Schedule / Tales / Account (per mockup — a distinct label set from the desktop nav; Invoices lives one tap deeper, from Home/Tribe/Account, not its own mobile tab). */
const TAB_ITEMS: (NavItem & { icon: string })[] = [
  { id: 'home', label: 'Home', to: '/home', icon: '\u{1F3E0}' },
  { id: 'tribe', label: 'Tribe', to: '/tribe', icon: '\u{1F43E}' },
  { id: 'schedule', label: 'Schedule', to: '/schedule', icon: '\u{1F4C5}' },
  { id: 'kintales', label: 'Tales', to: '/kintales', icon: '\u{1F4DD}' },
  { id: 'account', label: 'Account', to: '/account', icon: '\u{1F464}' },
];

/** Shared top nav + mobile bottom tab bar, extracted from the identical markup repeated across every mockup. */
export function PortalNav(props: { active: PortalNavTab; displayName?: string }) {
  const authState = useAuth();
  const access = useAccessState();
  const { signOut, signingOut } = useSignOut();
  const initial =
    (props.displayName || (authState.status === 'signedIn' ? (authState.user.email ?? '') : '') || 'M')
      .charAt(0)
      .toUpperCase();

  return (
    <>
      <nav className="nav">
        <div className="in">
          <div className="wordmark">
            My<span className="grad">Tribe</span>
          </div>
          <div className="navlinks">
            {NAV_LINKS.map((link) =>
              link.to ? (
                <Link key={link.id} className={link.id === props.active ? 'on' : ''} to={link.to}>
                  {link.label}
                </Link>
              ) : (
                <span key={link.id} className="navlink-inert" title="Coming soon">
                  {link.label}
                </span>
              ),
            )}
          </div>
          <div className="right">
            {access?.isOperator && (
              <Link className="iconbtn" to="/pick" aria-label="Switch tribe" title="Back to Directory">
                {'\u{1F4C7}'}
              </Link>
            )}
            <Link className="iconbtn" to="/account/notifications" aria-label="Notification settings">
              {'\u{1F514}'}
            </Link>
            {/* A div, so `disabled` does nothing — useSignOut's ref guard is what
                actually swallows the second tap; this only makes the wait visible. */}
            <div
              className="avatar"
              title={signingOut ? 'Signing out…' : 'Sign out'}
              aria-busy={signingOut}
              style={signingOut ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              onClick={signOut}
            >
              {initial}
            </div>
          </div>
        </div>
      </nav>

      <nav className="tabbar">
        {TAB_ITEMS.map((tab) =>
          tab.to ? (
            <Link key={tab.id} className={tab.id === props.active ? 'on' : ''} to={tab.to}>
              {tab.icon}
              <small>{tab.label}</small>
            </Link>
          ) : (
            <span key={tab.id} className="tabbar-inert">
              {tab.icon}
              <small>{tab.label}</small>
            </span>
          ),
        )}
      </nav>
    </>
  );
}
