import { Link } from '@tanstack/react-router';
import { useAuth } from '../lib/auth';
import { NOT_FOUND_TITLE, useScreenTitle } from '../lib/pageTitle';
import { PawMark } from '../screens/SignIn';
import { GlassSurface } from './GlassSurface';
import './Buttons.css';
import './NotFound.css';

/**
 * What an address no screen owns renders (#1845).
 *
 * Before this the router had no not-found screen at all, so `/qa-r1-nope`
 * painted the library's bare "Not Found" in the top left of an empty page: no
 * logo, no words, no way out. The portal had the same defect and fixed it in
 * #1293; this is the admin's half.
 *
 * TWO CASES, because who is asking decides what a way back is.
 *
 *   AdminNotFound     a signed-in operator. Rendered by the catch-all route
 *                     under the admin layout, so the guard has run and the
 *                     shell is around it: the rail is the way to every screen,
 *                     and the card's one button goes Home.
 *   SignedOutNotFound a visitor with no session. The admin guard throws
 *                     `notFound()` for the catch-all instead of bouncing to
 *                     sign-in, and the router renders this at the root. It
 *                     wears the sign-in screen's mark and wordmark, since that
 *                     is the only screen such a visitor can use, and its button
 *                     goes there.
 *
 * The heading is the whole message. No sentence under it (the settled
 * no-subtitle rule), and the address is not echoed back.
 */
const HEADING = 'We can’t find that page.';

export function AdminNotFound() {
  return (
    <div className="routeerr" data-testid="not-found">
      <div className="routeerr__stage">
        <GlassSurface className="routeerr__card notfound__card">
          <h1 className="notfound__title">{HEADING}</h1>
          <Link to="/home" className="auntie-btn auntie-btn--primary">
            <span className="auntie-btn__label">Back to Home</span>
          </Link>
        </GlassSurface>
      </div>
    </div>
  );
}

export function SignedOutNotFound() {
  // Rendered at the root, which has no route title of its own.
  useScreenTitle(NOT_FOUND_TITLE);
  // The root default also catches any `notFound()` a screen might throw, so a
  // session that IS signed in is offered Home rather than a sign-in it has done.
  const signedIn = useAuth().status === 'signedIn';
  return (
    <main className="signin" data-testid="not-found">
      <div className="signin__stage">
        <div className="signin__mark d1" aria-hidden="true">
          <PawMark />
        </div>
        <p className="signin__brand d2">AuntieOS</p>
        <GlassSurface className="signin__card notfound__card d3">
          <h1 className="signin__title">{HEADING}</h1>
          <Link to={signedIn ? '/home' : '/signin'} className="auntie-btn auntie-btn--primary">
            <span className="auntie-btn__label">{signedIn ? 'Back to Home' : 'Sign in'}</span>
          </Link>
        </GlassSurface>
      </div>
    </main>
  );
}
