import { useId, useState, type ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { type ResolvedScalar } from '../lib/async';
import './DenScreenKit.css';

/**
 * DenScreenKit, ported from the Compose commonMain kit of the same name.
 *
 * The Compose original is the shared Den vocabulary: mono kicker + serif
 * heading, brand-toned stat cards, glass panels, service pills, quiet hints.
 * Screens compose these instead of re-inventing layout, so the whole app reads
 * as one Den rather than 20 divergent pages. That intent carries over verbatim.
 *
 * What deliberately does NOT carry over is StatCard's `value: String`. See the
 * note on StatCard: the wasm signature is what let a permission-denied read
 * render as a confident "0" on production 2026-07-15.
 */

// ── tone ────────────────────────────────────────────────────────────────────

/** Mirrors Compose `AuntieStatusTone`. Resolved to a token in the CSS, never here. */
export type DenTone = 'neutral' | 'success' | 'warning' | 'error' | 'teal' | 'purple' | 'orange' | 'muted';

/** Maps a free-text service type to a brand tone, per the Compose `serviceTone`. */
export function serviceTone(serviceType: string): DenTone {
  const s = serviceType.toLowerCase();
  if (s.includes('walk')) return 'teal';
  if (s.includes('drop')) return 'orange';
  if (s.includes('sit') || s.includes('house') || s.includes('overnight')) return 'purple';
  if (s.includes('meet') || s.includes('greet')) return 'success';
  return 'orange';
}

// ── breadcrumbs ─────────────────────────────────────────────────────────────

/**
 * One step of a breadcrumb trail. Exactly one of three shapes, and which one it
 * is decides what gets rendered:
 *
 *   `link`      a real route. Renders an anchor, so it opens in a new tab, has a
 *               copyable address, and is a link to assistive technology.
 *   `onSelect`  a sibling VIEW of the screen you are on, which is what half of
 *               these destinations are: opening a household from the Directory
 *               list never changes the URL, so `<Link to="/directory">` there
 *               resolves to the page you are standing on and clicking it does
 *               nothing. Renders a button, which is what it actually is.
 *   neither     the page you are on. Text, and `aria-current="page"`.
 *
 * `link` is `LinkProps` rather than a bare `to: string` on purpose: the router
 * is typed through the `Register` declaration in `router.tsx`, so a made-up path
 * fails `npm run typecheck` instead of rendering a dead crumb. Build one with
 * `linkOptions({ to: '/directory' })`, the same way `AppShell` builds the rail.
 */
export interface Crumb {
  label: string;
  link?: LinkProps;
  onSelect?: () => void;
}

/**
 * The mocks' `.crumbs`: mono, 12px, .04em tracking, a slash between entries.
 *
 * The `<ol>` is not decoration. A trail is ordered, and its order is the
 * meaning; a screen reader announcing "list, 3 items" before "Directory" is
 * telling the operator how deep they are, which is the entire complaint this
 * answers.
 */
export function DenBreadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav className="den-crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => (
          // Keyed by position, not label: a trail legitimately repeats a word
          // ("Directory / Kinfolk / Directory" is not a bug), and two <li>s with
          // the same key silently drop one of them.
          <li key={`${i}-${crumb.label}`}>
            <CrumbStep crumb={crumb} />
            {i < crumbs.length - 1 && (
              <span className="den-crumbs-sep" aria-hidden="true">
                /
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function CrumbStep({ crumb }: { crumb: Crumb }) {
  if (crumb.link !== undefined) {
    return <Link {...crumb.link}>{crumb.label}</Link>;
  }
  if (crumb.onSelect !== undefined) {
    return (
      <button type="button" className="den-crumbs-step" onClick={crumb.onSelect}>
        {crumb.label}
      </button>
    );
  }
  return <span aria-current="page">{crumb.label}</span>;
}

// ── page heading ────────────────────────────────────────────────────────────

interface DenScreenHeadingBase {
  title: string;
  /** Painted in primary and italic, the way the Den heading emphasises its last word. */
  accentTail?: string;
  subtitle?: string;
  trailing?: ReactNode;
  className?: string;
}

/**
 * A heading carries EITHER a section kicker or a breadcrumb trail, never both
 * and never neither.
 *
 * Not a style rule: the ten `.crumbs` mocks all put the trail exactly where a
 * list screen puts its kicker, and not one of them shows the two together.
 * "THE DEN · DIRECTORY" reads identically on the list and three levels down, so
 * on a nested screen it is the line that has nothing to say and the trail is the
 * line that does. Expressed as a union so a nested screen cannot keep the stale
 * kicker by accident.
 */
type DenScreenHeadingProps = DenScreenHeadingBase &
  (
    | { kicker: string; crumbs?: never }
    | { crumbs: readonly Crumb[]; kicker?: never }
  );

/**
 * The standard Den page heading: uppercase mono kicker (or a breadcrumb trail
 * in its place), serif title with an optional italic accent tail, optional
 * subtitle blurb, optional trailing slot.
 */
export function DenScreenHeading({
  kicker,
  crumbs,
  title,
  accentTail,
  subtitle,
  trailing,
  className,
}: DenScreenHeadingProps) {
  return (
    <header className={className ? `den-heading ${className}` : 'den-heading'}>
      <div className="den-heading-main">
        {/* Uppercased in CSS, not here, so the accessible name keeps the author's
            casing instead of being read out as shouting by a screen reader. */}
        {crumbs === undefined ? (
          <p className="den-heading-kicker">{kicker}</p>
        ) : (
          <DenBreadcrumbs crumbs={crumbs} />
        )}
        <h1 className="den-heading-title">
          {accentTail ? `${title} ` : title}
          {accentTail !== undefined && <em className="den-heading-accent">{accentTail}</em>}
        </h1>
        {subtitle !== undefined && <p className="den-heading-subtitle">{subtitle}</p>}
      </div>
      {trailing !== undefined && <div className="den-heading-trailing">{trailing}</div>}
    </header>
  );
}

// ── stat card ───────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  /**
   * NOT a string, and not a number. The load state itself.
   *
   * The Compose signature is `value: String`, and every call site fills it with
   * `(state as? Data)?.value?.size ?: 0`. That `?: 0` is a fabricated claim: on
   * 2026-07-15 an operator saw "Open bookings: 0 / needs a reply" while the read
   * was permission-denied, with no error anywhere on the screen. Home has no
   * bookings panel, so the card was the only surface that could have told the
   * truth, and it said zero instead.
   *
   * Taking `ResolvedScalar<number>` removes the place the fallback used to live.
   * A caller holding an `Async<T>` can only reach a number through `asyncScalar`,
   * whose `project` never runs on a failed read, so a number this card renders is
   * always a number someone actually read.
   */
  value: ResolvedScalar<number>;
  /** The subline under the value. Rendered ONLY beside a real number: it is a claim too. */
  trend: string;
  tone: DenTone;
  /** The hero variant: tone wash, tone-painted value, larger type. */
  feature?: boolean;
  onClick?: () => void;
  /** Formats a proven number (currency, "3 of 8"). Never runs on loading or error. */
  formatValue?: (value: number) => string;
  className?: string;
}

/**
 * A Den stat card: small label, big value, trend subline, tone accent.
 *
 * Three renderings, one per load state, and the card picks which:
 *   loading  an ellipsis, no trend      (nothing is known yet, so it claims nothing)
 *   error    a dash, and the failure    (unknown is not zero)
 *   value    the number, and the trend
 */
export function StatCard({
  label,
  value,
  trend,
  tone,
  feature = false,
  onClick,
  formatValue,
  className,
}: StatCardProps) {
  const classes = ['den-stat', feature ? 'den-stat--feature' : null, className]
    .filter(Boolean)
    .join(' ');

  const body = <StatBody label={label} value={value} trend={trend} formatValue={formatValue} />;

  // A real <button> when it acts like one. The wasm card is a clickable Box, which
  // is why the canvas exposes no role, no focus ring, and no keyboard path (AO-15).
  //
  // `lift` (styles/base.css) rides on THIS branch only. The lift is a promise
  // that clicking does something, so the plain <div> card below must not carry
  // it: not clickable, does not rise.
  if (onClick) {
    return (
      <button type="button" className={`${classes} den-stat--button lift`} data-tone={tone} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div className={classes} data-tone={tone}>
      {body}
    </div>
  );
}

/**
 * Spread out of StatCard rather than Pick'd from its props: under
 * exactOptionalPropertyTypes an optional prop and an explicitly-undefined one are
 * different types, and forwarding the destructured `formatValue` is the latter.
 */
interface StatBodyProps {
  label: string;
  value: ResolvedScalar<number>;
  trend: string;
  formatValue: ((value: number) => string) | undefined;
}

/** Spans throughout: StatCard renders inside a <button> when clickable, and a button may only contain phrasing content. */
function StatBody({ label, value, trend, formatValue }: StatBodyProps) {
  return (
    <span className="den-stat-body">
      <span className="den-stat-label">{label}</span>

      {value.kind === 'loading' && (
        <>
          <span className="den-stat-value den-stat-value--pending" role="status" aria-label={`${label}, still loading`}>
            {'…'}
          </span>
          <span className="den-stat-trend">Counting{'…'}</span>
        </>
      )}

      {value.kind === 'error' && (
        <>
          {/* A hyphen, not a zero. The dash is the honest answer to "how many?"
              when the read failed, and the trend below says why. */}
          <span className="den-stat-value den-stat-value--unknown" aria-hidden="true">
            -
          </span>
          <span className="den-stat-trend den-stat-trend--error" role="alert">
            Couldn&rsquo;t load {label.toLowerCase()}: {value.message}
          </span>
        </>
      )}

      {value.kind === 'value' && (
        <>
          <span className="den-stat-value">
            {formatValue ? formatValue(value.value) : String(value.value)}
          </span>
          {/* Only reachable here. "needs a reply" beside a dash would be the second
              half of the 2026-07-15 bug: a claim about data nobody could read. */}
          <span className="den-stat-trend">{trend}</span>
        </>
      )}
    </span>
  );
}

// ── section panel ───────────────────────────────────────────────────────────

interface DenPanelProps {
  title: string;
  subtitle?: string;
  /** Header becomes a disclosure button. Collapses tall stacks above the fold. */
  collapsible?: boolean;
  initiallyExpanded?: boolean;
  hoverLift?: boolean;
  /**
   * The mocks' `.ct`: a short, right-aligned mono note on the panel header, for
   * a count or a total ("2 pets", "12 total", "$0 outstanding").
   *
   * Distinct from `trailing`, which holds CONTROLS. This is a statement about
   * the panel's contents, so it is text and it is never interactive, and it
   * exists as its own prop because the alternative screens kept reaching for was
   * concatenating the number into `title` ("Kin · 2"), which puts a number
   * inside the heading a screen reader announces as the section's name.
   */
  meta?: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Heading level for the panel title. A Den screen's own `DenScreenHeading`
   * owns the page `h1`, so a panel sitting directly on the screen is one level
   * under that: `2` is the sane default. A panel composed inside something that
   * already carries its own `h2` (the sheet/modal `Dialog` renders
   * `dialog__title` as an `h2`, e.g. `BookingDetailModal`) passes `3` so the
   * outline still nests correctly instead of jumping back up a level mid-document.
   */
  headingLevel?: 2 | 3 | 4;
}

/**
 * A glass section panel with a serif title, optional subtitle and trailing slot,
 * then arbitrary content. The workhorse container for Den dashboards.
 */
export function DenPanel({
  title,
  subtitle,
  collapsible = false,
  initiallyExpanded = true,
  hoverLift = false,
  meta,
  trailing,
  children,
  className,
  headingLevel = 2,
}: DenPanelProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const contentId = useId();
  const showContent = !collapsible || expanded;

  // `lift` is the shared utility in styles/base.css, and it replaces the old
  // `den-panel--lift` modifier: one class, one definition, one reduced-motion
  // guard for every card in the app that rises.
  const classes = ['den-panel', hoverLift ? 'lift' : null, className].filter(Boolean).join(' ');

  // An empty title must not become an empty heading: that reads to a screen
  // reader as a landmark with nothing to announce, worse than the span it
  // replaces. A real title gets the real heading element; a blank one falls
  // back to the plain span the whole app used to render, silent either way.
  const hasTitle = title.trim() !== '';
  const TitleTag = hasTitle ? (`h${headingLevel}` as 'h2' | 'h3' | 'h4') : 'span';

  const heading = (
    <span className="den-panel-heading">
      <TitleTag className="den-panel-title">{title}</TitleTag>
      {subtitle !== undefined && <span className="den-panel-subtitle">{subtitle}</span>}
    </span>
  );

  return (
    <section className={classes}>
      <div className="den-panel-header">
        {collapsible ? (
          <button
            type="button"
            className="den-panel-toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((e) => !e)}
          >
            {heading}
            <Chevron expanded={expanded} />
          </button>
        ) : (
          heading
        )}
        {meta !== undefined && meta.trim() !== '' && <span className="den-panel-meta">{meta}</span>}
        {trailing !== undefined && <div className="den-panel-trailing">{trailing}</div>}
      </div>
      {showContent && (
        <div className="den-panel-content" id={contentId}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Inline, because no icon package is installed here and one glyph is not worth a dependency. */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="den-panel-chevron"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-expanded={expanded}
    >
      <path d={expanded ? 'M6 9l6 6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  );
}

// ── service pill ────────────────────────────────────────────────────────────

interface ServicePillProps {
  serviceType: string;
  tone?: DenTone;
}

/** A small lowercase mono pill tinted to a service tone. */
export function ServicePill({ serviceType, tone }: ServicePillProps) {
  const label = serviceType.trim() === '' ? 'visit' : serviceType;
  return (
    <span className="den-pill" data-tone={tone ?? serviceTone(serviceType)}>
      {label}
    </span>
  );
}

// ── hints ───────────────────────────────────────────────────────────────────

/**
 * A quiet inline hint for a PROVEN-empty panel. "No visits today. Enjoy the quiet."
 *
 * The Compose original is `EmptyHint(text, error: Boolean)`, one component with
 * two moods, which is how "No Tribal Intel yet" ends up stacked under
 * "Couldn't load training documents": the boolean makes empty and error look
 * like the same thing wearing a different colour. They are not. Empty is a fact
 * about the data; an error means there IS no fact. So they are separate types
 * here, and neither can be talked into being the other.
 *
 * For a whole region, prefer AsyncRegion, which picks between these for you.
 */
export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="den-hint">{children}</p>;
}

/**
 * The failure counterpart: announced, tone-error, and never says "nothing here yet".
 *
 * role="alert" rather than colour alone. Red text is not an error message if
 * nothing can read it (the wasm canvas exposes no accessibility tree at all).
 */
export function ErrorHint({ children }: { children: ReactNode }) {
  return (
    <p className="den-hint den-hint--error" role="alert">
      {children}
    </p>
  );
}
