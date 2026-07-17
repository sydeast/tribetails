import { Link, Outlet, linkOptions, useRouteContext } from '@tanstack/react-router';
import { signOut } from '../lib/auth';
import { NAV_GROUP_LABEL, railGroup, type NavGroup } from '../lib/nav';
import { GhostButton } from './Buttons';
import { Banner } from './Banner';

const GROUP_ORDER: NavGroup[] = ['den', 'careOps', 'more'];

/**
 * The rail links to SHIPPED screens only. Each entry is a typed `linkOptions`, so
 * every `to` is checked against the route tree at compile time: a nav slug whose
 * route is not registered fails to build (S2), and adding a screen is one typed
 * line here. Slugs absent from this map render as disabled rail items.
 */
const LIVE_LINKS = {
  home: linkOptions({ to: '/home' }),
  'feature-flags': linkOptions({ to: '/feature-flags' }),
  activity: linkOptions({ to: '/activity' }),
} as const;

/** Typed lookup: preserves each entry's literal `to` (a lossy Record cast would
 *  erase it and break Link's required `to`). */
function liveLink(slug: string) {
  return slug in LIVE_LINKS ? LIVE_LINKS[slug as keyof typeof LIVE_LINKS] : undefined;
}

/**
 * The admin layout: the persistent Den nav rail + topbar, with the active screen
 * rendered into <Outlet/>. Wraps every admin route (the route tree guards the whole
 * layout with requireAdmin), so a screen component is just its content — and it
 * renders the single <main> landmark; screens render <div>, never a nested <main>.
 */
export function AppShell() {
  // Read the access the layout guard already resolved (S3), rather than minting a
  // second getIdTokenResult — which also removes the null window where a test admin
  // briefly rendered as "Operator" with no sandbox banner.
  const { access } = useRouteContext({ from: '/admin' });

  return (
    <div className="shell">
      <aside className="shell__rail" aria-label="Primary navigation">
        <div className="shell__brand">AuntieOS</div>
        {GROUP_ORDER.map((group) => (
          <nav key={group} className="shell__group" aria-label={NAV_GROUP_LABEL[group]}>
            <p className="shell__group-label">{NAV_GROUP_LABEL[group]}</p>
            <ul>
              {railGroup(group).map((entry) => {
                const link = liveLink(entry.slug);
                return (
                  <li key={entry.dest}>
                    {link ? (
                      <Link
                        {...link}
                        className="shell__link"
                        activeProps={{ className: 'shell__link shell__link--active' }}
                      >
                        {entry.title}
                      </Link>
                    ) : (
                      <span className="shell__link shell__link--pending" aria-disabled="true">
                        {entry.title}
                        <span className="shell__pending-note"> (coming soon)</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        ))}
      </aside>

      <main className="shell__main">
        <header className="shell__topbar">
          <div className="shell__who">
            {access.status === 'testAdmin' ? 'Test admin, sandbox' : 'Operator'}
          </div>
          <GhostButton label="Sign out" onClick={() => void signOut()} />
        </header>

        {access.status === 'testAdmin' ? (
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
