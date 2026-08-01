import { parseHash, routeToHash, routeWarning, type Destination } from '../../src/lib/nav';
import { VISUAL_DEMO_IDS } from './fixtures';
import type { ManifestScreen } from './manifest';

/**
 * Maps a manifest `webRoute` onto a React URL, and says so out loud when it
 * cannot.
 *
 * THE TWO DISAGREE, AND THAT IS THE FINDING. `manifest.json` was written for the
 * Compose app: its routes are HASH routes (`#/training-docs`) resolved by
 * `lib/nav.ts`'s slug table, while the React admin runs TanStack Router on real
 * paths (`/tribal-intel`). Three kinds of disagreement exist and each is handled
 * explicitly rather than papered over:
 *
 *   1. RENAMED. `#/training-docs` is the Tribal Intel screen, `#/template-bank`
 *      and `#/template-assignment` are both the merged Templates screen. The app
 *      already records every one of these in `nav.ts`'s back-compat entries, so
 *      this file derives the mapping FROM that table instead of hand-copying it.
 *      A rename that lands in `nav.ts` reaches this surface for free.
 *   2. RESHAPED. `#/invoices/{id}` is a path param in Compose and a search param
 *      (`/invoices?invoiceId={id}`) in React. A tiny explicit table below.
 *   3. GONE, or never reachable by URL. `#/payments` names a slug the React nav
 *      table does not know, and the form-schema editor is local component state
 *      with no URL of its own. These are reported by name and NOT captured. A
 *      golden of the wrong screen is worse than a missing one.
 *
 * Verification is therefore structural, not a list somebody kept in sync:
 * `routeWarning()` is the app's own dead-link detector, and every slug `nav.ts`
 * knows has a registered route (`AppShell.railLinks.test.ts` asserts exactly
 * that, by proving no rail entry falls through to "coming soon").
 */

/**
 * Destinations whose detail id rides in a SEARCH param on the React side.
 * A destination absent here has no URL for its detail view.
 */
const DETAIL_SEARCH_PARAM: Partial<Record<Destination, string>> = {
  // `/invoices?invoiceId=` -> Invoices' `initialInvoiceId` (router.tsx).
  invoices: 'invoiceId',
  // `/kintales?kinTaleId=` -> KinTalesView opens straight into detail.
  kintales: 'kinTaleId',
};

/**
 * Screens the React admin reaches only through an in-screen control, plus the
 * named control that opens them.
 *
 * KEPT TO CONTROLS WITH A REAL ACCESSIBLE NAME, and to screens that would
 * otherwise be either uncapturable or a duplicate of another screen's PNG:
 *
 *   template-assignment  Compose had a standalone screen; React merged it into
 *                        Templates behind the "Manage assignments" button. Left
 *                        as a plain URL it resolves to `/templates`, identical
 *                        to `template-bank`, so the surface would ship two names
 *                        for one picture.
 *   formschema-editor    `FormSchemasView` holds the editor in component state,
 *                        so no URL reaches it. "New schema" opens the blank
 *                        editor, which is more reproducible than clicking a
 *                        seeded row (no dependence on row order).
 *
 * A button name is a weaker contract than a URL, so both are asserted before the
 * click and the screen fails loud if the control is gone.
 */
export const SCREEN_OPENERS: Readonly<Record<string, { url: string; button: string }>> = {
  'template-assignment': { url: '/templates', button: 'Manage assignments' },
  'formschema-editor': { url: '/form-schemas', button: 'New schema' },
};

export type Mapping =
  | { kind: 'url'; url: string; dest: Destination; note?: string }
  | { kind: 'open'; url: string; button: string; note: string }
  | { kind: 'unmapped'; reason: string };

/** Replaces `__DEMO_X_ID__` tokens with the ids the visual seed writes. */
function resolveTokens(route: string): { route: string } | { missing: string } {
  const tokens = route.match(/__DEMO_[A-Z]+_ID__/g) ?? [];
  let out = route;
  for (const token of tokens) {
    const id = VISUAL_DEMO_IDS[token];
    if (id === undefined) return { missing: token };
    out = out.replace(token, id);
  }
  return { route: out };
}

export function mapScreen(entry: ManifestScreen): Mapping {
  const opener = SCREEN_OPENERS[entry.screen];
  if (opener) {
    return {
      kind: 'open',
      url: opener.url,
      button: opener.button,
      note: `no URL of its own in React; opened from ${opener.url} via "${opener.button}"`,
    };
  }

  const resolved = resolveTokens(entry.webRoute);
  if ('missing' in resolved) {
    return { kind: 'unmapped', reason: `no seeded id for ${resolved.missing}` };
  }

  // The app's own dead-link detector. Non-null means `parseHash` would fall back
  // to Home, so capturing this route would photograph Home under another name.
  const warning = routeWarning(resolved.route);
  if (warning !== null) {
    return {
      kind: 'unmapped',
      reason: `the React nav table has no such slug (routeWarning: "${warning}")`,
    };
  }

  const parsed = parseHash(resolved.route);
  // `routeToHash({dest})` is `#/slug`; the React path is the same slug without
  // the hash. Derived from nav.ts so a rename cannot desync this file.
  const path = routeToHash({ dest: parsed.dest }).replace(/^#/, '');

  if (parsed.detailId === undefined) {
    const renamed = path !== resolved.route.replace(/^#/, '');
    return {
      kind: 'url',
      url: path,
      dest: parsed.dest,
      ...(renamed ? { note: `manifest route ${resolved.route} is ${path} in React` } : {}),
    };
  }

  const param = DETAIL_SEARCH_PARAM[parsed.dest];
  if (param === undefined) {
    return {
      kind: 'unmapped',
      reason: `React has no URL for one ${parsed.dest} record (it is component state)`,
    };
  }
  return {
    kind: 'url',
    url: `${path}?${param}=${encodeURIComponent(parsed.detailId)}`,
    dest: parsed.dest,
    note: `path param in Compose, search param (?${param}=) in React`,
  };
}

/**
 * Manifest screens that map to the SAME React URL. Two names for one picture is
 * a reporting bug, not a capture bug, so it is surfaced rather than deduplicated.
 */
export function collisions(mapped: ReadonlyMap<string, Mapping>): Map<string, string[]> {
  const byUrl = new Map<string, string[]>();
  for (const [screen, m] of mapped) {
    if (m.kind === 'unmapped') continue;
    const key = m.kind === 'open' ? `${m.url} + "${m.button}"` : m.url;
    byUrl.set(key, [...(byUrl.get(key) ?? []), screen]);
  }
  return new Map([...byUrl].filter(([, screens]) => screens.length > 1));
}
