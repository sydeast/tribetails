import { Link, Outlet, linkOptions, useRouteContext } from '@tanstack/react-router';
import { signOut, useAuth } from '../lib/auth';
import { NAV_GROUP_LABEL, railGroup, type NavGroup } from '../lib/nav';
import { profileDisplayName, profileInitials } from '../lib/accountFormat';
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
  notifications: linkOptions({ to: '/notifications' }),
  'form-schemas': linkOptions({ to: '/form-schemas' }),
  invoices: linkOptions({ to: '/invoices' }),
  directory: linkOptions({ to: '/directory' }),
  bookings: linkOptions({ to: '/bookings' }),
  sessions: linkOptions({ to: '/sessions' }),
  kintales: linkOptions({ to: '/kintales' }),
  gallery: linkOptions({ to: '/gallery' }),
  templates: linkOptions({ to: '/templates' }),
  'tribal-intel': linkOptions({ to: '/tribal-intel' }),
  packages: linkOptions({ to: '/packages' }),
  schedule: linkOptions({ to: '/schedule' }),
  inbox: linkOptions({ to: '/inbox' }),
  settings: linkOptions({ to: '/settings' }),
  communicate: linkOptions({ to: '/communicate' }),
} as const;

/** Typed lookup: preserves each entry's literal `to` (a lossy Record cast would
 *  erase it and break Link's required `to`). */
function liveLink(slug: string) {
  return slug in LIVE_LINKS ? LIVE_LINKS[slug as keyof typeof LIVE_LINKS] : undefined;
}

/**
 * The admin layout: the persistent Den nav rail + topbar, with the active screen
 * rendered into <Outlet/>. Wraps every admin route (the route tree guards the whole
 * layout with requireAdmin), so a screen component is just its content, and it
 * renders the single <main> landmark; screens render <div>, never a nested <main>.
 */
export function AppShell() {
  // Read the access the layout guard already resolved (S3), rather than minting a
  // second getIdTokenResult, which also removes the null window where a test admin
  // briefly rendered as "Operator" with no sandbox banner.
  const { access } = useRouteContext({ from: '/admin' });

  // The chip has only Firebase Auth to name the operator: the `users/{uid}`
  // profile is the Account screen's own load, and duplicating it here would put
  // a second read on every screen in the app. profileDisplayName's later
  // fallbacks (auth display name, email local-part, then "Operator") are
  // exactly the ones that apply, so the empty profile is passed deliberately,
  // not as a stub.
  const authState = useAuth();
  const user = authState.status === 'signedIn' ? authState.user : null;
  const chipName = profileDisplayName(
    { displayName: '', firstName: '', lastName: '' },
    user?.displayName ?? null,
    user?.email ?? null,
  );
  const roleText = access.status === 'testAdmin' ? 'Test admin, sandbox' : 'Operator';

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
          {/* The operator's way into their own account: phone, email, password.
              Account is a contextual destination (nav.ts), so it is deliberately
              absent from the rail; this chip is its entry point, which is where
              an account link belongs anyway. The role line stays on the chip so
              a sandbox session still announces itself in the topbar. */}
          <Link
            to="/account"
            className="shell__account"
            activeProps={{ className: 'shell__account shell__account--active' }}
            aria-label="Your account"
          >
            <span className="shell__account-monogram" aria-hidden="true">
              {profileInitials(chipName)}
            </span>
            <span className="shell__account-text">
              <span className="shell__account-name">{chipName}</span>
              <span className="shell__account-role">{roleText}</span>
            </span>
          </Link>
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
