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
  | 'coveragePackages'
  | 'schedule'
  | 'bookings'
  | 'sessions'
  | 'invoices'
  | 'communicate'
  | 'marketingBlasts'
  | 'inbox'
  | 'notifications'
  | 'activity'
  | 'settings'
  | 'trainingDocs'
  | 'templates'
  | 'kinTaleTemplates'
  | 'formSchemas'
  | 'featureFlags'
  | 'mediaGallery'
  | 'accountSettings'
  | 'myNotifications'
  | 'householdMembers'
  | 'invites'
  | 'vetClinics';

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
  /**
   * The owner's screen only (#2163): an Auntie gets no rail entry and every
   * address for it sends her Home (`router.tsx#refuseAuntie`).
   */
  readonly ownerOnly?: true;
}

/** Order is the order shown in the rail. */
export const NAV: readonly NavEntry[] = [
  { dest: 'home', title: 'Home', group: 'den', slug: 'home' },
  { dest: 'directory', title: 'Directory', group: 'den', slug: 'directory' },
  // The admin-WIDE invite list. Pinned, unlike `householdMembers` below, which
  // is the same data for ONE household and is reached from that household's
  // profile. This one has no household to be reached from — it is the every-
  // household view, and "who never accepted" is a question asked cold — so a
  // rail entry is the only way it gets found. Beside Directory because it is
  // about the households Directory lists.
  { dest: 'invites', title: 'Invites', group: 'den', slug: 'invites' },
  { dest: 'kintales', title: 'KinTales', group: 'den', slug: 'kintales' },
  { dest: 'gallery', title: 'Gallery', group: 'den', slug: 'gallery' },

  // #2200 / #2201, lead ruling 2026-11-13: an Auntie never sees money, and
  // marketing and audit oversight are the owner's. Packages, Invoices,
  // Marketing blasts and Activity Log are off her rail and their addresses
  // send her Home, the way Settings and Templates are (#2163).
  { dest: 'coveragePackages', title: 'Packages', group: 'careOps', slug: 'packages', ownerOnly: true },
  { dest: 'schedule', title: 'Schedule', group: 'careOps', slug: 'schedule' },
  { dest: 'bookings', title: 'Bookings', group: 'careOps', slug: 'bookings' },
  // The rail says "Auntie Time"; the slug and the code say sessions.
  { dest: 'sessions', title: 'Auntie Time', group: 'careOps', slug: 'sessions' },
  { dest: 'invoices', title: 'Invoices', group: 'careOps', slug: 'invoices', ownerOnly: true },
  { dest: 'communicate', title: 'Communicate', group: 'careOps', slug: 'communicate' },
  // Beside Communicate because the two are the same act at two times:
  // Communicate sends now, this schedules. Pinned rather than contextual, since
  // "what goes out next week" is a question asked cold, with no screen to
  // arrive from.
  {
    dest: 'marketingBlasts',
    title: 'Marketing blasts',
    group: 'careOps',
    slug: 'marketing-blasts',
    ownerOnly: true,
  },

  { dest: 'inbox', title: 'Inbox', group: 'more', slug: 'inbox' },
  { dest: 'notifications', title: 'Notifications', group: 'more', slug: 'notifications' },
  { dest: 'activity', title: 'Activity Log', group: 'more', slug: 'activity', ownerOnly: true },
  // #2163, operator ruling 2026-11-13: an Auntie sees neither Settings nor
  // Templates (email, SMS, push). KinTale templates below stays hers.
  { dest: 'settings', title: 'Settings', group: 'more', slug: 'settings', ownerOnly: true },
  { dest: 'trainingDocs', title: 'Tribal Intel', group: 'more', slug: 'tribal-intel' },
  { dest: 'templates', title: 'Templates', group: 'more', slug: 'templates', ownerOnly: true },
  // The visit-recap / checklist template editor (kintale_templates), distinct
  // from the email "Templates" above. Reachable from KinTales conceptually; a
  // pinned rail entry so it is discoverable next to the other authoring screens.
  { dest: 'kinTaleTemplates', title: 'KinTale templates', group: 'more', slug: 'kintale-templates' },
  { dest: 'formSchemas', title: 'Form Schemas', group: 'more', slug: 'form-schemas' },
  { dest: 'featureFlags', title: 'Feature Flags', group: 'more', slug: 'feature-flags' },
  // The business notification gate had a pinned entry here from #396/#435
  // onward (reachable at /notification-gate, beside Templates and Feature
  // Flags as the third what-the-platform-emits screen). #718 reverses that:
  // the operator wants exactly one way to the gate, the Notifications section
  // under Settings, so it is no longer a destination at all. The old
  // `/notification-gate` route still exists in router.tsx, but only to
  // redirect into Settings > Notifications, so a bookmark or link still lands
  // somewhere instead of 404ing.

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
  // B1. Household members and invites, always about ONE household, so it is
  // reached from that household's profile and never pinned: a rail entry would
  // have no household to open. page-specs Decision 8 (LOCKED) re-homed this out
  // of Settings and under Directory / Households / {household} / Members, which
  // is exactly where the entry point lives.
  {
    dest: 'householdMembers',
    title: 'Members and invites',
    group: 'den',
    slug: 'household-members',
    contextual: true,
  },
  // The shared vet bank (punchlist B4). Contextual rather than pinned: it is a
  // catalog the operator tidies occasionally, reached from Settings and from a
  // household's vet picker, not a daily destination that earns a rail slot. The
  // spec files it under Settings; this keeps it addressable by URL either way.
  {
    dest: 'vetClinics',
    title: 'Vet clinics',
    group: 'more',
    slug: 'vet-clinics',
    contextual: true,
  },
];

/**
 * What the rail renders, in order. Contextual destinations are filtered out,
 * and so are the owner-only ones when the signed-in account is an Auntie
 * (#2163). `isAuntie` defaults to false, so the owner, the test admin and the
 * offline session whose claims were not read keep the full rail.
 */
export function railEntries(isAuntie = false): NavEntry[] {
  return NAV.filter((e) => !e.contextual && !(isAuntie && e.ownerOnly));
}

/** Rail entries for one group, in order. */
export function railGroup(group: NavGroup, isAuntie = false): NavEntry[] {
  return railEntries(isAuntie).filter((e) => e.group === group);
}

const BY_SLUG = new Map<string, Destination>([
  ...NAV.map((e) => [e.slug, e.dest] as const),
  // Back-compat: the old slug still resolves after the Tribal Intel rename.
  ['training-docs', 'trainingDocs'],
  // Legacy standalone template slugs resolve to the merged two-tab screen.
  ['template-bank', 'templates'],
  ['template-assignment', 'templates'],
  // #718: the retired notification-gate destination resolves to Settings,
  // where the gate now lives, instead of falling back to Home.
  ['notification-gate', 'settings'],
]);

const BY_DEST = new Map<Destination, string>(NAV.map((e) => [e.dest, e.slug]));

const OWNER_ONLY_DESTS = new Set<Destination>(NAV.filter((e) => e.ownerOnly).map((e) => e.dest));

/**
 * Does this in-app path open an owner-only screen (#2200 / #2201)? Reads the
 * first segment through the same slug table the rail uses, so a retired
 * address (`/template-bank`, `/notification-gate`) counts as the screen it
 * lands on. A link that answers true is hidden for an Auntie rather than left
 * as a button that only sends her Home.
 */
export function isOwnerOnlyPath(to: string): boolean {
  const slug = segments(to)[0];
  if (slug === undefined) return false;
  const dest = BY_SLUG.get(slug);
  return dest !== undefined && OWNER_ONLY_DESTS.has(dest);
}

const TITLE_BY_DEST = new Map<Destination, string>(NAV.map((e) => [e.dest, e.title]));

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

/**
 * The rail's own name for the screen a location lands on, or null.
 *
 * Reads the FIRST segment only, the same rule `parseHash` uses, so
 * `/directory/abc123` is still "Directory". Takes a TanStack pathname or a
 * hash; `segments` strips either prefix.
 *
 * Used by the route-level loading state, so an operator waiting on a screen's
 * chunk is told WHICH screen. Null rather than a "Loading…" default: inventing
 * a name for an unknown slug is the kind of confident-but-wrong string the
 * `lib/async.ts` header is about, and the caller has a truthful fallback.
 */
export function screenTitle(location: string): string | null {
  const slug = segments(location)[0];
  if (slug === undefined) return null;
  const dest = BY_SLUG.get(slug);
  if (dest === undefined) return null;
  return TITLE_BY_DEST.get(dest) ?? null;
}

/**
 * The rail's name for a destination, for the browser tab (#2007), so the tab
 * and the rail never disagree. Every destination has a NAV entry; the empty
 * fallback only keeps the type honest, and an empty part is dropped from the
 * tab rather than shown.
 */
export function navTitle(dest: Destination): string {
  return TITLE_BY_DEST.get(dest) ?? '';
}

/**
 * A screen's breadcrumb kicker, "<rail section> · <rail title>" (#1598). The
 * section comes from the rail entry, so a screen filed under Care Ops never
 * reads "The Den" in its heading while the sidebar says Care Ops.
 */
export function navKicker(dest: Destination): string {
  const entry = NAV.find((e) => e.dest === dest);
  if (entry === undefined) return NAV_GROUP_LABEL.den;
  return `${NAV_GROUP_LABEL[entry.group]} · ${entry.title}`;
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

/**
 * Where the retired `/notification-gate` route sends the TanStack router
 * (#718). A plain object, not wired into `Destination`/`NAV`, so `router.tsx`
 * and this file's own test can share the literal without either side
 * importing TanStack Router types into `nav.ts`. `section` matches the
 * `notifications` id `screens/Settings.tsx` already uses for that tab.
 */
export const NOTIFICATION_GATE_REDIRECT = {
  to: '/settings',
  search: { section: 'notifications' },
} as const;
