import { signOut } from '../lib/auth';
import { useAdminAccess } from '../lib/access';
import { NAV_GROUP_LABEL, railGroup, type NavGroup } from '../lib/nav';
import { GhostButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';

const GROUP_ORDER: NavGroup[] = ['den', 'careOps', 'more'];

/**
 * Band A app shell. The nav rail is real (single source: nav.ts, ported from the
 * wasm NavDestinations), but only Home is a live route today — every other entry
 * is a placeholder until its screen lands in a later band. Rendering them now
 * keeps the rail's shape honest and gives band B obvious slots to fill.
 */
export function Home() {
  const access = useAdminAccess();

  return (
    <div className="shell">
      <aside className="shell__rail" aria-label="Primary navigation">
        <div className="shell__brand">AuntieOS</div>
        {GROUP_ORDER.map((group) => (
          <nav key={group} className="shell__group" aria-label={NAV_GROUP_LABEL[group]}>
            <p className="shell__group-label">{NAV_GROUP_LABEL[group]}</p>
            <ul>
              {railGroup(group).map((entry) => {
                const isHome = entry.dest === 'home';
                return (
                  <li key={entry.dest}>
                    {isHome ? (
                      <span className="shell__link shell__link--active" aria-current="page">
                        {entry.title}
                      </span>
                    ) : (
                      <span className="shell__link shell__link--pending" title="Lands in a later band">
                        {entry.title}
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

        <DenScreenHeading kicker="Overview" title="Home" subtitle="AuntieOS admin — React rebuild" />
        <DenPanel title="Band A: shell + auth online">
          <p>
            Sign-in (admin-claim gate), the app shell, and the router are live on the
            new React stack. The data layer and the individual screens land in the
            next bands.
          </p>
        </DenPanel>
      </main>
    </div>
  );
}
