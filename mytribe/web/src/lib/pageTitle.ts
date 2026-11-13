import { useEffect, useRef } from 'react';
import { useRouterState } from '@tanstack/react-router';

/**
 * The browser tab's title, per screen (#2007).
 *
 * Until this, `index.html`'s static "MyTribe" was the title of every
 * screen, so two open tabs or a history list could not be told apart.
 *
 * THE SHAPE is "<record> · <screen> · MyTribe", most specific first so the
 * part that differs between tabs is the part a narrow tab still shows:
 *   Invoices · MyTribe
 *   Biscuit · Kin · MyTribe
 * The brand is spelled as the portal's own wordmark spells it. The admin app
 * has the same helper (`auntieos-admin/src/lib/pageTitle.ts`) with its own
 * brand; the two apps share no package, so each keeps its copy.
 *
 * TWO SOURCES, one writer:
 *   screen  each route's `staticData.title`, read off the deepest committed
 *           match by `useRouteTitle()` in the root layout. The names are the
 *           nav's and the screens' own headings.
 *   record  the screen that has a record open says its name with
 *           `useRecordTitle()` once it has loaded. The route only knows the
 *           id, which never goes in the tab.
 *
 * A record part is a NAME, never an id or an email. Callers pass the name the
 * heading shows, and only once it is loaded; while it loads the tab carries the
 * screen name alone. `formatPageTitle` also drops anything with an `@` in it, so
 * an email that slips through a fallback never reaches the tab.
 */
export const BRAND = 'MyTribe';

/** The screen name for an address no route owns. */
export const NOT_FOUND_TITLE = 'Page not found';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The screen's name in the browser tab. Every route that renders a screen sets one. */
    title?: string;
  }
}

function presentable(part: string | null | undefined): string | null {
  if (typeof part !== 'string') return null;
  const text = part.trim();
  if (text === '' || text.includes('@')) return null;
  return text;
}

/** "<parts> · MyTribe", blanks and emails dropped, a part repeated back to back said once. */
export function formatPageTitle(...parts: ReadonlyArray<string | null | undefined>): string {
  const kept: string[] = [];
  for (const raw of parts) {
    const text = presentable(raw);
    if (text !== null && kept[kept.length - 1] !== text) kept.push(text);
  }
  return [...kept, BRAND].join(' · ');
}

type Slot = 'screen' | 'record';
type Claim = { text: string | null };

let routeTitle: string | null = null;
/**
 * Claims in mount order, newest last. A stack rather than one value because
 * records nest: an invoice dialog opened over a household's profile names the
 * invoice, and closing it must hand the tab back to the household, not drop
 * to the bare screen name. A claim whose name is still loading is skipped.
 */
const claims: Record<Slot, Claim[]> = { screen: [], record: [] };

function current(slot: Slot): string | null {
  const stack = claims[slot];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const text = stack[i]?.text;
    if (text) return text;
  }
  return null;
}

function write(): void {
  if (typeof document === 'undefined') return;
  document.title = formatPageTitle(current('record'), current('screen') ?? routeTitle);
}

/**
 * One component's hold on a part of the title. Registered once at mount, so
 * its place in the stack does not move when its name finishes loading; only
 * the text changes after that.
 */
function useClaim(slot: Slot, text: string | null | undefined): void {
  const kept = presentable(text);
  const claimRef = useRef<Claim | null>(null);
  useEffect(() => {
    const claim: Claim = { text: null };
    claims[slot].push(claim);
    claimRef.current = claim;
    return () => {
      claims[slot] = claims[slot].filter((c) => c !== claim);
      claimRef.current = null;
      write();
    };
  }, [slot]);
  useEffect(() => {
    const claim = claimRef.current;
    if (claim === null || claim.text === kept) return;
    claim.text = kept;
    write();
  }, [kept]);
}

/** Name the open record in the tab ("Biscuit · Kin · MyTribe"). Pass null until the name is loaded. */
export function useRecordTitle(name: string | null | undefined): void {
  useClaim('record', name);
}

/**
 * Name the screen in the tab when no route can: the not-found card at the root,
 * which renders for an address that matched nothing and so has no route title.
 */
export function useScreenTitle(name: string): void {
  useClaim('screen', name);
}

/** The deepest committed match's title, or null. */
function leafTitle(matches: ReadonlyArray<{ staticData?: { title?: string } }>): string | null {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const title = matches[i]?.staticData?.title;
    if (typeof title === 'string' && title.trim() !== '') return title;
  }
  return null;
}

/** Mounted once, in the root layout: keeps the screen part in step with the router. */
export function useRouteTitle(): void {
  const title = useRouterState({ select: (s) => leafTitle(s.matches) });
  useEffect(() => {
    routeTitle = title;
    write();
  }, [title]);
}
