/**
 * Nav + routing, ported from the wasm app's `NavDestinations.kt` and `Route.kt`.
 *
 * Single source of truth for the rail. Order here is the order shown.
 *
 * Two behaviours worth keeping, both of which the Compose app got right:
 *  - Contextual destinations (Media, Account, My notifications) are reachable by
 *    URL but never pinned in the rail. Nothing is unreachable; the rail stays
 *    curated.
 *  - `routeWarning` fails loud on a dead link. `parseHash` falls back to Home,
 *    which on its own would silently swallow a typo'd or retired URL, so the
 *    warning makes the fallback visible. Do not drop it during the port: it is
 *    the same fail-loud instinct as Form Schemas, applied to routing.
 */

export type Destination =
  | 'home'
  | 'directory'
  | 'kintales'
  | 'gallery'
  | 'schedule'
  | 'bookings'
  | 'sessions'
  | 'invoices'
  | 'communicate'
  | 'inbox'
  | 'notifications'
  | 'activity'
  | 'settings'
  | 'trainingDocs'
  | 'templates'
  | 'formSchemas'
  | 'featureFlags'
  | 'mediaGallery'
  | 'accountSettings'
  | 'myNotifications';

export type NavGroup = 'den' | 'careOps' | 'more';

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  den: 'The Den',
  careOps: 'Care Ops',
  more: 'More',
};

export interface NavEntry {
  readonly dest: Destination;
  /** Rail label. "Auntie Time" is Sessions; the two names are not interchangeable. */
  readonly title: string;
  readonly group: NavGroup;
  /** Stable, kebab-case URL slug. */
  readonly slug: string;
  /** Reachable by URL but never pinned in the rail. */
  readonly contextual?: true;
}

/** Order is the order shown in the rail. */
export const NAV: readonly NavEntry[] = [
  { dest: 'home', title: 'Home', group: 'den', slug: 'home' },
  { dest: 'directory', title: 'Directory', group: 'den', slug: 'directory' },
  { dest: 'kintales', title: 'KinTales', group: 'den', slug: 'kintales' },
  { dest: 'gallery', title: 'Gallery', group: 'den', slug: 'gallery' },

  { dest: 'schedule', title: 'Schedule', group: 'careOps', slug: 'schedule' },
  { dest: 'bookings', title: 'Bookings', group: 'careOps', slug: 'bookings' },
  // The rail says "Auntie Time"; the slug and the code say sessions.
  { dest: 'sessions', title: 'Auntie Time', group: 'careOps', slug: 'sessions' },
  { dest: 'invoices', title: 'Invoices', group: 'careOps', slug: 'invoices' },
  { dest: 'communicate', title: 'Communicate', group: 'careOps', slug: 'communicate' },

  { dest: 'inbox', title: 'Inbox', group: 'more', slug: 'inbox' },
  { dest: 'notifications', title: 'Notifications', group: 'more', slug: 'notifications' },
  { dest: 'activity', title: 'Activity Log', group: 'more', slug: 'activity' },
  { dest: 'settings', title: 'Settings', group: 'more', slug: 'settings' },
  { dest: 'trainingDocs', title: 'Tribal Intel', group: 'more', slug: 'tribal-intel' },
  { dest: 'templates', title: 'Templates', group: 'more', slug: 'templates' },
  { dest: 'formSchemas', title: 'Form Schemas', group: 'more', slug: 'form-schemas' },
  { dest: 'featureFlags', title: 'Feature Flags', group: 'more', slug: 'feature-flags' },

  // Contextual: reachable, never pinned.
  { dest: 'mediaGallery', title: 'Media', group: 'more', slug: 'media', contextual: true },
  { dest: 'accountSettings', title: 'Account', group: 'more', slug: 'account', contextual: true },
  {
    dest: 'myNotifications',
    title: 'My notifications',
    group: 'more',
    slug: 'my-notifications',
    contextual: true,
  },
];

/** What the rail renders, in order. Contextual destinations are filtered out. */
export function railEntries(): NavEntry[] {
  return NAV.filter((e) => !e.contextual);
}

/** Rail entries for one group, in order. */
export function railGroup(group: NavGroup): NavEntry[] {
  return railEntries().filter((e) => e.group === group);
}

const BY_SLUG = new Map<string, Destination>([
  ...NAV.map((e) => [e.slug, e.dest] as const),
  // Back-compat: the old slug still resolves after the Tribal Intel rename.
  ['training-docs', 'trainingDocs'],
  // Legacy standalone template slugs resolve to the merged two-tab screen.
  ['template-bank', 'templates'],
  ['template-assignment', 'templates'],
]);

const BY_DEST = new Map<Destination, string>(NAV.map((e) => [e.dest, e.slug]));

export interface Route {
  readonly dest: Destination;
  readonly detailId?: string;
  readonly detailType?: string;
}

function segments(hash: string): string[] {
  return hash
    .replace(/^#/, '')
    .replace(/^\//, '')
    .split('/')
    .filter((s) => s.trim() !== '');
}

/** Parse a hash into a Route. Unknown or empty resolves to Home (see routeWarning). */
export function parseHash(hash: string): Route {
  const parts = segments(hash);
  const first = parts[0];
  if (first === undefined) return { dest: 'home' };

  const dest = BY_SLUG.get(first);
  if (dest === undefined) return { dest: 'home' };

  const detailId = parts[1];
  const detailType = parts[2];
  if (detailId !== undefined && detailType !== undefined) return { dest, detailId, detailType };
  if (detailId !== undefined) return { dest, detailId };
  return { dest };
}

/**
 * A message to show when [hash] names a slug that resolves to no screen.
 *
 * `parseHash` falls back to Home, which alone would swallow a dead link in
 * silence. The router still lands on Home; this makes the dead link visible.
 * Null for a valid or empty hash.
 */
export function routeWarning(hash: string): string | null {
  const slug = segments(hash)[0];
  if (slug === undefined) return null;
  return BY_SLUG.has(slug) ? null : `The page "${slug}" isn't available. Showing Home instead.`;
}

/** Build a hash for a route. */
export function routeToHash(r: Route): string {
  const slug = BY_DEST.get(r.dest) ?? 'home';
  if (r.dest === 'mediaGallery') return `#/media/${r.detailType ?? 'kin'}/${r.detailId ?? ''}`;
  if (r.detailId !== undefined && r.detailType !== undefined) {
    return `#/${slug}/${r.detailId}/${r.detailType}`;
  }
  if (r.detailId !== undefined) return `#/${slug}/${r.detailId}`;
  return `#/${slug}`;
}
