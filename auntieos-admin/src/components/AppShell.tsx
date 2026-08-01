import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, Outlet, linkOptions, useRouteContext } from '@tanstack/react-router';
import { signOut, useAuth } from '../lib/auth';
import { useUnreadInbox } from '../lib/useUnreadInbox';
import { reportError } from '../lib/sentry';
import {
  NAV_GROUP_LABEL,
  railEntries,
  railGroup,
  type NavEntry,
  type NavGroup,
} from '../lib/nav';
import { profileDisplayName, profileInitials } from '../lib/accountFormat';
import { NavGlyph } from './NavGlyphs';
import { GhostButton } from './Buttons';
import { Banner } from './Banner';

const GROUP_ORDER: NavGroup[] = ['den', 'careOps', 'more'];

/**
 * The width at which the rail stops being a column and becomes a drawer.
 *
 * WRITTEN TWICE ON PURPOSE, here and in `styles/shell.css`. CSS cannot read a
 * custom property inside a media query, so the breakpoint has to be a literal
 * there; this constant is what closes the drawer when a phone-width window is
 * widened past it, so `aria-expanded` cannot keep saying "open" about a panel
 * the cascade has already turned back into a static rail.
 */
const PHONE_MAX_WIDTH_PX = 720;

/** Chrome glyphs for the drawer's two controls. Same idiom as `NavGlyphs.tsx`
 *  (24-unit viewBox, no fill, `currentColor` stroke, out of the a11y tree), but
 *  keyed to nothing in `Destination`, so they live with the shell that uses
 *  them rather than in the destination-keyed map. */
function ChromeGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="nav-glyph"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const MenuGlyph = () => (
  <ChromeGlyph>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </ChromeGlyph>
);

const CloseGlyph = () => (
  <ChromeGlyph>
    <path d="M6 6l12 12M18 6L6 18" />
  </ChromeGlyph>
);

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
  // The visit-recap / checklist editor. Registered in router.tsx from the day
  // the screen shipped, but missing here until 2026-07-25, so the rail advertised
  // a finished screen as "(coming soon)" (operator issue #8). AppShell.test.tsx
  // now asserts no rail entry can fall through the fallback again.
  'kintale-templates': linkOptions({ to: '/kintale-templates' }),
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
 * Rail slugs that would render as the disabled "(coming soon)" span because
 * `LIVE_LINKS` has no entry for them. Exported for the regression test, which
 * asserts this is empty: the fallback is for a rail entry added ahead of its
 * route, never for a screen that already shipped.
 */
export function railPendingSlugs(): string[] {
  return railEntries()
    .filter((e) => liveLink(e.slug) === undefined)
    .map((e) => e.slug);
}

/** Live numbers for the rail's count pills, keyed by nav slug. */
export type RailCounts = Readonly<Record<string, number | undefined>>;

/**
 * The number to show on [slug]'s pill, or null for no pill at all.
 *
 * Zero renders nothing: an empty inbox and an inbox with a "0" beside it say
 * different things, and the emptier one is the truth. A negative or non-finite
 * count is a bug upstream, and the rail refuses to render it rather than
 * displaying "-1" or "NaN" on every screen in the app.
 */
export function railCount(counts: RailCounts, slug: string): number | null {
  const n = counts[slug];
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * One rail row: icon, label, and the count pill when there is a real number.
 *
 * Exported for the test, which is the only way to exercise the "(coming soon)"
 * branch: every rail slug is currently live (see AppShell.railLinks.test.ts,
 * which asserts exactly that), so AppShell alone can never render it.
 */
export function RailItem({ entry, count }: { entry: NavEntry; count: number | null }) {
  const link = liveLink(entry.slug);
  if (!link) {
    // Not built yet: no link, no pill (there is no screen for a number to be
    // about), and aria-disabled so it is not just visually greyed.
    return (
      <span className="shell__link shell__link--pending" aria-disabled="true">
        <NavGlyph dest={entry.dest} />
        <span className="shell__link-label">{entry.title}</span>
        <span className="shell__pending-note"> (coming soon)</span>
      </span>
    );
  }
  return (
    <Link
      {...link}
      className="shell__link"
      activeProps={{ className: 'shell__link shell__link--active' }}
    >
      <NavGlyph dest={entry.dest} />
      <span className="shell__link-label">{entry.title}</span>
      {/* Deliberately NOT aria-hidden. The glyph is decoration and the label
          already names the destination, but the count is information, and a
          screen reader user hearing "Inbox" while a sighted one sees "Inbox 4"
          is the badge telling two different stories. The separating space is
          what makes the name "Inbox 4" rather than "Inbox4"; collapsible white
          space between flex items is not rendered, so it costs no layout. */}
      {count === null ? null : <> <span className="shell__count">{count}</span></>}
    </Link>
  );
}

/**
 * The admin layout: the persistent Den nav rail + topbar, with the active screen
 * rendered into <Outlet/>. Wraps every admin route (the route tree guards the whole
 * layout with requireAdmin), so a screen component is just its content, and it
 * renders the single <main> landmark; screens render <div>, never a nested <main>.
 *
 * `counts` overrides the live count source and the router never passes it. It is
 * how the tests drive the pill directly, and how a caller embedding the shell
 * (the visual harness) can render a rail without opening a listener.
 */
export function AppShell({ counts }: { counts?: RailCounts } = {}) {
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

  // The rail's one real number: unread client threads, live. See
  // lib/useUnreadInbox.ts for why the shell owns this listener and what a
  // failure is allowed to do (no pill, no banner, navigation untouched).
  const unreadInbox = useUnreadInbox();
  // Reported, not swallowed. A rail that never shows a badge should be
  // diagnosable from the console and from Sentry rather than looking like a
  // feature nobody built. Keyed on the message so a re-render does not repeat
  // the same report, and a NEW failure still gets through.
  const countError = unreadInbox.kind === 'error' ? unreadInbox.message : null;
  useEffect(() => {
    if (countError === null) return;
    console.warn(`Rail inbox count unavailable: ${countError}`);
    reportError(new Error(countError), 'railInboxCount');
  }, [countError]);

  // `counts` (tests, harness) wins when given; otherwise the live listener is
  // the source, and it contributes a number ONLY once it has really resolved.
  const liveCounts: RailCounts = unreadInbox.kind === 'value' ? { inbox: unreadInbox.value } : {};
  const railCounts = counts ?? liveCounts;

  /**
   * PHONE NAVIGATION.
   *
   * Below 720px the rail used to be `display: none` with nothing in its place
   * (`styles/shell.css`), so every screen in the admin was reachable only by
   * typing its URL. The operator's ruling is that mobile web is the desktop
   * product in a phone shape, not a reduced one, so the SAME rail is still the
   * navigation: the cascade turns it into a drawer, this state opens it, and
   * there is still exactly one element in the document labelled "Primary
   * navigation" and exactly one copy of every destination.
   *
   * A drawer rather than a bottom bar because the rail carries nineteen pinned
   * destinations in three labelled groups. A bottom bar holds four or five, so
   * it would have had to choose fourteen to drop, which is the reduced product
   * the ruling rejects.
   */
  const [navOpen, setNavOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Distinguishes "closed because it was just closed" from "closed because the
  // app has only ever been on a desktop", so a first render never steals focus.
  const hasOpened = useRef(false);

  /**
   * Focus in on open, back to the toggle on close. The landing spot is the
   * close button rather than the first destination: it is the way back out, and
   * a screen reader user should hear that before nineteen links.
   *
   * IT DEPENDS ON `shell.css` OPENING THE DRAWER WITH `display`. An element
   * that is not being rendered is not focusable and `focus()` on it is a silent
   * no-op, so the panel has to be laid out by the time this effect runs. The
   * earlier `visibility` version was not, for a reason worth reading, and the
   * reason is written down next to the rule rather than here.
   */
  useEffect(() => {
    if (navOpen) {
      hasOpened.current = true;
      closeRef.current?.focus();
      return;
    }
    if (hasOpened.current) {
      hasOpened.current = false;
      toggleRef.current?.focus();
    }
  }, [navOpen]);

  // Escape closes. Bound on the document, not on the panel: focus can legally
  // sit on the scrim-covered page after a click, and the key still has to work.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setNavOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navOpen]);

  // The page behind a drawer must not scroll under it.
  useEffect(() => {
    if (!navOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [navOpen]);

  // Widening past the breakpoint turns the drawer back into the static rail
  // by cascade alone, which would leave `aria-expanded="true"` describing a
  // panel that is no longer a panel, and a scrim over a desktop app.
  // `matchMedia` is optional-chained for jsdom, which has no layout.
  useEffect(() => {
    if (!navOpen) return undefined;
    const query = window.matchMedia?.(`(min-width: ${String(PHONE_MAX_WIDTH_PX + 1)}px)`);
    if (query === undefined) return undefined;
    const onChange = () => {
      if (query.matches) setNavOpen(false);
    };
    onChange();
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [navOpen]);

  /**
   * Following a link closes the drawer. Delegated from the panel rather than
   * put on each `RailItem`, so `RailItem` stays the same component the rail and
   * the drawer both render and gains no knowledge of which one it is in.
   */
  const closeOnNavigate = (event: MouseEvent<HTMLElement>) => {
    if (!navOpen) return;
    if ((event.target as HTMLElement).closest('a') === null) return;
    setNavOpen(false);
  };

  return (
    <div className={navOpen ? 'shell shell--nav-open' : 'shell'}>
      {/* Only while open, and only ever visible below the breakpoint (the class
          is `display: none` above it). Clicking it closes, which is the gesture
          every drawer has; the keyboard equivalent is Escape. */}
      {navOpen ? (
        <div className="shell__scrim" onClick={() => { setNavOpen(false); }} aria-hidden="true" />
      ) : null}

      <aside
        id="shell-rail"
        className="shell__rail"
        aria-label="Primary navigation"
        onClick={closeOnNavigate}
      >
        {/* The brand mark, per the mock rail: a conic-gradient tile carrying the
            monogram, with the wordmark beside it. The tile is the first and only
            place the three brand hues appear at any size in the shell. The "A"
            is decoration on top of the wordmark that follows it, so it stays out
            of the accessibility tree. */}
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true">
            A
          </span>
          <span className="shell__brand-word">AuntieOS</span>
          {/* The way out of the drawer, for a pointer and for the keyboard.
              `display: none` above the breakpoint, where the rail is a column
              and there is nothing to close. */}
          <button
            ref={closeRef}
            type="button"
            className="shell__navclose"
            aria-label="Close navigation"
            onClick={() => { setNavOpen(false); }}
          >
            <CloseGlyph />
          </button>
        </div>
        {GROUP_ORDER.map((group) => (
          <nav key={group} className="shell__group" aria-label={NAV_GROUP_LABEL[group]}>
            <p className="shell__group-label">{NAV_GROUP_LABEL[group]}</p>
            <ul>
              {railGroup(group).map((entry) => (
                <li key={entry.dest}>
                  <RailItem entry={entry} count={railCount(railCounts, entry.slug)} />
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </aside>

      {/* `inert` while the drawer is open is the whole modality: it takes the
          screen behind the scrim out of the tab order AND out of the
          accessibility tree, so Tab cycles the drawer and a screen reader does
          not wander into a page the operator cannot see. It replaces a
          hand-rolled focus trap, and it can only ever be set below the
          breakpoint, because the toggle that sets `navOpen` is `display: none`
          above it. */}
      <main className="shell__main" inert={navOpen}>
        <header className="shell__topbar">
          {/* The drawer's opener. A real button carrying `aria-expanded` and
              `aria-controls`, not a link and not a div, and `display: none`
              above the breakpoint so the desktop topbar is untouched. */}
          <button
            ref={toggleRef}
            type="button"
            id="shell-nav-toggle"
            className="shell__navtoggle"
            aria-label="Navigation"
            aria-expanded={navOpen}
            aria-controls="shell-rail"
            onClick={() => {
              setNavOpen(true);
            }}
          >
            <MenuGlyph />
          </button>
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
