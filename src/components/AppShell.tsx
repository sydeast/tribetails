import { Link, Outlet } from '@tanstack/react-router';
import { signOut } from '../lib/auth';
import { useAdminAccess } from '../lib/access';
import { NAV_GROUP_LABEL, railGroup, type NavGroup } from '../lib/nav';
import { GhostButton } from './Buttons';
import { Banner } from './Banner';

const GROUP_ORDER: NavGroup[] = ['den', 'careOps', 'more'];

/** Slugs whose screens have shipped. The rest render as disabled rail items until
 *  their band lands, so the rail's shape stays honest without 30 stub routes. */
const LIVE_SLUGS = new Set(['home', 'feature-flags']);

/**
 * The admin layout: the persistent Den nav rail + topbar, with the active screen
 * rendered into <Outlet/>. Wraps every admin route (the route tree guards the
 * whole layout with requireAdmin), so a screen component is just its content.
 */
export function AppShell() {
  const access = useAdminAccess();

  return (
    <div className="shell">
      <aside className="shell__rail" aria-label="Primary navigation">
        <div className="shell__brand">AuntieOS</div>
        {GROUP_ORDER.map((group) => (
          <nav key={group} className="shell__group" aria-label={NAV_GROUP_LABEL[group]}>
            <p className="shell__group-label">{NAV_GROUP_LABEL[group]}</p>
            <ul>
              {railGroup(group).map((entry) =>
                LIVE_SLUGS.has(entry.slug) ? (
                  <li key={entry.dest}>
                    <Link
                      // Only LIVE_SLUGS reach here, all of which are registered routes;
                      // the union cast keeps the dynamic slug typed against tanstack.
                      to={`/${entry.slug}` as '/home' | '/feature-flags'}
                      className="shell__link"
                      activeProps={{ className: 'shell__link shell__link--active' }}
                    >
                      {entry.title}
                    </Link>
                  </li>
                ) : (
                  <li key={entry.dest}>
                    <span className="shell__link shell__link--pending" title="Lands in a later band">
                      {entry.title}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </nav>
        ))}
      </aside>

      <main className="shell__main">
        <header className="shell__topbar">
          <div className="shell__who">
            {access?.status === 'testAdmin' ? 'Test admin, sandbox' : 'Operator'}
          </div>
          <GhostButton label="Sign out" onClick={() => void signOut()} />
        </header>

        {access?.status === 'testAdmin' ? (
          <Banner tone="warning" title="Sandbox account">
            You are signed in as a Stage 0I test admin (scoped to{' '}
            <code>{access.testTribeId}</code>). Admin callables reject this account by
            design; nothing here can broadcast, text, or invoice a real client.
          </Banner>
        ) : null}

        <Outlet />
      </main>
    </div>
  );
}
