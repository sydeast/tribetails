import { Link } from '@tanstack/react-router';
import { useAuth } from '../lib/auth';
import { PortalNav } from '../components/PortalNav';
/**
 * What the router renders for a path no route owns (#1293).
 *
 * Before this the router set `defaultErrorComponent` but no
 * `defaultNotFoundComponent`, so a mistyped or stale link rendered the
 * library's bare "Not Found" in the top-left corner, with no header and no way
 * back.
 *
 * It sits inside the root layout, so the drifting orbs and the session notice
 * are already there. A signed-in household also gets the real nav, which is
 * the way out to any screen. A visitor who is signed out, or whose session is
 * still resolving, gets the wordmark only: the nav's links would all bounce
 * them to the sign-in screen, and its data calls need a session. "/" does the
 * right thing for every state (signed in goes to Home, signed out to sign-in),
 * so the one link is the same for both.
 */
export function NotFound() {
  const auth = useAuth();
  const signedIn = auth.status === 'signedIn';
  return (
    <>
      {signedIn ? (
        <PortalNav active={null} />
      ) : (
        <nav className="nav" aria-label="MyTribe">
          <div className="in">
            <div className="wordmark">
              My<span className="grad">Tribe</span>
            </div>
          </div>
        </nav>
      )}
      <div className="wrap">
        <main className="glass card" data-testid="not-found" style={{ marginTop: 40, textAlign: 'center' }}>
          <div className="sectlabel">Page not found</div>
          <h1>We can&rsquo;t find that page.</h1>
          <p className="sub" style={{ margin: '12px auto 20px', maxWidth: '44ch' }}>
            The link may be old, or the address may have a typo.
          </p>
          <Link className="btn grad" to={signedIn ? '/home' : '/'}>
            Back to Home
          </Link>
        </main>
      </div>
    </>
  );
}
